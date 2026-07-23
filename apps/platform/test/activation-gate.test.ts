import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { isTenantActivated, readActivationState } from "../src/engine/activation.js";
import type { VendorAdapterBundle } from "../src/vendors/factory.js";
import { RealEmailPort } from "../src/vendors/real/email-port.js";
import { SandboxEmailPort } from "../src/vendors/sandbox/email-port.js";
import { activatePaidPlan, failPayment, mintTenant, postWebhook, tenantStub } from "./helpers.js";

// I1 (self-serve activation design §2.1) — the product-driven activation gate
// that REPLACES the manual `ENGINE_TENANTS` allowlist and the hard-`false`
// `realAdaptersActivated` flag (see the deleted test/engine-tenants-allowlist.
// test.ts). `activated(tenant) = plan is paid && billing_state === 'active'
// && NOT isLifecycleFrozen(status, billing_state) && screening === 'clear'`.

describe("isTenantActivated — pure predicate (design §2.1's formula, verbatim)", () => {
  it("demo/free plan never activates, regardless of billing state (ARCHITECTURE.md #8)", () => {
    expect(isTenantActivated("demo", "active", "active", "clear")).toBe(false);
    expect(isTenantActivated("free", "active", "active", "clear")).toBe(false);
  });

  it("paid + active + not frozen + screening clear -> activated", () => {
    expect(isTenantActivated("launch", "active", "active", "clear")).toBe(true);
    expect(isTenantActivated("growth", "active", "active", "clear")).toBe(true);
    expect(isTenantActivated("scale", "active", "active", "clear")).toBe(true);
  });

  it("paid but billing_state isn't 'active' yet (none/past_due/canceled) -> not activated", () => {
    expect(isTenantActivated("launch", "active", "none", "clear")).toBe(false);
    expect(isTenantActivated("launch", "active", "past_due", "clear")).toBe(false);
    expect(isTenantActivated("launch", "active", "canceled", "clear")).toBe(false);
  });

  it("paid + billing_state active but status='suspended' -> not activated (isLifecycleFrozen)", () => {
    expect(isTenantActivated("launch", "suspended", "active", "clear")).toBe(false);
  });

  it("paid + billing_state='disputed' -> not activated even if it somehow read as otherwise fine", () => {
    expect(isTenantActivated("launch", "active", "disputed", "clear")).toBe(false);
  });

  it("screening not clear -> not activated even when paid + billing-active + unfrozen", () => {
    expect(isTenantActivated("launch", "active", "active", "review")).toBe(false);
  });
});

// G1 (ga-gates-design-2026-07-22.md §G1) — replaces the former
// screeningStatusStub describe block above's "always clear" STUB test.
// readActivationState now reads the REAL persisted tenant_profile.
// screening_status column (src/ofac/screening.ts writes it) — a fresh row
// defaults to 'clear' (schema.ts), a 'review' verdict blocks activation.
describe("readActivationState — real screening_status column (G1, replaces the stub)", () => {
  it("a brand-new tenant defaults screening_status='clear' (schema.ts DEFAULT — every existing row stays byte-identical)", async () => {
    const { tenantId } = await mintTenant("Fresh Screening Co", "launch");
    const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
    );
    expect(row.screening_status).toBe("clear");
  });

  it("a directly-set 'review' status flips `activated` false even for an otherwise fully-activatable tenant, and back on 'clear'", async () => {
    const { tenantId } = await mintTenant("Screening Flip Co", "launch");
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'active' WHERE id = ?`, tenantId);
    });
    const clear = await runInDurableObject(tenantStub(tenantId), async (_i, state) => readActivationState(state.storage.sql, tenantId));
    expect(clear.activated).toBe(true);

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET screening_status = 'review' WHERE id = ?`, tenantId);
    });
    const review = await runInDurableObject(tenantStub(tenantId), async (_i, state) => readActivationState(state.storage.sql, tenantId));
    expect(review.activated).toBe(false);

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET screening_status = 'clear' WHERE id = ?`, tenantId);
    });
    const clearedAgain = await runInDurableObject(tenantStub(tenantId), async (_i, state) => readActivationState(state.storage.sql, tenantId));
    expect(clearedAgain.activated).toBe(true);
  });
});

describe("readActivationState — fresh SQL read reflects a billing-state flip immediately", () => {
  it("no caching: a direct billing_state write is visible on the VERY NEXT read", async () => {
    const { tenantId } = await mintTenant("Fresh Read Co", "launch");

    const before = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(before.activated).toBe(false); // billing_state defaults to 'none' at mint (schema.ts)

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'active' WHERE id = ?`, tenantId);
    });

    const after = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(after.activated).toBe(true);
  });
});

// F3 (adversarial 2026-07-21, BLOCKING binding for this lane): the ADAPTER
// decision itself must never be cached across a billing-state change — only
// the sandbox port INSTANCE may be cached (its in-memory queues must
// survive). This calls TenantDO's own private `buildAdapters()` directly
// (the exact production code path, not a re-implementation) inside a single
// `runInDurableObject` callback so it's provably the SAME DO instance/no
// restart between assertions.
interface TenantDOWithBuildAdapters {
  buildAdapters(): VendorAdapterBundle;
}

describe("TenantDO.buildAdapters — no cached real/sandbox DECISION (F3, design §2.2 option-1)", () => {
  it("a billing_state flip is visible on the VERY NEXT buildAdapters() call, same DO instance, no restart", async () => {
    const { tenantId } = await mintTenant("Adapter Fresh Co", "launch");

    // The email gate ALSO requires the engine to be wired (ENGINE_BASE_URL/
    // ENGINE_AUTH_SECRET — factory.ts's doc comment on why `activated` alone
    // is unsafe); wire it here (test-only fake values, restored after) so this
    // test can prove the genuine real-vs-sandbox SWAP, not just that email
    // stays sandbox forever without engine config.
    const savedBaseUrl = env.ENGINE_BASE_URL;
    const savedAuthSecret = env.ENGINE_AUTH_SECRET;
    (env as { ENGINE_BASE_URL?: string }).ENGINE_BASE_URL = "https://engine.example.internal";
    (env as { ENGINE_AUTH_SECRET?: string }).ENGINE_AUTH_SECRET = "test-secret";
    try {
      await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
        const internals = instance as unknown as TenantDOWithBuildAdapters;

        // billing_state starts 'none' (mintTenant never checks out) -> sandbox.
        expect(internals.buildAdapters().email).toBeInstanceOf(SandboxEmailPort);

        // Flip billing_state to 'active' directly (mirrors the checkout/webhook
        // write path) — SAME DO instance, no restart in between.
        state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'active' WHERE id = ?`, tenantId);
        expect(internals.buildAdapters().email).toBeInstanceOf(RealEmailPort);

        // And back off — proves this isn't a one-way/sticky cache either
        // (payment failure / dunning suspend / dispute must deactivate just as
        // fast as activation applied).
        state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'past_due' WHERE id = ?`, tenantId);
        const firstSandboxEmail = internals.buildAdapters().email;
        expect(firstSandboxEmail).toBeInstanceOf(SandboxEmailPort);

        // The SANDBOX bundle instance IS cached across calls within the DO's
        // lifetime (design §2.2's other half) — its in-memory send/poll queues
        // must be the SAME object, or a poll() right after a send() would never
        // see what was just queued.
        const secondSandboxEmail = internals.buildAdapters().email;
        expect(secondSandboxEmail).toBe(firstSandboxEmail);
      });
    } finally {
      (env as { ENGINE_BASE_URL?: string }).ENGINE_BASE_URL = savedBaseUrl;
      (env as { ENGINE_AUTH_SECRET?: string }).ENGINE_AUTH_SECRET = savedAuthSecret;
    }
  });

  it("WITHOUT the engine wired (ENGINE_BASE_URL/ENGINE_AUTH_SECRET unset — every test env, and prod before the founder arms it), a genuinely paid+active tenant's EmailPort stays sandbox and WORKS, never a permanently-dark real port", async () => {
    const { tenantId } = await mintTenant("Unarmed Engine Co", "launch");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const internals = instance as unknown as TenantDOWithBuildAdapters;
      state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'active' WHERE id = ?`, tenantId);
      const email = internals.buildAdapters().email;
      expect(email).toBeInstanceOf(SandboxEmailPort);
      const result = await email.send(
        { fromEmail: "a@b.test", toEmail: "c@d.test", subject: "s", body: "b", threadId: "t", inReplyToMessageId: null },
        "idem-unarmed-1",
      );
      expect(result.messageId).toMatch(/@sandbox\.local>$/);
    });
  });

  // G1 systemic guard (design line 181): "a test that a 'review' tenant's next
  // buildAdapters() returns SandboxEmailPort even with engine+InboxKit armed
  // — proves screening blocks activation, not just annotates it — fails on
  // any code that reads activation without the screening conjunct." This is
  // RED against the OLD screeningStatusStub (which always returned 'clear'
  // regardless of any column), and GREEN now that readActivationState reads
  // the real column — see the report's revert-fail-restore proof.
  it("a 'review' tenant's buildAdapters() stays SandboxEmailPort even fully engine-armed — screening BLOCKS activation, doesn't just annotate it", async () => {
    const { tenantId } = await mintTenant("Screening Review Co", "launch");
    const savedBaseUrl = env.ENGINE_BASE_URL;
    const savedAuthSecret = env.ENGINE_AUTH_SECRET;
    (env as { ENGINE_BASE_URL?: string }).ENGINE_BASE_URL = "https://engine.example.internal";
    (env as { ENGINE_AUTH_SECRET?: string }).ENGINE_AUTH_SECRET = "test-secret";
    try {
      await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
        const internals = instance as unknown as TenantDOWithBuildAdapters;
        state.storage.sql.exec(`UPDATE tenant_profile SET billing_state = 'active' WHERE id = ?`, tenantId);
        // Fully activatable but for screening: paid + billing active + not
        // frozen + engine armed — every OTHER conjunct is satisfied.
        expect(internals.buildAdapters().email).toBeInstanceOf(RealEmailPort);

        state.storage.sql.exec(`UPDATE tenant_profile SET screening_status = 'review' WHERE id = ?`, tenantId);
        expect(internals.buildAdapters().email).toBeInstanceOf(SandboxEmailPort);

        // And clearing it un-blocks on the VERY NEXT call (fresh-read discipline).
        state.storage.sql.exec(`UPDATE tenant_profile SET screening_status = 'clear' WHERE id = ?`, tenantId);
        expect(internals.buildAdapters().email).toBeInstanceOf(RealEmailPort);
      });
    } finally {
      (env as { ENGINE_BASE_URL?: string }).ENGINE_BASE_URL = savedBaseUrl;
      (env as { ENGINE_AUTH_SECRET?: string }).ENGINE_AUTH_SECRET = savedAuthSecret;
    }
  });
});

// Brief requirement: "billing-state transitions from Stripe webhooks must
// drive the I1 gate" — checkout.completed -> gate-on, cancel/payment-failed
// -> gate-off, exercised through the REAL webhook HTTP surface (not raw SQL).
describe("webhook-driven billing transitions flip the I1 activation gate", () => {
  it("checkout.session.completed activates; invoice.payment_failed deactivates", async () => {
    const { tenantId } = await mintTenant("Webhook Gate Co", "launch");

    const before = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(before.activated).toBe(false);

    await activatePaidPlan(tenantId, "launch");
    const active = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(active.activated).toBe(true);

    // F2 (adversarial 2026-07-21, BLOCKING): the exact renewal-failure shape
    // a duration-limited 100%-off promo code produces once its discount ends
    // — the subscription has no payment method on file, the renewal invoice
    // fails, Stripe fires invoice.payment_failed. The existing dunning lane
    // (billing_state -> 'past_due') must catch it, and that alone must
    // already flip the I1 activation gate off — no separate wiring needed.
    await failPayment(tenantId);
    const pastDue = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(pastDue.activated).toBe(false);
    expect(pastDue.billingState).toBe("past_due");
  });

  it("customer.subscription.deleted (cancellation) deactivates a previously-active tenant", async () => {
    const { tenantId } = await mintTenant("Cancel Gate Co", "launch");
    await activatePaidPlan(tenantId, "launch");
    const active = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(active.activated).toBe(true);

    const res = await postWebhook({
      id: `evt_${crypto.randomUUID()}`,
      type: "customer.subscription.deleted",
      data: { object: { metadata: { tenantId } } },
    });
    expect(res.status).toBe(200);

    const canceled = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      readActivationState(state.storage.sql, tenantId),
    );
    expect(canceled.activated).toBe(false);
    expect(canceled.billingState).toBe("canceled");
  });
});
