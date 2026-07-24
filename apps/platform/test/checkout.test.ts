import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { api, mintTenant, signup, tenantStub } from "./helpers.js";

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
      body: JSON.stringify({ mailboxes: 20 }),
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.mode).toBe("simulated");
    expect(checkout.body.url).toContain("/checkout/simulate");

    const complete = await api<{ upgraded: boolean; plan: string }>(simulatePath(checkout.body.url));
    expect(complete.status).toBe(200);
    expect(complete.body).toEqual({ upgraded: true, plan: "managed" });

    const after = await api<AccountResponse>("/account", { token });
    expect(after.body.plan).toBe("managed");
    expect(after.body.billingState).toBe("active");
  });

  it("is idempotent — replaying the simulate link twice does not double-apply", async () => {
    const { token } = await signup("Replay Co", "founder@replay.test");
    const checkout = await api<CheckoutResponse>("/checkout", {
      method: "POST",
      token,
      body: JSON.stringify({ mailboxes: 5 }),
    });
    const path = simulatePath(checkout.body.url);

    const first = await api<{ upgraded: boolean }>(path);
    expect(first.body.upgraded).toBe(true);

    const second = await api<{ upgraded: boolean; plan: string }>(path);
    expect(second.body).toEqual({ upgraded: false, plan: "managed" });

    const account = await api<AccountResponse>("/account", { token });
    expect(account.body.plan).toBe("managed"); // still managed, not re-applied/changed
  });

  it("a checkout session is tenant-scoped — another tenant's query params can't complete it", async () => {
    const tenantA = await signup("Tenant A Co", "founder@a.test");
    const tenantB = await signup("Tenant B Co", "founder@b.test");

    const checkout = await api<CheckoutResponse>("/checkout", {
      method: "POST",
      token: tenantA.token,
      body: JSON.stringify({ mailboxes: 60 }),
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
    const res = await api("/checkout", { method: "POST", body: JSON.stringify({ mailboxes: 5 }) });
    expect(res.status).toBe(401);
  });

  it("rejects an out-of-range mailbox count (below the 5-mailbox minimum)", async () => {
    const { token } = await signup("Bad Plan Co", "founder@badplan.test");
    const res = await api("/checkout", { method: "POST", token, body: JSON.stringify({ mailboxes: 3 }) });
    expect(res.status).toBe(400);
  });

  // Adversarial panel-03 finding #10: startCheckout INSERTed a new
  // checkout_sessions row on every call — a tenant looping POST /checkout grew
  // its own DO storage unboundedly. A pending session for the same plan is now
  // reused. FAILS on the old code (old code leaves 5 rows).
  it("repeated /checkout reuses one pending session (bounded storage, finding #10)", async () => {
    const { tenantId, token } = await signup("Loop Checkout Co", "founder@loopcheckout.test");

    const sessionIds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await api<{ sessionId: string }>("/checkout", {
        method: "POST",
        token,
        body: JSON.stringify({ mailboxes: 5 }),
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

type Profile = {
  plan: string;
  billing_state: string;
};

function readProfile(tenantId: string): Promise<Profile> {
  return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<Profile>(`SELECT plan, billing_state FROM tenant_profile WHERE id = ?`, tenantId).one(),
  );
}

// F1 (adversarial 2026-07-21, BLOCKING —
// docs/adversarial/selfserve-activation-design-review-2026-07-21.md):
// unauthenticated GET /checkout/simulate was a free real-spend activation
// bypass under I1 — it wrote plan+billing_state='active' for ANY pending
// checkout_sessions row (e.g. a pre-arming test tenant's) with no gate on
// STRIPE_SECRET_KEY presence. Reproduces the exact live-ammo scenario: a
// PENDING session that predates live keys, hit AFTER a live key is
// configured (arming-order-independent — the guard fires regardless of when
// the session was created).
describe("GET /checkout/simulate — fails closed once live Stripe keys are configured (F1)", () => {
  it("refuses to complete a pending session and leaves the tenant untouched", async () => {
    const { tenantId } = await signup("Preexisting Session Co", "founder@preexisting.test");

    // A pending simulated session created BEFORE live keys were ever wired —
    // exactly the "pre-arming test tenant" scenario F1 describes. Inserted
    // directly (not via POST /checkout) so this test never depends on
    // env.STRIPE_SECRET_KEY's value at session-creation time.
    const sessionId = "cs_pre_arming_test_session";
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, 'managed', 'pending', ?)`,
        sessionId,
        tenantId,
        Date.now(),
      );
    });

    const before = await readProfile(tenantId);
    expect(before.billing_state).toBe("none");

    const saved = env.STRIPE_SECRET_KEY;
    try {
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake_key_for_f1_test";

      const res = await api(`/checkout/simulate?tenant=${tenantId}&session=${sessionId}`);
      expect(res.status).toBe(404);
    } finally {
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
    }

    // The activation-relevant write never landed.
    const after = await readProfile(tenantId);
    expect(after.billing_state).toBe("none");
    expect(after.plan).toBe("demo");

    // With NEITHER real-spend signal armed (no Stripe key, no engine — the
    // actual test-env default), the SAME session still completes normally —
    // proves the guard is config-gated, not a dead/always-block branch.
    const legit = await api(`/checkout/simulate?tenant=${tenantId}&session=${sessionId}`);
    expect(legit.status).toBe(200);
    const legitAfter = await readProfile(tenantId);
    expect(legitAfter.billing_state).toBe("active");
  });

  // Round-2 adversary re-attack (docs/adversarial/
  // selfserve-i1i2-build-review-2026-07-21.md finding 1, BLOCKING): the
  // ORIGINAL F1 window is "infra armed BEFORE Stripe keys" — i.e. exactly
  // when STRIPE_SECRET_KEY is UNSET. A STRIPE_SECRET_KEY-only guard is INERT
  // in that window. This reproduces the adversary's exact exploit sequence:
  // engine wired (ENGINE_BASE_URL/ENGINE_AUTH_SECRET set), Stripe key still
  // unset — the guard must ALSO fire here.
  it("refuses a pending session when the ENGINE is armed even though STRIPE_SECRET_KEY is still unset (round-2 adversary finding 1)", async () => {
    const { tenantId } = await signup("Engine Armed First Co", "founder@enginearmedfirst.test");
    const sessionId = "cs_engine_armed_before_stripe_session";
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, 'managed', 'pending', ?)`,
        sessionId,
        tenantId,
        Date.now(),
      );
    });

    const savedBaseUrl = env.ENGINE_BASE_URL;
    const savedAuthSecret = env.ENGINE_AUTH_SECRET;
    const savedStripeKey = env.STRIPE_SECRET_KEY;
    try {
      (env as { ENGINE_BASE_URL?: string }).ENGINE_BASE_URL = "https://engine.example.internal";
      (env as { ENGINE_AUTH_SECRET?: string }).ENGINE_AUTH_SECRET = "test-secret";
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = undefined; // the defining condition of the original window

      const res = await api(`/checkout/simulate?tenant=${tenantId}&session=${sessionId}`);
      expect(res.status).toBe(404);

      await runInDurableObject(tenantStub(tenantId), async (instance) => {
        // G1 (ga-gates-design-2026-07-22.md) made completeCheckoutSimulated
        // async (it now awaits screenTenant) — the throw surfaces as a
        // rejection, not a synchronous throw.
        await expect(instance.completeCheckoutSimulated(sessionId)).rejects.toThrow(/simulated checkout is disabled/);
      });
    } finally {
      (env as { ENGINE_BASE_URL?: string }).ENGINE_BASE_URL = savedBaseUrl;
      (env as { ENGINE_AUTH_SECRET?: string }).ENGINE_AUTH_SECRET = savedAuthSecret;
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = savedStripeKey;
    }

    const after = await readProfile(tenantId);
    expect(after.billing_state).toBe("none");
    expect(after.plan).toBe("demo");
  });

  it("completeSimulatedCheckout itself refuses when a live key is configured — defense in depth, even off the HTTP route", async () => {
    const { tenantId } = await mintTenant("Direct DO Call Co", "demo");
    const sessionId = "cs_direct_do_call_session";
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, 'managed', 'pending', ?)`,
        sessionId,
        tenantId,
        Date.now(),
      );
    });

    const saved = env.STRIPE_SECRET_KEY;
    try {
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake_key_for_f1_test";
      // Calls the method directly on the DO's own `instance` inside
      // runInDurableObject (matching idempotency.test.ts's established
      // pattern) rather than through the stub RPC boundary — avoids a
      // spurious "unhandled rejection" double-report some vitest-pool-workers
      // versions emit for an error thrown across the stub RPC call itself.
      // G1 (ga-gates-design-2026-07-22.md) made completeCheckoutSimulated
      // itself async (it now awaits screenTenant), so this rejects rather
      // than throwing synchronously.
      await runInDurableObject(tenantStub(tenantId), async (instance) => {
        await expect(instance.completeCheckoutSimulated(sessionId)).rejects.toThrow(/simulated checkout is disabled/);
      });
    } finally {
      (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = saved;
    }

    const after = await readProfile(tenantId);
    expect(after.billing_state).toBe("none");
  });
});
