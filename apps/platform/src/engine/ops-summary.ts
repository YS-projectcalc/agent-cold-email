// D2/D6 (brief) — the lightweight per-tenant summary the admin surface reads
// via TenantDO RPC (never direct SQL — tenant-do.ts is the only thing that
// touches a tenant's own SqlStorage). ARCHITECTURE.md #3 + the brief: D1
// only holds the control-plane INDEX (tenant ids); the authoritative
// plan/billing/deliverability state lives in each tenant's own DO, so the
// dunning sweep (routes/admin-ops.ts) and the owner digest both call this
// exact function through TenantDO.opsSummary() rather than trusting D1's
// (possibly stale — see db.ts's insertTenantIndex, never updated post-signup)
// mirror of plan/status.

import { isPaidPlanTier, PLAN_QUOTAS } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { getDeliverabilitySummary } from "./reporting.js";

export interface TenantOpsSummary {
  tenantId: string;
  brand: string;
  plan: string;
  status: string;
  billingState: string;
  usageCents: number;
  /** D5 — total annual-domain liability booked for this tenant (ledger kind='liability'), integer cents. */
  annualDomainLiabilityCents: number;
  /** priceCents of the tenant's plan if it's a paid tier AND billing is 'active'; 0 otherwise (SPEC.md §18). */
  mrrCents: number;
  /** Count of invoice.payment_failed webhook events this tenant's DO has recorded — the dunning "cycle" (admin/dunning.ts). */
  billingFailureCount: number;
  /** A5 — the most recent charge decline code (permanent codes make the dunning sweep suspend immediately); null if none/unknown. */
  lastDeclineCode: string | null;
  /** A4 — count of sends that exhausted the retry cap / hit a non-retryable vendor error (engine/tick.ts) — ops-visible. */
  failedSends: number;
  /** All-time deliverability rollup — same shape account() surfaces to the tenant. */
  deliverability: { pausedMailboxes: number; throttledMailboxes: number; burningDomains: number; domainsReplaced: number };
  /** Deliverability actions logged strictly since `sinceMs` — what the D6 digest windows over. */
  actionsInWindow: { paused: number; replaced: number };
}

function countActionsInWindow(ctx: TenantContext, action: string, sinceMs: number): number {
  return ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? AND action = ? AND ts >= ?`,
      ctx.tenantId,
      action,
      sinceMs,
    )
    .one().n;
}

export type SuspendReason = "dunning" | "terminate";

/**
 * Suspends a tenant (tick freeze via status='suspended'). `reason` records
 * WHY, so a later billing-recovery event can reactivate a DUNNING suspension
 * (a now-paying customer) WITHOUT resurrecting an abuse TERMINATE (adversarial
 * panel-03 finding #6). Distinguishing them via a stored reason avoids reading
 * D1 from inside the DO (the DO/D1 write boundary invariant — see the file
 * header). Called by the D2 dunning sweep (reason='dunning') and the abuse
 * terminate lane (reason='terminate').
 */
export function suspendTenant(ctx: TenantContext, reason: SuspendReason): void {
  ctx.sql.exec(
    `UPDATE tenant_profile SET status = 'suspended', suspend_reason = ? WHERE id = ?`,
    reason,
    ctx.tenantId,
  );
}

/**
 * Clears a DUNNING suspension on a billing-recovery transition
 * (subscription.updated->active / checkout.session.completed / dispute won).
 * Scoped to `suspend_reason = 'dunning'` so an abuse TERMINATE is NEVER lifted
 * by a stray billing event (adversarial panel-03 finding #6). Idempotent: a
 * no-op for an already-active or terminate-suspended tenant. Returns true iff
 * it actually un-suspended a dunning-frozen tenant.
 */
export function reactivateFromDunning(ctx: TenantContext): boolean {
  const res = ctx.sql.exec(
    `UPDATE tenant_profile SET status = 'active', suspend_reason = NULL
     WHERE id = ? AND status = 'suspended' AND suspend_reason = 'dunning'`,
    ctx.tenantId,
  );
  return res.rowsWritten > 0;
}

export function getOpsSummary(ctx: TenantContext, sinceMs: number): TenantOpsSummary {
  const profile = ctx.sql
    .exec<{ brand: string; plan: string; status: string; billing_state: string; last_decline_code: string | null }>(
      `SELECT brand, plan, status, billing_state, last_decline_code FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();

  const failedSends = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM scheduled_sends WHERE tenant_id = ? AND status = 'failed'`,
      ctx.tenantId,
    )
    .one().n;

  const usageCents = ctx.sql
    .exec<{ total: number | null }>(
      `SELECT SUM(amount_cents) as total FROM ledger_entries WHERE tenant_id = ? AND kind = 'usage'`,
      ctx.tenantId,
    )
    .one().total ?? 0;

  const annualDomainLiabilityCents = ctx.sql
    .exec<{ total: number | null }>(
      `SELECT SUM(amount_cents) as total FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`,
      ctx.tenantId,
    )
    .one().total ?? 0;

  // webhook_events is scoped per-DO already (one tenant per DO instance) —
  // no tenant_id column/filter needed, same as engine/billing.ts's idempotency check.
  const billingFailureCount = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM webhook_events WHERE type = 'invoice.payment_failed'`)
    .one().n;

  const mrrCents =
    isPaidPlanTier(profile.plan) && profile.billing_state === "active" ? PLAN_QUOTAS[profile.plan].priceCents : 0;

  return {
    tenantId: ctx.tenantId,
    brand: profile.brand,
    plan: profile.plan,
    status: profile.status,
    billingState: profile.billing_state,
    usageCents,
    annualDomainLiabilityCents,
    mrrCents,
    billingFailureCount,
    lastDeclineCode: profile.last_decline_code,
    failedSends,
    deliverability: getDeliverabilitySummary(ctx),
    actionsInWindow: {
      paused: countActionsInWindow(ctx, "PAUSE", sinceMs),
      replaced: countActionsInWindow(ctx, "REPLACE_DOMAIN", sinceMs),
    },
  };
}
