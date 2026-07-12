// D2 (brief) — the DECIDE half of the dunning / failed-payment sweep,
// mirroring engine/deliverability.ts's pure-decision shape: no I/O, no
// clock, unit-testable in isolation. The ACT half (idempotent per-tenant
// application) lives in routes/admin-ops.ts, the one caller.

export type DunningAction = "retry" | "escalate" | "suspend";

// A tenant's "failure count" is the number of invoice.payment_failed Stripe
// webhook events its own TenantDO has recorded (webhook_events, schema.ts) —
// the real per-tenant signal, no separate counter to keep in sync. These
// thresholds are built-to-contract defaults (ROADMAP.md hardening-budget
// rule); real dunning cadence is tuned at activation alongside real retry
// emails.
export const DUNNING_ESCALATE_AFTER_FAILURES = 2;
export const DUNNING_SUSPEND_AFTER_FAILURES = 4;

// A5 (CLASS A) — Stripe charge decline codes that are PERMANENT: retrying the
// same card can never succeed, so grinding through the count-based grace cycle
// only wastes it. A permanent decline skips straight to the final ('suspend')
// stage (the customer is still notified — a dunning email is an ACTIVATION
// step). Everything else — insufficient_funds, processing_error, generic
// declines — is transient and keeps the count-based cycle. Grounded in Stripe's
// documented decline_code / failure_code values.
const PERMANENT_DECLINE_CODES = new Set([
  "lost_card",
  "stolen_card",
  "pickup_card",
  "fraudulent",
  "do_not_honor",
]);

/** True only for a KNOWN permanent decline; unknown/absent => false (treat as transient, the safe default). */
export function isPermanentDeclineCode(code: string | null | undefined): boolean {
  return code != null && PERMANENT_DECLINE_CODES.has(code);
}

/**
 * PURE decision function. `failureCount` IS the dunning "cycle" — the sweep
 * (routes/admin-ops.ts) records at most one dunning_events row per
 * (tenantId, cycle), which is what makes re-running the sweep against an
 * unchanged failure count a no-op (idempotent per cycle, brief requirement).
 * `declineCode` is the most recent charge failure code (A5): a permanent code
 * suspends immediately regardless of count; a transient/unknown code follows
 * the count-based grace cycle.
 */
export function decideDunningAction(failureCount: number, declineCode?: string | null): DunningAction {
  if (isPermanentDeclineCode(declineCode)) return "suspend";
  if (failureCount >= DUNNING_SUSPEND_AFTER_FAILURES) return "suspend";
  if (failureCount >= DUNNING_ESCALATE_AFTER_FAILURES) return "escalate";
  return "retry";
}
