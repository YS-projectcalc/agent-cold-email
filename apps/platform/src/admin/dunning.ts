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

/**
 * PURE decision function. `failureCount` IS the dunning "cycle" — the sweep
 * (routes/admin-ops.ts) records at most one dunning_events row per
 * (tenantId, cycle), which is what makes re-running the sweep against an
 * unchanged failure count a no-op (idempotent per cycle, brief requirement).
 */
export function decideDunningAction(failureCount: number): DunningAction {
  if (failureCount >= DUNNING_SUSPEND_AFTER_FAILURES) return "suspend";
  if (failureCount >= DUNNING_ESCALATE_AFTER_FAILURES) return "escalate";
  return "retry";
}
