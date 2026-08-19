// The watchtower's ALERT VOCABULARY — what a check result is, which alert
// policy each named check gets, and how its email renders.
//
// Extracted from watchtower.ts because there are now TWO stores backing the
// same state machine, and the rules must be identical in both (CLAUDE.md rule
// c):
//  - `watchtower_state` in D1 (admin/watchtower.ts's reconcileAlerts) — every
//    ordinary platform/tenant check;
//  - the WatchtowerDO's own storage (watchtower-do.ts) — the D1-outage check
//    and the cron dead-man, which by definition cannot read D1.
// The transition RULE itself lives in `watchtower-policy.ts` (pure: no store,
// no clock, no mailer), so the anti-storm guarantee is one tested function
// rather than a rule copied per substrate.

import type { DeliveryReason, Notified, RecoveryBasis } from "@coldstart/shared";
import type { Env } from "../env.js";
import { escapeHtml } from "../html-escape.js";
import { OpsMailNotConfiguredError, type OpsMailer } from "../ops-mail/ops-mailer.js";
import {
  DEAD_MAN_ALERT_POLICY,
  DEBOUNCED_ALERT_POLICY,
  DEBOUNCED_DIGEST_ALERT_POLICY,
  IMMEDIATE_ALERT_POLICY,
  type AlertAction,
  type AlertPolicy,
  type AlertTransition,
} from "./watchtower-policy.js";

/** One health observation. `detail` is the human specifics that ride into the
 * alert body (never just the check name). */
/**
 * One health observation. `detail` is the human specifics that ride into the
 * alert body (never just the check name).
 *
 * A HEALTHY result must state the GROUNDS for its claim (docs/adversarial/
 * class-sweep-signal-inversion-2026-08-17.md, arm B). Three of these clears
 * announced a positive fact — "now has working mail DNS", "now has its engine
 * credentials pushed", "has eligible mailboxes again" — that nothing had
 * checked: they fired whenever the entity left a FILTERED unhealthy query, and
 * a domain that was released, a mailbox whose credentials were revoked on
 * teardown, and a tenant that simply ran out of due sends all leave those
 * queries exactly like a recovered one does.
 *
 * Making `basis` non-optional is the point: it does not compile until each
 * producer states which it is, and that is precisely the decision the old code
 * made implicitly. `no_longer_applicable` then makes `recoveryEmail` DISCARD
 * the producer's prose, so a false cause cannot reach the founder even if
 * someone writes one.
 */
export type CheckResult =
  | { name: string; healthy: false; detail: string }
  | { name: string; healthy: true; detail: string; basis: RecoveryBasis };

export interface AlertOutcome {
  name: string;
  action: AlertAction;
  emailSent: boolean;
  /** Why `emailSent` is what it is — see `Notified` (packages/shared). Lets an
   * operator surface tell "we chose not to" from "we could not tell you". */
  why: DeliveryReason;
}

// --- Check naming + human labels ------------------------------------------

// Human labels for the subject line (`[coldrig] <label>: UNHEALTHY`).
const CHECK_LABELS: Record<string, string> = {
  d1: "D1 database",
  // Honest scope (audit BLOCKING-3): this probe now touches BOTH DO classes —
  // the RateLimiterDO canary AND a TenantDO canary (the class that holds every
  // tenant's state, and the one the repo has twice wedged at construction).
  // A wedged INDIVIDUAL tenant is a separate, per-tenant check below.
  do_storage: "Durable Object storage",
  engine: "Engine /health",
  failure_signals: "Failure signals",
  // Audit BLOCKING-2 / NB-2 / NB-3 — the watchtower's own machinery.
  cron_sweep: "Ops sweep (cron)",
  cron_legs: "Ops sweep legs",
  warmup_cancel_gave_up: "Warmup cancellations gave up",
  // Item 1 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) — the
  // two account-wide InboxKit checks (admin/watchtower-vendor.ts).
  vendor_wallet: "InboxKit vendor wallet",
  warmup_duplicates: "Duplicate warmup subscriptions",
};

/**
 * Per-entity check-name prefixes (founder ruling 2026-08-06 — a stuck mailbox
 * purchase alerts on entering the stuck state AND on the re-buy's outcome).
 *
 * TWO names for the mailbox lane, not one, because the state machine suppresses
 * a repeat alert for the same check inside WATCHTOWER_COOLDOWN_MS: a failed
 * re-buy reported under the stuck check would be swallowed seconds after the
 * stuck alert that preceded it. Splitting them makes both outcomes reportable
 * while keeping each one deduped:
 *  - `mailbox_provisioning:<email>` — unhealthy on entering the stuck state;
 *    healthy again once the mailbox is resolved, which sends the RECOVERY email
 *    that reports a SUCCESSFUL re-buy.
 *  - `mailbox_rebuy:<email>` — unhealthy when the re-buy itself failed, or when
 *    the one-re-buy budget is spent and the address is being abandoned.
 *
 * Wave-2 §1c adds the two send-pipeline prefixes, and the 2026-08-06 audit adds
 * `tenant_do_wedged:` — all DISTINCT so none dedups another away.
 */
export const MAILBOX_PROVISIONING_CHECK = "mailbox_provisioning:";
export const MAILBOX_REBUY_CHECK = "mailbox_rebuy:";
export const CRED_PUSH_AGING_CHECK = "cred_push_aging:";
export const SEND_STARVED_CHECK = "send_starved:";
export const TENANT_DO_WEDGED_CHECK = "tenant_do_wedged:";
// Vendor-verdict class fix (2026-08-14) — the escalation edge a provisioned
// domain stuck at dns_status != 'ready' never had. Its own prefix so it cannot
// dedup against, or be deduped by, any mailbox-scoped check.
export const DOMAIN_DNS_AGING_CHECK = "domain_dns_aging:";
// Item 2 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class C
// stage 1) — a post-purchase mailbox/domain intent with no matching live row
// past the grace bound (engine/ops-summary.ts's mailboxOrphans/domainOrphans).
// Own prefixes, same reasoning as DOMAIN_DNS_AGING_CHECK above.
export const MAILBOX_ORPHAN_CHECK = "mailbox_orphan:";
export const DOMAIN_ORPHAN_CHECK = "domain_orphan:";
// I14 (design §7.11) — the stuck-customer check, split into TWO names so
// blame can carry a different channel: our own blocker (email, founder acts)
// vs the customer sitting still while paying (digest, "if they're paying,
// who cares" — founder ruling Q3). Own prefixes for the same reason every
// other pair above has one.
export const CUSTOMER_PROGRESS_OPERATOR_CHECK = "customer_progress_operator:";
export const CUSTOMER_PROGRESS_AGENT_CHECK = "customer_progress_agent:";

/**
 * The three checks whose names cross a module boundary, as constants rather
 * than literals. `cron_sweep` and `cron_legs` are the two the alert policy
 * EXEMPTS by name (`policyFor`) — a rename that silently moved either onto the
 * default policy would delete an exemption without a single test noticing — and
 * `d1` is decided inside the WatchtowerDO but named by the Worker's probe, so
 * the two halves must agree on the spelling to get the same policy.
 */
export const CRON_SWEEP_CHECK = "cron_sweep";
export const CRON_LEGS_CHECK = "cron_legs";
export const D1_CHECK = "d1";

export function labelFor(name: string): string {
  if (name.startsWith(MAILBOX_PROVISIONING_CHECK)) {
    return `Mailbox provisioning ${name.slice(MAILBOX_PROVISIONING_CHECK.length)}`;
  }
  if (name.startsWith(MAILBOX_REBUY_CHECK)) {
    return `Mailbox re-buy ${name.slice(MAILBOX_REBUY_CHECK.length)}`;
  }
  if (name.startsWith(CRED_PUSH_AGING_CHECK)) {
    return `Mailbox credentials ${name.slice(CRED_PUSH_AGING_CHECK.length)}`;
  }
  if (name.startsWith(SEND_STARVED_CHECK)) {
    return `Send capacity ${name.slice(SEND_STARVED_CHECK.length)}`;
  }
  if (name.startsWith(TENANT_DO_WEDGED_CHECK)) {
    return `Tenant state unreachable ${name.slice(TENANT_DO_WEDGED_CHECK.length)}`;
  }
  if (name.startsWith(DOMAIN_DNS_AGING_CHECK)) {
    return `Domain DNS stalled ${name.slice(DOMAIN_DNS_AGING_CHECK.length)}`;
  }
  if (name.startsWith(MAILBOX_ORPHAN_CHECK)) {
    return `Mailbox intent orphaned ${name.slice(MAILBOX_ORPHAN_CHECK.length)}`;
  }
  if (name.startsWith(DOMAIN_ORPHAN_CHECK)) {
    return `Domain intent orphaned ${name.slice(DOMAIN_ORPHAN_CHECK.length)}`;
  }
  if (name.startsWith(CUSTOMER_PROGRESS_OPERATOR_CHECK)) {
    return `Customer progress (operator-blocked) ${name.slice(CUSTOMER_PROGRESS_OPERATOR_CHECK.length)}`;
  }
  if (name.startsWith(CUSTOMER_PROGRESS_AGENT_CHECK)) {
    return `Customer progress (agent-side stall) ${name.slice(CUSTOMER_PROGRESS_AGENT_CHECK.length)}`;
  }
  return CHECK_LABELS[name] ?? name;
}

/** The watchtower check tracking whether ONE tenant is stalled with an
 *  operator-blamed owed step (§7.11) — email channel, our blocker. */
export function customerProgressOperatorCheckName(tenantId: string): string {
  return `${CUSTOMER_PROGRESS_OPERATOR_CHECK}${tenantId}`;
}

/** The sibling: a tenant stalled with no operator-blamed step — digest
 *  channel, the customer's own inaction while still paying. */
export function customerProgressAgentCheckName(tenantId: string): string {
  return `${CUSTOMER_PROGRESS_AGENT_CHECK}${tenantId}`;
}

/**
 * Which alert policy a named check gets — the ONE place the founder's
 * 2026-08-16 debounce is turned off, so every exemption is visible in one
 * screen and each one carries its own reason (an exemption inherits none of
 * the reasoning behind the guard it opts out of).
 *
 * The DEFAULT is debounced, deliberately: a new check is far more likely to be
 * another 5-minute cron probe than one of the three shapes below, and the
 * failure direction of a wrong default is one extra sweep of delay rather than
 * an alert that never arrives. `watchtower-policy.test.ts` enumerates every
 * check name this file knows about and fails if a new one is added without a
 * stated classification.
 */
export function policyFor(checkName: string): AlertPolicy {
  // C — the dead-man, HARD EXEMPTION (founder ruling 2026-08-16). It already
  // embodies a time threshold (SWEEP_STALE_MS) and it is the check of last
  // resort: when it fires, every other alert is silent, so double-delaying it
  // (or thinning it to daily) weakens the only signal that says so.
  if (checkName === CRON_SWEEP_CHECK) return DEAD_MAN_ALERT_POLICY;

  // Already damped upstream: `sweep-signals.ts` only reports this check after
  // LEG_ALERT_AFTER_SWEEPS consecutive bad ticks (15 min at the live cadence),
  // so a debounce here would make a genuinely broken sweep page at 20 min and
  // breach the founder's 10-15 min ceiling. The requirement the ruling asks for
  // is already satisfied — twice over — before the result reaches the machine.
  if (checkName === CRON_LEGS_CHECK) return IMMEDIATE_ALERT_POLICY;

  // ONE-SHOT event reports (`reportCheck`, from engine/mailbox-acquisition.ts).
  // Nothing re-observes these: they are raised once by whatever hit the
  // condition, around real vendor spend. "2 consecutive observations" is not a
  // delay for them, it is permanent silence.
  if (checkName.startsWith(MAILBOX_PROVISIONING_CHECK) || checkName.startsWith(MAILBOX_REBUY_CHECK)) {
    return IMMEDIATE_ALERT_POLICY;
  }

  // §7.11 (Q3) — the ONE place the blame-split channel routing happens.
  // Same cadence as every other re-observed check; only the channel differs.
  if (checkName.startsWith(CUSTOMER_PROGRESS_AGENT_CHECK)) return DEBOUNCED_DIGEST_ALERT_POLICY;

  return DEBOUNCED_ALERT_POLICY;
}

// --- Email bodies ---------------------------------------------------------

export interface OutgoingAlert {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * The email a transition implies, or null when it implies none. Both stores
 * render through this, so a D1-outage alert and an ordinary check alert are
 * byte-identical in shape. `prevSinceTs` is the state being LEFT (only a
 * recovery needs it, to report how long the check was down).
 */
export function alertEmailFor(
  env: Env,
  result: CheckResult,
  transition: AlertTransition,
  prevSinceTs: number | null,
  nowMs: number,
  policy: AlertPolicy,
): OutgoingAlert | null {
  // §7.11 (Q3) — a digest-channel check never owes an email, whatever the
  // transition. The caller (`reconcileAlerts`) is responsible for recording
  // `why: "digest_only"` when this returns null for that reason.
  if (policy.channel === "digest") return null;
  switch (transition.action) {
    case "alerted":
      return unhealthyEmail(env, result, nowMs, false);
    case "realerted":
      return unhealthyEmail(env, result, transition.next.sinceTs, true);
    case "recovered":
      // `recovered` is only ever produced from a healthy observation
      // (watchtower-policy.ts's decideAlert), so the narrowing always holds;
      // the guard keeps it a type fact rather than a comment.
      return result.healthy ? recoveryEmail(env, result, prevSinceTs ?? nowMs, nowMs) : null;
    default:
      return null;
  }
}

function unhealthyEmail(env: Env, result: CheckResult, sinceTs: number, isReAlert: boolean): OutgoingAlert {
  const label = labelFor(result.name);
  const persistence = isReAlert ? `\n\nStill unhealthy since ${new Date(sinceTs).toISOString()} (re-alert after cooldown).` : "";
  const text = `Check "${label}" (${result.name}) is UNHEALTHY.\n\n${result.detail}${persistence}\n\nThis is an automated coldrig watchtower alert.`;
  return {
    to: env.OPS_ALERT_EMAIL,
    subject: `[coldrig] ${label}: UNHEALTHY`,
    text,
    html: `<p>Check <strong>${escapeHtml(label)}</strong> (<code>${escapeHtml(result.name)}</code>) is <strong>UNHEALTHY</strong>.</p><p>${escapeHtml(result.detail)}</p>${isReAlert ? `<p>Still unhealthy since ${escapeHtml(new Date(sinceTs).toISOString())} (re-alert after cooldown).</p>` : ""}<p>This is an automated coldrig watchtower alert.</p>`,
  };
}

/**
 * The RECOVERED email. On `no_longer_applicable` the producer's `detail` is
 * DELIBERATELY DISCARDED and replaced with the only thing that is actually
 * known: the entity left this check's scope. That is the enforcement half of
 * arm B — a fixer can still write an over-confident sentence at a clear site,
 * and it will never reach the founder, because the renderer refuses to repeat
 * a claim the result did not earn.
 */
function recoveryEmail(
  env: Env,
  result: Extract<CheckResult, { healthy: true }>,
  sinceTs: number,
  nowMs: number,
): OutgoingAlert {
  const label = labelFor(result.name);
  const durationLine = `Was unhealthy for ~${Math.round((nowMs - sinceTs) / 60000)} min.`;
  const headline = result.basis === "reobserved" ? "has RECOVERED" : "is NO LONGER TRACKED";
  const body =
    result.basis === "reobserved"
      ? result.detail
      : `${result.name} left this check's scope — the entity is no longer in the population this check watches. ` +
        `This is NOT evidence that the condition was fixed; nothing re-verified it.`;
  const text = `Check "${label}" (${result.name}) ${headline}.\n\n${body}\n${durationLine}\n\nThis is an automated coldrig watchtower alert.`;
  return {
    to: env.OPS_ALERT_EMAIL,
    subject: `[coldrig] ${label}: ${result.basis === "reobserved" ? "RECOVERED" : "NO LONGER TRACKED"}`,
    text,
    html: `<p>Check <strong>${escapeHtml(label)}</strong> (<code>${escapeHtml(result.name)}</code>) ${escapeHtml(headline)}.</p><p>${escapeHtml(body)}</p><p>${escapeHtml(durationLine)}</p><p>This is an automated coldrig watchtower alert.</p>`,
  };
}

/**
 * Send, never throw — and report WHICH of the three outcomes happened, because
 * the caller's alert state is only allowed to advance on one of them
 * (docs/adversarial/class-sweep-cached-terminal-2026-08-17.md member 5).
 *
 * The boolean this used to return was discarded at every call site, so a dark
 * channel and a delivered email were recorded identically: `last_alert_ts` —
 * documented in migrations/0008_watchtower.sql as "last time an alert was
 * actually SENT" — was stamped either way, the backoff engaged, and on recovery
 * the founder got a RECOVERED email for an incident nobody had ever announced.
 * An unsendable alert still must not take down the sweep, so this still never
 * throws; what changes is that the caller can tell.
 */
export async function trySend(mailer: OpsMailer, alert: OutgoingAlert): Promise<Notified> {
  try {
    await mailer.send(alert);
    return { delivered: true, why: "sent" };
  } catch (err) {
    console.error(`watchtower: failed to send "${alert.subject}"`, err);
    return {
      delivered: false,
      why: err instanceof OpsMailNotConfiguredError ? "dark_channel" : "send_failed",
    };
  }
}

/**
 * What an event-driven caller (`reportCheck`) may claim about its own alert.
 *
 * `reportCheck` returns `AlertOutcome | null` and every caller threw it away,
 * so code paths that compose "the operator has been notified" for a CUSTOMER
 * were asserting delivery they had no evidence of: the alert may have been
 * withheld pending a confirming observation, suppressed inside the 6h cooldown,
 * sent into a dark channel, or lost to a `reportCheck` that swallowed a throw
 * (`null`). This is the one translation from that outcome to a claim.
 */
export function notifiedFromOutcome(outcome: AlertOutcome | null): Notified {
  // null = reportCheck caught and logged; nothing reached the state machine.
  if (!outcome) return { delivered: false, why: "send_failed" };
  return { delivered: outcome.emailSent, why: outcome.why };
}

/**
 * Why no email was owed for a transition that composed none. Kept beside
 * `AlertAction` semantics rather than inlined so "we chose not to tell you"
 * cannot quietly stand in for "there was nothing to tell".
 */
export function reasonForNoEmail(action: AlertAction): DeliveryReason {
  if (action === "pending") return "pending_debounce";
  if (action === "suppressed") return "suppressed_cooldown";
  return "nothing_owed";
}
