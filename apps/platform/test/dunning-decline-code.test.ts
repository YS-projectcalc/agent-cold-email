import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activatePaidPlan, adminApi, mintTenant, postWebhook, seedBenignSdnList, tenantStub } from "./helpers.js";
import { invoicePaymentFailed, stripeCustomerIdFor } from "./stripe-fixtures.js";

// A5's permanent-decline fast path (admin/dunning.ts) suspends immediately on a
// lost/stolen/fraudulent card instead of grinding through the four-strike grace
// cycle. It reads `tenant_profile.last_decline_code`, which the
// `invoice.payment_failed` handler writes.
//
// On a REAL unexpanded payload there is nowhere on the invoice for a decline
// code to be: `charge` and `payment_intent` are bare id STRINGS (see
// test/stripe-fixtures.ts). Every in-payload branch therefore returned null on
// every real delivery, so every real decline graded TRANSIENT and the fast path
// had never once executed. Reading the code costs a second Stripe call.
//
// SAFE DIRECTION, asserted below as hard as the happy path: a failed or slow
// lookup grades TRANSIENT. Suspending a paying customer because Stripe returned
// a 503 would be strictly worse than the bug.

interface SweepResponse {
  results: { tenantId: string; cycle: number; action: string; applied: boolean }[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Arms a Stripe test key and answers Stripe GETs for the duration of one
 * delivery, the way `postDisputeWebhook` (helpers.ts) does for the dispute
 * route. Both are restored immediately after: a set `STRIPE_SECRET_KEY` also
 * arms `isRealSpendArmed`, so it must never be left on around a tick.
 * Returns the Stripe URLs the delivery actually requested.
 */
async function withStripeLookup<T>(
  respond: (url: string) => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; urls: string[] }> {
  const savedKey = env.STRIPE_SECRET_KEY;
  const savedFetch = globalThis.fetch;
  const urls: string[] = [];
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_decline_fixture";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.stripe.com/")) {
      urls.push(url);
      return respond(url);
    }
    return savedFetch(input, init);
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = savedFetch;
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = savedKey;
  }
}

/** A real failed Charge: `outcome.reason` carries the issuer's decline code,
 *  `failure_code` the generic card error. Stripe's documented shape. */
function failedCharge(reason: string): Response {
  return new Response(
    JSON.stringify({
      id: "ch_test_declined",
      object: "charge",
      status: "failed",
      failure_code: "card_declined",
      failure_message: "Your card was declined.",
      outcome: { network_status: "declined_by_network", reason, risk_level: "normal", type: "issuer_declined" },
    }),
    { status: 200 },
  );
}

async function payingTenant(brand: string): Promise<string> {
  const { tenantId } = await mintTenant(brand, "managed");
  await seedBenignSdnList();
  await activatePaidPlan(tenantId, "managed");
  return tenantId;
}

async function sweepAction(tenantId: string): Promise<string | undefined> {
  const sweep = await adminApi<SweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
  return sweep.body.results.find((r) => r.tenantId === tenantId)?.action;
}

describe("invoice.payment_failed resolves the decline code from Stripe, not from the payload", () => {
  it("reads a PERMANENT decline off the charge and suspends on the FIRST failure", async () => {
    const tenantId = await payingTenant("Lost Card Co");

    const { urls } = await withStripeLookup(
      () => failedCharge("lost_card"),
      () =>
        postWebhook(
          invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), chargeId: "ch_lost_card" }),
        ),
    );

    expect(urls.some((u) => u.includes("/charges/ch_lost_card"))).toBe(true);
    const summary = await tenantStub(tenantId).opsSummary(Date.now());
    expect(summary.lastDeclineCode).toBe("lost_card");
    expect(summary.billingFailureCount).toBe(1);

    // The whole point of the A5 fast path: one failure, not four.
    expect(await sweepAction(tenantId)).toBe("suspend");
    expect((await tenantStub(tenantId).opsSummary(Date.now())).status).toBe("suspended");
  });

  it("falls back to the payment intent when the invoice carries no charge", async () => {
    const tenantId = await payingTenant("No Charge Co");

    const { urls } = await withStripeLookup(
      () =>
        new Response(
          JSON.stringify({
            id: "pi_no_charge",
            object: "payment_intent",
            status: "requires_payment_method",
            last_payment_error: { code: "card_declined", decline_code: "stolen_card", type: "card_error" },
          }),
          { status: 200 },
        ),
      () =>
        postWebhook(
          invoicePaymentFailed({
            tenantId,
            customerId: stripeCustomerIdFor(tenantId),
            chargeId: null,
            paymentIntentId: "pi_no_charge",
          }),
        ),
    );

    expect(urls.some((u) => u.includes("/payment_intents/pi_no_charge"))).toBe(true);
    expect((await tenantStub(tenantId).opsSummary(Date.now())).lastDeclineCode).toBe("stolen_card");
  });

  it("grades a TRANSIENT decline transient — the grace cycle still applies", async () => {
    const tenantId = await payingTenant("Insufficient Funds Co");

    await withStripeLookup(
      () => failedCharge("insufficient_funds"),
      () =>
        postWebhook(
          invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), chargeId: "ch_nsf" }),
        ),
    );

    expect((await tenantStub(tenantId).opsSummary(Date.now())).lastDeclineCode).toBe("insufficient_funds");
    expect(await sweepAction(tenantId)).toBe("retry");
  });

  it("NEVER suspends on an unknown code when the Stripe lookup fails", async () => {
    const tenantId = await payingTenant("Stripe Hiccup Co");

    const { result } = await withStripeLookup(
      () => new Response("stripe is having a moment", { status: 503 }),
      () =>
        postWebhook<{ applied: boolean }>(
          invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), chargeId: "ch_hiccup" }),
        ),
    );

    // The failure itself still applies — only the code is unknown. A 500 here
    // would put an unroutable-ish event into Stripe's 3-day retry march for
    // nothing.
    expect(result.status).toBe(200);
    expect(result.body.applied).toBe(true);
    const summary = await tenantStub(tenantId).opsSummary(Date.now());
    expect(summary.billingState).toBe("past_due");
    expect(summary.lastDeclineCode).toBeNull();
    expect(await sweepAction(tenantId)).toBe("retry");
  });

  it("NEVER suspends when the lookup times out / the network throws", async () => {
    const tenantId = await payingTenant("Timeout Co");

    const savedKey = env.STRIPE_SECRET_KEY;
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_decline_timeout";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    try {
      const res = await postWebhook<{ applied: boolean }>(
        invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId), chargeId: "ch_timeout" }),
      );
      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = savedKey;
    }

    expect((await tenantStub(tenantId).opsSummary(Date.now())).lastDeclineCode).toBeNull();
    expect(await sweepAction(tenantId)).toBe("retry");
  });

  it("makes no Stripe call at all when no key is armed", async () => {
    const tenantId = await payingTenant("Unarmed Co");
    const calls: string[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.stripe.com/")) calls.push(String(input));
      return savedFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await postWebhook<{ applied: boolean }>(
        invoicePaymentFailed({ tenantId, customerId: stripeCustomerIdFor(tenantId) }),
      );
      expect(res.body.applied).toBe(true);
    } finally {
      globalThis.fetch = savedFetch;
    }

    expect(calls).toEqual([]);
    expect((await tenantStub(tenantId).opsSummary(Date.now())).lastDeclineCode).toBeNull();
  });
});
