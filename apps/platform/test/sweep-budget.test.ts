/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import recoverySource from "../src/ofac/screening-recovery.ts?raw";
import reaperSource from "../src/engine/spend-ceiling.ts?raw";
import budgetSource from "../src/admin/sweep-budget.ts?raw";
import scheduledSource from "../src/scheduled.ts?raw";
import {
  ASSUMED_DO_RPC_MS,
  coverageTicks,
  effectiveConcurrency,
  SWEEP_FANOUT_CONCURRENCY,
  SWEEP_MEAN_COMPLETION_FRACTION,
  sweepTenantSliceFor,
  CRON_PERIOD_MS,
  SEND_PIPELINE_LEG_DEADLINE_MS,
  SEND_PIPELINE_TENANT_BUDGET_MS,
  SWEEP_BUDGET_FRACTION,
  SWEEP_FANOUT_DEADLINE_MS,
  SWEEP_FANOUT_RPCS_PER_TENANT,
  LEG_SUBREQUEST_COSTS,
  MEASURED_DO_RPC_MS,
  RESERVE_REAP_BATCH,
  RESERVE_REAP_SUBREQUESTS,
  RESERVE_REAP_SUBREQUESTS_PER_ITEM,
  SCREENING_RECOVERY_BATCH,
  SCREENING_RECOVERY_SUBREQUESTS,
  SCREENING_RECOVERY_SUBREQUESTS_PER_ITEM,
  SWEEP_FIXED_OVERHEAD_SUBREQUESTS,
  SWEEP_FIXED_SUBREQUESTS,
  SWEEP_RPCS_PER_TENANT,
  SWEEP_SUBREQUEST_BUDGET,
  SWEEP_TENANT_SLICE,
  SWEEP_TICK_SUBREQUESTS,
} from "../src/admin/sweep-budget.js";

/** The keys of `scheduled.ts`'s own `const legs = { ... }` bag — the SCHEDULER
 * as the source of truth for what legs exist, independent of what the budget
 * file believes. Same reader shape as sweep-signal-coverage.test.ts. */
function legBagKeys(source: string): string[] {
  const block = source.match(/const legs = \{([\s\S]*?)\n {2}\};/)?.[1];
  if (!block) throw new Error("could not find the `const legs = {...}` bag in scheduled.ts");
  return [...block.matchAll(/^\s{4}([a-zA-Z0-9_]+)[,:]/gm)].map((m) => m[1]!);
}

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
    //
    // DIVIDED BY THE EFFECTIVE CONCURRENCY since 2026-08-24: the round trips
    // overlap now, so the SEQUENTIAL sum is no longer the wall clock the leg
    // spends. The divisor is the MEASURED one (`1 + (C-1) x 0.70`), not `C` —
    // using `C` here would make this guard agree with a slice that the deadline
    // cannot actually sustain, which is the whole failure mode
    // SWEEP_CONCURRENCY_EFFICIENCY exists to prevent.
    const fanoutWorstCaseMs =
      (SWEEP_TENANT_SLICE * SWEEP_FANOUT_RPCS_PER_TENANT * ASSUMED_DO_RPC_MS) / effectiveConcurrency(SWEEP_FANOUT_CONCURRENCY);
    expect(fanoutWorstCaseMs).toBeLessThanOrEqual(SWEEP_FANOUT_DEADLINE_MS);
  });

  it("...and it still binds SERIALLY, so a rollback to concurrency 1 is also in budget", () => {
    // SWEEP_FANOUT_CONCURRENCY=1 is the documented rollback lever. If the slice
    // it derives did not fit the deadline serially, the lever would be a trap.
    const serialSlice = sweepTenantSliceFor(1);
    expect(serialSlice * SWEEP_FANOUT_RPCS_PER_TENANT * ASSUMED_DO_RPC_MS).toBeLessThanOrEqual(SWEEP_FANOUT_DEADLINE_MS);
  });
});

// CALIBRATION (live-signal fix 2026-08-20). The test above is REAL but it cannot
// catch the defect that actually shipped: it checks the slice against the
// ASSUMPTION, and the assumption was wrong by 16x. `A <= A` in different units.
//
// `ASSUMED_DO_RPC_MS = 25` was an in-process miniflare floor, honestly labelled
// as an assumption and never re-measured against production. At 63 real tenants
// it sized the slice at 37 while the 15s deadline afforded 3, so the trailing
// fan-out legs abandoned 36 of every 37-tenant slice, the rotation cursor
// advanced ONE tenant per tick, and `sweep_coverage` alerted the founder with a
// coverage figure ("a full pass every 2 tick(s) (~10 min)") that was 31x
// optimistic — the reassuring number was inside the alert that exists to say
// detection latency has degraded.
//
// THE ORACLE HERE IS THE MEASUREMENT, which is not derived from any constant in
// the source: `MEASURED_DO_RPC_MS` is a captured production distribution
// (provenance in its docstring). That makes these guards capable of failing —
// re-introducing 25 reds them, and so does a future latency regression once
// somebody re-measures.
describe("the slice is calibrated against MEASURED production latency, not an assumption", () => {
  it("the assumption is not below the measured p75 — a budget takes the worst case", () => {
    expect(
      ASSUMED_DO_RPC_MS,
      "ASSUMED_DO_RPC_MS is below the measured p75 DO RPC round trip. The slice it derives will not fit the " +
        "fan-out deadline at real latency: the trailing legs abandon most of every slice, the rotation cursor " +
        "advances by the LEAST-covered leg, and the published coverage figure becomes fiction.",
    ).toBeGreaterThanOrEqual(MEASURED_DO_RPC_MS.p75Ms);
  });

  it("the shipped slice COMPLETES at the measured mean, with headroom — not merely at the assumption", () => {
    // The expected cost of the fan-out is `rpcs x slice x measured MEAN`,
    // divided by the effective concurrency. A slice whose expected cost merely
    // touches the deadline clips its last leg on about half of all ticks, which
    // puts the published coverage number back into the optimistic-by-default
    // state the 2026-08-20 calibration removed.
    //
    // ⚠️ THIS ASSERTION IS NOW TRUE BY CONSTRUCTION, and saying so is the point.
    // Until 2026-08-24 the 0.85 rule lived ONLY here, and the derivation
    // satisfied it by rounding luck: the p75-derived slice costs `mean/p75 =
    // 0.92` of the deadline in expectation, and `floor()` happened to pull the
    // serial slice of 3 down to 0.75. At any larger slice that luck runs out —
    // it is exactly what reddened when concurrency raised the slice. The rule
    // is now the THIRD ceiling inside `sweepTenantSliceFor`, so it holds at
    // every concurrency instead of at one.
    //
    // What replaces the independence this assertion lost: the SIMULATION in
    // test/sweepcap-experiment/sweepcap.test.ts, which asserts
    // `sweepTenantSliceFor(C) <= the slice a fitted-latency model can actually
    // finish` at every C. That oracle is not derived from any constant here.
    const expectedMs =
      (SWEEP_TENANT_SLICE * SWEEP_FANOUT_RPCS_PER_TENANT * MEASURED_DO_RPC_MS.meanMs) / effectiveConcurrency(SWEEP_FANOUT_CONCURRENCY);
    expect(
      expectedMs,
      `at the measured mean the fan-out needs ${expectedMs}ms of the ${SWEEP_FANOUT_DEADLINE_MS}ms deadline`,
    ).toBeLessThanOrEqual(SWEEP_FANOUT_DEADLINE_MS * SWEEP_MEAN_COMPLETION_FRACTION);
  });

  it("the completion ceiling is what BINDS the slice — not a formality riding along behind p75", () => {
    // If p75 were the binding arm, the mean-completion rule would be satisfied
    // incidentally and could be deleted without reddening anything. Asserting
    // WHICH arm binds keeps the constant load-bearing.
    const effective = effectiveConcurrency(SWEEP_FANOUT_CONCURRENCY);
    const p75Arm = Math.floor((SWEEP_FANOUT_DEADLINE_MS * effective) / (ASSUMED_DO_RPC_MS * SWEEP_FANOUT_RPCS_PER_TENANT));
    const meanArm = Math.floor(
      (SWEEP_FANOUT_DEADLINE_MS * SWEEP_MEAN_COMPLETION_FRACTION * effective) / (MEASURED_DO_RPC_MS.meanMs * SWEEP_FANOUT_RPCS_PER_TENANT),
    );
    expect(SWEEP_TENANT_SLICE).toBe(Math.min(p75Arm, meanArm));
    expect(meanArm).toBeLessThanOrEqual(p75Arm);
  });

  it("the measurement records its own provenance, so the next re-calibration can date it", () => {
    // A bare number would be indistinguishable from the guess it replaced.
    expect(MEASURED_DO_RPC_MS.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MEASURED_DO_RPC_MS.samples).toBeGreaterThan(0);
    expect(MEASURED_DO_RPC_MS.p75Ms).toBeGreaterThanOrEqual(MEASURED_DO_RPC_MS.meanMs * 0.5);
  });
});

// B1 (docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md) — the
// budget's own accounting had a hole in it, and the hole was on the mechanism
// the wave exists to protect.
//
// `SWEEP_FIXED_SUBREQUESTS = 60`'s docstring claimed to cover "the
// screening-recovery leg (bounded by the pending-review queue, not by tenant
// count)". The other lane had capped that leg at 500 items costing two
// subrequests each — 1,000 subrequests, unmodelled, against a budget of 1,000:
//
//   worst case: 599 (full slice) + 500 × 2 = 1,599
//   break-even: (1000 − 599) / 2 ≈ 200 stuck tenants, i.e. the cap was 2.5× over
//
// Past the cap `runLeg` swallows the throw and every leg after it dies silently
// — including the dead-man heartbeat, which then pages "cron STOPPED" about a
// cron that is running. "Bounded by a population that is not the tenant count"
// is not the same as "small", and a docstring is not an accounting.
describe("B1 — every leg with its own fan-out is IN the derivation, not waved through in prose", () => {
  // NEW-2 (gate round 2): the assertion that used to live here was
  // `SWEEP_FIXED_SUBREQUESTS === OVERHEAD + SCREENING_RECOVERY_SUBREQUESTS`
  // while the source DEFINED it as exactly that sum — `A === A`, incapable of
  // failing. The gate planted the precise defect its comment claimed to catch
  // (a new 300 x 3 fan-out leg declared in the budget file, not summed in) and
  // the suite stayed green 13/13.
  //
  // Two ORACLES replace it, neither of which is the thing it checks:
  //
  //  (1) the SCHEDULER's own leg bag vs the per-leg cost table, with the
  //      columns summing to the two derived constants — three sources that all
  //      have to agree;
  //  (2) the budget file's SOURCE TEXT: every declared `*_SUBREQUESTS` term
  //      must literally appear as an operand of the aggregate, which is what
  //      catches a term that is declared and then not added.

  it("every leg the scheduler actually runs has a declared cost", () => {
    const uncosted = legBagKeys(scheduledSource).filter((name) => !(name in LEG_SUBREQUEST_COSTS));
    expect(
      uncosted,
      "a cron leg exists that the budget does not price. If it fans out over the tenant slice give it a " +
        "`perTenant` cost; if it fans out over a population of its OWN (the screening-recovery reviews, the " +
        "stale-reserve entries) it needs a declared batch, an `ownFanout` term, and to run through sweepTenants — " +
        "that is B1 and NEW-1, both of which reached production-shaped code as an unpriced leg.",
    ).toEqual([]);
  });

  it("prices no leg the scheduler does not run", () => {
    const legs = new Set(legBagKeys(scheduledSource));
    const orphaned = Object.keys(LEG_SUBREQUEST_COSTS).filter((name) => !legs.has(name));
    expect(orphaned, "LEG_SUBREQUEST_COSTS prices a leg scheduled.ts no longer runs — delete it (CLAUDE.md rule a)").toEqual([]);
  });

  it("the per-leg costs SUM to the two derived constants — the oracle the tautology was missing", () => {
    const perTenant = Object.values(LEG_SUBREQUEST_COSTS).reduce((n, leg) => n + leg.perTenant, 0);
    const ownFanout = Object.values(LEG_SUBREQUEST_COSTS).reduce((n, leg) => n + leg.ownFanout, 0);
    expect(perTenant, "the per-leg RPC costs no longer add up to SWEEP_RPCS_PER_TENANT").toBe(SWEEP_RPCS_PER_TENANT);
    expect(
      ownFanout,
      "a leg's own fan-out is priced in LEG_SUBREQUEST_COSTS but not summed into SWEEP_FIXED_SUBREQUESTS " +
        "(or vice versa) — the slice is being derived from a number that does not describe the tick",
    ).toBe(SWEEP_FIXED_SUBREQUESTS - SWEEP_FIXED_OVERHEAD_SUBREQUESTS);
  });

  it("every declared subrequest term is an OPERAND of the aggregate, read from the source", () => {
    // The oracle for the gate's exact plant: a `*_SUBREQUESTS` constant can be
    // declared in the budget file and simply never added. Comparing computed
    // values cannot see that; comparing the DEFINITION TEXT can.
    const aggregate = budgetSource.match(/export const SWEEP_FIXED_SUBREQUESTS\s*=([\s\S]*?);/)?.[1];
    expect(aggregate, "could not find SWEEP_FIXED_SUBREQUESTS' definition — this guard would be vacuous").toBeTruthy();

    const declared = [...budgetSource.matchAll(/^export const ([A-Z_0-9]*_SUBREQUESTS) =/gm)].map((m) => m[1]!);
    const aggregates = new Set(["SWEEP_FIXED_SUBREQUESTS", "SWEEP_TICK_SUBREQUESTS", "SWEEP_SUBREQUEST_BUDGET"]);
    const unsummed = declared.filter((name) => !aggregates.has(name) && !aggregate!.includes(name));
    expect(
      unsummed,
      "a per-leg subrequest term is declared in sweep-budget.ts and never added to SWEEP_FIXED_SUBREQUESTS. " +
        "The slice is derived by SUBTRACTING that aggregate from the budget, so an unsummed term is spend the " +
        "tick makes and the arithmetic does not know about — which is exactly how the dead-man heartbeat " +
        "vanished (B1) and how the stale-reserve reaper spent ~901 subrequests ahead of it (NEW-1).",
    ).toEqual([]);
  });

  it("the screening-recovery leg's worst case is derived from its batch, not chosen separately", () => {
    expect(SCREENING_RECOVERY_SUBREQUESTS).toBe(SCREENING_RECOVERY_BATCH * SCREENING_RECOVERY_SUBREQUESTS_PER_ITEM);
  });

  it("a FULL slice plus EVERY leg's own fan-out still fits the budget — the arithmetic B1 broke", () => {
    // Restated from the parts rather than read off the aggregate, so this stays
    // an independent statement of the same claim.
    const worstCaseTick =
      SWEEP_RPCS_PER_TENANT * SWEEP_TENANT_SLICE +
      SWEEP_FIXED_OVERHEAD_SUBREQUESTS +
      SCREENING_RECOVERY_SUBREQUESTS +
      RESERVE_REAP_SUBREQUESTS;
    expect(worstCaseTick).toBe(SWEEP_TICK_SUBREQUESTS);
    expect(worstCaseTick).toBeLessThanOrEqual(SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION);
    // And the tail — the heartbeat, the alert sends, the per-check writes — is
    // what is left. B1 is precisely the case where this went negative.
    expect(SWEEP_SUBREQUEST_BUDGET - worstCaseTick).toBeGreaterThan(0);
  });

  it("the OLD batch would NOT have fitted — the break-even the gate derived, as a bound", () => {
    // Kept executable rather than narrated: at 2 subrequests an item, the tail
    // reserve buys ~200 items, and the retired cap was 500.
    //
    // AGAINST THE BUDGET B1 WAS DERIVED UNDER (1,000), pinned as a literal
    // rather than read from the live constant. `SWEEP_SUBREQUEST_BUDGET` was
    // corrected to the real Workers-Paid 10,000 on 2026-08-24, and reading the
    // live value here would silently turn a HISTORICAL claim into a false
    // present-tense one — the 500-item batch fits comfortably under 10,000, so
    // the assertion would have to be deleted rather than restated. The history
    // is what makes SCREENING_RECOVERY_BATCH's size legible, so it stays.
    const B1_ERA_BUDGET = 1_000;
    const tailReserve = B1_ERA_BUDGET - SWEEP_TICK_SUBREQUESTS + SCREENING_RECOVERY_SUBREQUESTS;
    const breakEvenItems = Math.floor(tailReserve / SCREENING_RECOVERY_SUBREQUESTS_PER_ITEM);
    expect(SCREENING_RECOVERY_BATCH).toBeLessThanOrEqual(breakEvenItems);
    expect(500).toBeGreaterThan(breakEvenItems);
  });

  it("the budget is the PAID per-invocation ceiling, not the Free plan's internal-services row", () => {
    // The correction of 2026-08-24. 1,000 was never a conservative reading of
    // the Paid limit — it is the Free plan's row, i.e. a DIFFERENT plan's
    // number wearing an "UNVERIFIED" label. Pinned so a future "let's be
    // careful" edit cannot quietly reinstate a limit that is not the limit.
    expect(SWEEP_SUBREQUEST_BUDGET).toBe(10_000);
  });

  it("the stale-reserve reaper is bounded and priced too (NEW-1 — B1's class, one leg over)", () => {
    expect(RESERVE_REAP_SUBREQUESTS).toBe(RESERVE_REAP_BATCH * RESERVE_REAP_SUBREQUESTS_PER_ITEM);
    // It reads a bounded page and runs through the shared primitive with the
    // tick's deadline — the same two properties B1's fix gave the other leg.
    expect(reaperSource).toContain("RESERVE_REAP_BATCH");
    expect(reaperSource).toContain("LIMIT ?");
    expect(reaperSource).toContain("sweepDeadlineOf(");
    expect(
      reaperSource,
      "the reaper's SELECT lost its bound — it spent ~901 subrequests on 300 orphans, ahead of the heartbeat",
    ).not.toMatch(/WHERE status = 'reserved' AND created_at < \?\s*`/);
  });

  it("the leg takes its cap FROM the budget file — the two lanes cannot re-diverge", () => {
    // B1's root cause was one lane sizing the budget and the other sizing the
    // leg, in different files, each internally consistent. A local numeric cap
    // here is that mistake reappearing.
    expect(recoverySource).toContain("SCREENING_RECOVERY_BATCH");
    expect(recoverySource, "the recovery leg re-declared its own batch cap instead of importing the budget's").not.toMatch(
      /const\s+RECOVERY_BATCH_LIMIT\s*=/,
    );
    // ...and it runs through the shared primitive, so the tick's fan-out
    // deadline bounds it in wall clock as well as in count.
    expect(recoverySource).toContain("sweepTenants(");
    expect(recoverySource).toContain("sweepDeadlineOf(");
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

  it("the OLD shape crossed a budget at all — unbounded is the property that changed, not the crossing point", () => {
    // Measured on the real sweep at 5/20/50/100/200 seeded tenants: the slope
    // was exactly 8.0 DO RPCs per tenant, subrequests(N) ~= 8N + 29. Kept as an
    // executable statement of what changed, so "bounded" is a comparison rather
    // than an adjective.
    const oldShape = (n: number) => 8 * n + 29;

    // The audit's headline number, against the budget the audit believed in.
    const AUDIT_ERA_BUDGET = 1_000;
    expect(oldShape(122)).toBeGreaterThan(AUDIT_ERA_BUDGET);
    expect(oldShape(121)).toBeLessThan(AUDIT_ERA_BUDGET);

    // And against the VERIFIED budget, which moves the cliff without removing
    // it — the correction bought ~10x the runway and changed nothing about the
    // shape. This is the part that must keep holding as the budget is
    // re-verified: O(N) always crosses SOME ceiling.
    const crossesAt = Math.ceil((SWEEP_SUBREQUEST_BUDGET - 29) / 8);
    expect(oldShape(crossesAt)).toBeGreaterThanOrEqual(SWEEP_SUBREQUEST_BUDGET);
    expect(crossesAt).toBeLessThan(2_000);

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
