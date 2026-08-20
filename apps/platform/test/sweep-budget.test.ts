import { describe, expect, it } from "vitest";
import {
  ASSUMED_DO_RPC_MS,
  coverageTicks,
  CRON_PERIOD_MS,
  SEND_PIPELINE_LEG_DEADLINE_MS,
  SEND_PIPELINE_TENANT_BUDGET_MS,
  SWEEP_BUDGET_FRACTION,
  SWEEP_FANOUT_DEADLINE_MS,
  SWEEP_FANOUT_RPCS_PER_TENANT,
  SWEEP_FIXED_SUBREQUESTS,
  SWEEP_RPCS_PER_TENANT,
  SWEEP_SUBREQUEST_BUDGET,
  SWEEP_TENANT_SLICE,
  SWEEP_TICK_SUBREQUESTS,
} from "../src/admin/sweep-budget.js";

// SCALE AUDIT S1 + S6 — the arithmetic that bounds one cron tick.
//
// S6 was a comment claiming an invariant it did not enforce: "150s + 135s =
// 285s, under the 300s cron period, which is what keeps a wedged engine from
// making every sweep overlap the next" — silently assuming the SIX per-tenant
// legs that run BEFORE the send pipeline cost zero wall clock. None of them
// carried a deadline, a budget or a cursor. Measured in-process with zero
// network at 200 tenants the pre-pipeline legs alone took 4533ms, and at 500
// tenants against real DO hops the audit put the true worst case at 360-435s
// against a 300s period.
//
// The fix is not a bigger comment. `SWEEP_FANOUT_DEADLINE_MS` is DERIVED from
// the period minus the pipeline's own two published bounds, so the invariant
// holds by construction and the moment someone raises one of those constants
// past the period this file goes red instead of production going quiet.

describe("S6 — the cron period is fully accounted for, by construction", () => {
  it("the fan-out deadline is exactly the period the send pipeline does not claim", () => {
    expect(SWEEP_FANOUT_DEADLINE_MS + SEND_PIPELINE_LEG_DEADLINE_MS + SEND_PIPELINE_TENANT_BUDGET_MS).toBe(CRON_PERIOD_MS);
  });

  it("leaves the fan-out a POSITIVE budget — a non-positive one means the pipeline's bounds already overrun the period", () => {
    expect(SWEEP_FANOUT_DEADLINE_MS).toBeGreaterThan(0);
  });

  it("every per-tenant leg is bounded, so no term in that sum is a guess about N", () => {
    // The wall-clock ceiling the fan-out can actually meet at the shipped slice,
    // under the stated per-RPC assumption. This is the number the old comment
    // assumed was zero.
    const fanoutWorstCaseMs = SWEEP_TENANT_SLICE * SWEEP_FANOUT_RPCS_PER_TENANT * ASSUMED_DO_RPC_MS;
    expect(fanoutWorstCaseMs).toBeLessThanOrEqual(SWEEP_FANOUT_DEADLINE_MS);
  });
});

describe("S1 — one tick's subrequest cost is a constant, with headroom for the next leg", () => {
  it("fits the declared budget at a full slice", () => {
    expect(SWEEP_TICK_SUBREQUESTS).toBe(SWEEP_RPCS_PER_TENANT * SWEEP_TENANT_SLICE + SWEEP_FIXED_SUBREQUESTS);
    expect(SWEEP_TICK_SUBREQUESTS).toBeLessThanOrEqual(SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION);
  });

  it("still fits with TWO more O(N) legs than exist today", () => {
    // The audit's specific warning: arming PROVISIONING_RECONCILE_ENABLED adds a
    // seventh O(N) leg and moves the old ceiling from ~122 tenants down to ~110.
    // That leg is already counted in SWEEP_RPCS_PER_TENANT; this is the margin
    // for the two after it.
    const withTwoMoreLegs = (SWEEP_RPCS_PER_TENANT + 2) * SWEEP_TENANT_SLICE + SWEEP_FIXED_SUBREQUESTS;
    expect(withTwoMoreLegs).toBeLessThanOrEqual(SWEEP_SUBREQUEST_BUDGET);
  });

  it("the OLD shape crossed the same budget at ~122 tenants — the number this replaces", () => {
    // Measured on the real sweep at 5/20/50/100/200 seeded tenants: the slope
    // was exactly 8.0 DO RPCs per tenant, subrequests(N) ~= 8N + 29. Kept as an
    // executable statement of what changed, so "bounded" is a comparison rather
    // than an adjective.
    const oldShape = (n: number) => 8 * n + 29;
    expect(oldShape(122)).toBeGreaterThan(SWEEP_SUBREQUEST_BUDGET);
    expect(oldShape(121)).toBeLessThan(SWEEP_SUBREQUEST_BUDGET);
    // The new shape does not depend on N at all: 10x the tenants, same cost.
    expect(SWEEP_TICK_SUBREQUESTS).toBe(SWEEP_RPCS_PER_TENANT * SWEEP_TENANT_SLICE + SWEEP_FIXED_SUBREQUESTS);
  });
});

describe("coverage — the price of the bound, stated in ticks", () => {
  it("is the ceiling of tenants over slice", () => {
    expect(coverageTicks(0, 10)).toBe(0);
    expect(coverageTicks(10, 10)).toBe(1);
    expect(coverageTicks(11, 10)).toBe(2);
    expect(coverageTicks(500, SWEEP_TENANT_SLICE)).toBe(Math.ceil(500 / SWEEP_TENANT_SLICE));
  });

  it("a zero or negative slice reports 0 rather than Infinity", () => {
    expect(coverageTicks(500, 0)).toBe(0);
  });
});
