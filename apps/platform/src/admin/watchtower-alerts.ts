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
  type AlertObservation,
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
 *
 * `materiality` on the UNHEALTHY arm is the exact same device for the exact same
 * reason (alert-state design §1.1). The suppression used to decide on a
 * two-valued healthy/unhealthy comparison, so it could not tell a repeat from an
 * escalation: inside an announced episode `last_detail` was overwritten and
 * NOTHING was compared, and a second, genuinely worse condition under the same
 * check name reached the founder as an edited string on a suppressed row. The
 * key is a producer-stated classification over a CLOSED enumeration
 * (`ALERT_FAMILIES`), never the detail string and never a count — those embed
 * `errMsg(err)`, `JSON.stringify(body)` and per-tick counts, so keying on them
 * means one email per variant.
 */
export type CheckResult =
  | { name: string; healthy: false; detail: string; materiality: string }
  | { name: string; healthy: true; detail: string; basis: RecoveryBasis };

/** The observation a `CheckResult` makes, without the name or the prose — what
 * the pure state machine actually decides on. */
export function observationOf(result: CheckResult): AlertObservation {
  return result.healthy ? { healthy: true, basis: result.basis } : { healthy: false, materiality: result.materiality };
}

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
  // Scale audit S1/S4/S11 + sweep-completeness W-M1/W-M4 — the three things
  // the sweep could not say about ITSELF (admin/sweep-signals.ts).
  sweep_coverage: "Ops sweep coverage",
  sweep_signals: "Ops sweep signal reporting",
  alert_delivery: "Founder alert delivery",
  // Item 1 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) — the
  // two account-wide InboxKit checks (admin/watchtower-vendor.ts).
  vendor_wallet: "InboxKit vendor wallet",
  warmup_duplicates: "Duplicate warmup subscriptions",
  // Alert-state design §5.5 — the alerting channel reporting on itself.
  alert_budget_exceeded: "Founder alert budget",
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
// The three isolated-loop failures that reached no watchtower check at all
// (docs/adversarial/wave-1-2-integration-gate-2026-08-18.md §6) — they were
// customer-visible activity rows only. Own prefixes per item for the same
// reason every pair above has one, and ONE-SHOT (see `policyFor`): nothing
// re-observes a release that already failed.
export const MAILBOX_RELEASE_FAILED_CHECK = "mailbox_release_failed:";
export const DOMAIN_ORDINAL_FAILED_CHECK = "domain_ordinal_failed:";
export const MAILBOX_SLOT_FAILED_CHECK = "mailbox_slot_failed:";

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

/** The cross-tenant failure roll-up. A constant because THREE places now agree
 * on the spelling — the producer, the roster, and the partial-scan hold that
 * has to read its own current status (N3). */
export const FAILURE_SIGNALS_CHECK = "failure_signals";

/**
 * The sweep's coverage check (scale audit S4 + S11). SEPARATE from `cron_legs`
 * on purpose: `skippedForLegDeadline` used to be folded into the same
 * observation as `errors`, and it is set every cycle the rotation cannot reach
 * every tenant — which is not a fault, it is the design working. At scale it is
 * non-zero on EVERY tick, permanently, so the leg check pinned unhealthy and a
 * genuinely dying leg produced no new alert at all, only an edited `detail`
 * string on an already-suppressed row. Capacity gets its own name.
 */
export const SWEEP_COVERAGE_CHECK = "sweep_coverage";

/**
 * The alerting leg reporting on ITSELF (W-M4). `reportSweepSignals` builds its
 * observation from a bag constructed before it runs, so its own throw was
 * reported by nothing while the heartbeat kept the dead-man green.
 */
export const SWEEP_SIGNALS_CHECK = "sweep_signals";

/**
 * Alerts that were OWED this tick and did not reach the founder (W-M1). The
 * information existed — every `AlertOutcome` carries `emailSent` and a `why` —
 * and `collectLegSignals` could not see it, because `counterOf` reads three
 * NUMBER field names and an outcome array has none. The founder was told the
 * monitor was healthy on the exact tick the monitor could not reach them.
 */
export const ALERT_DELIVERY_CHECK = "alert_delivery";

/**
 * The ANNOUNCEMENT CHANNEL reporting that it is withholding (alert-state design
 * §5.5).
 *
 * A FAMILY rather than a key on an existing check, by §4's rule: a new family is
 * warranted when the SUBJECT is new; a materiality key when the subject is the
 * same and only the rung differs. Its subject is the alerting channel itself,
 * not any platform condition, and no existing check's key could carry it.
 */
export const ALERT_BUDGET_EXCEEDED_CHECK = "alert_budget_exceeded";

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
  if (name.startsWith(MAILBOX_RELEASE_FAILED_CHECK)) {
    return `Mailbox release failed ${name.slice(MAILBOX_RELEASE_FAILED_CHECK.length)}`;
  }
  if (name.startsWith(DOMAIN_ORDINAL_FAILED_CHECK)) {
    return `Domain setup failed ${name.slice(DOMAIN_ORDINAL_FAILED_CHECK.length)}`;
  }
  if (name.startsWith(MAILBOX_SLOT_FAILED_CHECK)) {
    return `Mailbox setup failed ${name.slice(MAILBOX_SLOT_FAILED_CHECK.length)}`;
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

  // N5 (docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md) — the two
  // checks damped by the SAME `gradeSweepStreak` as `cron_legs` above, for the
  // same reason its exemption exists. Both are graded over
  // LEG_ALERT_AFTER_SWEEPS consecutive bad ticks before they are reported at
  // all; debouncing them again puts the first email at tick 4 (20 min, 25 with
  // a missed tick) — the exact number that exemption's comment names as the
  // breach. `alert_delivery` is the check that says "we could not reach you",
  // which is the worst one in the platform to delay.
  //
  // `sweep_signals` is deliberately NOT here: scheduled.ts reports it once per
  // tick with NO upstream damping, so the debounce is the only thing standing
  // between one flaky WatchtowerDO RPC and an email.
  //
  // The frozen alert-state design owns the final assignment (§7.3 -> §3.3);
  // this closes the interim under-specification rather than pre-empting it.
  if (checkName === SWEEP_COVERAGE_CHECK || checkName === ALERT_DELIVERY_CHECK) return IMMEDIATE_ALERT_POLICY;

  // ONE-SHOT event reports (`reportCheck`, from engine/mailbox-acquisition.ts).
  // Nothing re-observes these: they are raised once by whatever hit the
  // condition, around real vendor spend. "2 consecutive observations" is not a
  // delay for them, it is permanent silence.
  if (checkName.startsWith(MAILBOX_PROVISIONING_CHECK) || checkName.startsWith(MAILBOX_REBUY_CHECK)) {
    return IMMEDIATE_ALERT_POLICY;
  }

  // The same shape, from `forEachIsolated`'s failure list
  // (engine/isolated-failure-alerts.ts): a release that threw, an ordinal that
  // could not be set up, a slot that could not be bought. Each is observed
  // exactly ONCE, by the loop that gave up on it, around real vendor spend.
  // Nothing re-observes them, so "2 consecutive observations" would be
  // permanent silence — and two of the three name money that keeps being spent
  // until a human intervenes.
  if (
    checkName.startsWith(MAILBOX_RELEASE_FAILED_CHECK) ||
    checkName.startsWith(DOMAIN_ORDINAL_FAILED_CHECK) ||
    checkName.startsWith(MAILBOX_SLOT_FAILED_CHECK)
  ) {
    return IMMEDIATE_ALERT_POLICY;
  }

  // §7.11 (Q3) — the ONE place the blame-split channel routing happens.
  // Same cadence as every other re-observed check; only the channel differs.
  if (checkName.startsWith(CUSTOMER_PROGRESS_AGENT_CHECK)) return DEBOUNCED_DIGEST_ALERT_POLICY;

  // The alerting channel's own saturation check (alert-state design §3.3) takes
  // the DEBOUNCED default DELIBERATELY, stated here rather than inherited: it is
  // re-observed every tick from the counter, so a single tick that touches the
  // ceiling is a flap worth zero emails, and two consecutive (10 min) is a
  // genuinely saturated channel. Its exemption is from the BUDGET (it cannot be
  // budgeted by the budget it announces), not from the debounce.
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
      return unhealthyEmail(env, result, transition, nowMs, "first");
    case "escalated":
      return unhealthyEmail(env, result, transition, transition.next.sinceTs, "escalation");
    case "realerted":
      return unhealthyEmail(env, result, transition, transition.next.sinceTs, "realert");
    case "recovered":
      // `recovered` is only ever produced from a healthy observation
      // (watchtower-policy.ts's decideAlert), so the narrowing always holds;
      // the guard keeps it a type fact rather than a comment.
      return result.healthy ? recoveryEmail(env, result, prevSinceTs ?? nowMs, nowMs) : null;
    case "suppressed":
    case "pending":
    case "holding":
    case "healthy":
    case "unreportable":
      return null;
    default:
      // EXHAUSTIVE, not a silent `default: return null` (§3.5, read site 1). A
      // forgotten case would drop the email WHILE the ledger records its key as
      // announced — a permanent deletion, because `escalated` never fires twice
      // for the same key. `escalated` is exactly the case that would have been
      // forgotten, which is why this became a compile-time obligation.
      return unhandledAction(transition.action);
  }
}

function unhandledAction(action: never): never {
  throw new Error(`unhandled watchtower alert action: ${String(action)}`);
}

/** Which unhealthy email this is — they differ only in the one line that says
 * why it arrived, which is the whole point of telling them apart. */
type UnhealthyKind = "first" | "escalation" | "realert";

function unhealthyEmail(env: Env, result: CheckResult, transition: AlertTransition, sinceTs: number, kind: UnhealthyKind): OutgoingAlert {
  const label = labelFor(result.name);
  const since = new Date(sinceTs).toISOString();
  const context =
    kind === "realert"
      ? `Still unhealthy since ${since} (re-alert after cooldown).`
      : kind === "escalation"
        ? `Unhealthy since ${since}. This is a DIFFERENT condition under the same check — the earlier one may also still be true.`
        : "";
  // The cap's disclosure (§1.3): an episode that hit
  // MAX_ANNOUNCED_KEYS_PER_EPISODE holds more distinct conditions than it has
  // told the founder about, and silently dropping that fact is what makes a cap
  // dangerous rather than safe.
  const overflow = transition.next.announcedKeys.overflow;
  const overflowLine =
    overflow > 0 ? `${overflow} further distinct condition(s) on this check were not announced separately — read the check's current detail for what it says now.` : "";
  const extra = [context, overflowLine].filter(Boolean);
  const text = `Check "${label}" (${result.name}) is UNHEALTHY.\n\n${result.detail}${extra.length > 0 ? `\n\n${extra.join("\n")}` : ""}\n\nThis is an automated coldrig watchtower alert.`;
  return {
    to: env.OPS_ALERT_EMAIL,
    subject: `[coldrig] ${label}: UNHEALTHY`,
    text,
    html: `<p>Check <strong>${escapeHtml(label)}</strong> (<code>${escapeHtml(result.name)}</code>) is <strong>UNHEALTHY</strong>.</p><p>${escapeHtml(result.detail)}</p>${extra.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p>This is an automated coldrig watchtower alert.</p>`,
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
export function reasonForNoEmail(transition: AlertTransition): DeliveryReason {
  if (transition.action === "pending") return "pending_debounce";
  // §3.5, read site 3. `holding` used to fall through to `nothing_owed`, which
  // reports "there was nothing to tell" about a recovery that is actively being
  // confirmed — the producer said HEALTHY and the episode is deliberately still
  // open.
  if (transition.action === "holding") return "pending_recovery";
  if (transition.action === "suppressed") {
    return transition.suppressedBy === "key_cap" ? "suppressed_key_cap" : "suppressed_cooldown";
  }
  return "nothing_owed";
}
