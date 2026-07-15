// D2 monitoring — the "watchtower". Runs on the ops-sweep cron (wrangler.toml
// `[triggers]`), probes platform health, and emails the founder via the
// OpsMailer on a STATE CHANGE only, re-alerting on persistence after a
// cooldown and sending a recovery email when a check heals. The alert state
// machine (reconcileAlerts) is the core correctness surface — it is what makes
// a 5-minute cron cadence safe: it never storms.
//
// Split like admin/dunning.ts (decide) + admin/ops-sweep.ts (act): the health
// PROBES are I/O (evaluateHealthChecks); the state machine is a separate,
// hard-tested function (reconcileAlerts) driven off a `CheckResult[]` so a
// test can feed synthetic health without any live probe.

import { listAllTenantIds } from "./db.js";
import type { Env } from "../env.js";
import { escapeHtml } from "../html-escape.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";

// Re-alert cooldown while a check stays unhealthy — a persistent outage emails
// at most once per 6h regardless of the (5-min) probe cadence.
export const WATCHTOWER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// A probe to the external engine must not hang the whole sweep on a stalled
// socket — bound it well under any reasonable cron budget.
const ENGINE_HEALTH_TIMEOUT_MS = 10 * 1000;

// Canary DO instance for the storage probe — a fixed name so it never collides
// with a real per-IP rate-limiter bucket (those are keyed `signup:<ip>`).
const DO_PROBE_NAME = "__watchtower_probe__";

/** One health observation. `detail` is the human specifics that ride into the
 * alert body (never just the check name). */
export interface CheckResult {
  name: string;
  healthy: boolean;
  detail: string;
}

/** What reconcileAlerts did for one check this sweep — returned for tests +
 * the sweep's structured log line. */
export type AlertAction = "alerted" | "realerted" | "recovered" | "suppressed" | "healthy";
export interface AlertOutcome {
  name: string;
  action: AlertAction;
  emailSent: boolean;
}

interface WatchtowerStateRow {
  check_name: string;
  status: "healthy" | "unhealthy";
  since_ts: number;
  last_alert_ts: number | null;
  last_detail: string | null;
}

// Human labels for the subject line (`[coldrig] <label>: UNHEALTHY`).
const CHECK_LABELS: Record<string, string> = {
  d1: "D1 database",
  do_storage: "Durable Object storage",
  engine: "Engine /health",
  failure_signals: "Failure signals",
};

function labelFor(name: string): string {
  return CHECK_LABELS[name] ?? name;
}

// --- Health probes -------------------------------------------------------

/**
 * Probe every platform-health check. The engine check is SKIPPED entirely
 * (omitted from the result) when `ENGINE_BASE_URL` is unset — a dark engine is
 * not a failure, so it must never alert or flap. `sinceMs` bounds the
 * failure-signal window to events since the previous sweep.
 */
export async function evaluateHealthChecks(env: Env, sinceMs: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // D1 reachable (the same SELECT 1 the public /status route uses).
  try {
    await env.DB.prepare("SELECT 1").first();
    results.push({ name: "d1", healthy: true, detail: "D1 SELECT 1 ok" });
  } catch (err) {
    results.push({ name: "d1", healthy: false, detail: `D1 unreachable: ${errMsg(err)}` });
  }

  // Durable Object subsystem + storage reachable (canary read, no tenant data).
  try {
    await env.SIGNUP_LIMITER.get(env.SIGNUP_LIMITER.idFromName(DO_PROBE_NAME)).ping();
    results.push({ name: "do_storage", healthy: true, detail: "DO storage probe ok" });
  } catch (err) {
    results.push({ name: "do_storage", healthy: false, detail: `DO storage probe failed: ${errMsg(err)}` });
  }

  // Engine /health — ONLY when configured (skip-dark: an unset engine is not
  // a check at all this phase).
  if (env.ENGINE_BASE_URL) {
    try {
      const res = await fetch(`${env.ENGINE_BASE_URL.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS),
      });
      results.push(
        res.ok
          ? { name: "engine", healthy: true, detail: `engine /health -> ${res.status}` }
          : { name: "engine", healthy: false, detail: `engine /health -> HTTP ${res.status}` },
      );
    } catch (err) {
      results.push({ name: "engine", healthy: false, detail: `engine /health unreachable: ${errMsg(err)}` });
    }
  }

  // Failure-signal scan — NEW terminal-'failed' sends + spam complaints across
  // all tenants since the last sweep (per-tenant events.ts >= sinceMs). A tick
  // fan-out at test-mode scale (admin/README.md notes the D1 read-model scale
  // path); one slow/failed tenant must not blank the whole signal.
  let failed = 0;
  let complaints = 0;
  const tenantIds = await listAllTenantIds(env);
  for (const tenantId of tenantIds) {
    try {
      const s = await env.TENANT.get(env.TENANT.idFromName(tenantId)).opsSummary(sinceMs);
      failed += s.failureSignalsInWindow.failed;
      complaints += s.failureSignalsInWindow.complaints;
    } catch (err) {
      console.error(`watchtower failure-signal scan failed for tenant ${tenantId}`, err);
    }
  }
  const total = failed + complaints;
  results.push({
    name: "failure_signals",
    healthy: total === 0,
    detail:
      total === 0
        ? "no new failed sends or complaints since last sweep"
        : `${failed} new terminal-failed send(s) + ${complaints} new complaint(s) since last sweep`,
  });

  return results;
}

// --- Alert state machine (the core correctness surface) ------------------

/**
 * Reconcile probe results against the persisted per-check state and email the
 * founder accordingly. The ONLY email rules:
 *  - healthy -> unhealthy (or first-ever-unhealthy): ALERT now.
 *  - unhealthy -> unhealthy: re-alert ONLY after WATCHTOWER_COOLDOWN_MS since
 *    the last alert; otherwise SUPPRESS (this is the anti-storm guarantee).
 *  - unhealthy -> healthy: RECOVERY email.
 *  - healthy -> healthy (or first-ever-healthy): nothing.
 * Every send is wrapped: an OpsMailNotConfiguredError / dark-domain send
 * failure is logged and the state is STILL advanced (so a dark channel does
 * not retry-storm and does not take down the sweep).
 */
export async function reconcileAlerts(
  env: Env,
  mailer: OpsMailer,
  results: CheckResult[],
  nowMs: number,
): Promise<AlertOutcome[]> {
  const stateByName = await readWatchtowerState(env);
  const outcomes: AlertOutcome[] = [];

  for (const result of results) {
    const prev = stateByName.get(result.name);
    let action: AlertAction;
    let emailSent = false;

    if (result.healthy) {
      if (prev && prev.status === "unhealthy") {
        emailSent = await trySend(mailer, recoveryEmail(env, result, prev, nowMs));
        await upsertWatchtowerState(env, { name: result.name, status: "healthy", sinceTs: nowMs, lastAlertTs: null, detail: result.detail, nowMs });
        action = "recovered";
      } else {
        // Stay/enter healthy — keep the original since_ts if already healthy.
        const sinceTs = prev && prev.status === "healthy" ? prev.since_ts : nowMs;
        await upsertWatchtowerState(env, { name: result.name, status: "healthy", sinceTs, lastAlertTs: null, detail: result.detail, nowMs });
        action = "healthy";
      }
    } else {
      if (!prev || prev.status === "healthy") {
        emailSent = await trySend(mailer, unhealthyEmail(env, result, nowMs, false));
        await upsertWatchtowerState(env, { name: result.name, status: "unhealthy", sinceTs: nowMs, lastAlertTs: nowMs, detail: result.detail, nowMs });
        action = "alerted";
      } else {
        const lastAlert = prev.last_alert_ts ?? prev.since_ts;
        if (nowMs - lastAlert >= WATCHTOWER_COOLDOWN_MS) {
          emailSent = await trySend(mailer, unhealthyEmail(env, result, prev.since_ts, true));
          await upsertWatchtowerState(env, { name: result.name, status: "unhealthy", sinceTs: prev.since_ts, lastAlertTs: nowMs, detail: result.detail, nowMs });
          action = "realerted";
        } else {
          // Still unhealthy, within cooldown — record the latest detail, send NOTHING.
          await upsertWatchtowerState(env, { name: result.name, status: "unhealthy", sinceTs: prev.since_ts, lastAlertTs: prev.last_alert_ts, detail: result.detail, nowMs });
          action = "suppressed";
        }
      }
    }

    outcomes.push({ name: result.name, action, emailSent });
  }

  return outcomes;
}

/** Full sweep: read the cursor, probe, reconcile, advance the cursor. Called
 * from scheduled.ts (production) with a real OpsMailer; tests drive
 * reconcileAlerts directly with synthetic results. */
export async function runWatchtower(env: Env, mailer: OpsMailer, nowMs: number): Promise<AlertOutcome[]> {
  // First sweep (no cursor) -> empty window (baseline, no spurious alert).
  const sinceMs = (await readWatchtowerCursor(env)) ?? nowMs;
  const results = await evaluateHealthChecks(env, sinceMs);
  const outcomes = await reconcileAlerts(env, mailer, results, nowMs);
  await writeWatchtowerCursor(env, nowMs);
  return outcomes;
}

// --- Email bodies --------------------------------------------------------

interface OutgoingAlert {
  to: string;
  subject: string;
  text: string;
  html: string;
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

function recoveryEmail(env: Env, result: CheckResult, prev: WatchtowerStateRow, nowMs: number): OutgoingAlert {
  const label = labelFor(result.name);
  const downForMs = nowMs - prev.since_ts;
  const durationLine = `Was unhealthy for ~${Math.round(downForMs / 60000)} min.`;
  const text = `Check "${label}" (${result.name}) has RECOVERED.\n\n${result.detail}\n${durationLine}\n\nThis is an automated coldrig watchtower alert.`;
  return {
    to: env.OPS_ALERT_EMAIL,
    subject: `[coldrig] ${label}: RECOVERED`,
    text,
    html: `<p>Check <strong>${escapeHtml(label)}</strong> (<code>${escapeHtml(result.name)}</code>) has <strong>RECOVERED</strong>.</p><p>${escapeHtml(result.detail)}</p><p>${escapeHtml(durationLine)}</p><p>This is an automated coldrig watchtower alert.</p>`,
  };
}

async function trySend(mailer: OpsMailer, alert: OutgoingAlert): Promise<boolean> {
  try {
    await mailer.send(alert);
    return true;
  } catch (err) {
    // Dark channel (OpsMailNotConfiguredError) or a send failure — log, never
    // throw. The state still advances so the sweep does not retry-storm.
    console.error(`watchtower: failed to send "${alert.subject}"`, err);
    return false;
  }
}

// --- D1 state helpers ----------------------------------------------------

async function readWatchtowerState(env: Env): Promise<Map<string, WatchtowerStateRow>> {
  const result = await env.DB.prepare(
    `SELECT check_name, status, since_ts, last_alert_ts, last_detail FROM watchtower_state`,
  ).all<WatchtowerStateRow>();
  const map = new Map<string, WatchtowerStateRow>();
  for (const row of result.results) map.set(row.check_name, row);
  return map;
}

async function upsertWatchtowerState(
  env: Env,
  params: { name: string; status: "healthy" | "unhealthy"; sinceTs: number; lastAlertTs: number | null; detail: string; nowMs: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(check_name) DO UPDATE SET
       status = excluded.status,
       since_ts = excluded.since_ts,
       last_alert_ts = excluded.last_alert_ts,
       last_detail = excluded.last_detail,
       updated_at = excluded.updated_at`,
  )
    .bind(params.name, params.status, params.sinceTs, params.lastAlertTs, params.detail, params.nowMs)
    .run();
}

async function readWatchtowerCursor(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT last_sweep_ts FROM watchtower_cursor WHERE id = 1`).first<{ last_sweep_ts: number }>();
  return row?.last_sweep_ts ?? null;
}

async function writeWatchtowerCursor(env: Env, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_cursor (id, last_sweep_ts) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_sweep_ts = excluded.last_sweep_ts`,
  )
    .bind(nowMs)
    .run();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
