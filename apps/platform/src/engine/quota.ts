// B1 money path — plan quotas + the provisioning/spend runaway guard.
// `capFor` is the single source of truth `setup_infrastructure` (quota
// rejection) AND `account()` (reported quota) both read.

import { isPaidPlanTier, PLAN_QUOTAS, ValidationError } from "@coldstart/shared";
import type { TenantPlan } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

export interface ProvisioningCap {
  domains: number;
  mailboxes: number;
}

// Demo/free is not a purchasable tier (SPEC.md §18 lists it at "0 real" —
// nothing provisioned under it is ever real spend; ARCHITECTURE.md #8
// structurally forces the sandbox VendorPort bundle regardless of what's
// requested here). This flat cap is the "provisioning/spend cap, distinct
// from usage quota" runaway guard the B1 brief calls for: it bounds a
// buggy/looping agent's SANDBOX exploration, independent of the paid-tier
// quota math below (which governs actual purchased capacity).
const SANDBOX_PROVISIONING_CAP: ProvisioningCap = { domains: 5, mailboxes: 15 };

/** The cap governing `setup_infrastructure` for a tenant's current plan. */
export function capFor(plan: TenantPlan): ProvisioningCap {
  if (isPaidPlanTier(plan)) {
    const quota = PLAN_QUOTAS[plan];
    return { domains: quota.domains, mailboxes: quota.mailboxes };
  }
  return SANDBOX_PROVISIONING_CAP;
}

/**
 * Rejects (ValidationError -> HTTP 400) a `setup_infrastructure` call whose
 * requested domains/mailboxes, ADDED to what the tenant already has
 * provisioned, would exceed its plan's cap. Cumulative across calls so
 * repeated small requests can't creep past the quota either.
 */
export function assertWithinProvisioningCap(
  ctx: TenantContext,
  requested: { domains: number; mailboxes: number },
): void {
  const cap = capFor(ctx.plan);
  const existingDomains = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM domains WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;
  const existingMailboxes = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ?`, ctx.tenantId)
    .one().n;

  if (existingDomains + requested.domains > cap.domains) {
    throw new ValidationError(
      `plan '${ctx.plan}' allows at most ${cap.domains} domains (have ${existingDomains}, this request adds ${requested.domains}) — upgrade via POST /checkout for a higher tier`,
    );
  }
  if (existingMailboxes + requested.mailboxes > cap.mailboxes) {
    throw new ValidationError(
      `plan '${ctx.plan}' allows at most ${cap.mailboxes} mailboxes (have ${existingMailboxes}, this request adds ${requested.mailboxes}) — upgrade via POST /checkout for a higher tier`,
    );
  }
}
