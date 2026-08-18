import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";
import {
  DEFAULT_WALLET_FLOOR_CREDITS,
  evaluateVendorChecks,
  VENDOR_WALLET_CHECK,
  WARMUP_DUPLICATES_CHECK,
} from "../src/admin/watchtower-vendor.js";
import { IK_API_KEY, IK_WARMUP_LIST_ACTIVE, IK_WARMUP_LIST_EMPTY, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// Item 1 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class B) —
// the vendor's prepaid credit wallet was a resource no code path read, modeled
// or could express. `fetch` is stubbed (never a real network call), same
// pattern as test/real-mailbox-port.test.ts.

const CONFIGURED_ENV = { ...env, INBOXKIT_API_KEY: IK_API_KEY, INBOXKIT_WORKSPACE_ID: IK_WORKSPACE_ID } as unknown as Env;

// GET /billing/wallet — the LIVE snake_case shape captured in the class-sweep
// canon (Finding 6): {credits_remaining, auto_topup_enabled, ...}, NOT the
// camelCase the original fix sketch guessed. A reader keyed on the wrong
// field names must fail LOUD, not silently read `undefined < floor` as false.
function walletBody(overrides: Record<string, unknown> = {}) {
  return {
    error: false,
    message: "Wallet Details",
    total_credits: 91,
    credits_used: 35,
    credits_remaining: 56,
    auto_topup_enabled: true,
    auto_topup_mode: "threshold",
    auto_topup_trigger_drops_below: 10,
    auto_topup_add_credits: 25,
    ...overrides,
  };
}

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const res of responses) {
    spy.mockImplementationOnce(
      async () => new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } }),
    );
  }
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("evaluateVendorChecks — dark until InboxKit is configured", () => {
  it("returns [] and calls fetch ZERO times with no INBOXKIT_* env (deployed default / every test env)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const results = await evaluateVendorChecks(env);
    expect(results).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("vendor_wallet — account-wide InboxKit credit balance check", () => {
  it("healthy when credits_remaining is comfortably above the floor", async () => {
    stubFetchSequence([{ status: 200, body: walletBody({ credits_remaining: 56 }) }, { status: 200, body: IK_WARMUP_LIST_EMPTY }]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    expect(wallet.healthy).toBe(true);
  });

  it(`unhealthy when credits_remaining is below the default floor (${DEFAULT_WALLET_FLOOR_CREDITS})`, async () => {
    stubFetchSequence([
      { status: 200, body: walletBody({ credits_remaining: DEFAULT_WALLET_FLOOR_CREDITS - 1, auto_topup_enabled: true }) },
      { status: 200, body: IK_WARMUP_LIST_EMPTY },
    ]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    expect(wallet.healthy).toBe(false);
    if (!wallet.healthy) expect(wallet.detail).toContain(String(DEFAULT_WALLET_FLOOR_CREDITS - 1));
  });

  it("unhealthy below the floor even with auto-topup ON — the balance itself is the alarm, not just an unrecoverable one", async () => {
    stubFetchSequence([
      { status: 200, body: walletBody({ credits_remaining: 3, auto_topup_enabled: true }) },
      { status: 200, body: IK_WARMUP_LIST_EMPTY },
    ]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    expect(wallet.healthy).toBe(false);
  });

  it("respects an env-tunable WALLET_FLOOR_CREDITS", async () => {
    const highFloorEnv = { ...CONFIGURED_ENV, WALLET_FLOOR_CREDITS: "100" } as unknown as Env;
    stubFetchSequence([{ status: 200, body: walletBody({ credits_remaining: 56 }) }, { status: 200, body: IK_WARMUP_LIST_EMPTY }]);
    const results = await evaluateVendorChecks(highFloorEnv);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    // 56 credits, floor raised to 100 -> unhealthy, though the DEFAULT floor would read it healthy.
    expect(wallet.healthy).toBe(false);
  });

  it("FAILS LOUD (unhealthy) on a camelCase-shaped body — the exact trap the canon records, never silently healthy", async () => {
    // A body with the WRONG field names (what the original fix sketch guessed):
    // `credits_remaining` is undefined, so `undefined < floor` is false — a
    // naive reader would report this healthy forever.
    stubFetchSequence([
      { status: 200, body: { error: false, message: "ok", creditsRemaining: 56, autoTopupEnabled: true } },
      { status: 200, body: IK_WARMUP_LIST_EMPTY },
    ]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    expect(wallet.healthy).toBe(false);
    if (!wallet.healthy) expect(wallet.detail.toLowerCase()).toMatch(/shape|unexpected|malformed|unparseable/);
  });

  it("FAILS LOUD when credits_remaining is present but not a number", async () => {
    stubFetchSequence([
      { status: 200, body: walletBody({ credits_remaining: "fifty-six" }) },
      { status: 200, body: IK_WARMUP_LIST_EMPTY },
    ]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    expect(wallet.healthy).toBe(false);
  });

  it("unhealthy (never throws out) when the vendor call itself fails", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connect timeout"));
    spy.mockImplementationOnce(async () => new Response(JSON.stringify(IK_WARMUP_LIST_EMPTY), { status: 200 }));
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const wallet = results.find((r) => r.name === VENDOR_WALLET_CHECK)!;
    expect(wallet.healthy).toBe(false);
  });
});

describe("warmup_duplicates — same mailbox uid subscribed to warmup twice", () => {
  it("healthy with zero duplicate active subscriptions", async () => {
    stubFetchSequence([{ status: 200, body: walletBody() }, { status: 200, body: IK_WARMUP_LIST_ACTIVE }]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const dup = results.find((r) => r.name === WARMUP_DUPLICATES_CHECK)!;
    expect(dup.healthy).toBe(true);
  });

  it("unhealthy when the SAME mailbox uid appears in two active warmup subscriptions", async () => {
    const duplicated = {
      ...IK_WARMUP_LIST_ACTIVE,
      subscriptions: [
        IK_WARMUP_LIST_ACTIVE.subscriptions[0],
        { ...IK_WARMUP_LIST_ACTIVE.subscriptions[0], uid: "warm-duplicate-0000-0000-0000-000000000000" },
      ],
      total: 2,
    };
    stubFetchSequence([{ status: 200, body: walletBody() }, { status: 200, body: duplicated }]);
    const results = await evaluateVendorChecks(CONFIGURED_ENV);
    const dup = results.find((r) => r.name === WARMUP_DUPLICATES_CHECK)!;
    expect(dup.healthy).toBe(false);
    if (!dup.healthy) expect(dup.detail).toContain("john.doe@example-lookalike.com");
  });
});
