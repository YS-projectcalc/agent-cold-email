// THE ONE RESULT VOCABULARY (parent-class ruling, docs/adversarial/
// sweep-completeness-pass-2026-08-17.md §3).
//
// Six independent class sweeps proposed six wrappers with the same shape, which
// is the tell that they were all describing one defect:
//
//   PARENT CLASS — the outcome does not carry its own provenance. A result says
//   WHAT happened but not HOW WELL IT IS KNOWN: whether it is terminal, whether
//   it was delivered, whether it was collapsed into an earlier one, whether the
//   positive claim it makes was observed or merely inferred from absence.
//   Because the qualifier has no field, no caller can branch on it — so every
//   consumer takes the optimistic reading, and every one of them did.
//
// Declared HERE, once, rather than per-wrapper, because the same functions are
// in scope for more than one of them: `withRequestIdempotency` needs both
// terminality and (a later wave) collapse. Nesting the wrappers would give
// `Collapsed<Settled<T>>` and a signature that changes twice; a result type
// carrying independent OPTIONAL qualifier fields composes flat instead.
//
// These are deliberately plain types, not zod schemas: they qualify values that
// cross function boundaries inside the Worker, never a request body. The
// precedent for putting a contract in the type system rather than in reviewer
// discipline is errors.ts.

/**
 * Is this outcome FINAL, or does it still owe work?
 *
 * The distinction control flow cannot express: `return` means "this function is
 * done", never "the work is done". A saga that returns HTTP 202 while a domain's
 * DNS is still coming up has returned and owes everything. Where that difference
 * decides whether a result may be cached, replayed, or announced as an ending,
 * it has to be a value someone WROTE, because a reviewer cannot see a missing
 * one.
 *
 * `terminal: false` keeps the customer-facing value byte-identical — the caller
 * still gets its 202 — and only changes what the machinery around it is
 * entitled to conclude.
 */
export type Settled<T> = { terminal: boolean; value: T };

/** A finished outcome: safe to record, replay, and report as an ending. */
export function terminal<T>(value: T): Settled<T> {
  return { terminal: true, value };
}

/**
 * An outcome that returned while still owing work. Safe to hand THIS caller;
 * never safe to freeze as the answer for later callers.
 */
export function nonTerminal<T>(value: T): Settled<T> {
  return { terminal: false, value };
}

/**
 * Was this response produced fresh, or is it an earlier one handed back?
 *
 * The in-repo precedent is `ackMessage`'s `alreadyAcked` (engine/
 * tenant-messages.ts) — a no-op success that says so. The sites that lack it
 * return a collapse byte-identically to a real admission, so an agent in a loop
 * cannot tell that its second, genuinely different request was absorbed.
 */
export type Collapsed<T> = T & { deduplicated: boolean };

/**
 * Why a notification attempt ended the way it did. `delivered` is the only
 * field a claim may cite; `why` exists so an operator surface can distinguish
 * "we chose not to" from "we could not".
 *
 * - `sent` — the channel accepted it.
 * - `dark_channel` — no channel is configured (OPS_ALERT_EMAIL unset).
 * - `suppressed_cooldown` — deliberately withheld; an earlier alert stands.
 * - `pending_debounce` — withheld awaiting confirming observations.
 * - `send_failed` — the channel was asked and refused/errored.
 * - `no_notifier` — this path notified nobody: either nothing anywhere notifies
 *   for the condition, or the code composing the claim holds no result to cite.
 * - `nothing_owed` — no notification was due (a steady state, not a decision).
 * - `digest_only` (design §7.11, Q3) — the check's `AlertPolicy.channel` is
 *   `"digest"`: an email was never owed for ANY transition on this check,
 *   whatever `AlertAction` fired. Distinct from `dark_channel` (no channel
 *   configured at all) — this channel exists, it is simply not email.
 * - `reclassified` (design §7.17.3, N3) — a blame flip between the two
 *   `customer_progress_*` names: the abandoned name's state genuinely clears
 *   (so it cannot re-alert on the 24h step) but its RECOVERY email is
 *   withheld, because the tenant it was reporting on is still stalled, just
 *   under a different blamed name. Scoped to that flip pair — every other
 *   `no_longer_applicable` clear on the platform still emails.
 * - `pending_recovery` (alert-state design §3.5) — the check's producer reported
 *   HEALTHY but the episode is still holding open, awaiting
 *   `recoverAfterObservations` clean observations. Without it a `holding`
 *   transition fell through to `nothing_owed`, which says "there was nothing to
 *   tell" about a recovery that is actively being confirmed.
 * - `suppressed_key_cap` (§1.4) — the episode has already announced
 *   `MAX_ANNOUNCED_KEYS_PER_EPISODE` distinct materiality keys, so a further
 *   NOVEL condition under the same check name is not escalated. The count of
 *   these rides the next ladder email's body (`AnnouncedKeys.overflow`).
 * - `suppressed_daily_budget` (§5.5) — the rolling 24h announcement budget was
 *   full when this announcement came up for a slot. The episode's state still
 *   advanced; only the email waits, and `alert_budget_exceeded` reports that the
 *   channel is withholding.
 *
 * `nothing_owed` is separate from the withholding reasons on purpose: folding
 * "there was nothing to say" into "we chose not to say it" is how a delivery
 * failure and a quiet tick end up recorded as the same thing.
 */
export type DeliveryReason =
  | "sent"
  | "dark_channel"
  | "suppressed_cooldown"
  | "pending_debounce"
  | "send_failed"
  | "no_notifier"
  | "nothing_owed"
  | "digest_only"
  | "reclassified"
  | "pending_recovery"
  | "suppressed_key_cap"
  | "suppressed_daily_budget";

export interface Notified {
  delivered: boolean;
  why: DeliveryReason;
}

export const NOT_NOTIFIED: Notified = { delivered: false, why: "no_notifier" };

/**
 * On what grounds a monitoring check claims to be healthy.
 *
 * - `reobserved` — the positive condition was CHECKED at emission.
 * - `no_longer_applicable` — the entity merely left the unhealthy query, which
 *   is evidence of nothing. A released domain leaves the "stalled domains" set
 *   exactly like a recovered one does.
 *
 * The point of typing it is that the RENDERER can then refuse to repeat a
 * producer's prose on `no_longer_applicable`, so a false cause cannot reach the
 * founder even if someone writes one.
 */
export type RecoveryBasis = "reobserved" | "no_longer_applicable";

/**
 * The customer-facing sentence a code path may compose ONLY when it holds a
 * `Notified` with `delivered: true`. Exported so the honest alternative below
 * sits beside it and the pair is greppable as one decision.
 */
export const OPERATOR_NOTIFIED = "The operator has been notified.";

/**
 * What to say instead. Deliberately names the tool the customer's agent can
 * actually use, rather than implying someone is already on it.
 */
export const OPERATOR_NOT_CONFIRMED =
  "We could not confirm that an operator was notified — call contact_operator to reach a human.";

/** The claim, chosen by what actually happened. */
export function operatorNotifiedClause(notified: Notified): string {
  return notified.delivered ? OPERATOR_NOTIFIED : OPERATOR_NOT_CONFIRMED;
}
