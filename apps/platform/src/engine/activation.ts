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

/**
 * STUB — OFAC/sanctions screening. Increment I5 (unbuilt; see design §2.7 and
 * `docs/research/self-serve-activation-design-2026-07-21.md`) will replace
 * this with a real denied-party/SDN check backed by a persisted
 * `screening_status` column. Until then this ALWAYS returns "clear" so the
 * pilot's activation gate has a slot to consult without blocking on I5 (the
 * founder-accepted risk for the single trusted pilot — design Q2). Every
 * caller keys off the return value, not a hardcoded true, so widening this to
 * a real check needs no caller change.
 */
export function screeningStatusStub(_tenantId: string): ScreeningStatus {
  return "clear";
}

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
 */
export function readActivationState(sql: SqlStorage, tenantId: string): ActivationState {
  const row = sql
    .exec<{ plan: TenantPlan; status: string; billing_state: string }>(
      `SELECT plan, status, billing_state FROM tenant_profile WHERE id = ?`,
      tenantId,
    )
    .one();
  const activated = isTenantActivated(row.plan, row.status, row.billing_state, screeningStatusStub(tenantId));
  return { plan: row.plan, status: row.status, billingState: row.billing_state, activated };
}
