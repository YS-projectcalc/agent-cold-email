// The watchtower's ALERT VOCABULARY — what a check result is, how its email
// renders, and the pure state transition that decides whether to send one.
//
// Extracted from watchtower.ts because there are now TWO stores backing the
// same state machine, and the rules must be identical in both (CLAUDE.md rule
// c):
//  - `watchtower_state` in D1 (admin/watchtower.ts's reconcileAlerts) — every
//    ordinary platform/tenant check;
//  - the WatchtowerDO's own storage (watchtower-do.ts) — the D1-outage check
//    and the cron dead-man, which by definition cannot read D1.
// `decideAlert` is PURE (no store, no clock, no mailer), so the anti-storm
// guarantee is one tested function rather than a rule copied per substrate.

import type { Env } from "../env.js";
import { escapeHtml } from "../html-escape.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";

// Re-alert cooldown while a check stays unhealthy — a persistent outage emails
// at most once per 6h regardless of the (5-min) probe cadence.
export const WATCHTOWER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** One health observation. `detail` is the human specifics that ride into the
 * alert body (never just the check name). */
export interface CheckResult {
  name: string;
  healthy: boolean;
  detail: string;
}

/** What the state machine did for one check this sweep — returned for tests +
 * the sweep's structured log line. `unreportable` is NOT a decision: it is the
 * D1-independent leg saying its own store was unreachable too, so the check was
 * neither alerted nor cleared. It must never read as "suppressed" (which claims
 * a deliberate, throttled silence). */
export type AlertAction = "alerted" | "realerted" | "recovered" | "suppressed" | "healthy" | "unreportable";
export interface AlertOutcome {
  name: string;
  action: AlertAction;
  emailSent: boolean;
}

/** The persisted per-check state, store-agnostic (D1 row or DO storage value). */
export interface AlertState {
  status: "healthy" | "unhealthy";
  sinceTs: number;
  lastAlertTs: number | null;
}

export interface AlertTransition {
  action: AlertAction;
  next: AlertState;
}

/**
 * The ONE alert rule set, as a pure function of (previous state, observation):
 *  - healthy -> unhealthy (or first-ever-unhealthy): ALERT now.
 *  - unhealthy -> unhealthy: re-alert ONLY after `cooldownMs` since the last
 *    alert; otherwise SUPPRESS (this is the anti-storm guarantee).
 *  - unhealthy -> healthy: RECOVERY email.
 *  - healthy -> healthy (or first-ever-healthy): nothing.
 * `next` is what the caller must persist; `action` says which email (if any)
 * `alertEmailFor` will render.
 */
export function decideAlert(
  prev: AlertState | null,
  healthy: boolean,
  nowMs: number,
  cooldownMs: number = WATCHTOWER_COOLDOWN_MS,
): AlertTransition {
  if (healthy) {
    if (prev && prev.status === "unhealthy") {
      return { action: "recovered", next: { status: "healthy", sinceTs: nowMs, lastAlertTs: null } };
    }
    // Stay/enter healthy — keep the original since_ts if already healthy.
    const sinceTs = prev && prev.status === "healthy" ? prev.sinceTs : nowMs;
    return { action: "healthy", next: { status: "healthy", sinceTs, lastAlertTs: null } };
  }

  if (!prev || prev.status === "healthy") {
    return { action: "alerted", next: { status: "unhealthy", sinceTs: nowMs, lastAlertTs: nowMs } };
  }

  const lastAlert = prev.lastAlertTs ?? prev.sinceTs;
  if (nowMs - lastAlert >= cooldownMs) {
    return { action: "realerted", next: { status: "unhealthy", sinceTs: prev.sinceTs, lastAlertTs: nowMs } };
  }
  // Still unhealthy, within cooldown — record the latest detail, send NOTHING.
  return { action: "suppressed", next: { status: "unhealthy", sinceTs: prev.sinceTs, lastAlertTs: prev.lastAlertTs } };
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
  return CHECK_LABELS[name] ?? name;
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
