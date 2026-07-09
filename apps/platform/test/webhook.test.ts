import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { api, mintTenant, postWebhook, tenantStub } from "./helpers.js";

interface AccountResponse {
  plan: string;
  billingState: string;
}

interface WebhookResponse {
  received: boolean;
  applied: boolean;
  duplicate: boolean;
  plan?: string;
}

function checkoutCompletedEvent(eventId: string, tenantId: string, plan: string) {
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_test_123",
        subscription: "sub_test_123",
        client_reference_id: tenantId,
        metadata: { tenantId, plan },
      },
    },
  };
}

function invoicePaymentFailedEvent(eventId: string, tenantId: string) {
  return {
    id: eventId,
    type: "invoice.payment_failed",
    data: { object: { metadata: { tenantId } } },
  };
}

// A test STRIPE_WEBHOOK_SECRET IS configured (vitest.config.ts), and the route
// now FAILS CLOSED without one (adversarial panel-03 finding #1). So every
// fixture here is delivered through `postWebhook()`, which signs the raw body
// exactly as a real Stripe delivery would — these tests exercise the full
// verify-then-route-then-apply path end to end. The fail-closed + bad-signature
// transport cases live in webhook-security.test.ts.
describe("POST /webhooks/stripe — idempotent per event id (ARCHITECTURE.md #3)", () => {
  it("checkout.session.completed upgrades the tenant plan exactly once, even redelivered", async () => {
    const { tenantId, token } = await mintTenant("Webhook Co", "demo");
    const eventId = `evt_${crypto.randomUUID()}`;
    const event = checkoutCompletedEvent(eventId, tenantId, "scale");

    const first = await postWebhook<WebhookResponse>(event);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ applied: true, duplicate: false, plan: "scale" });

    // Redelivery of the SAME event id — must be a no-op, not a second upgrade.
    const second = await postWebhook<WebhookResponse>(event);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ applied: false, duplicate: true });

    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.plan).toBe("scale");
    expect(account.body.billingState).toBe("active");

    // Exactly one upgrade-credit ledger entry, not two.
    await runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
      const n = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) as n FROM ledger_entries WHERE tenant_id = ? AND kind = 'credit' AND description LIKE '%checkout.session.completed%'`,
          tenantId,
        )
        .one().n;
      expect(n).toBe(1);
    });
  });

  it("invoice.payment_failed marks the tenant past_due", async () => {
    const { tenantId, token } = await mintTenant("Dunning Co", "launch");
    const event = invoicePaymentFailedEvent(`evt_${crypto.randomUUID()}`, tenantId);

    const res = await postWebhook<WebhookResponse>(event);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.billingState).toBe("past_due");
    expect(account.body.plan).toBe("launch"); // payment failure doesn't itself change the plan
  });

  it("customer.subscription.deleted cancels billing and downgrades the tenant to free", async () => {
    const { tenantId, token } = await mintTenant("Cancel Co", "growth");
    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: "customer.subscription.deleted",
      data: { object: { metadata: { tenantId } } },
    };

    const res = await postWebhook<WebhookResponse>(event);
    expect(res.body).toMatchObject({ applied: true, plan: "free" });

    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.plan).toBe("free");
    expect(account.body.billingState).toBe("canceled");
  });

  it("an event with no resolvable tenant reference is accepted but not applied", async () => {
    const event = { id: `evt_${crypto.randomUUID()}`, type: "checkout.session.completed", data: { object: {} } };
    const res = await postWebhook<WebhookResponse>(event);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, applied: false });
  });
});
