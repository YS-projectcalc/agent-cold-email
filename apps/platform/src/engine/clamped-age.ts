/**
 * THE WAVE-LEVEL CLOCK RULE (design §7.19), in one function.
 *
 * > Any timestamp this wave ages from is read as `MIN(anchorTs, realNow)`.
 *
 * No exceptions and no per-anchor argument about whether a particular column
 * "is real for the tenants in scope". One helper, so the rule cannot be half
 * applied.
 *
 * WHY IT IS A RULE AND NOT A JUDGEMENT CALL. `clock-migration.ts` shifts a
 * closed, short list — exactly six columns (`scheduled_sends.send_at`,
 * `scheduled_sends.sending_since`, `request_idempotency.created_at`,
 * `domains.first_send_eligible_at`, `domains.dns_first_checked_at`,
 * `domains.dns_gave_up_at`). EVERY other `ctx.clock`-stamped timestamp in the
 * schema is virtual-domain forever for any tenant that lived on the demo/free
 * VirtualClock — which runs up to 1440x ahead of real time — before upgrading.
 * And the migration route is CLOSED: `migrateTenantClockToReal` is one-shot per
 * tenant, guarded by `clock_mode != 'real'`, and has already run for every paid
 * tenant. A column this wave newly starts reading can never be shifted by it,
 * so adding a line to the migration would do nothing for exactly the population
 * that needs it. The clamp is the only fix, permanently.
 *
 * THE FAILURE SIGNATURE. A future-dated anchor makes `now - anchor` NEGATIVE,
 * so an age bound is never crossed and the check SILENTLY NEVER FIRES. It does
 * not error, it does not alert, and it looks identical to a healthy tenant —
 * strictly worse than a false positive, and it lands on the demo-era-then-
 * upgraded population, which is disproportionately the tenants carrying
 * half-finished setups.
 *
 * DIRECTION IS DELIBERATE. Clamping to `realNow` UNDERSTATES age, which delays
 * an alert and can never fire one early. Correct direction for a founder-facing
 * alert channel and for a customer-facing "this has been stuck for N days".
 */

import { RealClock } from "../clock.js";

/** Real wall-clock, never `ctx.clock` — a demo tenant's VirtualClock runs up to 1440x accelerated. */
export function realNowMs(): number {
  return new RealClock().now();
}

/**
 * How long ago `anchorTs` was, in ms, never negative and never measured from a
 * virtual-domain future. Returns null for a missing anchor, so "we have no
 * honest anchor" stays distinguishable from "zero milliseconds ago" — the same
 * distinction `NextStep.sinceMs` publishes.
 */
export function clampedAge(anchorTs: number | null | undefined, realNow: number): number | null {
  if (anchorTs === null || anchorTs === undefined) return null;
  return realNow - Math.min(anchorTs, realNow);
}
