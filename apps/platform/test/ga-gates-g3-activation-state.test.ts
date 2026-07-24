import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";
import { deriveActivationState, realSendPathLive } from "../src/engine/activation.js";
import { getAccount } from "../src/engine/reporting.js";
import { activatePaidPlan, mintTenant, seedBenignSdnList, withTenantContext } from "./helpers.js";

// getAccount via withTenantContext (not the RPC stub): the stub's `.account()`
// return type collapses to `never` because AccountSummary carries a
// Record<string, unknown> (Rpc-non-serializable) — a pre-existing quirk. The
// direct call exercises the SAME derivation on the SAME live DO state + env.
const accountOf = (tenantId: string) => withTenantContext(tenantId, (ctx) => getAccount(ctx));

// GA gate G3 (ga-gates-design-2026-07-22.md §G3 + adversary B2) — the
// confident-wrong class: a PAID, billing_state='active' tenant whose real send
// path isn't live silently gets a SandboxEmailPort that SIMULATES successful
// sends. activationState must report the truth, never a fake 'active'.

function fakeEnv(overrides: Partial<Env>): Env {
  return overrides as unknown as Env;
}

describe("realSendPathLive — BOTH engine AND InboxKit armed (adversary B2 corrected formula)", () => {
  it("true only when ENGINE_* AND INBOXKIT_* are all present", () => {
    expect(
      realSendPathLive(fakeEnv({ ENGINE_BASE_URL: "u", ENGINE_AUTH_SECRET: "s", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" })),
    ).toBe(true);
  });
  it("false when InboxKit is unbound even though the engine is armed (the B2 hole)", () => {
    expect(realSendPathLive(fakeEnv({ ENGINE_BASE_URL: "u", ENGINE_AUTH_SECRET: "s" }))).toBe(false);
  });
  it("false when the engine is unarmed", () => {
    expect(realSendPathLive(fakeEnv({ INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" }))).toBe(false);
  });
});

describe("deriveActivationState — pure derivation (design §G3)", () => {
  const paidActive = { plan: "managed" as const, status: "active", billingState: "active", screening: "clear" as const };

  it("demo/free → sandbox (expected, honest)", () => {
    expect(deriveActivationState({ ...paidActive, plan: "demo", realSendPathLive: true, capacityPending: false })).toBe("sandbox");
    expect(deriveActivationState({ ...paidActive, plan: "free", realSendPathLive: true, capacityPending: false })).toBe("sandbox");
  });

  it("CONFIDENT-WRONG #1 — paid+active with the ENGINE unset → pending_provisioning (not active)", () => {
    expect(deriveActivationState({ ...paidActive, realSendPathLive: false, capacityPending: false })).toBe("pending_provisioning");
  });

  it("CONFIDENT-WRONG #2 (adversary B2) — engine armed but InboxKit unbound → pending_provisioning (realSendPathLive false)", () => {
    // realSendPathLive already encodes the B2 conjunct; here it is false because
    // InboxKit is unbound, so a genuinely engine-armed tenant is STILL pending.
    expect(deriveActivationState({ ...paidActive, realSendPathLive: false, capacityPending: false })).toBe("pending_provisioning");
  });

  it("paid+active + real send path live → active", () => {
    expect(deriveActivationState({ ...paidActive, realSendPathLive: true, capacityPending: false })).toBe("active");
  });

  it("capacity_pending is a sub-state of an otherwise-active tenant (G2/G4)", () => {
    expect(deriveActivationState({ ...paidActive, realSendPathLive: true, capacityPending: true })).toBe("capacity_pending");
  });

  it("screening review → screening_hold (only once past the billing-freeze branch)", () => {
    expect(deriveActivationState({ ...paidActive, screening: "review", realSendPathLive: true, capacityPending: false })).toBe(
      "screening_hold",
    );
  });

  it("billing freeze is checked BEFORE screening (a disputed+in-review tenant shows the dispute, not 'account review')", () => {
    expect(
      deriveActivationState({ plan: "managed", status: "active", billingState: "disputed", screening: "review", realSendPathLive: true, capacityPending: false }),
    ).toBe("suspended");
    expect(
      deriveActivationState({ plan: "managed", status: "active", billingState: "canceled", screening: "review", realSendPathLive: true, capacityPending: false }),
    ).toBe("canceled");
  });

  it("past_due (not isLifecycleFrozen) surfaces as suspended, not active", () => {
    expect(deriveActivationState({ plan: "managed", status: "active", billingState: "past_due", screening: "clear", realSendPathLive: true, capacityPending: false })).toBe("suspended");
  });
});

describe("account().activationState — end-to-end honest state through the real DO", () => {
  const saved = {
    ENGINE_BASE_URL: env.ENGINE_BASE_URL,
    ENGINE_AUTH_SECRET: env.ENGINE_AUTH_SECRET,
    INBOXKIT_API_KEY: env.INBOXKIT_API_KEY,
    INBOXKIT_WORKSPACE_ID: env.INBOXKIT_WORKSPACE_ID,
  };
  function setEnv(patch: Partial<typeof saved>) {
    Object.assign(env, patch);
  }
  afterEach(() => {
    setEnv(saved); // restore the hermetic (null) values so no cross-test leak
  });
  // N-OF-1 (adversary OFAC build review, 2026-07-23): activatePaidPlan below
  // now genuinely fail-CLOSES (screening_status='review') when NO SDN list is
  // loaded — this describe block's intent is activationState derivation
  // (billing/engine/InboxKit wiring), not screening, so seed a real,
  // non-matching list first so each tenant genuinely screens 'clear'.
  beforeEach(async () => {
    await seedBenignSdnList();
  });

  it("paid+active, NOTHING armed → pending_provisioning (silent-sandbox confident-wrong closed)", async () => {
    setEnv({ ENGINE_BASE_URL: undefined, ENGINE_AUTH_SECRET: undefined, INBOXKIT_API_KEY: undefined, INBOXKIT_WORKSPACE_ID: undefined });
    const { tenantId } = await mintTenant("G3 Pending Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const account = await accountOf(tenantId);
    expect(account.billingState).toBe("active");
    expect(account.activationState).toBe("pending_provisioning");
  });

  it("paid+active, ENGINE armed but INBOXKIT unbound → STILL pending_provisioning (adversary B2)", async () => {
    setEnv({ ENGINE_BASE_URL: "https://engine.example.internal", ENGINE_AUTH_SECRET: "s", INBOXKIT_API_KEY: undefined, INBOXKIT_WORKSPACE_ID: undefined });
    const { tenantId } = await mintTenant("G3 Engine-Only Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const account = await accountOf(tenantId);
    expect(account.activationState).toBe("pending_provisioning");
  });

  it("paid+active, BOTH engine AND InboxKit armed → active", async () => {
    setEnv({ ENGINE_BASE_URL: "https://engine.example.internal", ENGINE_AUTH_SECRET: "s", INBOXKIT_API_KEY: "k", INBOXKIT_WORKSPACE_ID: "w" });
    const { tenantId } = await mintTenant("G3 Fully Armed Co", "managed");
    await activatePaidPlan(tenantId, "managed");
    const account = await accountOf(tenantId);
    expect(account.activationState).toBe("active");
  });

  it("a demo tenant → sandbox", async () => {
    const { tenantId } = await mintTenant("G3 Demo Co", "demo");
    const account = await accountOf(tenantId);
    expect(account.activationState).toBe("sandbox");
  });
});
