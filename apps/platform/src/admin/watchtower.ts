// D2 monitoring — the "watchtower". Runs on the ops-sweep cron (wrangler.toml
// `[triggers]`), probes platform health, and emails the founder via the
// OpsMailer on a STATE CHANGE only, re-alerting on persistence after a
// cooldown and sending a recovery email when a check heals.
//
// Split three ways (CLAUDE.md rule b), by what each part can fail on:
//  - watchtower-alerts.ts — what an alert IS, how it renders, and the pure
//    transition rule (the anti-storm guarantee), shared by both stores;
//  - watchtower-infra.ts + watchtower-do.ts — the checks that CANNOT use D1,
//    because D1 (or the cron) is what they are alarming on;
//  - this file — the probes, the per-tenant checks, and the D1-backed state
//    machine for everything else.
//
// ORDERING RULE (audit 2026-08-06, BLOCKING-1): the `d1` probe runs FIRST and
// every D1-dependent scan below it is skipped when it fails. The old code
// computed a `d1: unhealthy` result and then aborted on two unguarded D1 reads
// before returning it, so the one check named for a D1 outage was structurally
// incapable of reporting one.

import { listAllTenantIds } from "./db.js";
import type { Env } from "../env.js";
import type { TenantOpsSummary } from "../engine/ops-summary.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import {
  alertEmailFor,
  decideAlert,
  trySend,
  CRED_PUSH_AGING_CHECK,
  DOMAIN_DNS_AGING_CHECK,
  MAILBOX_PROVISIONING_CHECK,
  MAILBOX_REBUY_CHECK,
  SEND_STARVED_CHECK,
  TENANT_DO_WEDGED_CHECK,
  type AlertOutcome,
  type AlertState,
  type CheckResult,
} from "./watchtower-alerts.js";
import { FAILURE_SIGNAL_WINDOW_MS, gradeFailureSignals } from "./watchtower-grading.js";
import { reconcileD1Alert, recordWatchtowerCompleted } from "./watchtower-infra.js";

// A probe to the external engine must not hang the whole sweep on a stalled
// socket — bound it well under any reasonable cron budget.
const ENGINE_HEALTH_TIMEOUT_MS = 10 * 1000;

// Canary DO instance name for the storage probe — fixed, so it never collides
// with a real per-IP rate-limiter bucket (`signup:<ip>`) and, for TENANT, never
// with a real tenant id (which is minted, never this literal). The canary
// TenantDO is not in `tenants_index`, so no sweep ever visits it.
const DO_PROBE_NAME = "__watchtower_probe__";

/** The watchtower check tracking whether ONE mailbox address is provisioning-stuck. */
export function mailboxProvisioningCheckName(email: string): string {
  return `${MAILBOX_PROVISIONING_CHECK}${email}`;
}

/** The watchtower check tracking the OUTCOME of a guarded re-buy for one address. */
export function mailboxRebuyCheckName(email: string): string {
  return `${MAILBOX_REBUY_CHECK}${email}`;
}

/** The watchtower check tracking ONE mailbox's overdue engine credential push. */
export function credPushAgingCheckName(email: string): string {
  return `${CRED_PUSH_AGING_CHECK}${email}`;
}

/** The watchtower check tracking whether ONE tenant has due mail and no way to send it. */
export function sendStarvedCheckName(tenantId: string): string {
  return `${SEND_STARVED_CHECK}${tenantId}`;
}

/** The watchtower check tracking whether ONE tenant's DO is answering at all. */
export function tenantDoWedgedCheckName(tenantId: string): string {
  return `${TENANT_DO_WEDGED_CHECK}${tenantId}`;
}

/** The watchtower check tracking ONE provisioned domain whose mail DNS is stalled. */
export function domainDnsAgingCheckName(domain: string): string {
  return `${DOMAIN_DNS_AGING_CHECK}${domain}`;
}

// --- Health probes -------------------------------------------------------

/**
 * Probe every platform-health check as of `nowMs`. The engine check is SKIPPED
 * entirely (omitted from the result) when `ENGINE_BASE_URL` is unset — a dark
 * engine is not a failure, so it must never alert or flap.
 *
 * NEVER THROWS on a D1 outage: the `d1` result is returned alongside whatever
 * else could still be probed, and the D1-backed scans are skipped. Its caller
 * routes the `d1` result through a store that does not depend on D1.
 */
export async function evaluateHealthChecks(env: Env, nowMs: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // D1 reachable (the same SELECT 1 the public /status route uses).
  let d1Healthy = true;
  try {
    await env.DB.prepare("SELECT 1").first();
    results.push({ name: "d1", healthy: true, detail: "D1 SELECT 1 ok" });
  } catch (err) {
    d1Healthy = false;
    results.push({ name: "d1", healthy: false, detail: `D1 unreachable: ${errMsg(err)}` });
  }

  results.push(await probeDurableObjectStorage(env));

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

  // Everything below reads D1. With D1 down these scans cannot run, and the
  // `d1` result above is the honest, complete report of that state.
  if (!d1Healthy) return results;

  results.push(...(await scanTenants(env, nowMs)));
  return results;
}

/**
 * Durable Object subsystem + storage. Probes BOTH classes (audit BLOCKING-3):
 * the old probe only pinged a `RateLimiterDO` canary, so a check labelled
 * "Durable Object storage" reported healthy while every `TenantDO` — the class
 * holding all customer state — threw on every call. This repo has wedged a
 * TenantDO at CONSTRUCTION twice (a mid-wave table re-key; a UNIQUE-constraint
 * throw), and a construction failure takes out every instance of the class at
 * once, which is exactly what a canary catches immediately.
 */
async function probeDurableObjectStorage(env: Env): Promise<CheckResult> {
  try {
    await env.SIGNUP_LIMITER.get(env.SIGNUP_LIMITER.idFromName(DO_PROBE_NAME)).ping();
  } catch (err) {
    return { name: "do_storage", healthy: false, detail: `RateLimiterDO probe failed: ${errMsg(err)}` };
  }
  try {
    await env.TENANT.get(env.TENANT.idFromName(DO_PROBE_NAME)).ping();
  } catch (err) {
    return {
      name: "do_storage",
      healthy: false,
      detail: `TenantDO canary probe failed — the class holding every tenant's state does not construct or read: ${errMsg(err)}`,
    };
  }
  return { name: "do_storage", healthy: true, detail: "DO storage probe ok (RateLimiterDO + TenantDO canary)" };
}

/**
 * The per-tenant scan: failure signals plus each tenant's send-pipeline checks.
 *
 * WINDOWED, not per-sweep (audit NB-1). The failure-signal count used to cover
 * only events since the previous sweep, so an intermittent failure rate flipped
 * the check unhealthy/healthy every 5 minutes — a genuine state change each
 * time, which the 6h cooldown does not suppress (executed on the old code: 24
 * emails in 2 h). A trailing window plus a threshold makes an intermittent
 * fault a single sustained condition, and `gradeFailureSignals` can answer
 * "hold" so a middling count changes nothing at all.
 *
 * A tenant whose DO throws is now REPORTED (audit BLOCKING-3) instead of logged
 * and skipped: that one catch used to silently drop the tenant's failure
 * signals, its credential-push checks and its starvation check in a single
 * pass, leaving the only paying customer unmonitored and unmentioned.
 */
async function scanTenants(env: Env, nowMs: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const sinceMs = nowMs - FAILURE_SIGNAL_WINDOW_MS;
  let failed = 0;
  let complaints = 0;

  const tenantIds = await listAllTenantIds(env);
  // One read of every check name the state machine has ever recorded. The
  // per-entity checks below use it to stay SILENT about entities they never
  // alerted on (a "healthy" row per mailbox per tenant would bury the handful
  // of real platform checks this table exists for — same reasoning as
  // readCheckStatus) while still emitting the healthy result that sends the
  // RECOVERY email for one they did.
  const reported = await readReportedCheckNames(env);

  for (const tenantId of tenantIds) {
    const wedgedName = tenantDoWedgedCheckName(tenantId);
    try {
      const s = await env.TENANT.get(env.TENANT.idFromName(tenantId)).opsSummary(sinceMs);
      failed += s.failureSignalsInWindow.failed;
      complaints += s.failureSignalsInWindow.complaints;
      results.push(...sendPipelineChecks(tenantId, s, reported));
      if (reported.has(wedgedName)) {
        results.push({ name: wedgedName, healthy: true, detail: `Tenant ${tenantId} (${s.brand}) is answering again.` });
      }
    } catch (err) {
      results.push({
        name: wedgedName,
        healthy: false,
        detail:
          `Tenant ${tenantId}'s Durable Object threw instead of answering opsSummary: ${errMsg(err)}. ` +
          `While it stays this way that tenant is invisible to EVERY health check (failure signals, credential pushes, send ` +
          `starvation) and is skipped by the dunning, deliverability, digest and send-pipeline sweeps as well — it is not sending, ` +
          `and nothing else will say so.`,
      });
    }
  }

  // Global failure-signal roll-up. `null` = inside the dead band: report
  // nothing, which leaves the check's state (and its cooldown) untouched.
  const grade = gradeFailureSignals(failed, complaints);
  if (grade !== null) {
    const windowMin = Math.round(FAILURE_SIGNAL_WINDOW_MS / 60000);
    results.push({
      name: "failure_signals",
      healthy: grade,
      detail: grade
        ? `no failed sends or complaints in the last ${windowMin} min`
        : `${failed} terminal-failed send(s) + ${complaints} complaint(s) in the last ${windowMin} min, across all tenants`,
    });
  }

  return results;
}

/**
 * Wave-2 §1c — derives one tenant's send-pipeline checks from the opsSummary
 * the failure-signal scan already fetched (no extra RPC). PURE: it decides what
 * to report, `reconcileAlerts` decides what to email.
 *
 * Both checks are scoped to ACTIVATED tenants. An unactivated tenant is
 * expected not to send — alerting on it would be noise that trains the founder
 * to ignore the channel. When a tenant DE-activates while a check is
 * outstanding it is reported healthy once (clearing it), which is the honest
 * reading: the condition no longer describes a problem.
 */
export function sendPipelineChecks(
  tenantId: string,
  summary: TenantOpsSummary,
  reported: ReadonlySet<string>,
): CheckResult[] {
  const results: CheckResult[] = [];
  const { activated, agingPendingDomains, agingPendingPushes, dueNonDemoPendingSends, eligibleMailboxes, provisionedDomainNames } =
    summary.sendPipeline;

  // Vendor-verdict class fix, guard C — the escalation edge un-ready domains
  // owed. CORRECTED (gate delta NOTE 4, docs/adversarial/
  // vendor-verdict-gate-2026-08-14.md): this is NOT a reader of the
  // `DOMAIN_DNS_PENDING` action row — nothing reads that row, before or after
  // this guard. It is an independent query over `domains` (engine/
  // ops-summary.ts's `agingPendingDomains`). A provisioned domain that has been
  // un-ready past DNS_PENDING_MAX_MS is a PAID resource that will never carry a
  // mailbox, and before this nothing anywhere bounded, escalated or even
  // counted it: no timer, no ceiling, no check keyed on domains at all. Scoped
  // to activated tenants for the same reason the credential-push check is — an
  // unactivated tenant's domains are sandbox ones, and alerting on them trains
  // the founder to ignore the channel.
  const stalledDomains = activated ? agingPendingDomains : [];
  for (const stalled of stalledDomains) {
    const hours = Math.round(stalled.pendingForMs / 3_600_000);
    results.push({
      name: domainDnsAgingCheckName(stalled.domain),
      healthy: false,
      detail:
        `Domain ${stalled.domain} (tenant ${tenantId}) has had un-ready mail DNS for ${hours}h. ` +
        (stalled.gaveUp
          ? `The platform has GIVEN UP on it: setup calls for it now fail non-retryably, so this domain needs replacing by hand. `
          : `It is past the point where propagation explains it. `) +
        `It was paid for and no mailbox will come up on it until it is replaced.`,
    });
  }
  // Clear an aging-domain alert once the domain is ready/released — and only for
  // domains THIS tenant holds, so one tenant's sweep never clears another's.
  const stalledNow = new Set(stalledDomains.map((d) => d.domain));
  for (const name of reported) {
    if (!name.startsWith(DOMAIN_DNS_AGING_CHECK)) continue;
    const domain = name.slice(DOMAIN_DNS_AGING_CHECK.length);
    if (stalledNow.has(domain)) continue;
    if (!provisionedDomainNames.includes(domain)) continue; // another tenant's domain
    results.push({ name, healthy: true, detail: `Domain ${domain} (tenant ${tenantId}) now has working mail DNS.` });
  }

  const aging = activated ? agingPendingPushes : [];
  for (const push of aging) {
    results.push({
      name: credPushAgingCheckName(push.email),
      healthy: false,
      detail:
        `Mailbox ${push.email} (tenant ${tenantId}) has been waiting ${Math.round(push.pendingForMs / 60000)} min for its engine ` +
        `credential push. It cannot send or poll until an OAuth grant is minted for it — on the manual path that means adding it ` +
        `to the GMAIL_OAUTH_GRANTS secret. The tenant's other mailboxes are unaffected.`,
    });
  }
  // Clear any aging alert for a mailbox that is no longer aging — but only for
  // ones actually raised before, so this never files rows for healthy mailboxes.
  const agingNow = new Set(aging.map((p) => p.email));
  for (const name of reported) {
    if (!name.startsWith(CRED_PUSH_AGING_CHECK)) continue;
    const email = name.slice(CRED_PUSH_AGING_CHECK.length);
    if (agingNow.has(email)) continue;
    if (!summary.mailboxProvenance.some((m) => m.email === email)) continue; // another tenant's mailbox
    results.push({ name, healthy: true, detail: `Mailbox ${email} (tenant ${tenantId}) now has its engine credentials pushed.` });
  }

  const starved = activated && dueNonDemoPendingSends > 0 && eligibleMailboxes === 0;
  const starvedName = sendStarvedCheckName(tenantId);
  if (starved) {
    results.push({
      name: starvedName,
      healthy: false,
      detail:
        `Tenant ${tenantId} (${summary.brand}) has ${dueNonDemoPendingSends} send(s) due and ZERO eligible mailboxes — nothing will go ` +
        `out. Every mailbox it holds is released, sandbox-origin, BYO (no engine credentials wired yet), unclassified, paused by the ` +
        `deliverability loop, or waiting on a credential push. Read opsSummary.mailboxProvenance for which.`,
    });
  } else if (reported.has(starvedName)) {
    results.push({ name: starvedName, healthy: true, detail: `Tenant ${tenantId} (${summary.brand}) has eligible mailboxes again.` });
  }

  return results;
}

// --- Alert state machine (the core correctness surface) ------------------

/**
 * Reconcile probe results against the persisted per-check state (D1) and email
 * the founder accordingly. The rules themselves live in `decideAlert`
 * (watchtower-alerts.ts) so the DO-backed store applies exactly the same ones;
 * this function is the D1 read/apply half.
 *
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
    const prev = stateByName.get(result.name) ?? null;
    const transition = decideAlert(prev, result.healthy, nowMs);
    const email = alertEmailFor(env, result, transition, prev?.sinceTs ?? null, nowMs);
    const emailSent = email ? await trySend(mailer, email) : false;
    await upsertWatchtowerState(env, { name: result.name, state: transition.next, detail: result.detail, nowMs });
    outcomes.push({ name: result.name, action: transition.action, emailSent });
  }

  return outcomes;
}

/** Full sweep: probe, reconcile, record the sweep's completion. Called from
 * scheduled.ts (production) with a real OpsMailer; tests drive
 * reconcileAlerts directly with synthetic results.
 *
 * The `d1` result is reconciled FIRST and through a store that is not D1, and
 * a D1 outage returns right there: everything below reads the table that is
 * down, and attempting it would only trade one email for ten stack traces. */
export async function runWatchtower(env: Env, mailer: OpsMailer, nowMs: number): Promise<AlertOutcome[]> {
  const results = await evaluateHealthChecks(env, nowMs);
  const d1 = results.find((r) => r.name === "d1") as CheckResult;

  const outcomes: AlertOutcome[] = [await reconcileD1Alert(env, mailer, d1, nowMs)];
  if (!d1.healthy) return outcomes;

  outcomes.push(...(await reconcileAlerts(env, mailer, results.filter((r) => r.name !== "d1"), nowMs)));
  await recordWatchtowerCompleted(env, nowMs);
  return outcomes;
}

/**
 * The persisted status of one check, or null when it has never been reported.
 *
 * Lets an event-driven caller stay silent about a check it never raised: without
 * it, every successful mailbox provision would file a "healthy" row for an
 * address that was never in trouble, burying the handful of real platform checks
 * this table exists for.
 */
export async function readCheckStatus(env: Env, checkName: string): Promise<"healthy" | "unhealthy" | null> {
  const row = await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = ?`)
    .bind(checkName)
    .first<{ status: "healthy" | "unhealthy" }>();
  return row?.status ?? null;
}

/**
 * Reports ONE event-driven check through the same state machine the cron sweep
 * uses, so an alert raised from inside a TenantDO inherits its dedup, its 6h
 * cooldown and its recovery email rather than growing a parallel notifier.
 *
 * Unlike `evaluateHealthChecks`'s probes, these checks are raised by whatever
 * observed the condition (engine/mailbox-provisioning.ts) — the cron never
 * produces them, so they stay at whatever state their last report left them.
 * They are also ONE-SHOT, which is why they are never streak-damped: a repeat
 * requirement on an event that happens once would silence it forever.
 *
 * NEVER THROWS. The caller is mid-saga around real vendor spend; a D1 hiccup in
 * the notifier must not decide whether a purchase happens or a customer's setup
 * fails. A failure to alert is logged and swallowed, exactly as `trySend` already
 * swallows a dark mail channel.
 */
export async function reportCheck(
  env: Env,
  mailer: OpsMailer,
  result: CheckResult,
  nowMs: number,
): Promise<AlertOutcome | null> {
  try {
    const [outcome] = await reconcileAlerts(env, mailer, [result], nowMs);
    return outcome ?? null;
  } catch (err) {
    console.error(`watchtower: failed to report check "${result.name}"`, err);
    return null;
  }
}

// --- D1 state helpers ----------------------------------------------------

/**
 * Every check name the state machine has ever recorded, in ONE query. Lets a
 * cron-driven per-entity check (wave-2 §1c) emit the healthy result that sends
 * a RECOVERY email for entities it alerted on, without filing a healthy row for
 * every entity it never did.
 */
export async function readReportedCheckNames(env: Env): Promise<Set<string>> {
  const result = await env.DB.prepare(`SELECT check_name FROM watchtower_state`).all<{ check_name: string }>();
  return new Set(result.results.map((row) => row.check_name));
}

async function readWatchtowerState(env: Env): Promise<Map<string, AlertState>> {
  const result = await env.DB.prepare(`SELECT check_name, status, since_ts, last_alert_ts FROM watchtower_state`).all<{
    check_name: string;
    status: "healthy" | "unhealthy";
    since_ts: number;
    last_alert_ts: number | null;
  }>();
  const map = new Map<string, AlertState>();
  for (const row of result.results) {
    map.set(row.check_name, { status: row.status, sinceTs: row.since_ts, lastAlertTs: row.last_alert_ts });
  }
  return map;
}

async function upsertWatchtowerState(
  env: Env,
  params: { name: string; state: AlertState; detail: string; nowMs: number },
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
    .bind(params.name, params.state.status, params.state.sinceTs, params.state.lastAlertTs, params.detail, params.nowMs)
    .run();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
