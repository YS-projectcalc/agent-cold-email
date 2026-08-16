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

import type { Env } from "../env.js";
import { escapeHtml } from "../html-escape.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import {
  DEAD_MAN_ALERT_POLICY,
  DEBOUNCED_ALERT_POLICY,
  IMMEDIATE_ALERT_POLICY,
  type AlertAction,
  type AlertPolicy,
  type AlertTransition,
} from "./watchtower-policy.js";

/** One health observation. `detail` is the human specifics that ride into the
 * alert body (never just the check name). */
export interface CheckResult {
  name: string;
  healthy: boolean;
  detail: string;
}

export interface AlertOutcome {
  name: string;
  action: AlertAction;
  emailSent: boolean;
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
  return CHECK_LABELS[name] ?? name;
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
): OutgoingAlert | null {
  switch (transition.action) {
    case "alerted":
      return unhealthyEmail(env, result, nowMs, false);
    case "realerted":
      return unhealthyEmail(env, result, transition.next.sinceTs, true);
    case "recovered":
      return recoveryEmail(env, result, prevSinceTs ?? nowMs, nowMs);
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

function recoveryEmail(env: Env, result: CheckResult, sinceTs: number, nowMs: number): OutgoingAlert {
  const label = labelFor(result.name);
  const durationLine = `Was unhealthy for ~${Math.round((nowMs - sinceTs) / 60000)} min.`;
  const text = `Check "${label}" (${result.name}) has RECOVERED.\n\n${result.detail}\n${durationLine}\n\nThis is an automated coldrig watchtower alert.`;
  return {
    to: env.OPS_ALERT_EMAIL,
    subject: `[coldrig] ${label}: RECOVERED`,
    text,
    html: `<p>Check <strong>${escapeHtml(label)}</strong> (<code>${escapeHtml(result.name)}</code>) has <strong>RECOVERED</strong>.</p><p>${escapeHtml(result.detail)}</p><p>${escapeHtml(durationLine)}</p><p>This is an automated coldrig watchtower alert.</p>`,
  };
}

/**
 * Send, never throw. A dark channel (OpsMailNotConfiguredError) or a send
 * failure is logged; the caller STILL advances its state, so the sweep does not
 * retry-storm and an unsendable alert can never take down the sweep.
 */
export async function trySend(mailer: OpsMailer, alert: OutgoingAlert): Promise<boolean> {
  try {
    await mailer.send(alert);
    return true;
  } catch (err) {
    console.error(`watchtower: failed to send "${alert.subject}"`, err);
    return false;
  }
}
