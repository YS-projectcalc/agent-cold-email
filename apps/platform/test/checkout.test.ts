import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { api, signup, tenantStub } from "./helpers.js";

interface CheckoutResponse {
  mode: "stripe" | "simulated";
  url: string;
  sessionId: string;
}

interface AccountResponse {
  plan: string;
  billingState: string;
}

function simulatePath(url: string): string {
  // `api()` prefixes with a fixed origin — strip whatever origin startCheckout
  // built the url with (the test worker's own request origin) and keep the
  // path+query so `api()` re-adds the SELF-fetch origin consistently.
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

// No STRIPE_SECRET_KEY is configured anywhere in this test environment
// (.dev.vars.example ships both Stripe vars commented out) — every checkout
// in this suite exercises the SIMULATED path. The real-Stripe path is coded
// (src/billing/stripe-client.ts) but inert/UNVERIFIED without a live key.
describe("POST /checkout — simulated test-mode upgrade (B1 money path)", () => {
  it("upgrades a demo tenant to a paid plan when the simulate link is hit", async () => {
    const { token } = await signup("Checkout Co", "founder@checkout.test");

    const before = await api<AccountResponse>("/account", { token });
    expect(before.body.plan).toBe("demo");
    expect(before.body.billingState).toBe("none");

    const checkout = await api<CheckoutResponse>("/checkout", {
      method: "POST",
      token,
      body: JSON.stringify({ plan: "growth" }),
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.mode).toBe("simulated");
    expect(checkout.body.url).toContain("/checkout/simulate");

    const complete = await api<{ upgraded: boolean; plan: string }>(simulatePath(checkout.body.url));
    expect(complete.status).toBe(200);
    expect(complete.body).toEqual({ upgraded: true, plan: "growth" });

    const after = await api<AccountResponse>("/account", { token });
    expect(after.body.plan).toBe("growth");
    expect(after.body.billingState).toBe("active");
  });

  it("is idempotent — replaying the simulate link twice does not double-apply", async () => {
    const { token } = await signup("Replay Co", "founder@replay.test");
    const checkout = await api<CheckoutResponse>("/checkout", {
      method: "POST",
      token,
      body: JSON.stringify({ plan: "launch" }),
    });
    const path = simulatePath(checkout.body.url);

    const first = await api<{ upgraded: boolean }>(path);
    expect(first.body.upgraded).toBe(true);

    const second = await api<{ upgraded: boolean; plan: string }>(path);
    expect(second.body).toEqual({ upgraded: false, plan: "launch" });

    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.plan).toBe("launch"); // still launch, not re-applied/changed
  });

  it("a checkout session is tenant-scoped — another tenant's query params can't complete it", async () => {
    const tenantA = await signup("Tenant A Co", "founder@a.test");
    const tenantB = await signup("Tenant B Co", "founder@b.test");

    const checkout = await api<CheckoutResponse>("/checkout", {
      method: "POST",
      token: tenantA.token,
      body: JSON.stringify({ plan: "scale" }),
    });

    // Swap tenant A's session id onto tenant B's tenantId in the query string.
    const parsed = new URL(checkout.body.url);
    const hijackPath = `/checkout/simulate?tenant=${tenantB.tenantId}&session=${parsed.searchParams.get("session")}`;
    const hijackAttempt = await api(hijackPath);
    expect(hijackAttempt.status).toBe(404);

    // The legitimate link still works for tenant A.
    const legit = await api<{ upgraded: boolean }>(simulatePath(checkout.body.url));
    expect(legit.body.upgraded).toBe(true);
  });

  it("requires auth to start a checkout", async () => {
    const res = await api("/checkout", { method: "POST", body: JSON.stringify({ plan: "launch" }) });
    expect(res.status).toBe(401);
  });

  it("rejects an unrecognized plan tier", async () => {
    const { token } = await signup("Bad Plan Co", "founder@badplan.test");
    const res = await api("/checkout", { method: "POST", token, body: JSON.stringify({ plan: "enterprise" }) });
    expect(res.status).toBe(400);
  });

  // Adversarial panel-03 finding #10: startCheckout INSERTed a new
  // checkout_sessions row on every call — a tenant looping POST /checkout grew
  // its own DO storage unboundedly. A pending session for the same plan is now
  // reused. FAILS on the old code (old code leaves 5 rows).
  it("repeated /checkout for the same plan reuses one pending session (bounded storage, finding #10)", async () => {
    const { tenantId, token } = await signup("Loop Checkout Co", "founder@loopcheckout.test");

    const sessionIds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await api<{ sessionId: string }>("/checkout", {
        method: "POST",
        token,
        body: JSON.stringify({ plan: "launch" }),
      });
      expect(res.status).toBe(201);
      sessionIds.add(res.body.sessionId);
    }
    // Same session returned every time.
    expect(sessionIds.size).toBe(1);

    // Exactly one pending row in the DO, not five.
    const rows = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) as n FROM checkout_sessions WHERE tenant_id = ? AND status = 'pending'`, tenantId)
        .one().n,
    );
    expect(rows).toBe(1);
  });
});
