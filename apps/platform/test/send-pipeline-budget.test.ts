import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  CRON_PERIOD_MS,
  runSendPipelineAllTenants,
  SEND_PIPELINE_LEG_DEADLINE_MS,
  SEND_PIPELINE_TENANT_BUDGET_MS,
} from "../src/admin/ops-sweep.js";
import { SEND_CLAIM_TTL_MS } from "../src/engine/tick.js";
import { ENGINE_REQUEST_TIMEOUT_MS } from "../src/vendors/real/email-port.js";

// WAVE 2 §5 — the leg's WALL-CLOCK behavior: budget, deadline, rotation.
//
// These drive `runSendPipelineAllTenants` against a synthetic tenant namespace
// rather than the cron body. That is deliberate and it is the only place in
// this wave's tests where the real entry point is not used: the production
// budget is 135 SECONDS, so a never-resolving RPC driven through
// `worker.scheduled()` would take over two minutes of suite time per case. The
// control flow under test here (race, deadline, modulo) is entirely
// independent of the values, and the values themselves are covered by the
// ladder assertions at the bottom of this file.

interface StubCall {
  tenantId: string;
  method: "poll" | "tick";
}

/**
 * A tenant namespace whose stubs record every call and can be made to stall or
 * throw per tenant. Shaped exactly like the two RPC methods the leg uses.
 */
function fakeEnv(
  tenantIds: string[],
  behavior: (tenantId: string) => "ok" | "stall" | "throw" = () => "ok",
): { env: Env; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const makeStub = (tenantId: string) => {
    const guard = async () => {
      const mode = behavior(tenantId);
      if (mode === "throw") throw new Error(`tenant ${tenantId} is wedged`);
      if (mode === "stall") await new Promise(() => {}); // never resolves — the abandoned-RPC case
    };
    return {
      async runScheduledPoll() {
        calls.push({ tenantId, method: "poll" });
        await guard();
        return { ran: true, reason: "", replies: 0, bounces: 0, complaints: 0 };
      },
      async runScheduledTick() {
        calls.push({ tenantId, method: "tick" });
        await guard();
        return { ran: true, reason: "", sent: 0, skipped: 0, deferred: 0 };
      },
    };
  };
  const env = {
    DB: {
      prepare: () => ({ all: async () => ({ results: tenantIds.map((id) => ({ id })) }) }),
    },
    TENANT: {
      idFromName: (name: string) => name,
      get: (name: string) => makeStub(name),
    },
  } as unknown as Env;
  return { env, calls };
}

const FAST = { tenantBudgetMs: 40, legDeadlineMs: 400 };

describe("send pipeline leg — per-tenant budget", () => {
  it("a stalled tenant is abandoned at its budget; every other tenant is still processed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, calls } = fakeEnv(["t1", "t2", "t3"], (id) => (id === "t1" ? "stall" : "ok"));
    const summary = await runSendPipelineAllTenants(env, 0, FAST);

    expect(summary.budgetExpiries).toBe(1);
    expect(summary.tenantsRan).toBe(2);
    expect(calls.filter((c) => c.tenantId === "t2")).toHaveLength(2); // poll AND tick
    expect(calls.filter((c) => c.tenantId === "t3")).toHaveLength(2);
    expect(warn.mock.calls.flat().join(" ")).toContain("t1");
    warn.mockRestore();
  });

  it("poll runs BEFORE tick for every tenant — a reply must land before we decide what to send", async () => {
    const { env, calls } = fakeEnv(["t1"], () => "ok");
    await runSendPipelineAllTenants(env, 0, FAST);
    expect(calls.map((c) => c.method)).toEqual(["poll", "tick"]);
  });

  it("one tenant's throw never aborts the leg", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fakeEnv(["t1", "t2"], (id) => (id === "t1" ? "throw" : "ok"));
    const summary = await runSendPipelineAllTenants(env, 0, FAST);
    expect(summary.errors).toBe(1);
    expect(calls.filter((c) => c.tenantId === "t2")).toHaveLength(2);
    err.mockRestore();
  });
});

describe("send pipeline leg — leg deadline", () => {
  it("stops between tenants once the deadline passes and reports how many it deferred", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Every tenant stalls, so each burns a whole 40ms budget; a 100ms leg
    // deadline admits ~2-3 of the 8 and defers the rest to a later cycle.
    const { env, calls } = fakeEnv(["a", "b", "c", "d", "e", "f", "g", "h"], () => "stall");
    const summary = await runSendPipelineAllTenants(env, 0, { tenantBudgetMs: 40, legDeadlineMs: 100 });

    expect(summary.skippedForLegDeadline).toBeGreaterThan(0);
    expect(summary.budgetExpiries).toBeGreaterThan(0);
    expect(summary.budgetExpiries + summary.skippedForLegDeadline).toBe(8);
    // "some tenants this cycle" — never "all of them, unboundedly".
    expect(new Set(calls.map((c) => c.tenantId)).size).toBeLessThan(8);
    warn.mockRestore();
  });
});

describe("send pipeline leg — rotation (R6)", () => {
  it("an empty tenant list is a clean no-op, not a NaN offset", async () => {
    const { env, calls } = fakeEnv([], () => "ok");
    const summary = await runSendPipelineAllTenants(env, Date.now(), FAST);
    expect(summary).toMatchObject({ tenantsScanned: 0, tenantsRan: 0, errors: 0, disabled: false });
    expect(calls).toEqual([]);
  });

  it("reaches EVERY tenant across successive cycles even when the head one always stalls", async () => {
    // The fairness property that matters. NOT strict +1 stepping: cron fire
    // times drift around the period boundary, so two consecutive cycles can
    // repeat or skip an offset (R6). Eventual coverage is the real guarantee,
    // and it is what a stalled head tenant would otherwise destroy — with a
    // fixed start offset, everyone behind it is starved on every single cycle.
    const tenantIds = ["a", "b", "c", "d", "e"];
    const seen = new Set<string>();
    for (let cycle = 0; cycle < tenantIds.length; cycle++) {
      const { env, calls } = fakeEnv(tenantIds, (id) => (id === "a" ? "stall" : "ok"));
      // One cycle's worth of wall clock per iteration, exactly as cron fires.
      await runSendPipelineAllTenants(env, cycle * CRON_PERIOD_MS, { tenantBudgetMs: 20, legDeadlineMs: 45 });
      for (const call of calls) seen.add(call.tenantId);
    }
    expect(seen).toEqual(new Set(tenantIds));
  });

  it("the start offset advances with the cycle, so the head of the queue moves", async () => {
    const tenantIds = ["a", "b", "c", "d", "e"];
    const heads: string[] = [];
    for (let cycle = 0; cycle < tenantIds.length; cycle++) {
      const { env, calls } = fakeEnv(tenantIds, () => "ok");
      await runSendPipelineAllTenants(env, cycle * CRON_PERIOD_MS, FAST);
      heads.push(calls[0]?.tenantId as string);
    }
    expect(new Set(heads).size).toBe(tenantIds.length);
  });
});

describe("send pipeline leg — the AUTOSEND_DISABLED kill switch", () => {
  it("returns disabled and touches no tenant at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env, calls } = fakeEnv(["t1", "t2"], () => "ok");
    (env as unknown as { AUTOSEND_DISABLED: string }).AUTOSEND_DISABLED = "1";
    const summary = await runSendPipelineAllTenants(env, 0, FAST);
    expect(summary.disabled).toBe(true);
    expect(calls).toEqual([]);
    warn.mockRestore();
  });
});

// --- R5: the ordering ladder ---------------------------------------------

describe("R5 — the send-pipeline timing ladder is internally coherent", () => {
  // The ORIGINAL R5 defect was a set of constants that each looked reasonable
  // alone and were incoherent together (a 60s per-tenant budget under a 180s
  // request timeout ⇒ every tenant abandoned having done zero work, on every
  // cycle, forever). A comment cannot prevent that recurring; these assertions
  // can. See vendors/real/email-port.ts for the prose version.

  /** apps/engine/src/smtp.ts: 20s connect + 20s greeting + 60s socket. */
  const ENGINE_WORST_CASE_SMTP_MS = 100_000;

  it("rung 1: the engine request timeout exceeds the engine's own worst-case SMTP transaction", () => {
    // This is the rung the adversary's suggested ~45s would have broken — it
    // would abort genuinely slow but SUCCEEDING sends.
    expect(ENGINE_REQUEST_TIMEOUT_MS).toBeGreaterThan(ENGINE_WORST_CASE_SMTP_MS);
  });

  it("rung 2: a tenant's budget fits at least ONE complete engine request", () => {
    expect(SEND_PIPELINE_TENANT_BUDGET_MS).toBeGreaterThan(ENGINE_REQUEST_TIMEOUT_MS);
  });

  it("rung 3: the leg deadline can accommodate one whole tenant budget", () => {
    expect(SEND_PIPELINE_LEG_DEADLINE_MS).toBeGreaterThanOrEqual(SEND_PIPELINE_TENANT_BUDGET_MS);
  });

  it("rung 4: the leg's true worst case (deadline + one budget) stays inside the cron period", () => {
    // The deadline is checked BETWEEN tenants, so a tenant admitted just under
    // it can still run a full budget past it.
    expect(SEND_PIPELINE_LEG_DEADLINE_MS + SEND_PIPELINE_TENANT_BUDGET_MS).toBeLessThan(CRON_PERIOD_MS);
  });

  it("rung 5: a send resolves or aborts BEFORE its row is reclaim-eligible", () => {
    expect(ENGINE_REQUEST_TIMEOUT_MS).toBeLessThan(SEND_CLAIM_TTL_MS);
  });
});
