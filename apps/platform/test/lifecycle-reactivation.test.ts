import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { activatePaidPlan, adminApi, api, failPayment, mintTenant, postWebhook, tenantStub } from "./helpers.js";

function setupBody(brand: string, primaryDomain: string, domains: number, inboxesEach: number) {
  return JSON.stringify({
    brand,
    primaryDomain,
    domains,
    inboxesEach,
    persona: "Sender",
    physicalAddress: "1 React St",
    senderIdentity: `Sender <s@${primaryDomain}>`,
  });
}

async function statusOf(tenantId: string): Promise<{ status: string; billing_state: string; suspend_reason: string | null }> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql
      .exec<{ status: string; billing_state: string; suspend_reason: string | null }>(
        `SELECT status, billing_state, suspend_reason FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one(),
  );
}

// Adversarial panel-03 finding #4 (LIVE-PROVEN): quota counted released/burning
// resources (locking out a re-subscribing tenant) and teardown_records was a
// permanent tombstone (a second cancel returned the stale summary, never
// releasing the NEW infra = vendor-spend leak). Both FAIL on the old code.
describe("cancel -> re-subscribe -> re-provision (finding #4)", () => {
  it("re-provisioning within cap SUCCEEDS after a cancel (released resources don't count)", async () => {
    const { tenantId, token } = await mintTenant("Requota Co", "launch");
    await activatePaidPlan(tenantId, "launch");

    // Provision to the Launch cap (2 domains, 4 mailboxes <= 5).
    const first = await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("Requota Co", "requota.com", 2, 2),
    });
    expect(first.status).toBe(202);

    // Cancel immediately -> releases all 2 domains + 4 mailboxes.
    await api("/cancel", { method: "POST", token, body: JSON.stringify({ immediate: true }) });

    // Re-subscribe (a real re-checkout) -> reactivates + clears the teardown.
    await activatePaidPlan(tenantId, "launch");
    expect((await statusOf(tenantId)).billing_state).toBe("active");

    // Re-provision within cap -> ALLOWED (the released domains no longer count).
    // On the old code this was rejected 400 ("have 2 domains").
    const second = await api<{ jobId?: string; error?: string }>("/setup-infrastructure", {
      method: "POST",
      token,
      body: setupBody("Requota Co", "requota.com", 2, 2),
    });
    expect(second.status).toBe(202);

    // Exactly 2 LIVE domains + 4 LIVE mailboxes now (old released ones excluded).
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const liveDomains = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE status = 'active'`)
        .one().n;
      const liveMailboxes = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE released_at IS NULL`)
        .one().n;
      expect(liveDomains).toBe(2);
      expect(liveMailboxes).toBe(4);
    });
  });

  it("a SECOND cancel re-runs teardown on the NEW infra + books its liability", async () => {
    const { tenantId, token } = await mintTenant("Reteardown Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Reteardown Co", "reteardown.com", 2, 1) });

    // First cancel -> 2 domains released, 2 liability rows.
    const cancel1 = await api<{ teardown: { domainsReleased: number } }>("/cancel", {
      method: "POST",
      token,
      body: JSON.stringify({ immediate: true }),
    });
    expect(cancel1.body.teardown.domainsReleased).toBe(2);

    // Re-subscribe + re-provision NEW infra.
    await activatePaidPlan(tenantId, "launch");
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Reteardown Co", "reteardown.com", 2, 1) });

    // SECOND cancel -> must re-run teardown on the NEW infra (old code returned
    // alreadyCanceled=true with the stale summary and released nothing).
    const cancel2 = await api<{ alreadyCanceled: boolean; teardown: { domainsReleased: number } }>("/cancel", {
      method: "POST",
      token,
      body: JSON.stringify({ immediate: true }),
    });
    expect(cancel2.body.alreadyCanceled).toBe(false);
    expect(cancel2.body.teardown.domainsReleased).toBe(2);

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      // No live infra left.
      const liveDomains = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE status = 'active'`)
        .one().n;
      expect(liveDomains).toBe(0);
      // 4 liability rows total — 2 per lifecycle epoch, no double-count.
      const liability = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE kind = 'liability'`)
        .one().n;
      expect(liability).toBe(4);
    });
  });
});

// Adversarial panel-03 finding #6: a dunning-suspended tenant who cured payment
// had no reactivation path — billed but permanently frozen. A billing-recovery
// event now un-suspends a DUNNING suspension (never a TERMINATE).
describe("dunning suspension is reversible; terminate is not (finding #6)", () => {
  it("dunning-suspend -> subscription.updated(active) -> status active, tick resumes", async () => {
    const { tenantId, token } = await mintTenant("Recover Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    // Live infra + a due send.
    await api("/setup-infrastructure", { method: "POST", token, body: setupBody("Recover Co", "recover.com", 1, 2) });
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Recover campaign",
        offer: "x",
        leads: [{ email: "lead@recover-leads.com", firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });

    // Dunning: fail payment then suspend (the D2 sweep's action).
    await failPayment(tenantId);
    await tenantStub(tenantId).suspendForDunning();
    const suspended = await statusOf(tenantId);
    expect(suspended.status).toBe("suspended");
    expect(suspended.suspend_reason).toBe("dunning");
    // Frozen: tick sends nothing.
    expect((await tenantStub(tenantId).tick()).sent).toBe(0);

    // Customer fixes payment -> Stripe fires subscription.updated(active).
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "customer.subscription.updated",
      data: { object: { status: "active", metadata: { tenantId } } },
    });
    const recovered = await statusOf(tenantId);
    expect(recovered.status).toBe("active"); // un-suspended
    expect(recovered.suspend_reason).toBeNull();
    expect(recovered.billing_state).toBe("active");

    // Tick resumes (the previously-frozen due send now goes out).
    expect((await tenantStub(tenantId).tick()).sent).toBe(1);
  });

  it("an abuse TERMINATE is NEVER un-suspended by a billing event", async () => {
    const { tenantId } = await mintTenant("NoResurrect Co", "launch");
    await activatePaidPlan(tenantId, "launch");

    // Terminate (abuse offboarding) -> status suspended, reason terminate, token locked.
    const term = await adminApi(`/admin/tenants/${tenantId}/terminate`, {
      method: "POST",
      body: JSON.stringify({ reason: "abuse" }),
    });
    expect(term.status).toBe(200);
    const afterTerm = await statusOf(tenantId);
    expect(afterTerm.status).toBe("suspended");
    expect(afterTerm.suspend_reason).toBe("terminate");

    // A billing-recovery event must NOT resurrect a terminated tenant.
    await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "customer.subscription.updated",
      data: { object: { status: "active", metadata: { tenantId } } },
    });
    const stillTerminated = await statusOf(tenantId);
    expect(stillTerminated.status).toBe("suspended");
    expect(stillTerminated.suspend_reason).toBe("terminate");
  });
});
