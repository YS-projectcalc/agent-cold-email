// EXPERIMENT-ONLY (sweep-capacity lane, 2026-08-24). Measurement harness for
// the sweep-calibration gate's finding 6: can bounded-concurrency fan-out
// inside the existing 5-minute cron tick bring `sweep_coverage` healthy?
//
// Findings doc: docs/research/sweep-capacity-measurement-2026-08-24.md.
// Nothing here is imported by src/. This file makes NO production change.

import { describe, expect, it } from "vitest";
import {
  ASSUMED_DO_RPC_MS,
  coverageTicks,
  LEG_SUBREQUEST_COSTS,
  MEASURED_DO_RPC_MS,
  SWEEP_BUDGET_FRACTION,
  SWEEP_FANOUT_DEADLINE_MS,
  SWEEP_FANOUT_RPCS_PER_TENANT,
  SWEEP_FIXED_SUBREQUESTS,
  SWEEP_RPCS_PER_TENANT,
  SWEEP_SUBREQUEST_BUDGET,
  SWEEP_TENANT_SLICE,
} from "../../src/admin/sweep-budget.js";
import { COVERAGE_TICKS_ALERT_AFTER } from "../../src/admin/sweep-signals.js";
import { newSweepFanout, sweepTenants } from "../../src/admin/tenant-slice.js";
import { derivedSlice, mulberry32, sampleDoRpcMs, summarize } from "./latency-model.js";
import { simulateTick, type LegSpec } from "./tick-model.js";
import { sweepTenantsConcurrentCandidate } from "./concurrent-candidate.js";

/** The fan-out legs, DERIVED from the shipped cost table rather than retyped —
 * if a leg is added there this harness picks it up instead of going stale. */
const FANOUT_LEGS: LegSpec[] = Object.entries(LEG_SUBREQUEST_COSTS)
  .filter(([name, c]) => c.perTenant > 0 && name !== "sendPipeline")
  .map(([name, c]) => ({ name, rpcsPerTenant: c.perTenant }));

const TRIALS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Cell {
  concurrency: number;
  slice: number;
  wallP50: number;
  wallP95: number;
  completedPct: number;
  advanceP50: number;
  advanceP05: number;
}

function runCell(concurrency: number, slice: number, seed: number): Cell {
  const rng = mulberry32(seed);
  const wall: number[] = [];
  const advance: number[] = [];
  let completed = 0;
  for (let t = 0; t < TRIALS; t++) {
    const out = simulateTick({
      legs: FANOUT_LEGS,
      sliceSize: slice,
      concurrency,
      deadlineMs: SWEEP_FANOUT_DEADLINE_MS,
      rng,
      sampleMs: sampleDoRpcMs,
    });
    wall.push(out.wallMs);
    advance.push(out.leastPrefix);
    if (out.leastPrefix >= slice) completed++;
  }
  const w = [...wall].sort((a, b) => a - b);
  const a = [...advance].sort((x, y) => x - y);
  return {
    concurrency,
    slice,
    wallP50: Math.round(w[Math.floor(0.5 * (w.length - 1))] as number),
    wallP95: Math.round(w[Math.floor(0.95 * (w.length - 1))] as number),
    completedPct: Math.round((completed / TRIALS) * 1000) / 10,
    advanceP50: a[Math.floor(0.5 * (a.length - 1))] as number,
    advanceP05: a[Math.floor(0.05 * (a.length - 1))] as number,
  };
}

/** The largest slice at which >=95% of ticks cover the WHOLE slice. */
function maxSustainableSlice(concurrency: number, seed: number): { slice: number; cell: Cell } {
  let best = { slice: 1, cell: runCell(concurrency, 1, seed) };
  for (let L = 1; L <= 80; L++) {
    const cell = runCell(concurrency, L, seed + L);
    if (cell.completedPct >= 95) best = { slice: L, cell };
    else break;
  }
  return best;
}

/** What the shipped `sweep_coverage` check would grade, given an achieved advance. */
function shippedRotationTicks(total: number, advance: number, handed: number, allowed: number): number {
  const clipped = advance < handed;
  return coverageTicks(total, clipped ? advance : allowed);
}

describe("sweepcap: the latency fixture reproduces its production source", () => {
  it("re-derives MEASURED_DO_RPC_MS from 200k draws", () => {
    const rng = mulberry32(1);
    const samples = Array.from({ length: 200_000 }, () => sampleDoRpcMs(rng));
    const s = summarize(samples);
    // A model of the measurement has to BE the measurement, within sampling
    // error, or every number downstream of it is decorative.
    expect(Math.abs(s.meanMs - MEASURED_DO_RPC_MS.meanMs)).toBeLessThan(6);
    expect(Math.abs(s.p50Ms - MEASURED_DO_RPC_MS.p50Ms)).toBeLessThan(6);
    expect(Math.abs(s.p75Ms - MEASURED_DO_RPC_MS.p75Ms)).toBeLessThan(6);
    expect(Math.abs(s.p90Ms - MEASURED_DO_RPC_MS.p90Ms)).toBeLessThan(6);
    console.log(
      `[fixture] fitted mean=${s.meanMs.toFixed(1)} p50=${s.p50Ms.toFixed(0)} p75=${s.p75Ms.toFixed(0)} ` +
        `p90=${s.p90Ms.toFixed(0)} p95=${s.p95Ms.toFixed(0)}  vs measured ` +
        `mean=${MEASURED_DO_RPC_MS.meanMs} p50=${MEASURED_DO_RPC_MS.p50Ms} p75=${MEASURED_DO_RPC_MS.p75Ms} p90=${MEASURED_DO_RPC_MS.p90Ms}`,
    );
  });
});

describe("sweepcap: the simulator is pinned to the SHIPPED sweepTenants", () => {
  it("reproduces the real sequential loop exactly, replaying its OBSERVED durations", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ten_${String(i).padStart(2, "0")}`);
    const scripted = ids.map(() => 100);
    const observed = new Array<number>(ids.length).fill(0);
    const startedAt = Date.now();
    const fanout = newSweepFanout(startedAt, 650);
    const real = await sweepTenants(
      ids,
      fanout,
      async (id) => {
        const i = ids.indexOf(id);
        const t0 = Date.now();
        await sleep(scripted[i] as number);
        observed[i] = Date.now() - t0;
      },
      () => {},
    );
    const replay = observed.map((v, i) => (v > 0 ? v : (scripted[i] as number)));
    const model = simulateTick(
      {
        legs: [{ name: "one", rpcsPerTenant: 1 }],
        sliceSize: ids.length,
        concurrency: 1,
        deadlineMs: 650,
        rng: mulberry32(1),
        sampleMs: sampleDoRpcMs,
      },
      [replay],
    );
    expect(model.legs[0]!.visited).toBe(real.visited);
    expect(model.legs[0]!.deferred).toBe(real.deferred);
    expect(model.leastVisited).toBe(fanout.leastVisited);
    // Positive control: the deadline must actually have bitten, or the equality
    // above is the trivial "both swept everything" and proves nothing.
    expect(real.deferred).toBeGreaterThan(0);
    console.log(`[pin C=1] real visited=${real.visited} deferred=${real.deferred} | model visited=${model.legs[0]!.visited}`);
  });

  it("reproduces the bounded-concurrency candidate exactly at C=2", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `ten_${String(i).padStart(2, "0")}`);
    const scripted = ids.map(() => 100);
    const observed = new Array<number>(ids.length).fill(0);
    const startedAt = Date.now();
    const fanout = newSweepFanout(startedAt, 350);
    const real = await sweepTenantsConcurrentCandidate(
      ids,
      fanout,
      async (id) => {
        const i = ids.indexOf(id);
        const t0 = Date.now();
        await sleep(scripted[i] as number);
        observed[i] = Date.now() - t0;
      },
      () => {},
      2,
    );
    const replay = observed.map((v, i) => (v > 0 ? v : (scripted[i] as number)));
    const model = simulateTick(
      {
        legs: [{ name: "one", rpcsPerTenant: 1 }],
        sliceSize: ids.length,
        concurrency: 2,
        deadlineMs: 350,
        rng: mulberry32(1),
        sampleMs: sampleDoRpcMs,
      },
      [replay],
    );
    expect(model.legs[0]!.visited).toBe(real.visited);
    expect(model.legs[0]!.prefix).toBe(real.prefix);
    expect(real.deferred).toBeGreaterThan(0);
    console.log(`[pin C=2] real visited=${real.visited} prefix=${real.prefix} | model visited=${model.legs[0]!.visited} prefix=${model.legs[0]!.prefix}`);
  });
});

describe("sweepcap: the cursor-safety constraint concurrency introduces", () => {
  it("CLAIM discipline keeps the covered set a contiguous prefix (property, 300 randomized ticks)", () => {
    const rng = mulberry32(7);
    for (let t = 0; t < 300; t++) {
      const slice = 1 + Math.floor(rng() * 40);
      const concurrency = 1 + Math.floor(rng() * 12);
      const out = simulateTick({
        legs: FANOUT_LEGS,
        sliceSize: slice,
        concurrency,
        deadlineMs: SWEEP_FANOUT_DEADLINE_MS,
        rng,
        sampleMs: sampleDoRpcMs,
        onDeadline: "claim",
      });
      for (const leg of out.legs) {
        // `commitSweepCursor` does `slice.ids[covered - 1]`. That is only sound
        // when `covered` IS the prefix length.
        expect(leg.prefix).toBe(leg.visited);
      }
      expect(out.leastVisited).toBeGreaterThanOrEqual(1);
    }
  });

  it("ABANDON discipline leaves a HOLE — the shipped cursor would skip a live tenant", async () => {
    // One slow tenant at the head, fast ones behind it: the shape a real slice
    // hits whenever one tenant's DO is cold or wedged.
    const ids = ["ten_00_slow", "ten_01", "ten_02", "ten_03", "ten_04", "ten_05"];
    const delays = [900, 20, 20, 20, 20, 20];
    const fanout = newSweepFanout(Date.now(), 300);
    const out = await sweepTenantsConcurrentCandidate(
      ids,
      fanout,
      async (id) => {
        await sleep(delays[ids.indexOf(id)] as number);
      },
      () => {},
      3,
      "abandon",
    );
    // The count says several tenants were covered; the PREFIX says zero, because
    // index 0 never finished.
    expect(out.visited).toBeGreaterThan(0);
    expect(out.prefix).toBe(0);
    // This is the defect, made concrete: a cursor advanced by the COUNT lands
    // past a tenant that was never swept, and the keyset `WHERE id > ?` means
    // the next tick starts BEHIND it — so it is skipped for the whole rotation.
    const cursorFromCount = ids[out.visited - 1];
    const skipped = ids.slice(0, out.visited).filter((_, i) => i >= out.prefix);
    expect(skipped).toContain("ten_00_slow");
    console.log(`[hole] visited=${out.visited} prefix=${out.prefix} cursor-from-count=${cursorFromCount} skipped=${skipped.join(",")}`);
  });
});

describe("sweepcap: the measurement matrix", () => {
  it("concurrency x slice -> wall time, achieved coverage, projected rotation", () => {
    const concurrencies = [1, 2, 4, 6, 8, 12];
    const slices = [3, 6, 12, 24, 48];
    const rows: string[] = [];
    rows.push(`deadline=${SWEEP_FANOUT_DEADLINE_MS}ms  legs=${FANOUT_LEGS.length}  rpcs/tenant=${SWEEP_FANOUT_RPCS_PER_TENANT}  p75=${ASSUMED_DO_RPC_MS}ms  trials=${TRIALS}`);
    rows.push("  C | slice | wall p50 | wall p95 | slice completed | advance p50 | advance p05 | rotation@66 | @150 | @300");
    rows.push("----+-------+----------+----------+-----------------+-------------+-------------+-------------+------+------");
    for (const c of concurrencies) {
      for (const L of slices) {
        const cell = runCell(c, L, 1000 + c * 100 + L);
        const adv = cell.advanceP05;
        const r66 = shippedRotationTicks(66, adv, L, L);
        const r150 = shippedRotationTicks(150, adv, L, L);
        const r300 = shippedRotationTicks(300, adv, L, L);
        rows.push(
          `${String(c).padStart(3)} | ${String(L).padStart(5)} | ${String(cell.wallP50).padStart(8)} | ${String(cell.wallP95).padStart(8)} | ` +
            `${String(cell.completedPct + "%").padStart(15)} | ${String(cell.advanceP50).padStart(11)} | ${String(adv).padStart(11)} | ` +
            `${String(r66).padStart(11)} | ${String(r150).padStart(4)} | ${String(r300).padStart(4)}`,
        );
      }
    }
    console.log("\n=== MATRIX: concurrency x slice ===\n" + rows.join("\n"));

    // The C=1 / slice=3 cell must reproduce the SHIPPED configuration, or the
    // harness is not modelling the thing in production.
    const baseline = runCell(1, SWEEP_TENANT_SLICE, 99);
    expect(baseline.completedPct).toBeGreaterThanOrEqual(50);
    expect(SWEEP_TENANT_SLICE).toBe(3);
    console.log(`[baseline C=1 slice=${SWEEP_TENANT_SLICE}] wallP50=${baseline.wallP50} wallP95=${baseline.wallP95} completed=${baseline.completedPct}%`);
  });

  it("max sustainable slice per concurrency, and whether it clears the coverage threshold", () => {
    const subrequestCeiling = Math.floor((SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION - SWEEP_FIXED_SUBREQUESTS) / SWEEP_RPCS_PER_TENANT);
    const rows: string[] = [];
    rows.push(`subrequest ceiling on the slice (budget ${SWEEP_SUBREQUEST_BUDGET} x ${SWEEP_BUDGET_FRACTION} - fixed ${SWEEP_FIXED_SUBREQUESTS}) / ${SWEEP_RPCS_PER_TENANT} = ${subrequestCeiling}`);
    rows.push("  C | max slice (wall) | effective slice | rotation@66 | @150 | @300 | healthy@66 | @150 | @300");
    rows.push("----+------------------+-----------------+-------------+------+------+------------+------+------");
    const results: { c: number; wall: number; effective: number }[] = [];
    for (const c of [1, 2, 4, 6, 8, 12]) {
      const { slice, cell } = maxSustainableSlice(c, 5000 + c);
      const effective = Math.min(slice, subrequestCeiling);
      const r66 = coverageTicks(66, effective);
      const r150 = coverageTicks(150, effective);
      const r300 = coverageTicks(300, effective);
      results.push({ c, wall: slice, effective });
      rows.push(
        `${String(c).padStart(3)} | ${String(slice).padStart(16)} | ${String(effective).padStart(15)} | ${String(r66).padStart(11)} | ` +
          `${String(r150).padStart(4)} | ${String(r300).padStart(4)} | ${String(r66 <= COVERAGE_TICKS_ALERT_AFTER).padStart(10)} | ` +
          `${String(r150 <= COVERAGE_TICKS_ALERT_AFTER).padStart(4)} | ${String(r300 <= COVERAGE_TICKS_ALERT_AFTER).padStart(4)}`,
      );
      void cell;
    }
    console.log("\n=== MAX SUSTAINABLE SLICE PER CONCURRENCY (>=95% of ticks cover the whole slice) ===\n" + rows.join("\n"));

    // THE HEADLINE CLAIM, asserted rather than narrated: today's serial fan-out
    // cannot bring sweep_coverage healthy at 66 tenants, and a bounded
    // concurrency of 6 can.
    const serial = results.find((r) => r.c === 1)!;
    const c6 = results.find((r) => r.c === 6)!;
    expect(coverageTicks(66, serial.effective)).toBeGreaterThan(COVERAGE_TICKS_ALERT_AFTER);
    expect(coverageTicks(66, c6.effective)).toBeLessThanOrEqual(COVERAGE_TICKS_ALERT_AFTER);
  });
});

describe("sweepcap: the PROPOSED sizing rule (findings doc section 6)", () => {
  it("is conservative at every measured concurrency, and a no-op at C=1", () => {
    for (const c of [1, 2, 3, 4, 6, 8, 12]) {
      const derived = derivedSlice(c, SWEEP_FANOUT_DEADLINE_MS, ASSUMED_DO_RPC_MS, SWEEP_FANOUT_RPCS_PER_TENANT);
      const measured = maxSustainableSlice(c, 5000 + c).slice;
      // A sizing rule that OVERSHOOTS what the deadline sustains is worse than
      // one that undershoots: Table 1 shows an over-sized slice collapsing the
      // achieved advance to 1, not to something proportionally smaller.
      expect(derived, `C=${c}: derived ${derived} must not exceed measured max ${measured}`).toBeLessThanOrEqual(measured);
    }
    // The whole change must be provably inert with concurrency disabled.
    expect(derivedSlice(1, SWEEP_FANOUT_DEADLINE_MS, ASSUMED_DO_RPC_MS, SWEEP_FANOUT_RPCS_PER_TENANT)).toBe(SWEEP_TENANT_SLICE);
  });

  it("at the recommended C=6 the rotation clears the coverage threshold at 66 and 150 tenants", () => {
    const slice = derivedSlice(6, SWEEP_FANOUT_DEADLINE_MS, ASSUMED_DO_RPC_MS, SWEEP_FANOUT_RPCS_PER_TENANT);
    expect(coverageTicks(66, slice)).toBeLessThanOrEqual(COVERAGE_TICKS_ALERT_AFTER);
    expect(coverageTicks(150, slice)).toBeLessThanOrEqual(COVERAGE_TICKS_ALERT_AFTER);
    // Stated rather than hidden: 300 tenants is NOT covered at C=6 without the
    // opsSummary dedupe. That is the boundary at which the read-model is due.
    expect(coverageTicks(300, slice)).toBeGreaterThan(COVERAGE_TICKS_ALERT_AFTER);
    // ...and today's serial configuration does not clear it at any of the three.
    const serial = derivedSlice(1, SWEEP_FANOUT_DEADLINE_MS, ASSUMED_DO_RPC_MS, SWEEP_FANOUT_RPCS_PER_TENANT);
    expect(coverageTicks(66, serial)).toBeGreaterThan(COVERAGE_TICKS_ALERT_AFTER);
  });
});
