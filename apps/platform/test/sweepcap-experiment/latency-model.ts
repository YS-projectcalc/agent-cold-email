// EXPERIMENT-ONLY (sweep-capacity lane, 2026-08-24). Not imported by src/.
//
// The DO-RPC latency distribution the tick model draws from, fitted to the
// PRODUCTION capture already recorded in `admin/sweep-budget.ts`
// (`MEASURED_DO_RPC_MS`: mean 414, p50 350, p75 450, p90 531, n=77, wrangler
// tail against prod worker 133fc911 on 2026-08-20).
//
// WHY A FITTED DISTRIBUTION AND NOT JUST p75. The whole question this lane asks
// is what happens when C round trips overlap, and that is an ORDER-STATISTIC
// question: a pool of C workers is paced by the draws it actually gets, so the
// tail matters in a way a single point estimate cannot express. Sizing a
// concurrent fan-out off p75 alone would repeat the 2026-08-20 defect in a new
// coordinate — a plan, not an observation.
//
// THE FIT IS ITSELF CHECKED. `sweepcap.test.ts` re-derives mean/p50/p75/p90
// from 200k draws and asserts they land on the measured four. A fixture that
// merely looks plausible is the thing this repo has been burned by; this one
// has to reproduce its own source.

/** Deterministic PRNG — every number in the findings doc must be re-derivable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Piecewise-linear inverse CDF, `[quantile, ms]`.
 *
 * The three interior anchors ARE the measured quantiles. The two free
 * parameters are the floor (q=0) and the tail max (q=1); they were solved so
 * the resulting mean is the measured 414ms, which is the statistic the three
 * quantiles alone do NOT pin — and the gap between the measured mean (414) and
 * the mean a plain lognormal through p50/p90 would give (~369) is precisely the
 * evidence that there IS a tail beyond p90 worth modelling.
 */
export const DO_RPC_INVERSE_CDF: readonly (readonly [number, number])[] = [
  [0.0, 180],
  [0.25, 280],
  [0.5, 350],
  [0.75, 450],
  [0.9, 531],
  [1.0, 1552],
];

export function sampleDoRpcMs(rng: () => number): number {
  const q = rng();
  for (let i = 1; i < DO_RPC_INVERSE_CDF.length; i++) {
    const [q0, v0] = DO_RPC_INVERSE_CDF[i - 1] as [number, number];
    const [q1, v1] = DO_RPC_INVERSE_CDF[i] as [number, number];
    if (q <= q1) return v0 + ((q - q0) / (q1 - q0)) * (v1 - v0);
  }
  return DO_RPC_INVERSE_CDF[DO_RPC_INVERSE_CDF.length - 1]![1];
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx] as number;
}

export function summarize(samples: readonly number[]): { meanMs: number; p50Ms: number; p75Ms: number; p90Ms: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50Ms: quantile(sorted, 0.5),
    p75Ms: quantile(sorted, 0.75),
    p90Ms: quantile(sorted, 0.9),
    p95Ms: quantile(sorted, 0.95),
  };
}

/**
 * THE PROPOSED SIZING RULE (findings doc section 6), as code so the doc's table
 * is machine-checked rather than hand-arithmetic.
 *
 * The naive `deadline x C / (p75 x rpcs)` overstates the sustainable slice by
 * 25-30% at every C >= 4, because a leg is paced by its stragglers rather than
 * by its p75. This discounts the CONCURRENCY term, which makes the rule
 * degenerate to exactly the shipped serial value at C = 1 — so the change is a
 * provable no-op with concurrency disabled.
 */
export const SWEEP_CONCURRENCY_EFFICIENCY = 0.7;

export function effectiveConcurrency(concurrency: number): number {
  return 1 + (concurrency - 1) * SWEEP_CONCURRENCY_EFFICIENCY;
}

export function derivedSlice(concurrency: number, deadlineMs: number, rpcMs: number, rpcsPerTenant: number): number {
  return Math.max(1, Math.floor((deadlineMs * effectiveConcurrency(concurrency)) / (rpcMs * rpcsPerTenant)));
}
