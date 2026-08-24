// EXPERIMENT-ONLY (sweep-capacity lane, 2026-08-24). Not imported by src/.
//
// The MATRIX PRINTER. It lives outside vitest for one boring reason worth
// recording: `@cloudflare/vitest-pool-workers` in this repo swallows
// `console.log` from inside the worker entirely (probed 2026-08-24 — a test
// logging a unique marker produced 0 occurrences in the run output), so a
// harness whose deliverable is a TABLE cannot emit it from a test. The
// assertions live in `sweepcap.test.ts`; the numbers are printed here.
//
// Run:  npx esbuild test/sweepcap-experiment/report.ts --bundle --format=esm \
//         --platform=node --outfile=/tmp/sweepcap-report.mjs && node /tmp/sweepcap-report.mjs

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { derivedSlice, mulberry32, sampleDoRpcMs, SWEEP_CONCURRENCY_EFFICIENCY, summarize } from "./latency-model.js";
import { simulateTick, type LegSpec } from "./tick-model.js";

// This file is BUNDLED to a temp dir before it runs, so `import.meta.url` is
// not the source location. Resolve against the invocation cwd (apps/platform)
// and fail LOUD rather than silently reporting a stale threshold.
function platformRoot(): string {
  for (const c of [process.cwd(), resolve(process.cwd(), "apps/platform")]) {
    if (existsSync(resolve(c, "src/admin/sweep-signals.ts"))) return c;
  }
  throw new Error(`run this from apps/platform — cannot find src/admin/sweep-signals.ts from ${process.cwd()}`);
}

/** Read the live threshold out of the source rather than restating it — that
 * module pulls cloudflare deps this Node script cannot load, and a hardcoded
 * copy is exactly how a harness starts reporting a number the system no longer
 * grades by. */
function coverageThreshold(): number {
  const src = readFileSync(resolve(platformRoot(), "src/admin/sweep-signals.ts"), "utf8");
  const m = /export const COVERAGE_TICKS_ALERT_AFTER = (\d+);/.exec(src);
  if (!m) throw new Error("COVERAGE_TICKS_ALERT_AFTER not found in sweep-signals.ts — harness is stale");
  return Number(m[1]);
}
const COVERAGE_TICKS_ALERT_AFTER = coverageThreshold();

const FANOUT_LEGS: LegSpec[] = Object.entries(LEG_SUBREQUEST_COSTS)
  .filter(([name, c]) => c.perTenant > 0 && name !== "sendPipeline")
  .map(([name, c]) => ({ name, rpcsPerTenant: c.perTenant }));

const TRIALS = 400;

interface Cell {
  wallP50: number;
  wallP95: number;
  completedPct: number;
  advanceP50: number;
  advanceP05: number;
  rpcsP95: number;
}

function runCell(concurrency: number, slice: number, seed: number): Cell {
  const rng = mulberry32(seed);
  const wall: number[] = [];
  const advance: number[] = [];
  const rpcs: number[] = [];
  let completed = 0;
  for (let t = 0; t < TRIALS; t++) {
    const out = simulateTick({ legs: FANOUT_LEGS, sliceSize: slice, concurrency, deadlineMs: SWEEP_FANOUT_DEADLINE_MS, rng, sampleMs: sampleDoRpcMs });
    wall.push(out.wallMs);
    advance.push(out.leastPrefix);
    rpcs.push(out.rpcsIssued);
    if (out.leastPrefix >= slice) completed++;
  }
  const w = [...wall].sort((a, b) => a - b);
  const a = [...advance].sort((x, y) => x - y);
  const r = [...rpcs].sort((x, y) => x - y);
  const at = (arr: number[], q: number) => arr[Math.floor(q * (arr.length - 1))] as number;
  return {
    wallP50: Math.round(at(w, 0.5)),
    wallP95: Math.round(at(w, 0.95)),
    completedPct: Math.round((completed / TRIALS) * 1000) / 10,
    advanceP50: at(a, 0.5),
    advanceP05: at(a, 0.05),
    rpcsP95: at(r, 0.95),
  };
}

function maxSustainableSlice(concurrency: number, seed: number): number {
  let best = 1;
  for (let L = 1; L <= 90; L++) {
    if (runCell(concurrency, L, seed + L).completedPct >= 95) best = L;
    else break;
  }
  return best;
}

const out: string[] = [];
const say = (s = "") => out.push(s);

say(`ColdStart sweep-capacity measurement — generated ${new Date().toISOString()}`);
say(`fan-out deadline ${SWEEP_FANOUT_DEADLINE_MS}ms | legs ${FANOUT_LEGS.length} (${FANOUT_LEGS.map((l) => `${l.name}:${l.rpcsPerTenant}`).join(" ")})`);
say(`rpcs/tenant (fan-out) ${SWEEP_FANOUT_RPCS_PER_TENANT} | rpcs/tenant (tick) ${SWEEP_RPCS_PER_TENANT} | p75 ${ASSUMED_DO_RPC_MS}ms | shipped slice ${SWEEP_TENANT_SLICE} | trials/cell ${TRIALS}`);
say(`coverage threshold: rotation > ${COVERAGE_TICKS_ALERT_AFTER} ticks => sweep_coverage UNHEALTHY`);
say();

{
  const rng = mulberry32(1);
  const s = summarize(Array.from({ length: 200_000 }, () => sampleDoRpcMs(rng)));
  say("--- latency fixture vs the production capture it is fitted to ---");
  say(`  fitted   mean=${s.meanMs.toFixed(1)} p50=${s.p50Ms.toFixed(0)} p75=${s.p75Ms.toFixed(0)} p90=${s.p90Ms.toFixed(0)} p95=${s.p95Ms.toFixed(0)}`);
  say(`  measured mean=${MEASURED_DO_RPC_MS.meanMs}   p50=${MEASURED_DO_RPC_MS.p50Ms} p75=${MEASURED_DO_RPC_MS.p75Ms} p90=${MEASURED_DO_RPC_MS.p90Ms}  (n=${MEASURED_DO_RPC_MS.samples}, ${MEASURED_DO_RPC_MS.capturedAt})`);
  say();
}

say("=== TABLE 1 — concurrency x slice (achieved advance = p05 of leastPrefix, i.e. a bad tick) ===");
say("  C | slice | wall p50 | wall p95 | slice completed | adv p50 | adv p05 | rot@66 | @150 | @300 | DO RPCs p95");
say("----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------");
for (const c of [1, 2, 4, 6, 8, 12]) {
  for (const L of [3, 6, 12, 24, 48]) {
    const cell = runCell(c, L, 1000 + c * 100 + L);
    const adv = cell.advanceP05;
    const eff = adv < L ? adv : L;
    say(
      `${String(c).padStart(3)} | ${String(L).padStart(5)} | ${String(cell.wallP50).padStart(8)} | ${String(cell.wallP95).padStart(8)} | ` +
        `${(cell.completedPct + "%").padStart(15)} | ${String(cell.advanceP50).padStart(7)} | ${String(adv).padStart(7)} | ` +
        `${String(coverageTicks(66, eff)).padStart(6)} | ${String(coverageTicks(150, eff)).padStart(4)} | ${String(coverageTicks(300, eff)).padStart(4)} | ${String(cell.rpcsP95).padStart(11)}`,
    );
  }
  say("----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------");
}
say();

const subrequestCeilingNow = Math.floor((SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION - SWEEP_FIXED_SUBREQUESTS) / SWEEP_RPCS_PER_TENANT);
const subrequestCeilingDocumented = Math.floor((10_000 * SWEEP_BUDGET_FRACTION - SWEEP_FIXED_SUBREQUESTS) / SWEEP_RPCS_PER_TENANT);
say("=== TABLE 2 — max sustainable slice per concurrency (>=95% of ticks cover the WHOLE slice) ===");
say(`subrequest ceiling on the slice: ${subrequestCeilingNow} at the repo's assumed budget ${SWEEP_SUBREQUEST_BUDGET}; ${subrequestCeilingDocumented} at the DOCUMENTED Workers-Paid 10,000`);
say("  C | max slice (wall clock) | binding ceiling | effective | rot@66 | @150 | @300 | healthy@66 | @150 | @300");
say("----+------------------------+-----------------+-----------+--------+------+------+------------+------+------");
for (const c of [1, 2, 3, 4, 6, 8, 12]) {
  const wallMax = maxSustainableSlice(c, 5000 + c);
  const eff = Math.min(wallMax, subrequestCeilingNow);
  const binding = wallMax <= subrequestCeilingNow ? "wall clock" : "subrequests";
  const r = (n: number) => coverageTicks(n, eff);
  say(
    `${String(c).padStart(3)} | ${String(wallMax).padStart(22)} | ${binding.padStart(15)} | ${String(eff).padStart(9)} | ` +
      `${String(r(66)).padStart(6)} | ${String(r(150)).padStart(4)} | ${String(r(300)).padStart(4)} | ` +
      `${String(r(66) <= COVERAGE_TICKS_ALERT_AFTER).padStart(10)} | ${String(r(150) <= COVERAGE_TICKS_ALERT_AFTER).padStart(4)} | ${String(r(300) <= COVERAGE_TICKS_ALERT_AFTER).padStart(4)}`,
  );
}
say();

say("=== TABLE 3 — the same, WITH the opsSummary dedupe (3 identical-tenant RPCs -> 1) ===");
say("dunning+digest+watchtower each call opsSummary once per tenant; folding them to one call takes");
say(`fan-out rpcs/tenant ${SWEEP_FANOUT_RPCS_PER_TENANT} -> ${SWEEP_FANOUT_RPCS_PER_TENANT - 2} and tick rpcs/tenant ${SWEEP_RPCS_PER_TENANT} -> ${SWEEP_RPCS_PER_TENANT - 2}.`);
const DEDUPED_LEGS: LegSpec[] = [
  { name: "deliverability", rpcsPerTenant: 1 },
  { name: "opsSummaryShared", rpcsPerTenant: 1 },
  { name: "dunningAction", rpcsPerTenant: 1 },
  { name: "watchtowerNudge", rpcsPerTenant: 1 },
  { name: "warmupCancel", rpcsPerTenant: 1 },
  { name: "webhooks", rpcsPerTenant: 1 },
  { name: "provisioningReconcile", rpcsPerTenant: 1 },
];
function maxSustainableSliceLegs(legs: LegSpec[], concurrency: number, seed: number): number {
  let best = 1;
  for (let L = 1; L <= 90; L++) {
    const rng = mulberry32(seed + L);
    let completed = 0;
    for (let t = 0; t < TRIALS; t++) {
      const o = simulateTick({ legs, sliceSize: L, concurrency, deadlineMs: SWEEP_FANOUT_DEADLINE_MS, rng, sampleMs: sampleDoRpcMs });
      if (o.leastPrefix >= L) completed++;
    }
    if (completed / TRIALS >= 0.95) best = L;
    else break;
  }
  return best;
}
const dedupSubreqCeiling = Math.floor((SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION - SWEEP_FIXED_SUBREQUESTS) / (SWEEP_RPCS_PER_TENANT - 2));
say("  C | max slice (wall clock) | effective | rot@66 | @150 | @300 | healthy@66 | @150 | @300");
say("----+------------------------+-----------+--------+------+------+------------+------+------");
for (const c of [1, 2, 4, 6, 8]) {
  const wallMax = maxSustainableSliceLegs(DEDUPED_LEGS, c, 7000 + c);
  const eff = Math.min(wallMax, dedupSubreqCeiling);
  const r = (n: number) => coverageTicks(n, eff);
  say(
    `${String(c).padStart(3)} | ${String(wallMax).padStart(22)} | ${String(eff).padStart(9)} | ${String(r(66)).padStart(6)} | ` +
      `${String(r(150)).padStart(4)} | ${String(r(300)).padStart(4)} | ${String(r(66) <= COVERAGE_TICKS_ALERT_AFTER).padStart(10)} | ` +
      `${String(r(150) <= COVERAGE_TICKS_ALERT_AFTER).padStart(4)} | ${String(r(300) <= COVERAGE_TICKS_ALERT_AFTER).padStart(4)}`,
  );
}
say();

say("=== TABLE 4 — sensitivity: what if the platform's 6-connection ceiling DOES bind DO RPCs? ===");
say("Documented behaviour past 6 is QUEUEING, not an error, so an over-set concurrency degrades to 6.");
for (const requested of [8, 12]) {
  const capped = 6;
  const wallReq = maxSustainableSlice(requested, 9000 + requested);
  const wallCap = maxSustainableSlice(capped, 9100);
  say(`  requested C=${requested}: slice ${wallReq} if unbound, ${wallCap} if the ceiling clamps to 6 (rot@66 ${coverageTicks(66, Math.min(wallCap, subrequestCeilingNow))} ticks — still healthy)`);
}
say();

say("=== TABLE 5 — sensitivity to a latency regression (the p75 the slice is sized against) ===");
say("  latency x | C=1 slice | C=6 slice | rot@66 C=1 | rot@66 C=6 | C=6 healthy@66");
say("------------+-----------+-----------+------------+------------+---------------");
for (const mult of [1, 1.5, 2, 3]) {
  const scaled = (rng: () => number) => sampleDoRpcMs(rng) * mult;
  const maxFor = (c: number) => {
    let best = 1;
    for (let L = 1; L <= 90; L++) {
      const rng = mulberry32(11000 + c * 100 + L + Math.round(mult * 10));
      let completed = 0;
      for (let t = 0; t < TRIALS; t++) {
        const o = simulateTick({ legs: FANOUT_LEGS, sliceSize: L, concurrency: c, deadlineMs: SWEEP_FANOUT_DEADLINE_MS, rng, sampleMs: scaled });
        if (o.leastPrefix >= L) completed++;
      }
      if (completed / TRIALS >= 0.95) best = L;
      else break;
    }
    return best;
  };
  const s1 = maxFor(1);
  const s6 = Math.min(maxFor(6), subrequestCeilingNow);
  say(
    `${(mult + "x").padStart(11)} | ${String(s1).padStart(9)} | ${String(s6).padStart(9)} | ${String(coverageTicks(66, s1)).padStart(10)} | ` +
      `${String(coverageTicks(66, s6)).padStart(10)} | ${String(coverageTicks(66, s6) <= COVERAGE_TICKS_ALERT_AFTER).padStart(14)}`,
  );
}

say();
say("=== TABLE 6 — the PROPOSED sizing rule vs the measured maxima (findings doc section 6) ===");
say(`slice = floor(deadline x (1 + (C-1) x ${SWEEP_CONCURRENCY_EFFICIENCY}) / (p75 x rpcsPerTenant))`);
say("  C | derived | measured max | conservative? | rot@66 | @150 | @300 || deduped derived | rot@66 | @150 | @300");
say("----+---------+--------------+---------------+--------+------+------++-----------------+--------+------+------");
for (const c of [1, 2, 3, 4, 6, 8, 12]) {
  const d = derivedSlice(c, SWEEP_FANOUT_DEADLINE_MS, ASSUMED_DO_RPC_MS, SWEEP_FANOUT_RPCS_PER_TENANT);
  const measured = maxSustainableSlice(c, 5000 + c);
  const dd = derivedSlice(c, SWEEP_FANOUT_DEADLINE_MS, ASSUMED_DO_RPC_MS, SWEEP_FANOUT_RPCS_PER_TENANT - 2);
  const r = (n: number, s2: number) => coverageTicks(n, s2);
  say(
    `${String(c).padStart(3)} | ${String(d).padStart(7)} | ${String(measured).padStart(12)} | ${String(d <= measured).padStart(13)} | ` +
      `${String(r(66, d)).padStart(6)} | ${String(r(150, d)).padStart(4)} | ${String(r(300, d)).padStart(4)} || ` +
      `${String(dd).padStart(15)} | ${String(r(66, dd)).padStart(6)} | ${String(r(150, dd)).padStart(4)} | ${String(r(300, dd)).padStart(4)}`,
  );
}
say();
say(`healthy = rotation <= ${COVERAGE_TICKS_ALERT_AFTER} ticks`);

console.log(out.join("\n"));
