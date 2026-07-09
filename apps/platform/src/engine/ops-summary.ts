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

/** D2 dunning sweep's "suspend after grace" action (admin/dunning.ts) — a real local state transition, no vendor call. */
export function suspendTenant(ctx: TenantContext): void {
  ctx.sql.exec(`UPDATE tenant_profile SET status = 'suspended' WHERE id = ?`, ctx.tenantId);
}

export function getOpsSummary(ctx: TenantContext, sinceMs: number): TenantOpsSummary {
  const profile = ctx.sql
    .exec<{ brand: string; plan: string; status: string; billing_state: string }>(
      `SELECT brand, plan, status, billing_state FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();

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
    deliverability: getDeliverabilitySummary(ctx),
    actionsInWindow: {
      paused: countActionsInWindow(ctx, "PAUSE", sinceMs),
      replaced: countActionsInWindow(ctx, "REPLACE_DOMAIN", sinceMs),
    },
  };
}
