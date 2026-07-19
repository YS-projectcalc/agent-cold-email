// SPEC.md §20.2/§20.5 — the domain-tier warmup/cap ramp. Composes
// warmup.ts's existing pure ramp math (unchanged, untouched) rather than
// duplicating it (CLAUDE.md rule c). `rampTierFor` is the single place that
// maps a domain's (isPrimary, reputationBranch) onto a ramp tier; every
// EXISTING provisioned/non-BYO domain has isPrimary=false and
// reputationBranch=null, which always resolves to 'standard' -- byte-identical
// to the pre-existing warmupDailyCap() behavior (flag-dark guarantee).

import { warmupDailyCap } from "./warmup.js";
import type { ReputationBranch } from "./byo-reputation.js";

export type RampTier = "standard" | "shortened" | "primary";

export function rampTierFor(input: { isPrimary: boolean; reputationBranch: ReputationBranch | null }): RampTier {
  // Primary-axis-first (SPEC.md §20.5): primary gates BEFORE the reputation
  // signal is even consulted -- an established-good PRIMARY still never gets
  // the shortened ramp (§20.2's "no schedule compression" restated on the
  // ramp-length axis).
  if (input.isPrimary) return "primary";
  if (input.reputationBranch === "established_good") return "shortened";
  return "standard";
}

// Shortened ramp (SPEC.md §20.5): 7-10 days to steady-state instead of the
// standard 28. This is a genuinely FASTER curve for a domain with a proven
// track record, not a "cap lifted" -- it still ramps (never a flat unlock)
// and is still gated by the same per-mailbox health monitoring as any ramp
// (deliverability.ts's evaluate() applies identically regardless of tier).
export function shortenedWarmupDailyCap(day: number): number {
  if (day <= 3) return 5;
  if (day <= 6) return 15;
  if (day <= 9) return 25;
  return 40; // fully warmed by day 10 -- inside the spec's 7-10-day window
}

// SPEC.md §20.2: "primary domain send volume is min(§9's scheduled day-N
// volume, 20/mbx/day)" -- the ramp's own pacing/shape is unchanged, only the
// ceiling is lower. This is a CLAMP, not a separate schedule racing the
// standard one, so it can never send MORE than the standard ramp at any day.
const PRIMARY_DAILY_CAP_CEILING = 20;

export function effectiveDailyCap(day: number, tier: RampTier): number {
  switch (tier) {
    case "primary":
      return Math.min(warmupDailyCap(day), PRIMARY_DAILY_CAP_CEILING);
    case "shortened":
      return shortenedWarmupDailyCap(day);
    case "standard":
      return warmupDailyCap(day);
  }
}
