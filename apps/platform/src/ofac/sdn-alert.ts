// Ops alerting for the SDN (OFAC sanctions) list subsystem. BOTH the
// direct-fetch refresh (sdn-refresh.ts) and the droplet-relay ingest
// (sdn-ingest.ts) funnel every load attempt through `reconcileSdnAlert()` so
// the alert-storm class below is fixed in exactly one place — a stuck
// Treasury fetch seen via the refresh path and a stuck ingest via the relay
// path are the SAME underlying "no fresh list is landing" condition from the
// founder's point of view, and a success from EITHER path closes the SAME
// open incident.
//
// CLASS FIX (2026-07-24, founder-reported: 160 identical emails in one day)
// — maybeRefreshSdnList previously alerted on EVERY failed 5-min cron tick,
// unthrottled: a persistent block meant an email every 5 minutes forever.
// This is the SAME "cron-driven retry loop alerts unconditionally per
// attempt" shape admin/watchtower.ts's reconcileAlerts already solves for
// platform-health checks (WATCHTOWER_COOLDOWN_MS) — this module applies the
// identical state-machine shape to a single logical "is the SDN list loading
// successfully?" check, backed by its own singleton state row
// (sdn_alert_state, migrations/0013) rather than watchtower_state, since this
// isn't one of watchtower's named platform-health probes.
//
// Class-sweep note (2026-07-24): every OTHER scheduled()-driven alert in this
// codebase was already transition/idempotency-gated (admin/ops-sweep.ts's
// dunning suspend via insertDunningEventIfNew, engine/deliverability-actions.ts's
// hard-pause via its active->paused_primary UPDATE guard, engine/spend-ceiling.ts's
// capacity-pending marker) — this file's callers were the one exception, not
// a wider pattern.
import { escapeHtml } from "../html-escape.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import type { Env } from "../env.js";

// Re-alert cooldown while the SDN list stays stuck failing — mirrors
// WATCHTOWER_COOLDOWN_MS exactly (admin/watchtower.ts): a persistent failure
// emails at most once per 6h regardless of the underlying retry cadence.
export const SDN_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type SdnAlertAction = "alerted" | "realerted" | "recovered" | "suppressed" | "healthy";

interface SdnAlertStateRow {
  failure_streak: number;
  last_alert_ts: number | null;
}

/**
 * Call after EVERY SDN load attempt (refresh OR ingest), success or failure.
 * The ONE email rules (mirrors reconcileAlerts, admin/watchtower.ts):
 *  - first failure of a new streak: ALERT now.
 *  - failure while already in a streak: re-alert only after
 *    SDN_ALERT_COOLDOWN_MS since the last alert; otherwise SUPPRESS.
 *  - success after a failure streak: ONE recovery email, streak resets.
 *  - success with no prior streak: nothing (the normal case).
 * Returns which action was taken so a test (or the caller's structured log)
 * can assert on it instead of poking at mailer internals directly.
 */
export async function reconcileSdnAlert(
  env: Env,
  outcome: { success: boolean; detail: string },
  mailer: OpsMailer,
  nowMs: number,
): Promise<SdnAlertAction> {
  const state = await readSdnAlertState(env);

  if (outcome.success) {
    if (state.failure_streak > 0) {
      await sendSdnAlertEmail(env, recoveryEmail(outcome.detail, state.failure_streak), mailer);
      await writeSdnAlertState(env, { failureStreak: 0, lastAlertTs: null, detail: outcome.detail, nowMs });
      return "recovered";
    }
    await writeSdnAlertState(env, { failureStreak: 0, lastAlertTs: null, detail: outcome.detail, nowMs });
    return "healthy";
  }

  const nextStreak = state.failure_streak + 1;
  if (state.failure_streak === 0) {
    await sendSdnAlertEmail(env, failureEmail(outcome.detail, nextStreak, false), mailer);
    await writeSdnAlertState(env, { failureStreak: nextStreak, lastAlertTs: nowMs, detail: outcome.detail, nowMs });
    return "alerted";
  }

  const lastAlert = state.last_alert_ts ?? nowMs;
  if (nowMs - lastAlert >= SDN_ALERT_COOLDOWN_MS) {
    await sendSdnAlertEmail(env, failureEmail(outcome.detail, nextStreak, true), mailer);
    await writeSdnAlertState(env, { failureStreak: nextStreak, lastAlertTs: nowMs, detail: outcome.detail, nowMs });
    return "realerted";
  }

  // Still failing, within cooldown — record the latest detail, send NOTHING.
  await writeSdnAlertState(env, { failureStreak: nextStreak, lastAlertTs: state.last_alert_ts, detail: outcome.detail, nowMs });
  return "suppressed";
}

function failureEmail(detail: string, streak: number, isReAlert: boolean): { subject: string; text: string } {
  const cooldownHours = SDN_ALERT_COOLDOWN_MS / 3_600_000;
  const persistence = isReAlert
    ? `\n\nThis is failure #${streak} in the current streak — re-alerting after the ${cooldownHours}h cooldown (NOT one email per attempt).`
    : `\n\nThis is the FIRST failure of a new streak — you will NOT get another email for this SAME streak until it recovers, or ${cooldownHours}h pass, whichever is first.`;
  const text =
    `The SDN (OFAC sanctions) list is NOT loading successfully — the platform keeps screening against the prior good list, ` +
    `not a corrupt one.\n\n${detail}${persistence}`;
  return { subject: `[coldrig] SDN list load failing${isReAlert ? " (still)" : ""} — kept prior good list`, text };
}

function recoveryEmail(detail: string, streakLength: number): { subject: string; text: string } {
  const text = `The SDN (OFAC sanctions) list is loading successfully again, after ${streakLength} consecutive failed attempt(s).\n\n${detail}`;
  return { subject: `[coldrig] SDN list load RECOVERED`, text };
}

async function sendSdnAlertEmail(env: Env, params: { subject: string; text: string }, mailer: OpsMailer): Promise<void> {
  if (!env.OPS_ALERT_EMAIL) return;
  try {
    await mailer.send({
      to: env.OPS_ALERT_EMAIL,
      subject: params.subject,
      text: params.text,
      html: `<p>${escapeHtml(params.text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`SDN alert: send to ${env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}

async function readSdnAlertState(env: Env): Promise<SdnAlertStateRow> {
  const row = await env.DB.prepare(`SELECT failure_streak, last_alert_ts FROM sdn_alert_state WHERE id = 1`).first<SdnAlertStateRow>();
  return row ?? { failure_streak: 0, last_alert_ts: null };
}

async function writeSdnAlertState(
  env: Env,
  params: { failureStreak: number; lastAlertTs: number | null; detail: string; nowMs: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sdn_alert_state (id, failure_streak, last_alert_ts, last_detail, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       failure_streak = excluded.failure_streak,
       last_alert_ts = excluded.last_alert_ts,
       last_detail = excluded.last_detail,
       updated_at = excluded.updated_at`,
  )
    .bind(params.failureStreak, params.lastAlertTs, params.detail, params.nowMs)
    .run();
}
