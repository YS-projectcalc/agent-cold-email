// THE PER-FAMILY ALERT FACTS — one table, three questions.
//
// For every watchtower check family: which MATERIALITY KEYS its producer may
// state, whether its instances are per-entity (so the daily budget's reserved
// slice applies), and whether its announcements are budgeted at all.
//
// WHY ONE TABLE AND NOT THREE (alert-state design §1.2, §5.5): all three
// questions are answered per family and all three are load-bearing for the same
// anti-storm property. Split across three files they drift — a family added to
// the key table and missed by the budget scope is exactly the "a shared
// primitive's caveat wired to one consumer" shape this repo has hit three times.
// `watchtower-families.test.ts` reds when a check name declared in
// `watchtower-alerts.ts` has no row here, so a new family cannot inherit any of
// the three silently.
//
// WHY A KEY IS NEVER THE DETAIL STRING (§1.1). `tenant_do_wedged:`'s detail
// embeds `errMsg(err)`; `vendor_wallet`'s embeds `JSON.stringify(body)`;
// `failure_signals`' and `sweep_coverage`'s embed counts that move almost every
// tick. Keying an escalation on any of them means one email per variant — the
// storm the announced ledger exists to bound. A key is a producer-stated
// classification over a CLOSED enumeration, derived from structured facts the
// producer already holds.

import type { NextStepReason } from "@coldstart/shared";
import {
  ALERT_BUDGET_EXCEEDED_CHECK,
  ALERT_DELIVERY_CHECK,
  CRED_PUSH_AGING_CHECK,
  CRON_LEGS_CHECK,
  CRON_SWEEP_CHECK,
  CUSTOMER_PROGRESS_AGENT_CHECK,
  CUSTOMER_PROGRESS_OPERATOR_CHECK,
  D1_CHECK,
  DOMAIN_DNS_AGING_CHECK,
  DOMAIN_ORDINAL_FAILED_CHECK,
  DOMAIN_ORPHAN_CHECK,
  FAILURE_SIGNALS_CHECK,
  MAILBOX_ORPHAN_CHECK,
  MAILBOX_PROVISIONING_CHECK,
  MAILBOX_REBUY_CHECK,
  MAILBOX_RELEASE_FAILED_CHECK,
  MAILBOX_SLOT_FAILED_CHECK,
  SEND_STARVED_CHECK,
  SWEEP_COVERAGE_CHECK,
  SWEEP_SIGNALS_CHECK,
  TENANT_DO_WEDGED_CHECK,
} from "./watchtower-alerts.js";

/** Whether a family's instances multiply with the platform's entity count. */
export type FamilyScope = "global" | "per_entity";

/**
 * Whether this family's announcements consume the daily budget (§5.5).
 *
 * `exempt` is never a convenience: each member below states which of the three
 * exemption groups it is in and why, because an exemption inherits none of the
 * reasoning behind the guard it opts out of.
 */
export type FamilyBudget = "counted" | "exempt";

export interface AlertFamily {
  /** The CLOSED set of materiality keys this family's producers may state. */
  readonly keys: readonly string[];
  readonly scope: FamilyScope;
  readonly budget: FamilyBudget;
}

/** The four action classes both `customer_progress_*` names share. */
const CUSTOMER_PROGRESS_KEYS: readonly string[] = ["ours_to_fix", "capacity_or_money", "waiting_on_infra", "customer_side"];

/**
 * Every family, by exact check name or by per-entity prefix.
 *
 * `|keys|` IS CAPPED BY CONSTRUCTION AT 4 (§1.2/B3), and
 * `MAX_ANNOUNCED_KEYS_PER_EPISODE` is strictly greater — see its docstring for
 * why that inequality is the whole safety argument. Three v1 spaces were
 * narrowed to reach it, each with a stated loss:
 *
 *  - `cron_legs` keyed on the SET of failing legs (combinatorial) -> the KIND of
 *    failure. LOSS: leg A erroring and later leg B erroring is one key and gets
 *    no escalation email; the body updates and the ladder still fires.
 *  - `customer_progress_*` keyed on the reason (12) -> the action class (4).
 *  - `failure_signals` three count bands -> two. LOSS: a 3 -> 15 jump no longer
 *    escalates; a 3 -> 120 jump does.
 */
export const ALERT_FAMILIES: Readonly<Record<string, AlertFamily>> = {
  // --- Global platform checks -------------------------------------------
  [D1_CHECK]: { keys: ["down"], scope: "global", budget: "counted" },
  do_storage: { keys: ["down"], scope: "global", budget: "counted" },
  engine: { keys: ["down"], scope: "global", budget: "counted" },
  [FAILURE_SIGNALS_CHECK]: {
    // Banded over the GRADED severity, never the raw count: re-expressing the
    // observation as a rate over a denominator (the scale train's fix for the
    // global roll-up pinning unhealthy at 100+ tenants) changes the band inputs
    // and nothing else here.
    keys: ["failed_elevated", "failed_severe", "complaints", "sustained_subthreshold"],
    scope: "global",
    budget: "counted",
  },
  [CRON_LEGS_CHECK]: { keys: ["counted", "threw", "both"], scope: "global", budget: "counted" },
  warmup_cancel_gave_up: { keys: ["gaveup_b1", "gaveup_b2", "gaveup_b3"], scope: "global", budget: "counted" },
  [SWEEP_COVERAGE_CHECK]: {
    keys: ["slice_unreadable", "rotation_behind", "in_tick_deferral", "both"],
    scope: "global",
    budget: "counted",
  },
  [SWEEP_SIGNALS_CHECK]: { keys: ["threw"], scope: "global", budget: "counted" },
  [ALERT_DELIVERY_CHECK]: { keys: ["dark_channel", "send_failed", "both"], scope: "global", budget: "counted" },
  vendor_wallet: {
    keys: ["unreachable", "shape_drift", "below_floor_autotopup_on", "below_floor_autotopup_off"],
    scope: "global",
    budget: "counted",
  },
  warmup_duplicates: { keys: ["dup_b1", "dup_b2"], scope: "global", budget: "counted" },

  // --- Budget-exempt group 1: the check of last resort -------------------
  // When the dead-man fires every other alert in the platform is already
  // silent, so budgeting it would delete the one signal that says so. It is
  // also hard-exempt from the escape entirely (single-valued key space).
  [CRON_SWEEP_CHECK]: { keys: ["stale"], scope: "global", budget: "exempt" },

  // --- Budget-exempt group 3: the alarm on the budget itself -------------
  // It goes unhealthy exactly when the budget is full, so budgeting it makes it
  // self-suppressing — simulated over a 7-day storm, 0 sent / 2015 withheld,
  // and the founder is never told the channel is rate-limited. That is this
  // repo's own recorded class (an alarm that depends on the thing it monitors),
  // and it is the same reason `cron_sweep` is exempt from the debounce.
  [ALERT_BUDGET_EXCEEDED_CHECK]: { keys: ["saturated"], scope: "global", budget: "exempt" },

  // --- Budget-exempt group 2: one-shot, money-bearing --------------------
  // Suppressing one of these is a silent billable loss (two of the three name
  // money that keeps being spent until a human intervenes); suppressing a
  // repeat REMINDER is not. Nothing re-observes them, so a delayed announcement
  // is a deleted one. RESIDUAL, stated: a correlated BATCH (100 tenants'
  // releases failing in one tick) is unbounded, because each item is
  // deliberately its own check name and its own money — the mitigation is one
  // email per failed BATCH and belongs at the producer, which already holds the
  // whole list (design §7.8), not in the budget.
  [MAILBOX_PROVISIONING_CHECK]: {
    keys: ["lookup_failed", "too_recent", "rebuy_attempting"],
    scope: "per_entity",
    budget: "exempt",
  },
  [MAILBOX_REBUY_CHECK]: {
    keys: ["unusable_at_vendor", "budget_spent", "dispatch_failed"],
    scope: "per_entity",
    budget: "exempt",
  },
  [MAILBOX_RELEASE_FAILED_CHECK]: { keys: ["vendor_threw", "still_slot_counted"], scope: "per_entity", budget: "exempt" },
  [DOMAIN_ORDINAL_FAILED_CHECK]: { keys: ["setup_threw", "paid_no_infra"], scope: "per_entity", budget: "exempt" },
  [MAILBOX_SLOT_FAILED_CHECK]: { keys: ["buy_threw", "paid_no_infra"], scope: "per_entity", budget: "exempt" },

  // --- Per-entity, budgeted ---------------------------------------------
  [CRED_PUSH_AGING_CHECK]: { keys: ["aging"], scope: "per_entity", budget: "counted" },
  [SEND_STARVED_CHECK]: { keys: ["starved"], scope: "per_entity", budget: "counted" },
  [TENANT_DO_WEDGED_CHECK]: {
    // A CLOSED map over `err.name`, never `err.message` — the message embeds the
    // RPC's own prose and would key one email per variant.
    keys: ["rpc_unreachable", "constructor_throw", "storage_throw", "other"],
    scope: "per_entity",
    budget: "counted",
  },
  [DOMAIN_DNS_AGING_CHECK]: { keys: ["pending", "gave_up"], scope: "per_entity", budget: "counted" },
  [MAILBOX_ORPHAN_CHECK]: { keys: ["orphaned"], scope: "per_entity", budget: "counted" },
  [DOMAIN_ORPHAN_CHECK]: { keys: ["orphaned"], scope: "per_entity", budget: "counted" },
  [CUSTOMER_PROGRESS_OPERATOR_CHECK]: { keys: CUSTOMER_PROGRESS_KEYS, scope: "per_entity", budget: "counted" },
  [CUSTOMER_PROGRESS_AGENT_CHECK]: { keys: CUSTOMER_PROGRESS_KEYS, scope: "per_entity", budget: "counted" },
};

/** Prefix families, longest first so `customer_progress_operator:` is matched
 * before any shorter prefix that might one day share its head. */
const PREFIX_FAMILIES = Object.keys(ALERT_FAMILIES)
  .filter((name) => name.endsWith(":"))
  .sort((a, b) => b.length - a.length);

/** The family row for a concrete check name, or `null` when it has none —
 * which `decideAlert`'s caller must treat as "cannot alert" (§1.1.2). */
export function familyFor(checkName: string): AlertFamily | null {
  const exact = ALERT_FAMILIES[checkName];
  if (exact) return exact;
  const prefix = PREFIX_FAMILIES.find((p) => checkName.startsWith(p));
  return prefix ? (ALERT_FAMILIES[prefix] ?? null) : null;
}

/** Does the daily budget's 15-of-20 per-entity sub-cap apply to this check? */
export function isPerEntityCheck(checkName: string): boolean {
  return familyFor(checkName)?.scope === "per_entity";
}

/** Is this check's announcement exempt from the daily budget entirely? */
export function isBudgetExemptCheck(checkName: string): boolean {
  return familyFor(checkName)?.budget === "exempt";
}

// --- Key derivations the producers share ----------------------------------
//
// Each of these is the ONE place its family's key is derived, so a producer and
// the table cannot drift. They take the structured facts the producer already
// holds — never a rendered string.

/** `failure_signals`' banded severity. `sustained_subthreshold` is stated by the
 * dead-band hold arm directly (§4), not derived from counts. */
export function failureSignalsKey(failed: number, complaints: number): string {
  if (failed >= 100) return "failed_severe";
  if (failed > 0) return "failed_elevated";
  return "complaints";
}

/** `cron_legs`' KIND of failure: a leg that was counting errors is now THROWING
 * is the escalation that changes the founder's action. Which legs they are
 * rides the body, at zero email cost. */
export function cronLegsKey(threw: boolean, counted: boolean): string {
  if (threw && counted) return "both";
  return threw ? "threw" : "counted";
}

/** `sweep_coverage`'s two independent ways of not keeping up. */
export function sweepCoverageKey(sliceUnreadable: boolean, rotationBehind: boolean, inTickDeferral: boolean): string {
  if (sliceUnreadable) return "slice_unreadable";
  if (rotationBehind && inTickDeferral) return "both";
  return rotationBehind ? "rotation_behind" : "in_tick_deferral";
}

/** `alert_delivery`'s reasons, already a closed `DeliveryReason` subset at the
 * producer. Never a catch-all: the new `suppressed_key_cap` /
 * `suppressed_daily_budget` reasons are DELIBERATE withholdings, not delivery
 * failures, and must not false-count as either arm here (design §7.2). */
export function alertDeliveryKey(reasons: readonly string[]): string {
  const dark = reasons.includes("dark_channel");
  const failed = reasons.includes("send_failed");
  if (dark && failed) return "both";
  return dark ? "dark_channel" : "send_failed";
}

/** `warmup_duplicates`' two bands (1 / 2+). A band, not the count: the count
 * moves as subscriptions are found and cancelled, and one email per value is
 * the storm the ledger exists to bound. */
export function warmupDuplicatesKey(duplicates: number): string {
  return duplicates >= 2 ? "dup_b2" : "dup_b1";
}

/** `warmup_cancel_gave_up`'s three bands (1 / 2-4 / 5+). */
export function warmupGaveUpKey(gaveUp: number): string {
  if (gaveUp >= 5) return "gaveup_b3";
  return gaveUp >= 2 ? "gaveup_b2" : "gaveup_b1";
}

/**
 * `tenant_do_wedged:`'s CLOSED map over `err.name`.
 *
 * The default is `other` on purpose and it is not a hole: `err.name` is
 * attacker-influenced only in the sense that a new runtime error class appears,
 * and the cap invariant (`MAX_ANNOUNCED_KEYS_PER_EPISODE > max(|space|)`) holds
 * regardless of whether this map is right — which is the point of the cap.
 */
export function tenantDoWedgedKey(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TypeError" || name === "ReferenceError") return "constructor_throw";
  if (name === "DurableObjectError" || name === "StorageError") return "storage_throw";
  if (name === "Error" || name === "") return "rpc_unreachable";
  return "other";
}

/**
 * `customer_progress_*`'s action class — a CLOSED map over all 12
 * `NEXT_STEP_REASONS`, applied to the highest-precedence owed step.
 *
 * Keying on the reason itself gives 12; keying on `waitingOn` gives 3 but is
 * near-constant per name (the blame is already IN the name). The action class
 * is the fact the founder acts on. Exhaustive by construction: a 13th reason
 * fails to compile here, which is what `watchtower-families.test.ts` pins.
 */
const CUSTOMER_PROGRESS_ACTION_CLASS: Record<NextStepReason, string> = {
  paid_seats_unprovisioned: "ours_to_fix",
  setup_operator_blocked: "ours_to_fix",
  billed_quantity_drift: "ours_to_fix",
  setup_capacity_held: "capacity_or_money",
  account_frozen: "capacity_or_money",
  domain_dns_incomplete: "waiting_on_infra",
  ordinal_incomplete: "waiting_on_infra",
  ordinal_slot_shortfall: "waiting_on_infra",
  mailbox_credentials_pending: "waiting_on_infra",
  seat_headroom_free: "customer_side",
  message_action_required: "customer_side",
  ready_to_launch: "customer_side",
};

export function customerProgressKey(owedReasons: readonly NextStepReason[]): string {
  // `owedReasons` arrives in the producer's own derivation order (state,
  // messages, credentials, launch — engine/next-steps.ts's `owedFirst`), so the
  // first entry IS the highest-precedence owed step. An empty list cannot reach
  // here: the check is only unhealthy when `owedCount > 0`.
  const first = owedReasons[0];
  return first ? CUSTOMER_PROGRESS_ACTION_CLASS[first] : "customer_side";
}
