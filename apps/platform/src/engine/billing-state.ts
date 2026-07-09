// The billing lifecycle state machine — the single source of truth for which
// billing_state values FREEZE a tenant (no sends / no provisioning / no
// deliverability spend) and, by extension, which routine webhook writers must
// treat as sticky. Adversarial panel-03 root cause: billing_state/status were
// written by many handlers with no state-machine discipline — terminal freezes
// (disputed/canceled) weren't sticky, and the lifecycle freeze wasn't enforced
// everywhere spend can happen. Centralizing the predicate here keeps every
// enforcement point (the tick, the deliverability sweep, the setup/launch
// guards, the sticky webhook UPDATEs in engine/billing.ts) in agreement instead
// of each re-deriving its own subset (CLAUDE.md rule c).

import { ValidationError } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// billing_state values that freeze a tenant. 'disputed' = chargeback freeze
// (only a won dispute lifts it); 'canceling' = end-of-period cancel scheduled;
// 'canceled' = cancellation finalized/immediate. A routine billing event
// (checkout/subscription/invoice) must never silently overwrite one of these.
export const FROZEN_BILLING_STATES = ["disputed", "canceling", "canceled"] as const;

export function isFrozenBillingState(billingState: string): boolean {
  return (FROZEN_BILLING_STATES as readonly string[]).includes(billingState);
}

/**
 * The tenant-level kill switch shared by the tick AND the deliverability sweep:
 * a dunning/abuse SUSPEND (status='suspended') OR any frozen billing_state
 * stops all spend-incurring work. A frozen tenant "does nothing" — that
 * guarantee only holds if every entry point that can spend consults this.
 */
export function isLifecycleFrozen(status: string, billingState: string): boolean {
  return status === "suspended" || isFrozenBillingState(billingState);
}

export function readLifecycleState(ctx: TenantContext): { status: string; billingState: string } {
  const row = ctx.sql
    .exec<{ status: string; billing_state: string }>(
      `SELECT status, billing_state FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();
  return { status: row.status, billingState: row.billing_state };
}

/**
 * Rejects a spend-incurring write (setup_infrastructure / launch_campaign) when
 * the tenant is lifecycle-frozen. Without this, a canceled paid tenant (plan is
 * NOT reset on cancel) re-provisions fresh mailboxes and relaunches, accruing
 * metering + sends at activation on an account that stopped paying
 * (adversarial panel-03). A frozen tenant must re-subscribe via POST /checkout
 * — which reactivates it — before it can provision/launch again.
 */
export function assertNotLifecycleFrozen(ctx: TenantContext, action: string): void {
  const { status, billingState } = readLifecycleState(ctx);
  if (isLifecycleFrozen(status, billingState)) {
    throw new ValidationError(
      `${action} rejected: this account is frozen (status='${status}', billing_state='${billingState}'). A suspended, disputed, or canceled tenant cannot provision infrastructure or launch campaigns — reactivate via POST /checkout first.`,
    );
  }
}
