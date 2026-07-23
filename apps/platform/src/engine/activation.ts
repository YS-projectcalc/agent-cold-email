// I1 (self-serve activation design, 2026-07-21) — the product-driven
// activation gate that REPLACES the manual `ENGINE_TENANTS` allowlist and the
// hard-`false` `realAdaptersActivated` flag (vendors/factory.ts's prior
// mechanism). No operator ever touches an allowlist again: paying flips
// `billing_state` to 'active' (engine/billing.ts), which flips activation on;
// stopping payment (dunning -> suspend, or dispute) trips `isLifecycleFrozen`
// (billing-state.ts), which flips it off — the existing freeze/abuse machine
// IS the deactivation mechanism, for free. See design §2.1.

import { isPaidPlanTier, type TenantPlan } from "@coldstart/shared";
import { isLifecycleFrozen } from "./billing-state.js";

export type ScreeningStatus = "clear" | "review";

export interface ActivationState {
  readonly plan: TenantPlan;
  readonly status: string;
  readonly billingState: string;
  readonly activated: boolean;
}

/**
 * PURE activation predicate (design §2.1's formula, verbatim):
 *   activated(tenant) =
 *        plan is a paid tier (isPaidPlanTier)
 *     && billing_state === 'active'
 *     && NOT isLifecycleFrozen(status, billing_state)
 *     && screening_status === 'clear'
 * Mirrors billing-state.ts's isLifecycleFrozen/readLifecycleState split: the
 * predicate takes plain values (unit-testable with no DO/SQL), the reader
 * below does the actual SQL fetch.
 */
export function isTenantActivated(
  plan: TenantPlan,
  status: string,
  billingState: string,
  screening: ScreeningStatus,
): boolean {
  return isPaidPlanTier(plan) && billingState === "active" && !isLifecycleFrozen(status, billingState) && screening === "clear";
}

/**
 * Reads the CURRENT activation state with a FRESH SQL query — no caller may
 * cache this result across a billing-state change (adversarial finding F3,
 * `docs/adversarial/selfserve-activation-design-review-2026-07-21.md`:
 * re-evaluating on every `buildAdapters()` call is REQUIRED, not merely
 * recommended, because the on-demand reply/followup send path has no
 * independent freeze check of its own and relies entirely on this swap).
 * `tenant-do.ts`'s `buildAdapters()` calls this on every request instead of
 * caching the real/sandbox decision for the DO's lifetime.
 *
 * G1 (ga-gates-design-2026-07-22.md §G1) — `screening_status` is read in the
 * SAME query, replacing the former `screeningStatusStub` (which always
 * returned "clear" — the founder-accepted pilot risk, design Q2, now closed).
 * The column is written by `src/ofac/screening.ts`'s `screenTenant` at
 * checkout and at setup_infrastructure's brand rewrite (NB-1 disposition).
 * This function's signature and every downstream consumer are unchanged
 * (design line 38's explicit "no caller changes" guarantee) — the fresh-read
 * discipline above means a screening verdict flip is visible on the VERY NEXT
 * call too, exactly like a billing-state flip.
 */
export function readActivationState(sql: SqlStorage, tenantId: string): ActivationState {
  const row = sql
    .exec<{ plan: TenantPlan; status: string; billing_state: string; screening_status: ScreeningStatus }>(
      `SELECT plan, status, billing_state, screening_status FROM tenant_profile WHERE id = ?`,
      tenantId,
    )
    .one();
  const activated = isTenantActivated(row.plan, row.status, row.billing_state, row.screening_status);
  return { plan: row.plan, status: row.status, billingState: row.billing_state, activated };
}
