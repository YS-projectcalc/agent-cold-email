// Warmup ramp math — SPEC.md §9: "~5/day wk1 → 25-40/day wk4 (~4 wks)".
// Pure functions only; the caller supplies `now`/`startedAt` from an
// injected Clock (ARCHITECTURE.md #4) — nothing here reads wall time.

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const WARMUP_RAMP_DAYS = 28;

export function computeWarmupDay(startedAtMs: number, nowMs: number): number {
  // FAIL TO DAY 1, never to "fully warmed" (adversary N2). Every threshold
  // below is a `<=` comparison and every comparison against NaN is false, so a
  // non-finite input used to fall through warmupDailyCap to the 40/day branch —
  // a brand-new mailbox blasting at full cap — and a null one computed a day in
  // the 20,000s, which also reads send-ready. Both directions are closed here:
  // an unusable timestamp yields the most conservative ramp position there is.
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 1;
  const elapsedDays = Math.floor((nowMs - startedAtMs) / ONE_DAY_MS);
  return Math.max(1, elapsedDays + 1);
}

/** Daily send cap for a mailbox on a given warmup day (1-indexed). */
export function warmupDailyCap(day: number): number {
  if (day <= 7) return 5;
  if (day <= 14) return 15;
  if (day <= 21) return 25;
  if (day <= WARMUP_RAMP_DAYS) return 35;
  return 40; // fully warmed
}

export function isSendReady(day: number): boolean {
  return day > WARMUP_RAMP_DAYS;
}

export function warmupStatus(day: number): "warming" | "active" {
  return isSendReady(day) ? "active" : "warming";
}

export function epochDay(nowMs: number): number {
  return Math.floor(nowMs / ONE_DAY_MS);
}
