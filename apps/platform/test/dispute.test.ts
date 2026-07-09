import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { activatePaidPlan, api, mintTenant, postWebhook, tenantStub } from "./helpers.js";

interface WebhookResponse {
  received: boolean;
  applied: boolean;
  duplicate: boolean;
  frozen?: boolean;
  unfrozen?: boolean;
}

interface AccountResponse {
  billingState: string;
}

function disputeCreatedEvent(eventId: string, tenantId: string, disputeId: string) {
  return {
    id: eventId,
    type: "charge.dispute.created",
    data: { object: { id: disputeId, charge: "ch_test_1", amount: 9900, reason: "fraudulent", metadata: { tenantId } } },
  };
}

function disputeClosedEvent(eventId: string, tenantId: string, disputeId: string, status: string) {
  return {
    id: eventId,
    type: "charge.dispute.closed",
    data: { object: { id: disputeId, status, metadata: { tenantId } } },
  };
}

async function provisionAndLaunch(token: string): Promise<void> {
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand: "Dispute Co",
      primaryDomain: "dispute-co.com",
      domains: 1,
      inboxesEach: 2,
      persona: "Sender",
      physicalAddress: "1 Dispute St",
      senderIdentity: "Sender <s@dispute-co.com>",
    }),
  });
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "Dispute campaign",
      offer: "x",
      leads: [{ email: "lead@dispute-leads.com", firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
}

// D5.3 — chargeback / dispute lane (protects the master Stripe account).
// Required cases: dispute.created -> tenant frozen + recorded; same event id
// twice -> applied once; dispute.closed(won) -> unfreeze.
describe("charge.dispute.* webhook — chargeback freeze/unfreeze lane (D5)", () => {
  it("dispute.created freezes the tenant (sends stop); dispute.closed(won) unfreezes (sends resume)", async () => {
    const { tenantId, token } = await mintTenant("Dispute Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await provisionAndLaunch(token);

    const disputeId = "dp_test_1";
    const created = await postWebhook<WebhookResponse>(
      disputeCreatedEvent(`evt_${crypto.randomUUID()}`, tenantId, disputeId),
    );
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ applied: true, duplicate: false, frozen: true });

    const frozenAccount = await api<AccountResponse>("/account", { token });
    expect(frozenAccount.body.billingState).toBe("disputed");

    // The dispute is recorded, open.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const row = state.storage.sql
        .exec<{ status: string; amount_cents: number }>(`SELECT status, amount_cents FROM disputes WHERE dispute_id = ?`, disputeId)
        .one();
      expect(row.status).toBe("open");
      expect(row.amount_cents).toBe(9900);
    });

    // FROZEN: a tick sends nothing even though a send is due.
    const frozenTick = await tenantStub(tenantId).tick();
    expect(frozenTick.sent).toBe(0);

    // Won -> unfreeze.
    const closed = await postWebhook<WebhookResponse>(
      disputeClosedEvent(`evt_${crypto.randomUUID()}`, tenantId, disputeId, "won"),
    );
    expect(closed.body).toMatchObject({ applied: true, unfrozen: true });

    const unfrozenAccount = await api<AccountResponse>("/account", { token });
    expect(unfrozenAccount.body.billingState).toBe("active");

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const status = state.storage.sql
        .exec<{ status: string }>(`SELECT status FROM disputes WHERE dispute_id = ?`, disputeId)
        .one().status;
      expect(status).toBe("won");
    });

    // RESUMED: the previously-deferred send now goes through.
    const resumedTick = await tenantStub(tenantId).tick();
    expect(resumedTick.sent).toBe(1);
  });

  it("is idempotent by event id — the same dispute.created delivered twice applies once", async () => {
    const { tenantId } = await mintTenant("Dispute Idem Co", "launch");
    await activatePaidPlan(tenantId, "launch");

    const eventId = `evt_${crypto.randomUUID()}`;
    const event = disputeCreatedEvent(eventId, tenantId, "dp_idem_1");

    const first = await postWebhook<WebhookResponse>(event);
    expect(first.body).toMatchObject({ applied: true, duplicate: false, frozen: true });

    const second = await postWebhook<WebhookResponse>(event);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ applied: false, duplicate: true });

    // Exactly one dispute row (per-DO table), billing still disputed — applied once.
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const n = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM disputes`).one().n;
      expect(n).toBe(1);
      const billingState = state.storage.sql
        .exec<{ billing_state: string }>(`SELECT billing_state FROM tenant_profile WHERE id = ?`, tenantId)
        .one().billing_state;
      expect(billingState).toBe("disputed");
    });
  });

  it("a lost dispute keeps the tenant frozen (owner decides via terminate)", async () => {
    const { tenantId } = await mintTenant("Dispute Lost Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    const disputeId = "dp_lost_1";

    await postWebhook(disputeCreatedEvent(`evt_${crypto.randomUUID()}`, tenantId, disputeId));
    const closed = await postWebhook<WebhookResponse>(
      disputeClosedEvent(`evt_${crypto.randomUUID()}`, tenantId, disputeId, "lost"),
    );
    expect(closed.body).toMatchObject({ applied: true });
    expect(closed.body.unfrozen).toBeFalsy();

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const billingState = state.storage.sql
        .exec<{ billing_state: string }>(`SELECT billing_state FROM tenant_profile WHERE id = ?`, tenantId)
        .one().billing_state;
      expect(billingState).toBe("disputed"); // still frozen
      const disputeStatus = state.storage.sql
        .exec<{ status: string }>(`SELECT status FROM disputes WHERE dispute_id = ?`, disputeId)
        .one().status;
      expect(disputeStatus).toBe("lost");
    });
  });
});
