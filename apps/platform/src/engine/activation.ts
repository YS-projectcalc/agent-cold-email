// I1 (self-serve activation design, 2026-07-21) — the product-driven
// activation gate that REPLACES the manual `ENGINE_TENANTS` allowlist and the
// hard-`false` `realAdaptersActivated` flag (vendors/factory.ts's prior
// mechanism). No operator ever touches an allowlist again: paying flips
// `billing_state` to 'active' (engine/billing.ts), which flips activation on;
// stopping payment (dunning -> suspend, or dispute) trips `isLifecycleFrozen`
// (billing-state.ts), which flips it off — the existing freeze/abuse machine
// IS the deactivation mechanism, for free. See design §2.1.

import { isPaidPlan, type TenantPlan } from "@coldstart/shared";
import type { Env } from "../env.js";
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
 *        plan is the paid plan (isPaidPlan)
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
  return isPaidPlan(plan) && billingState === "active" && !isLifecycleFrozen(status, billingState) && screening === "clear";
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

// G3 (ga-gates-design-2026-07-22.md §G3) — the HONEST activation state a paid
// tenant is actually in, surfaced to the agent (account JSON + MCP tool) and the
// human (dashboard banner). Fixes the confident-wrong where a PAID,
// billing_state='active' tenant whose real send path isn't live silently gets a
// SandboxEmailPort and sees "successful" sends that never leave.
export type ActivationSurfaceState =
  | "sandbox" // demo/free — sandbox is expected + honest
  | "suspended" // billing frozen / lapsed (dunning suspend, dispute, past_due)
  | "canceled" // cancellation finalized/scheduled
  | "screening_hold" // held for OFAC/sanctions review (G1b; stubbed 'clear' for now)
  | "capacity_pending" // paid+armed but a spend-ceiling / plan-slot gate is holding provisioning (G2/G4)
  | "pending_provisioning" // paid+active but the real send path (engine+InboxKit) isn't live yet
  | "active"; // paid, active, real send path live — really sending

/**
 * The FULL real end-to-end send path (adversary B2 corrected formula): the
 * external engine (real EmailPort) AND InboxKit (real mailboxes) must BOTH be
 * armed. An engine-armed-but-InboxKit-unbound paid tenant gets a real EmailPort
 * but SANDBOX mailboxes (factory.ts:113 `useSandbox = … || !inboxKitConfig`) —
 * nothing actually leaves — so an engine-ONLY check would falsely report
 * 'active', recreating the exact confident-wrong G3 exists to kill. The domain
 * REGISTRAR is deliberately NOT part of this conjunct: a tenant sends from
 * already-provisioned / BYO-connected mailboxes without ever buying a domain.
 */
export function realSendPathLive(env: Env): boolean {
  return Boolean(env.ENGINE_BASE_URL && env.ENGINE_AUTH_SECRET && env.INBOXKIT_API_KEY && env.INBOXKIT_WORKSPACE_ID);
}

/**
 * Wave-2 ACTIVATION PREDICATE — may the CRON drive this tenant's send pipeline?
 *
 * Evaluated INSIDE the TenantDO (tenant-do.ts's runScheduledTick /
 * runScheduledPoll) on every call, from FRESH SQL reads with nothing cached, so
 * no future route, MCP tool or alarm can arm automatic sending by reaching a
 * different entry point: the cron is a dumb driver and this is the gate.
 *
 * The four legs, and what each one alone prevents:
 *  1. paid plan — a demo/free tenant's whole world is the sandbox; automatic
 *     real sending is not a thing it can have. Read fresh rather than from
 *     TenantDO's cached `this.plan` (which is only ever more restrictive, but
 *     "only ever" is not a guarantee worth depending on in a send gate).
 *  2. `clock_mode='real'` — the L4/L5 interlock. The one-shot clock migration
 *     stamps this INSIDE its own transaction, so an unmigrated (or
 *     rolled-back) tenant is structurally unreachable by the driver: its rows
 *     still carry frozen virtual timestamps, and sending against those would
 *     mean sending on a schedule rebased to a time base that no longer exists.
 *  3. the EXACT existing activation predicate (paid AND billing_state='active'
 *     AND not lifecycle-frozen AND screening clear) — reused, never re-derived,
 *     so past_due / suspended / canceling / disputed / OFAC-review all block
 *     here by construction rather than by an enumeration that can drift.
 *  4. `realSendPathLive` — without it a paid, activated tenant gets a SANDBOX
 *     EmailPort and the cron would mass-produce fake "sent" events that never
 *     left the building.
 *
 * `runTick`'s own internal freeze guard stays in place as the belt.
 */
export interface SendDriverGate {
  allowed: boolean;
  /** Why the driver skipped this tenant — logged by the cron leg; never customer-facing. */
  reason: string;
}

export function readSendDriverGate(sql: SqlStorage, tenantId: string, env: Env): SendDriverGate {
  const row = sql
    .exec<{ plan: TenantPlan; clock_mode: string }>(`SELECT plan, clock_mode FROM tenant_profile WHERE id = ?`, tenantId)
    .toArray()[0];
  if (!row) return { allowed: false, reason: "no tenant_profile row" };
  if (!isPaidPlan(row.plan)) return { allowed: false, reason: `plan '${row.plan}' is not a paid plan` };
  if (row.clock_mode !== "real") return { allowed: false, reason: "clock_mode is not 'real' (clock migration has not committed)" };
  if (!readActivationState(sql, tenantId).activated) return { allowed: false, reason: "tenant is not activated (billing/lifecycle/screening)" };
  if (!realSendPathLive(env)) return { allowed: false, reason: "the real send path is not live (ENGINE_*/INBOXKIT_* unarmed)" };
  return { allowed: true, reason: "" };
}

/**
 * PURE activation-surface derivation (design §G3). Derive-don't-store, mirroring
 * isTenantActivated. Branch order is load-bearing: the billing freeze is checked
 * BEFORE screening (adversary minor) so a disputed+in-review tenant shows its
 * dispute freeze, not a masking "account review". `capacity_pending` is a
 * sub-state of an otherwise-active tenant (a spend/slot gate is holding new
 * provisioning) — surfaced only when the marker is set.
 */
export function deriveActivationState(args: {
  plan: TenantPlan;
  status: string;
  billingState: string;
  screening: ScreeningStatus;
  realSendPathLive: boolean;
  capacityPending: boolean;
}): ActivationSurfaceState {
  if (!isPaidPlan(args.plan)) return "sandbox";
  if (isLifecycleFrozen(args.status, args.billingState)) {
    return args.billingState === "canceled" || args.billingState === "canceling" ? "canceled" : "suspended";
  }
  if (args.billingState === "past_due") return "suspended"; // billing lapsed — not isLifecycleFrozen, but display as suspended
  if (args.screening === "review") return "screening_hold";
  if (args.billingState === "active") {
    if (!args.realSendPathLive) return "pending_provisioning";
    if (args.capacityPending) return "capacity_pending";
    return "active";
  }
  // Paid tier but billing_state still 'none' (minted, never completed checkout):
  // infrastructure not armed — honestly pending, never a fake 'active'.
  return "pending_provisioning";
}
