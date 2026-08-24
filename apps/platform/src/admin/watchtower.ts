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

import type { Notified, RecoveryBasis } from "@coldstart/shared";
import { isLifecycleFrozen } from "../engine/billing-state.js";
import { countTenants, resolveSweepTenants, sweepTenants, sweptSummary, type SweepScope } from "./tenant-slice.js";
import { DEFAULT_ADMIN_LIST_LIMIT, MAX_ADMIN_LIST_LIMIT } from "./db.js";
import { expectedCheckRoster } from "./watchtower-roster.js";
import { clampListLimit } from "../validate.js";
import type { Env } from "../env.js";
import { isPaidPlan } from "@coldstart/shared";
import {
  continuityNudgeDelayMs,
  customerProgressOwedMaxMs,
  customerProgressStallMs,
  DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS,
  DEFAULT_CUSTOMER_PROGRESS_STALL_MS,
  type TenantOpsSummary,
} from "../engine/ops-summary.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import {
  alertEmailFor,
  customerProgressAgentCheckName,
  customerProgressOperatorCheckName,
  observationOf,
  policyFor,
  reasonForNoEmail,
  trySend,
  ALERT_BUDGET_EXCEEDED_CHECK,
  CRED_PUSH_AGING_CHECK,
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
  TENANT_DO_WEDGED_CHECK,
  type AlertOutcome,
  type CheckResult,
} from "./watchtower-alerts.js";
import {
  decideAlert,
  normalizeAlertState,
  withheldAlertState,
  EMPTY_ANNOUNCED_KEYS,
  type AlertAction,
  type AlertPolicy,
  type AlertState,
  type AlertTransition,
  type AnnouncedKeys,
} from "./watchtower-policy.js";
import {
  announcementOrder,
  MAX_ANNOUNCEMENT_EMAILS_PER_DAY,
  MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY,
  type AnnouncementCandidate,
} from "./watchtower-budget.js";
import {
  customerProgressKey,
  failureSignalsKey,
  isBudgetExemptCheck,
  isPerEntityCheck,
  tenantDoWedgedKey,
} from "./watchtower-families.js";
import { FAILURE_SIGNAL_WINDOW_MS, FAILURE_SIGNALS_HOLD_STREAK, gradeFailureSignals, SUSTAINED_HOLD_TICKS } from "./watchtower-grading.js";
import { reconcileD1Alert, recordWatchtowerCompleted, watchtowerStub } from "./watchtower-infra.js";
import { evaluateVendorChecks } from "./watchtower-vendor.js";

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

/** Item 2 — the watchtower check tracking ONE mailbox_intents row with no matching live mailboxes row. */
export function mailboxOrphanCheckName(email: string): string {
  return `${MAILBOX_ORPHAN_CHECK}${email}`;
}

/** Item 2 — the domain twin: ONE domain_intents row with no matching domains row. */
export function domainOrphanCheckName(domain: string): string {
  return `${DOMAIN_ORPHAN_CHECK}${domain}`;
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

/** ONE mailbox the vendor would not release — still live, still billing. */
export function mailboxReleaseFailedCheckName(email: string): string {
  return `${MAILBOX_RELEASE_FAILED_CHECK}${email}`;
}

/** ONE domain ordinal whose setup could not be completed. */
export function domainOrdinalFailedCheckName(domain: string): string {
  return `${DOMAIN_ORDINAL_FAILED_CHECK}${domain}`;
}

/** ONE mailbox slot whose provision could not be completed. */
export function mailboxSlotFailedCheckName(email: string): string {
  return `${MAILBOX_SLOT_FAILED_CHECK}${email}`;
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
export async function evaluateHealthChecks(env: Env, nowMs: number, scope: SweepScope = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // D1 reachable (the same SELECT 1 the public /status route uses).
  let d1Healthy = true;
  try {
    await env.DB.prepare("SELECT 1").first();
    results.push({ name: D1_CHECK, healthy: true, detail: "D1 SELECT 1 ok", basis: "reobserved" });
  } catch (err) {
    d1Healthy = false;
    results.push({ name: D1_CHECK, healthy: false, materiality: "down", detail: `D1 unreachable: ${errMsg(err)}` });
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
          ? { name: "engine", healthy: true, detail: `engine /health -> ${res.status}`, basis: "reobserved" }
          : { name: "engine", healthy: false, materiality: "down", detail: `engine /health -> HTTP ${res.status}` },
      );
    } catch (err) {
      results.push({ name: "engine", healthy: false, materiality: "down", detail: `engine /health unreachable: ${errMsg(err)}` });
    }
  }

  // Item 1 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) —
  // account-wide InboxKit checks (vendor_wallet, warmup_duplicates). Same
  // placement as `engine` above: an external probe unrelated to D1, so it
  // runs even during a D1 outage; skip-dark ([]) when InboxKit is not armed.
  results.push(...(await evaluateVendorChecks(env)));

  // Everything below reads D1. With D1 down these scans cannot run, and the
  // `d1` result above is the honest, complete report of that state.
  if (!d1Healthy) return results;

  results.push(...(await scanTenants(env, nowMs, scope)));
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
    return { name: "do_storage", healthy: false, materiality: "down", detail: `RateLimiterDO probe failed: ${errMsg(err)}` };
  }
  try {
    await env.TENANT.get(env.TENANT.idFromName(DO_PROBE_NAME)).ping();
  } catch (err) {
    return {
      name: "do_storage",
      healthy: false,
      materiality: "down",
      detail: `TenantDO canary probe failed — the class holding every tenant's state does not construct or read: ${errMsg(err)}`,
    };
  }
  return { name: "do_storage", healthy: true, detail: "DO storage probe ok (RateLimiterDO + TenantDO canary)", basis: "reobserved" };
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
async function scanTenants(env: Env, nowMs: number, scope: SweepScope): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const sinceMs = nowMs - FAILURE_SIGNAL_WINDOW_MS;
  let failed = 0;
  let complaints = 0;

  const tenantTotal = await countTenants(env);
  const tenantIds = await resolveSweepTenants(env, scope);
  // One read of every check name the state machine has ever recorded. The
  // per-entity checks below use it to stay SILENT about entities they never
  // alerted on (a "healthy" row per mailbox per tenant would bury the handful
  // of real platform checks this table exists for — same reasoning as
  // readCheckStatus) while still emitting the healthy result that sends the
  // RECOVERY email for one they did.
  const reported = await readReportedCheckNames(env);

  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      // The watchtower reads `failureSignalsInWindow`, so it MUST have been
      // windowed at FAILURE_SIGNAL_WINDOW_MS — asserted, not assumed. Grading a
      // 24h failure count against a 1h threshold reads as an incident.
      const s = await sweptSummary(env, scope, tenantId, { failureSignalsSinceMs: sinceMs }, sinceMs);
      if (s === null) throw new Error(`watchtower: the shared ops-summary prefetch did not supply tenant ${tenantId}`);
      failed += s.failureSignalsInWindow.failed;
      complaints += s.failureSignalsInWindow.complaints;
      results.push(
        ...sendPipelineChecks(tenantId, s, reported, {
          stallMs: customerProgressStallMs(env),
          owedMaxMs: customerProgressOwedMaxMs(env),
        }),
      );
      if (reported.has(tenantDoWedgedCheckName(tenantId))) {
        // reobserved: this line is inside the callback where the opsSummary RPC
        // actually returned, so the positive claim was just proven.
        results.push({
          name: tenantDoWedgedCheckName(tenantId),
          healthy: true,
          detail: `Tenant ${tenantId} (${s.brand}) is answering again.`,
          basis: "reobserved",
        });
      }
    },
    (tenantId, err) => {
      results.push({
        name: tenantDoWedgedCheckName(tenantId),
        healthy: false,
        // The KIND of throw, from `err.name` — never `err.message`, which is in
        // the detail below and moves with every RPC.
        materiality: tenantDoWedgedKey(err),
        detail:
          `Tenant ${tenantId}'s Durable Object threw instead of answering opsSummary: ${errMsg(err)}. ` +
          `While it stays this way that tenant is invisible to EVERY health check (failure signals, credential pushes, send ` +
          `starvation) and is skipped by the dunning, deliverability, digest and send-pipeline sweeps as well — it is not sending, ` +
          `and nothing else will say so.`,
      });
    },
  );

  // Global failure-signal roll-up. `null` = inside the dead band: report
  // nothing, which leaves the check's state (and its cooldown) untouched.
  //
  // A PARTIAL SCAN MAY NOT CLEAR IT (scale audit S1 x the watch-completeness
  // class). `gradeFailureSignals` answers `true` only on a genuinely clean
  // window — but "clean" is now clean ACROSS THE TENANTS THIS TICK REACHED,
  // and the cron reaches a bounded slice. A `true` from a partial scan would
  // send a RECOVERED email for failures still sitting in the un-scanned
  // remainder. The UNHEALTHY direction is unaffected: a failure seen anywhere
  // is a failure platform-wide, whatever else went unread.
  //
  // ...BUT THE HOLD IS ONLY OWED WHILE AN EPISODE IS OPEN (N3, docs/adversarial/
  // wave-b1-scale-monitoring-gate-2026-08-20.md). The thing a partial scan must
  // not do is send a false RECOVERED, and `decideAlert` only composes one when
  // an episode was ANNOUNCED — a healthy observation on an already-healthy
  // check emails nothing at all. Holding in that case bought no safety and cost
  // the check its existence: above one slice `scanComplete` is permanently
  // false, so a healthy platform emitted NO `failure_signals` observation ever,
  // nothing created the row, and `GET /admin/ops/checks` reported it `missing`
  // forever — on the guard whose stated purpose is catching a check that
  // silently left the monitored set.
  //
  // So: a partial scan reports UNHEALTHY freely (a failure seen anywhere is a
  // failure), reports HEALTHY only while the check is not currently unhealthy
  // (refreshing a row rather than claiming a recovery), and still HOLDS the one
  // case that matters — a partial clean window against an open episode. The
  // detail string names the scanned-vs-total scope either way, so the row never
  // claims more than it saw.
  const scanComplete = swept.visited >= tenantTotal;
  const observed = gradeFailureSignals(failed, complaints);
  const holdWouldHideRecovery = observed === true && !scanComplete && (await readCheckStatus(env, FAILURE_SIGNALS_CHECK)) === "unhealthy";
  const grade = holdWouldHideRecovery ? null : observed;

  // U-2 — THE SUSTAINED DEAD BAND (alert-state design §4). `gradeFailureSignals`
  // answers `null` for a window that is neither clean nor over threshold, and
  // `null` means "report nothing" — so a tenant losing 1-2 sends an hour, every
  // hour, forever, was reported by nothing at all. The missing information is
  // TEMPORAL, not categorical (`Grade` is already three-valued), and the store it
  // needs already exists: the DO's generic keyed streak.
  //
  // POLARITY (B1 — the highest-value RED in the increment). `gradeStreak`'s arms
  // are DISJOINT BY INPUT: fed `observedUnhealthy = (grade === null)`, a tick
  // satisfying `grade === null` takes the first branch, which can only return
  // `false` or `null`. `true` is unreachable there, so a `grade === null &&
  // holdGrade` composition is ALWAYS FALSY — 300 ticks, 0 results, byte-identical
  // to doing nothing. The guard is `holdGrade === false`: `false` is "the streak
  // has reached its threshold", i.e. the dead band has been occupied
  // continuously. This inversion passes every "it alerts on a real signal" test,
  // because the real-signal path is the OTHER arm.
  //
  // INTERACTION, STATED: a tick where `grade === false` feeds
  // `observedUnhealthy = false` and clears the hold streak, so dead-band ⇄
  // over-threshold oscillation never accumulates 144 consecutive hold ticks.
  // Acceptable — the over-threshold ticks emit the real signal on their own arm.
  //
  // FED `observed`, NOT `grade`. `grade` is `null` for two different reasons and
  // only one of them is a dead band: `holdWouldHideRecovery` nulls a genuinely
  // CLEAN window that a partial scan may not use to claim a recovery. Feeding
  // that in would accumulate dead-band ticks on clean windows and eventually
  // announce a sustained sub-threshold rate that is not happening.
  const holdGrade = await watchtowerStub(env).gradeSweepStreak(FAILURE_SIGNALS_HOLD_STREAK, observed === null, SUSTAINED_HOLD_TICKS, 1);

  const windowMin = Math.round(FAILURE_SIGNAL_WINDOW_MS / 60000);
  const scanScope = scanComplete ? `all ${tenantTotal} tenant(s)` : `${swept.visited} of ${tenantTotal} tenant(s) scanned this cycle`;
  if (grade === null) {
    if (holdGrade === false) {
      results.push({
        name: FAILURE_SIGNALS_CHECK,
        healthy: false,
        materiality: "sustained_subthreshold",
        detail:
          `Terminal send failures have sat BELOW the alerting threshold continuously for ~${Math.round((SUSTAINED_HOLD_TICKS * 5) / 60)}h — ` +
          `${failed} failed send(s) + ${complaints} complaint(s) in the last ${windowMin} min, across ${scanScope}. ` +
          `No single window is worth an alert, and the sustained rate is: this is the shape a slowly-dying mailbox, a ` +
          `degrading domain reputation or a partially-wrong credential makes. Read the per-tenant breakdown in GET /admin/ops/digest.`,
      });
    }
    return results;
  }

  results.push({
    name: FAILURE_SIGNALS_CHECK,
    // reobserved: the healthy claim is a freshly counted window, not an
    // entity dropping out of a filter.
    ...(grade
      ? { healthy: true as const, basis: "reobserved" as const }
      : { healthy: false as const, materiality: failureSignalsKey(failed, complaints) }),
    detail: grade
      ? `no failed sends or complaints in the last ${windowMin} min, across ${scanScope}`
      : `${failed} terminal-failed send(s) + ${complaints} complaint(s) in the last ${windowMin} min, across ${scanScope}`,
  });

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
  customerProgressBounds: { stallMs: number; owedMaxMs: number } = {
    stallMs: DEFAULT_CUSTOMER_PROGRESS_STALL_MS,
    owedMaxMs: DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS,
  },
): CheckResult[] {
  const results: CheckResult[] = [];
  const {
    activated,
    agingPendingDomains,
    agingPendingPushes,
    credentialPushes,
    dueNonDemoPendingSends,
    eligibleMailboxes,
    provisionedDomains,
    // Item 2 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) — defaulted
    // to `[]` because existing fixtures in sibling test files predate these
    // fields (a bare `??`/destructure default, not a product fallback: a real
    // TenantOpsSummary always supplies them, engine/ops-summary.ts).
    mailboxOrphans = [],
    mailboxIntentEmails = [],
    domainOrphans = [],
    domainIntentCandidates = [],
  } = summary.sendPipeline;

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
      // `gaveUp` IS the escalation: "propagation may still explain it" and "the
      // platform will never retry this domain" are different founder actions.
      materiality: stalled.gaveUp ? "gave_up" : "pending",
      detail:
        `Domain ${stalled.domain} (tenant ${tenantId}) has had un-ready mail DNS for ${hours}h. ` +
        (stalled.gaveUp
          ? `The platform has GIVEN UP on it: setup calls for it now fail non-retryably, so this domain needs replacing by hand. `
          : `It is past the point where propagation explains it. `) +
        `It was paid for and no mailbox will come up on it until it is replaced.`,
    });
  }
  // Clear an aging-domain alert once the domain leaves the stalled set — and
  // only for domains THIS tenant holds, so one tenant's sweep never clears
  // another's.
  //
  // A domain can leave that set two ways and they are not the same news
  // (signal-inversion arm B; audit F10): its DNS came up, OR it stopped being
  // an active provisioned domain — released, burning, retired — with its DNS
  // still dead. Re-read the columns rather than inferring from absence, and
  // state which one this is, so `recoveryEmail` renders a merely-departed
  // entity as departed no matter what prose anyone writes here.
  const stalledNow = new Set(stalledDomains.map((d) => d.domain));
  for (const name of reported) {
    if (!name.startsWith(DOMAIN_DNS_AGING_CHECK)) continue;
    const domain = name.slice(DOMAIN_DNS_AGING_CHECK.length);
    if (stalledNow.has(domain)) continue;
    const owned = provisionedDomains.find((d) => d.domain === domain);
    if (!owned) continue; // another tenant's domain
    const dnsWorks = owned.dnsStatus === "ready" && owned.status === "active";
    results.push(
      dnsWorks
        ? {
            name,
            healthy: true,
            basis: "reobserved",
            detail: `Domain ${domain} (tenant ${tenantId}) now has working mail DNS.`,
          }
        : {
            name,
            healthy: true,
            basis: "no_longer_applicable",
            detail: `Domain ${domain} (tenant ${tenantId}) is status=${owned.status}, dns=${owned.dnsStatus}.`,
          },
    );
  }

  const aging = activated ? agingPendingPushes : [];
  for (const push of aging) {
    results.push({
      name: credPushAgingCheckName(push.email),
      healthy: false,
      materiality: "aging",
      detail:
        `Mailbox ${push.email} (tenant ${tenantId}) has been waiting ${Math.round(push.pendingForMs / 60000)} min for its engine ` +
        `credential push. It cannot send or poll until an OAuth grant is minted for it — on the manual path that means adding it ` +
        `to the GMAIL_OAUTH_GRANTS secret. The tenant's other mailboxes are unaffected.`,
    });
  }
  // Clear any aging alert for a mailbox that is no longer aging — but only for
  // ones actually raised before, so this never files rows for healthy mailboxes.
  //
  // EXACT SIBLING of the domain clear above, and it was missed by the audit
  // that found that one (signal-inversion arm B). `agingPendingPushes` requires
  // status='pending', and lifecycle.ts writes 'revoked' on suspend/teardown —
  // so tearing a tenant down while a push was aging used to send the founder
  // "now has its engine credentials pushed" for a mailbox that never received
  // any. The ownership guard is `mailboxProvenance`, which has no released_at
  // filter, so a released mailbox passes it. Re-read the push row instead.
  const agingNow = new Set(aging.map((p) => p.email));
  for (const name of reported) {
    if (!name.startsWith(CRED_PUSH_AGING_CHECK)) continue;
    const email = name.slice(CRED_PUSH_AGING_CHECK.length);
    if (agingNow.has(email)) continue;
    if (!summary.mailboxProvenance.some((m) => m.email === email)) continue; // another tenant's mailbox
    const push = credentialPushes.find((p) => p.email === email);
    results.push(
      push?.status === "pushed"
        ? {
            name,
            healthy: true,
            basis: "reobserved",
            detail: `Mailbox ${email} (tenant ${tenantId}) now has its engine credentials pushed.`,
          }
        : {
            name,
            healthy: true,
            basis: "no_longer_applicable",
            detail: `Mailbox ${email} (tenant ${tenantId}) credential push is status=${push?.status ?? "absent"}.`,
          },
    );
  }

  const starved = activated && dueNonDemoPendingSends > 0 && eligibleMailboxes === 0;
  const starvedName = sendStarvedCheckName(tenantId);
  if (starved) {
    results.push({
      name: starvedName,
      healthy: false,
      materiality: "starved",
      detail:
        `Tenant ${tenantId} (${summary.brand}) has ${dueNonDemoPendingSends} send(s) due and ZERO eligible mailboxes — nothing will go ` +
        `out. Every mailbox it holds is released, sandbox-origin, BYO (no engine credentials wired yet), unclassified, paused by the ` +
        `deliverability loop, or waiting on a credential push. Read opsSummary.mailboxProvenance for which.`,
    });
  } else if (reported.has(starvedName)) {
    // `starved` also goes false when the DUE side drops to zero — the tick
    // marked the sends failed, the campaign paused, the leads ran out, the
    // tenant de-activated — in every one of which the mailbox count is still
    // zero. Only the mailbox half is evidence that capacity came back.
    results.push(
      eligibleMailboxes > 0
        ? {
            name: starvedName,
            healthy: true,
            basis: "reobserved",
            detail: `Tenant ${tenantId} (${summary.brand}) has ${eligibleMailboxes} eligible mailbox(es) again.`,
          }
        : {
            name: starvedName,
            healthy: true,
            basis: "no_longer_applicable",
            detail: `Tenant ${tenantId} (${summary.brand}) still has ZERO eligible mailboxes; it simply has no due sends right now.`,
          },
    );
  }

  // Item 2 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class C
  // stage 1) — a mailbox_intents row at 'bought'/'dangling'/'warming' with no
  // matching live mailboxes row, past the grace bound: the vendor may hold a
  // resource this platform has no record of, billing every month invisibly.
  // Scoped to activated tenants for the same reason every other §1c check is
  // — an unactivated tenant's intents are sandbox ones.
  const orphanMailboxes = activated ? mailboxOrphans : [];
  for (const orphan of orphanMailboxes) {
    const minutes = Math.round(orphan.pendingForMs / 60000);
    results.push({
      name: mailboxOrphanCheckName(orphan.email),
      healthy: false,
      materiality: "orphaned",
      detail:
        `Mailbox intent ${orphan.email} (tenant ${tenantId}) has sat at a post-purchase status for ${minutes} min with ` +
        `no live mailboxes row — the vendor may hold a mailbox this platform has no record of and cannot bill or manage. ` +
        `Ask the vendor what it holds for this address before buying a replacement.`,
    });
  }
  const orphanMailboxesNow = new Set(orphanMailboxes.map((o) => o.email));
  for (const name of reported) {
    if (!name.startsWith(MAILBOX_ORPHAN_CHECK)) continue;
    const email = name.slice(MAILBOX_ORPHAN_CHECK.length);
    if (orphanMailboxesNow.has(email)) continue;
    if (!mailboxIntentEmails.includes(email)) continue; // another tenant's intent
    // A live mailboxes row appearing is an affirmative fact worth reobserving;
    // any OTHER reason the row left the query (intent released, reconciled by
    // hand) is the "left this check's scope" clear — mirrors the domain_dns_aging/
    // cred_push_aging clears above exactly.
    const nowLive = summary.mailboxProvenance.some((m) => m.email === email && m.released_at === null);
    results.push(
      nowLive
        ? { name, healthy: true, basis: "reobserved", detail: `Mailbox intent ${email} (tenant ${tenantId}) now has a live mailboxes row.` }
        : {
            name,
            healthy: true,
            basis: "no_longer_applicable",
            detail: `Mailbox intent ${email} (tenant ${tenantId}) is no longer in a post-purchase status with no live row.`,
          },
    );
  }

  // The domain twin: a domain_intents row marked 'committed' with no matching
  // domains row past the grace bound.
  const orphanDomains = activated ? domainOrphans : [];
  for (const orphan of orphanDomains) {
    const minutes = Math.round(orphan.pendingForMs / 60000);
    results.push({
      name: domainOrphanCheckName(orphan.domain),
      healthy: false,
      materiality: "orphaned",
      detail:
        `Domain intent ${orphan.domain} (tenant ${tenantId}) has been marked committed for ${minutes} min with no matching ` +
        `domains row — the vendor may hold a domain this platform has no record of. Ask the vendor what it holds before buying a replacement.`,
    });
  }
  const orphanDomainsNow = new Set(orphanDomains.map((o) => o.domain));
  for (const name of reported) {
    if (!name.startsWith(DOMAIN_ORPHAN_CHECK)) continue;
    const domain = name.slice(DOMAIN_ORPHAN_CHECK.length);
    if (orphanDomainsNow.has(domain)) continue;
    if (!domainIntentCandidates.includes(domain)) continue; // another tenant's intent
    const nowLive = provisionedDomains.some((d) => d.domain === domain);
    results.push(
      nowLive
        ? { name, healthy: true, basis: "reobserved", detail: `Domain intent ${domain} (tenant ${tenantId}) now has a matching domains row.` }
        : {
            name,
            healthy: true,
            basis: "no_longer_applicable",
            detail: `Domain intent ${domain} (tenant ${tenantId}) is no longer committed with no matching row.`,
          },
    );
  }

  // §7.11 — the two stuck-customer checks: BLAME IN THE NAME, CHANNEL IN THE
  // POLICY. Signals ride this same opsSummary fan-out (§7.10.3's minimized
  // `owedReasons`/`owedCount`/`oldestOwedSinceMs`/`anyOwedWaitingOnOperator`
  // + `lastAgentActivityAgeMs`) — no new RPC. Destructured with defaults
  // (the `mailboxOrphans = []` precedent above): fixtures in sibling test
  // files predate these fields.
  const {
    owedReasons = [],
    owedCount = 0,
    oldestOwedSinceMs = null,
    anyOwedWaitingOnOperator = false,
    lastAgentActivityAgeMs = null,
  } = summary.sendPipeline;

  const inScope = activated && isPaidPlan(summary.plan) && !isLifecycleFrozen(summary.status, summary.billingState);
  // NULL (never a bearer-authed call, or a tenant predating the column) is
  // NOT "silent since the epoch" — the disjunct is simply never satisfied by
  // a null anchor, so nothing pages on deploy day; the owed-age disjunct
  // alone still catches a genuinely stalled tenant.
  const agentStalled = lastAgentActivityAgeMs !== null && lastAgentActivityAgeMs > customerProgressBounds.stallMs;
  const owedTooOld = oldestOwedSinceMs !== null && oldestOwedSinceMs > customerProgressBounds.owedMaxMs;
  const stalled = inScope && owedCount > 0 && (agentStalled || owedTooOld);

  const operatorName = customerProgressOperatorCheckName(tenantId);
  const agentName = customerProgressAgentCheckName(tenantId);
  const blamedName = anyOwedWaitingOnOperator ? operatorName : agentName;
  const abandonedName = blamedName === operatorName ? agentName : operatorName;

  if (stalled) {
    const stallHours = agentStalled ? Math.round((lastAgentActivityAgeMs as number) / 3_600_000) : null;
    const owedHours = owedTooOld ? Math.round((oldestOwedSinceMs as number) / 3_600_000) : null;
    results.push({
      name: blamedName,
      healthy: false,
      // The ACTION CLASS of the highest-precedence owed step — a closed map over
      // all 12 NEXT_STEP_REASONS. Keying on the reason gives 12; keying on
      // `waitingOn` is near-constant per name, because the blame is already IN
      // the name. "our blocker became a capacity hold" is the change that
      // changes what the founder does.
      materiality: customerProgressKey(owedReasons),
      detail:
        `Tenant ${tenantId} (${summary.brand}) has ${owedCount} owed next-step(s) — ${owedReasons.join(", ")} — ` +
        `blamed on ${anyOwedWaitingOnOperator ? "the operator" : "the agent"}. ` +
        // WHAT IS ACTUALLY MEASURED (non-blocking 4): `last_agent_activity_at`
        // is stamped by any bearer-authed MCP tool call and by a bearer-authed
        // status poll — not by a cookie-authed dashboard tab, and not by any
        // other REST route.
        (stallHours !== null ? `No MCP tool call or bearer-authed status poll in over ${stallHours}h. ` : "") +
        (owedHours !== null ? `Its oldest owed step has stood for over ${owedHours}h. ` : "") +
        `See infrastructure_status.nextSteps for the account's own next action.`,
    });
    // The MANDATORY cross-clear (§7.17.3, N3): the abandoned name, in the
    // SAME pass, so `reconcileAlerts` sees the sibling unhealthy here and
    // treats this as a RE-CLASSIFICATION — the state clears (so it cannot
    // re-alert on its own 24h step) but the recovery email is withheld,
    // because this tenant is still stalled, just under the other name now.
    if (reported.has(abandonedName)) {
      results.push({
        name: abandonedName,
        healthy: true,
        basis: "no_longer_applicable",
        detail: `Tenant ${tenantId} (${summary.brand}) is still stalled, but blame moved to ${anyOwedWaitingOnOperator ? "the operator" : "the agent"}.`,
      });
    }
  } else {
    // Neither name is unhealthy this tick — clear whichever was previously
    // reported. `owedCount === 0` is a genuine resolution (reobserved);
    // leaving scope (deactivated / unpaid / lifecycle-frozen) is the entity
    // departing the population this check watches (no_longer_applicable) —
    // the same distinction every other clear in this file makes.
    const basis: RecoveryBasis = inScope ? "reobserved" : "no_longer_applicable";
    for (const name of [operatorName, agentName]) {
      if (!reported.has(name)) continue;
      results.push({
        name,
        healthy: true,
        basis,
        detail: inScope
          ? `Tenant ${tenantId} (${summary.brand}) has ${owedCount} owed next-step(s) and is no longer stalled.`
          : `Tenant ${tenantId} (${summary.brand}) is no longer in scope for this check (deactivated, unpaid, or lifecycle-frozen).`,
      });
    }
  }

  return results;
}

// --- Alert state machine (the core correctness surface) ------------------

/**
 * Reconcile probe results against the persisted per-check state (D1) and email
 * the founder accordingly. The rules themselves live in `decideAlert`
 * (watchtower-policy.ts) so the DO-backed store applies exactly the same ones;
 * this function is the D1 read/apply half.
 *
 * Every send is wrapped: an OpsMailNotConfiguredError / dark-domain send
 * failure is logged and never throws, so an unsendable alert cannot take down
 * the sweep. What it does NOT do any more is advance the announcement counters
 * regardless of the outcome — see `withheldAlertState`.
 *
 * PER-CHECK ISOLATION (docs/adversarial/class-sweep-hol-blocking-2026-08-17.md).
 * The loop body touches D1 twice and either can throw; before this, the FIRST
 * check whose upsert failed aborted alerting for every check after it in the
 * array — head-of-line blocking on the one code path whose job is to tell a
 * human that something is broken, and the checks are ordered, so the same
 * unlucky check would shadow the same tail on every tick. One check's failure
 * is now its own `unreportable` outcome and nothing more.
 *
 * The per-check policy comes from `policyFor` — one table, so the checks that
 * must NOT be debounced (`reportCheck`'s one-shot event reports below, and
 * `cron_legs`, which is damped over consecutive ticks before it ever gets
 * here) cannot be silently swept into the default by this loop.
 */
/**
 * The other `customer_progress_*` name for the SAME tenant id, or `null` for
 * any other check. §7.17.3 (N3) — a blame flip is detected by looking up
 * whether THIS name's sibling is unhealthy in the SAME pass, never by
 * inferring it from `basis` alone (that would silence every other
 * `no_longer_applicable` clear on the platform too — declined, see the
 * `reclassified` DeliveryReason doc).
 */
function customerProgressSiblingName(name: string): string | null {
  if (name.startsWith(CUSTOMER_PROGRESS_OPERATOR_CHECK)) {
    return CUSTOMER_PROGRESS_AGENT_CHECK + name.slice(CUSTOMER_PROGRESS_OPERATOR_CHECK.length);
  }
  if (name.startsWith(CUSTOMER_PROGRESS_AGENT_CHECK)) {
    return CUSTOMER_PROGRESS_OPERATOR_CHECK + name.slice(CUSTOMER_PROGRESS_AGENT_CHECK.length);
  }
  return null;
}

/**
 * The transitions an email is genuinely OWED for.
 *
 * A SECOND, INDEPENDENT enumeration of the email-owing actions (§3.5, read site
 * 2 — `alertEmailFor`'s switch is the first). `escalated` had to join BOTH or
 * the digest-channel `why` would be wrong for exactly the transition this
 * increment adds.
 */
function wouldEmail(action: AlertAction): boolean {
  return action === "alerted" || action === "escalated" || action === "realerted" || action === "recovered";
}

/**
 * Does this transition need a slot in the rolling daily budget (§5.5)?
 *
 * ANNOUNCEMENTS ONLY. `recovered` is exempt — a budget-withheld recovery reverts
 * the whole previous state through `withheldAlertState`, so the episode would
 * never close, and NO BUDGET DECISION MAY BLOCK AN EPISODE CLOSE. The exemption
 * is self-bounding rather than open-ended: a recovery is owed only when
 * `alertCount > 0`, i.e. only for an episode that was actually ANNOUNCED, and a
 * budget-withheld confirming alert leaves `alertCount` at 0 — so recoveries over
 * any window are bounded by the announcements over that window, which is exactly
 * what this budget limits.
 */
function isBudgetedAnnouncement(checkName: string, action: AlertAction): boolean {
  if (action !== "alerted" && action !== "escalated" && action !== "realerted") return false;
  return !isBudgetExemptCheck(checkName);
}

/** One check's decision, before anything has been sent or written. */
interface PendingDecision {
  result: CheckResult;
  persisted: PersistedCheck | undefined;
  prev: AlertState | null;
  policy: AlertPolicy;
  transition: AlertTransition;
  /** The other `customer_progress_*` name for this tenant, or null. */
  sibling: string | null;
  reclassified: boolean;
  digestSuppressed: boolean;
  /** Set only for a budgeted announcement — its index into the candidate list. */
  candidateIndex: number | null;
}

export async function reconcileAlerts(
  env: Env,
  mailer: OpsMailer,
  results: CheckResult[],
  nowMs: number,
): Promise<AlertOutcome[]> {
  const stateByName = await readWatchtowerState(env);
  const outcomes: AlertOutcome[] = [];

  // §7.17.3 (N3) — computed ONCE over this pass's own results, so a genuine
  // full recovery (no unhealthy sibling anywhere in this batch) still emails
  // normally; only a same-tick blame flip is reclassified.
  const unhealthyProgressNames = new Set(
    results
      .filter(
        (r) => !r.healthy && (r.name.startsWith(CUSTOMER_PROGRESS_OPERATOR_CHECK) || r.name.startsWith(CUSTOMER_PROGRESS_AGENT_CHECK)),
      )
      .map((r) => r.name),
  );

  // PASS 1 — DECIDE. Nothing is sent or written here, because the daily budget
  // has to rank this tick's announcements against EACH OTHER before any of them
  // takes a slot (§5.5 ordering): round-robin across families, most urgent
  // action first. Deciding per-check-then-sending, the old shape, hands slots
  // out in array order, which is the tenant scan's order — so one noisy family
  // at the head of the batch would starve every check behind it.
  const decisions: PendingDecision[] = [];
  const candidates: AnnouncementCandidate[] = [];
  for (const result of results) {
    const persisted = stateByName.get(result.name);
    const prev = persisted?.state ?? null;
    const policy = policyFor(result.name);
    let transition: AlertTransition;
    try {
      transition = decideAlert(prev, observationOf(result), nowMs, policy);
    } catch (err) {
      console.error(`watchtower: check "${result.name}" could not be decided — it is UNREPORTED this tick`, err);
      outcomes.push({ name: result.name, action: "unreportable", emailSent: false, why: "send_failed" });
      continue;
    }

    // A blame flip is a RE-CLASSIFICATION, not a recovery: suppress the
    // SEND, never the state transition. `transition.next` (the ordinary
    // clear-to-healthy state) still persists — this tenant is still
    // stalled, just under the sibling's name now, and the abandoned name
    // must not re-alert on its own 24h step.
    const sibling = customerProgressSiblingName(result.name);
    const reclassified = result.healthy && sibling !== null && unhealthyProgressNames.has(sibling);
    // An email was genuinely OWED (would have rendered on the email channel) but
    // this check's channel is not email — distinct from "nothing was owed yet"
    // (pending/holding/suppressed/steady-healthy), which keeps its ordinary
    // `reasonForNoEmail`.
    const digestSuppressed = !reclassified && policy.channel === "digest" && wouldEmail(transition.action);

    let candidateIndex: number | null = null;
    if (!reclassified && !digestSuppressed && isBudgetedAnnouncement(result.name, transition.action)) {
      candidateIndex = candidates.length;
      candidates.push({
        name: result.name,
        family: familyKeyOf(result.name),
        action: transition.action,
        perEntity: isPerEntityCheck(result.name),
      });
    }
    decisions.push({ result, persisted, prev, policy, transition, sibling, reclassified, digestSuppressed, candidateIndex });
  }

  // Claim slots ATOMICALLY, in the budget's own order. A failure here must not
  // take the tick down: an unreachable WatchtowerDO means we cannot tell whether
  // a slot is free, and the safe reading for a MONITOR is to let the
  // announcement through — under-alerting is the failure this whole subsystem
  // exists to prevent, and the ring is bounded by its own window regardless.
  const claims = await claimAnnouncementSlots(env, candidates, nowMs);
  const releasable: string[] = [];

  // PASS 2 — SEND, PERSIST, REPORT, in the caller's own result order.
  for (const decision of decisions) {
    const { result, persisted, prev, policy, transition, sibling, reclassified, digestSuppressed, candidateIndex } = decision;
    try {
      const claim = candidateIndex === null ? null : claims[candidateIndex] ?? null;
      // Withheld for want of a slot: the state still advances everywhere the
      // announcement counters do not, so nothing is lost except the timing of
      // the email — and `alert_budget_exceeded` reports that it happened.
      const budgetWithheld = candidateIndex !== null && claim === null;
      const email = reclassified || budgetWithheld ? null : alertEmailFor(env, result, transition, prev?.sinceTs ?? null, nowMs, policy);
      // `null` = no email was OWED (suppressed / pending / steady-healthy /
      // digest channel / reclassified). That is not a delivery, and it is not
      // a failure either — it must not withhold the transition, and it must
      // not be recorded as "sent". The two used to be one boolean, which is
      // the same conflation member 5 is about, one level down.
      const notified: Notified | null = email ? await trySend(mailer, email) : null;
      const withheld = budgetWithheld || (notified !== null && !notified.delivered);
      // A claimed slot whose send did not land is not an email that was sent, so
      // it goes back. Leaving it banked would let a dark channel burn the whole
      // day's budget on zero delivered emails, and keep suppressing real
      // announcements for 24h after the channel came back.
      if (claim !== null && notified !== null && !notified.delivered) releasable.push(claim);
      const decided = withheld ? withheldAlertState(prev, transition) : transition.next;

      // NON-BLOCKING-3 — THE EPISODE IS THE STALL, NOT THE NAME.
      // `continuity_nudge_episode_ts` is per-TENANT while an `AlertState` is
      // per-check-NAME, so a blame flip mid-stall opened a fresh state with a
      // later `sinceTs`, `sinceTs > stored` passed again, and one continuous
      // stall produced a second nudge — one per blame regime. Blame genuinely
      // oscillates (it tracks a vendor wallet that dips and refills), so this
      // is not a corner case.
      //
      // The fix is to ADOPT the sibling's onset when this name is being blamed
      // and the sibling was already carrying the stall — and to PERSIST it, so
      // the currently-blamed name always holds the true onset and the next flip
      // reads it back from here. `stateByName` is the pre-pass read, so on the
      // flip tick the abandoned name is still `unhealthy` with the original
      // `sinceTs`, which is exactly the value that must survive.
      //
      // Safe against the alert ladder: the debounce counts OBSERVATIONS, and
      // the backoff compares against `lastAlertTs`, which is always set once
      // `alertCount > 0`. An earlier `sinceTs` therefore accelerates no email —
      // it only makes "unhealthy since" report the truth about the stall.
      //
      // GATED ON `healthyObs === 0` (B6, alert-state design §3.1). `holding`
      // leaves a check reading `status = 'unhealthy'` while its PRODUCER has
      // already said healthy, and this predicate reads exactly that column — so
      // without the gate a cleared sibling stays adoptable, the new episode
      // inherits an OLD `T0`, and `maybeEmitContinuityNudge`'s `>=` guard
      // returns early: ZERO nudges for the new episode's entire duration. That
      // is the silent direction of the exactly-once property, and it is the
      // failure `holding` would have introduced into a shipped, gate-ratified
      // guarantee. `healthyObs > 0` means the producer has reported healthy at
      // least once, so that sibling is not carrying a live stall.
      //
      // The legitimate same-tick blame flip is unaffected: `stateByName` is the
      // PRE-PASS read, so on the flip tick the abandoned sibling still reads
      // `healthyObs === 0`.
      const siblingState = sibling !== null ? normalizeAlertState(stateByName.get(sibling)?.state ?? null) : null;
      const siblingCarriesStall = siblingState !== null && siblingState.status === "unhealthy" && siblingState.healthyObs === 0;
      const stallOnsetTs =
        !result.healthy && siblingCarriesStall ? Math.min(decided.sinceTs, siblingState.sinceTs) : decided.sinceTs;
      const state = stallOnsetTs < decided.sinceTs ? { ...decided, sinceTs: stallOnsetTs } : decided;
      // N6 — WHILE HOLDING, KEEP THE LAST UNHEALTHY DETAIL. The upsert writes
      // `result.detail` unconditionally, so a holding row would read
      // `status='unhealthy'` beside a healthy producer's prose ("Domain X now
      // has working mail DNS") on `GET /admin/ops/checks`. `healthy_obs` is what
      // tells an operator a recovery is in progress; the detail must keep
      // describing the condition the row is still open for.
      const detail = transition.action === "holding" ? (persisted?.detail ?? result.detail) : result.detail;
      // S5 — a tick that changed nothing writes nothing. See `isSteadyState`.
      if (!isSteadyState(persisted, state, detail)) {
        await upsertWatchtowerState(env, { name: result.name, state, detail, nowMs });
      }

      // I15 (§7.12) — the one-shot continuity nudge.
      //
      // NON-BLOCKING-2 — FIRED ON ANY UNHEALTHY TICK PAST THE DELAY, not only
      // on an alert-WORTHY transition. Gating on `alerted|realerted` sampled
      // the delay on the REALERT GRID: `alerted` at ~onset (fails a 24h test),
      // the first `realerted` at WATCHTOWER_COOLDOWN_MS = 6h (fails), the next
      // at +WATCHTOWER_STEADY_REALERT_MS = 24h — so the first passing sample
      // was ~30h and `CONTINUITY_NUDGE_DELAY_MS` did nothing at all below 6h.
      // The founder ruled ONE nudge per episode, ONE DAY after onset; this
      // makes the tunable mean what its name says.
      //
      // COST, STATED: a stalled tenant now costs one cross-DO RPC per 5-minute
      // tick for the rest of its episode instead of one per alert rung. The
      // per-tick worst case is unchanged — §7.17.7 already bounds this sweep at
      // `9.0N + 29` for the all-transition tick — but that worst case is now
      // reached whenever N tenants are stalled rather than only on a correlated
      // onset. Every one of those calls after the first is a genuine no-op:
      // `sinceTs > continuity_nudge_episode_ts` is monotone, so the DO-side
      // guard (engine/continuity-nudge.ts) keeps "exactly once per episode"
      // EXACT no matter how often this fires.
      if (
        !result.healthy &&
        (result.name.startsWith(CUSTOMER_PROGRESS_OPERATOR_CHECK) || result.name.startsWith(CUSTOMER_PROGRESS_AGENT_CHECK)) &&
        nowMs - stallOnsetTs >= continuityNudgeDelayMs(env)
      ) {
        const tenantId = result.name.slice(result.name.indexOf(":") + 1);
        try {
          await env.TENANT.get(env.TENANT.idFromName(tenantId)).maybeEmitContinuityNudge(stallOnsetTs);
        } catch (err) {
          console.error(`watchtower: continuity nudge RPC failed for tenant ${tenantId}`, err);
        }
      }

      outcomes.push({
        name: result.name,
        action: transition.action,
        emailSent: notified?.delivered ?? false,
        why:
          notified?.why ??
          (reclassified
            ? "reclassified"
            : digestSuppressed
              ? "digest_only"
              : budgetWithheld
                ? "suppressed_daily_budget"
                : reasonForNoEmail(transition)),
      });
    } catch (err) {
      console.error(`watchtower: check "${result.name}" could not be reconciled — it is UNREPORTED this tick`, err);
      outcomes.push({ name: result.name, action: "unreportable", emailSent: false, why: "send_failed" });
    }
  }

  await releaseAnnouncementSlots(env, releasable);
  return outcomes;
}

/**
 * The FAMILY a check name belongs to, for round-robin ordering — the prefix for
 * a per-entity check, the name itself for a global one. Ordering on the raw name
 * would make every `tenant_do_wedged:<id>` its own "family" and the round-robin
 * a no-op, which is the whole defect ordering (i) exists to close.
 */
function familyKeyOf(checkName: string): string {
  const colon = checkName.indexOf(":");
  return colon === -1 ? checkName : checkName.slice(0, colon + 1);
}

/**
 * Announcements admitted in ONE tick while the budget cannot be consulted.
 *
 * SIZED AT THE RESERVED GLOBAL SLICE, not picked (build gate N2). When the
 * counter is unreadable we cannot know what has already been spent, so we grant
 * exactly what the budget GUARANTEES is available no matter what any storm has
 * consumed: `MAX_ANNOUNCEMENT_EMAILS_PER_DAY - MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY`,
 * the floor the 15/5 sub-cap reserves for the global and monitor families. It is
 * the one number the budget's own rules make safe to hand out blind.
 */
const FAIL_OPEN_ANNOUNCEMENTS_PER_TICK = MAX_ANNOUNCEMENT_EMAILS_PER_DAY - MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY;

/**
 * Claim budget slots, or hand out a bounded fallback allowance if the budget
 * cannot be consulted.
 *
 * FAIL-OPEN, AND NOW PRICED. The WatchtowerDO holding the ring is the same DO
 * the `d1` check's alert state lives in, so it is unreachable exactly when the
 * platform is worst off — and a DO-platform incident is precisely when a
 * 100-instance `tenant_do_wedged:` storm happens, so the failure is CORRELATED
 * with the storm the budget exists for, not independent of it. For a MONITOR,
 * "we could not check the rate limit" must not mean "stay silent"; under-
 * alerting is the failure this whole subsystem exists to prevent. But
 * unconditional fail-open is not the only alternative: the gate measured 200
 * announcements in 24h at 100 instances against a ratified <=20.
 *
 * WHAT THIS BOUNDS AND WHAT IT DOES NOT — stated exactly, because the founder is
 * being asked to ratify a number:
 *  - BOUNDED: the per-tick BURST. A correlated 100-instance onset can no longer
 *    put 100 emails in one inbox in one tick; it gets the reserved slice, in the
 *    budget's own priority order (a new incident before an escalation before a
 *    repeat, round-robin across families), so the emails that do go out are the
 *    ones the budget would itself have chosen.
 *  - NOT BOUNDED: the 24h TOTAL. That bound cannot be restored while the store
 *    holding the counter is the thing that is down. Worker memory is
 *    isolate-scoped and lossy, so a Worker-side tally cannot survive to be
 *    reconciled when the DO returns; and putting the fallback counter in D1
 *    would re-couple the failure domain the WatchtowerDO was chosen to escape
 *    (the `d1` check's own alert must stay decidable during a D1 outage).
 *    Fail-open sends are therefore NEVER recorded in the ring — they are
 *    invisible to it by construction, and when the DO returns the budget resumes
 *    from whatever it last knew.
 *
 * The residual is disclosed in the §9.13 [RATIFY:founder] ask: while the
 * WatchtowerDO is unreachable the <=20/day ceiling does not hold, and
 * `alert_budget_exceeded` is itself unreported in that state (it reads the same
 * store), so the founder gets the storm without the explanation.
 */
async function claimAnnouncementSlots(
  env: Env,
  candidates: AnnouncementCandidate[],
  nowMs: number,
): Promise<(string | null)[]> {
  if (candidates.length === 0) return [];
  try {
    return await watchtowerStub(env).admitAnnouncements(candidates, nowMs);
  } catch (err) {
    console.error(
      `watchtower: the announcement budget could not be consulted — admitting at most ${FAIL_OPEN_ANNOUNCEMENTS_PER_TICK} announcement(s) this tick`,
      err,
    );
    // The SAME ordering the DO would have applied, so the fallback spends its
    // allowance on the same candidates the budget would have chosen.
    const claims: (string | null)[] = candidates.map(() => null);
    for (const index of announcementOrder(candidates).slice(0, FAIL_OPEN_ANNOUNCEMENTS_PER_TICK)) {
      claims[index] = FAIL_OPEN_CLAIM;
    }
    return claims;
  }
}

/** The claim id used when the budget was unreachable: it admits the send and is
 * never released, because there is no ring entry to release. */
const FAIL_OPEN_CLAIM = "budget-unavailable";

async function releaseAnnouncementSlots(env: Env, ids: string[]): Promise<void> {
  const real = ids.filter((id) => id !== FAIL_OPEN_CLAIM);
  if (real.length === 0) return;
  try {
    await watchtowerStub(env).releaseAnnouncements(real);
  } catch (err) {
    // The slot stays banked for its 24h window — a bounded over-count of the
    // budget, never an unbounded one, and never a lost alert.
    console.error("watchtower: budget slots for undelivered alerts could not be released", err);
  }
}

/** Full sweep: probe, reconcile, record the sweep's completion. Called from
 * scheduled.ts (production) with a real OpsMailer; tests drive
 * reconcileAlerts directly with synthetic results.
 *
 * The `d1` result is reconciled FIRST and through a store that is not D1, and
 * a D1 outage returns right there: everything below reads the table that is
 * down, and attempting it would only trade one email for ten stack traces. */
export async function runWatchtower(env: Env, mailer: OpsMailer, nowMs: number, scope: SweepScope = {}): Promise<AlertOutcome[]> {
  const results = await evaluateHealthChecks(env, nowMs, scope);
  const d1 = results.find((r) => r.name === D1_CHECK) as CheckResult;

  const outcomes: AlertOutcome[] = [await reconcileD1Alert(env, mailer, d1, nowMs)];
  if (!d1.healthy) return outcomes;

  outcomes.push(...(await reconcileAlerts(env, mailer, results.filter((r) => r.name !== D1_CHECK), nowMs)));
  outcomes.push(...(await reportAlertBudgetHealth(env, mailer, nowMs)));
  await recordWatchtowerCompleted(env, nowMs);
  return outcomes;
}

/**
 * Report whether the announcement channel is WITHHOLDING (§5.5).
 *
 * OBSERVED AFTER this tick's announcements, not before, so the report describes
 * the budget the tick actually left behind.
 *
 * EXEMPT FROM THE BUDGET IT ANNOUNCES, and that is the whole point of it being a
 * check at all: budgeting this one makes it self-suppressing — it goes unhealthy
 * exactly when the budget is full, so it is always the announcement with no slot
 * left. Simulated over a 7-day storm, 0 sent / 2015 withheld, with the founder
 * never told the channel was rate-limited. This repo has a name for that shape
 * (an alarm that depends on the thing it monitors); it is the same reason
 * `cron_sweep` is exempt from the debounce.
 *
 * `saturated` reads EITHER counter. A total-only reading is silent in exactly
 * the storm this exists for: with the 15-of-20 per-entity sub-cap in place, a
 * PURE per-entity storm pins the total at 15/20 forever, so the check never
 * fires while 85 of 100 instances are being suppressed.
 *
 * NEVER THROWS: the budget being unreadable is not a reason to take the sweep
 * down, and `reconcileAlerts` has already fail-opened on the same DO.
 */
export async function reportAlertBudgetHealth(env: Env, mailer: OpsMailer, nowMs: number): Promise<AlertOutcome[]> {
  let budget: { total: number; perEntity: number; saturated: boolean };
  try {
    budget = await watchtowerStub(env).readAnnouncementBudget(nowMs);
  } catch (err) {
    // THE CEILING IS NOT BEING APPLIED, and that is worth its own announcement
    // (DESIGN DELTA — orchestrator ruling on build-gate N2, option (a)). This
    // used to return `[]`, leaving the check UNREPORTED at exactly the moment
    // the budget was not bounding anything: the founder got the storm with no
    // explanation. The counter and the ring live in the same WatchtowerDO, so
    // "cannot read the budget" and "cannot apply the budget" are one condition.
    //
    // IT REACHES THE FOUNDER BECAUSE THE FAMILY IS BUDGET-EXEMPT, not because
    // of the fail-open allowance: `isBudgetedAnnouncement` filters exempt
    // families out before `claimAnnouncementSlots` is called at all, so this
    // announcement never asks for a slot and cannot be denied one. What the
    // fail-open bound buys it is AUDIBILITY — capping the storm at the reserved
    // slice per tick is what keeps this message from being buried under a
    // hundred near-identical ones in the same inbox.
    console.error("watchtower: the announcement budget could not be read — the daily ceiling is NOT being applied this tick", err);
    return reconcileAlerts(
      env,
      mailer,
      [
        {
          name: ALERT_BUDGET_EXCEEDED_CHECK,
          healthy: false,
          materiality: "unreadable",
          detail:
            `The founder alert budget CANNOT BE READ — the WatchtowerDO that holds the rolling 24h counter is ` +
            `unreachable, so the <=${MAX_ANNOUNCEMENT_EMAILS_PER_DAY}/day announcement ceiling is NOT being applied. ` +
            `Announcements are bounded only at ${MAX_ANNOUNCEMENT_EMAILS_PER_DAY - MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY} ` +
            `per 5-minute tick while this lasts, so expect MORE mail than usual, not less. This condition is correlated ` +
            `with the storms the budget exists for — the same Durable Object holds the sweep's streak state and the D1 ` +
            `check's own alert state — so treat a burst arriving alongside this as a platform incident, not as noise.`,
        },
      ],
      nowMs,
    );
  }

  const scope = `${budget.total} of ${MAX_ANNOUNCEMENT_EMAILS_PER_DAY} announcement(s) in the last 24h, ${budget.perEntity} of ${MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY} per-entity`;
  return reconcileAlerts(
    env,
    mailer,
    [
      budget.saturated
        ? {
            name: ALERT_BUDGET_EXCEEDED_CHECK,
            healthy: false,
            materiality: "saturated",
            detail:
              `The founder alert channel is WITHHOLDING announcements — ${scope}. ` +
              `Alerts that would otherwise have been sent are being delayed until a slot frees up, so an empty inbox does NOT ` +
              `mean a quiet platform right now: poll GET /admin/ops/checks for the full picture. The cron dead-man, the ` +
              `money-bearing one-shot failures and every recovery email are exempt and still arriving.`,
          }
        : {
            name: ALERT_BUDGET_EXCEEDED_CHECK,
            healthy: true,
            // reobserved: the counters were just read out of the ring, so the
            // healthy claim is a current measurement, not an absence.
            basis: "reobserved",
            detail: `The founder alert channel has room — ${scope}.`,
          },
    ],
    nowMs,
  );
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
 * They are also ONE-SHOT, which is why they are never streak-damped and why
 * `policyFor` exempts their check names from the 2026-08-16 transition
 * debounce: a repeat-observation requirement on an event that happens once
 * would not delay the alert, it would silence it forever.
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

/** One row of the D1-backed per-check state, shaped for a READ surface (the
 * exact columns `migrations/0008_watchtower.sql` persists, renamed to match
 * `CheckResult`/`AlertState`'s field names elsewhere in this file). */
export interface WatchtowerCheckRow {
  name: string;
  healthy: boolean;
  detail: string;
  sinceTs: number;
  lastAlertTs: number | null;
  updatedAt: number;
}

/** One PAGE of check rows, with the totals it was drawn from. */
export interface WatchtowerCheckPage {
  rows: WatchtowerCheckRow[];
  /** Every row in the table, whatever this page's filter was. */
  total: number;
  /** Every UNHEALTHY row in the table — never this page's share of them. */
  unhealthyTotal: number;
}

/**
 * One bounded page of persisted check rows, PLUS the totals it came from — for
 * `GET /admin/ops/checks` (`../routes/admin-ops.ts`), the operator's own agent
 * polling per-check health instead of parsing `OPS_ALERT_EMAIL` alerts. Pure
 * SELECT: it shares `watchtower_state` with `reconcileAlerts` but never writes
 * to it, so this read path cannot affect alert emission, dedup state or the 6h
 * cooldown.
 *
 * S8 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — this was the last
 * unbounded cross-tenant operator read: no LIMIT, no cursor, no truncation, over
 * a table the S5 retirement bounds only by TIME (a platform can hold more than
 * a page of checks inside one retention window, and an incident is exactly when
 * it does).
 *
 * THE PAGE AND ITS DENOMINATOR COME OUT TOGETHER, deliberately: a caller cannot
 * obtain the rows without also obtaining the numbers that say whether they are
 * all of them. That is the whole watch-completeness lesson applied to its own
 * fix — bounding a read without publishing what it was bounded from just moves
 * the blind spot.
 *
 * TWO SEPARATE MECHANISMS KEEP A BROKEN CHECK ON PAGE ONE, and they cover
 * different reads — worth stating precisely, because each one alone looks
 * sufficient:
 *
 *  - the ORDER BY sorts unhealthy first, which is what the UNFILTERED read
 *    depends on. Without it, a page of healthy checks with newer `since_ts`
 *    buries every broken one past the LIMIT. (Executed: dropping the
 *    `(status = 'healthy') ASC` term reds `admin-ops-checks.test.ts`.)
 *  - the WHERE is what makes `?unhealthy=1` a filtered READ rather than a
 *    filtered PAGE. Given the ordering above the two happen to agree on which
 *    rows come back, so this is not load-bearing for correctness today — what
 *    it buys is not materialising a page of healthy rows only to discard them,
 *    and a `count` that needs no post-filtering. Stated rather than dressed up
 *    as the guard.
 *
 * The clamp can only cost you unhealthy rows once there are MORE unhealthy rows
 * than the clamp, and `unhealthyTotal` + the route's `truncated` say so
 * explicitly when it happens.
 *
 * The order is also TOTAL (`since_ts DESC, check_name ASC` after the status
 * term): without a total order a LIMIT returns whatever the index walk
 * produces, so successive polls could disagree about which rows exist and a
 * watch that diffs pages would see phantom appearances and disappearances.
 */
export async function readCheckRows(
  env: Env,
  opts: { limit?: number; onlyUnhealthy?: boolean } = {},
): Promise<WatchtowerCheckPage> {
  const limit = clampListLimit(opts.limit, DEFAULT_ADMIN_LIST_LIMIT, MAX_ADMIN_LIST_LIMIT);
  const [totals, page] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'unhealthy' THEN 1 ELSE 0 END) as unhealthy FROM watchtower_state`,
    ).first<{ total: number | null; unhealthy: number | null }>(),
    env.DB.prepare(
      `SELECT check_name, status, since_ts, last_alert_ts, last_detail, updated_at
         FROM watchtower_state
        ${opts.onlyUnhealthy ? `WHERE status = 'unhealthy'` : ``}
        ORDER BY (status = 'healthy') ASC, since_ts DESC, check_name ASC
        LIMIT ?`,
    )
      .bind(limit)
      .all<{
        check_name: string;
        status: "healthy" | "unhealthy";
        since_ts: number;
        last_alert_ts: number | null;
        last_detail: string;
        updated_at: number;
      }>(),
  ]);

  return {
    rows: page.results.map((row) => ({
      name: row.check_name,
      healthy: row.status === "healthy",
      detail: row.last_detail,
      sinceTs: row.since_ts,
      lastAlertTs: row.last_alert_ts,
      updatedAt: row.updated_at,
    })),
    total: totals?.total ?? 0,
    unhealthyTotal: totals?.unhealthy ?? 0,
  };
}

/**
 * Which of `names` currently have a row — the ROSTER lookup, asked directly of
 * the table rather than inferred from a page.
 *
 * `missing` (the roster denominator this endpoint publishes) used to be derived
 * from the full unfiltered read, which was correct only because that read was
 * unbounded. Deriving it from a PAGE instead would name every expected check
 * that fell past the LIMIT as absent — turning the guard against a silently
 * deleted check into a generator of false ones, on exactly the surface an
 * operator trusts to tell them what is not being watched.
 *
 * Bounded by the caller's own list: `expectedCheckRoster` returns a
 * code-defined roster (single digits today), comfortably inside D1's 100
 * bound-parameter ceiling per statement.
 */
export async function readPresentCheckNames(env: Env, names: readonly string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const result = await env.DB.prepare(
    `SELECT check_name FROM watchtower_state WHERE check_name IN (${names.map(() => "?").join(", ")})`,
  )
    .bind(...names)
    .all<{ check_name: string }>();
  return new Set(result.results.map((row) => row.check_name));
}

/** The persisted state PLUS the detail it was written with — `reconcileAlerts`
 * needs both to tell a genuine no-op tick from one that changed something. */
interface PersistedCheck {
  state: AlertState;
  detail: string;
}

async function readWatchtowerState(env: Env): Promise<Map<string, PersistedCheck>> {
  const result = await env.DB.prepare(
    `SELECT check_name, status, since_ts, last_alert_ts, last_detail, unhealthy_obs, alert_count, healthy_obs, realert_count, announced_keys
       FROM watchtower_state`,
  ).all<{
    check_name: string;
    status: "healthy" | "unhealthy";
    since_ts: number;
    last_alert_ts: number | null;
    last_detail: string | null;
    unhealthy_obs: number;
    alert_count: number;
    healthy_obs: number;
    realert_count: number;
    announced_keys: string | null;
  }>();
  const map = new Map<string, PersistedCheck>();
  for (const row of result.results) {
    map.set(row.check_name, {
      state: {
        status: row.status,
        sinceTs: row.since_ts,
        lastAlertTs: row.last_alert_ts,
        unhealthyObs: row.unhealthy_obs,
        healthyObs: row.healthy_obs,
        alertCount: row.alert_count,
        realertCount: row.realert_count,
        announcedKeys: parseAnnouncedKeys(row.announced_keys, row.check_name),
      },
      detail: row.last_detail ?? "",
    });
  }
  return map;
}

/**
 * Read the ledger blob, taking the LEGACY branch on anything unreadable.
 *
 * A `JSON.parse` failure must NOT produce "this episode announced nothing":
 * that instructs the machine to re-announce every key in the episode, so a
 * single corrupt byte becomes a storm. An empty ledger on an announced episode
 * is `decideAlert`'s silent adopt instead — the safe reading of "we cannot tell
 * what was announced". `normalizeAlertState` coerces the shape; this only has to
 * survive the parse.
 */
function parseAnnouncedKeys(raw: string | null, checkName: string): AnnouncedKeys {
  if (raw === null) return { ...EMPTY_ANNOUNCED_KEYS };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as AnnouncedKeys;
  } catch (err) {
    console.error(`watchtower: check "${checkName}" has an unreadable announced-keys ledger — treating it as legacy`, err);
  }
  return { ...EMPTY_ANNOUNCED_KEYS };
}

/**
 * Is this tick's outcome byte-identical to what is already stored?
 *
 * S5 (scale audit), MEASURED: every entity that has ever alerted re-emits a
 * healthy `CheckResult` on EVERY tick — the per-entity clear loops in
 * `sendPipelineChecks` iterate `reported`, not the unhealthy set — and each one
 * used to cost an `upsertWatchtowerState` D1 write. Probed at one mailbox + one
 * domain: `{"seededEntityResultsPerTick":[2,2,2,2,2],"watchtowerWritesOver5Ticks":20}`.
 * That cost is additive to the per-tenant fan-out and grows with the platform's
 * LIFETIME count of entities that ever hit an alert.
 *
 * Skipping the write changes nothing an alert consumer reads except
 * `updated_at`, which stops advancing for a check that has nothing new to say.
 * That mattered — `updated_at` freshness was the de-facto dead-cron tell for
 * `GET /admin/ops/checks` — so that route now serves `sweepAgeSeconds` from
 * `watchtower_cursor` instead, a signal the sweep writes UNCONDITIONALLY. The
 * tell is published rather than inferred from a side effect nobody declared.
 */
function isSteadyState(prev: PersistedCheck | undefined, next: AlertState, detail: string): boolean {
  if (!prev) return false;
  return (
    prev.detail === detail &&
    prev.state.status === next.status &&
    prev.state.sinceTs === next.sinceTs &&
    prev.state.lastAlertTs === next.lastAlertTs &&
    prev.state.unhealthyObs === next.unhealthyObs &&
    prev.state.alertCount === next.alertCount &&
    // The three the alert-state increment added. Omitting any of them would make
    // this predicate report "nothing changed" for a tick that banked a new
    // materiality key or advanced the recovery confirmation — the write would be
    // skipped and the ledger silently reverted on the next read, so the same
    // condition would announce again on every tick.
    prev.state.healthyObs === next.healthyObs &&
    prev.state.realertCount === next.realertCount &&
    prev.state.announcedKeys.overflow === next.announcedKeys.overflow &&
    prev.state.announcedKeys.keys.length === next.announcedKeys.keys.length &&
    prev.state.announcedKeys.keys.every((key, i) => key === next.announcedKeys.keys[i])
  );
}

/**
 * How long a check must have been HEALTHY before its row is retired.
 *
 * Long enough that the row is still there for an operator reading
 * `GET /admin/ops/checks` after an incident, short enough that the per-entity
 * families do not accumulate for the platform's lifetime.
 *
 * NOT "the table no longer grows", which is what this used to claim (N4,
 * docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md). Retirement
 * deletes `status = 'healthy'` rows ONLY — correctly, since `since_ts` on an
 * unhealthy row means "unhealthy since" and the same predicate would delete
 * exactly the longest-running incidents. The three one-shot families this wave
 * introduced (`mailbox_release_failed:`, `domain_ordinal_failed:`,
 * `mailbox_slot_failed:`) have three producers and, grepped, ZERO clearers:
 * nothing anywhere ever reports those names healthy, so their rows are
 * immortal by construction and this GC never touches them. Executed by the
 * gate: `10-YEAR-OLD one-shots: retired=1 rowsLeft=3 unhealthyLeft=3`.
 *
 * OWED, and deliberately NOT invented here: a clearing path for those three.
 * One-shot semantics are the frozen alert-state design's territory (§7.3's
 * `recoverAfter: 1` does not help — recovery needs a healthy observation and no
 * producer emits one), and guessing at a clearer in this lane would put a
 * second opinion about one-shot lifecycle into the codebase a week before the
 * increment that owns it lands. Tracked on the ROADMAP under the alert-state
 * increment. Until then the growth is bounded by real provisioning/teardown
 * FAILURES, not by tenant count, and it is visible: those rows are unhealthy,
 * so they sit at the top of `GET /admin/ops/checks` where an operator can see
 * the queue lengthening. Retirement is what stops S5's
 * other half: the ownership sets the per-entity clears test against
 * (`provisionedDomains`, `mailboxProvenance`, `mailboxIntentEmails`) carry NO
 * released/status filter by design — that is what lets a stale alert clear
 * instead of pinning unhealthy forever — so a churned customer's entities keep
 * emitting a clear result on every tick, for life. Once the row is gone they
 * are not in `reported`, so nothing emits for them at all.
 */
export const CHECK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete check rows that have been healthy for the whole retention window.
 *
 * ONLY `status='healthy'`: an unhealthy row is a live incident and `since_ts`
 * on it means "unhealthy since", so the same predicate would delete exactly the
 * longest-running problems. Retiring a healthy row is also alert-neutral — the
 * check's next unhealthy observation reads `prev = null`, which
 * `decideAlert` already treats identically to `prev = healthy` (a fresh
 * episode, debounced by the check's own policy), and `readCheckStatus`'s one
 * consumer (engine/mailbox-acquisition.ts) branches on `!== "unhealthy"`, which
 * `null` and `"healthy"` both satisfy.
 *
 * NEVER A ROSTER MEMBER (N3, docs/adversarial/wave-b1-scale-monitoring-gate-
 * 2026-08-20.md). Retirement and the roster denominator composed into a lie:
 * `expectedCheckRoster` lists the always-on checks and `GET /admin/ops/checks`
 * reports any of them without a row as `missing` — the guard whose whole stated
 * purpose is to catch "an env var lost in a deploy DELETED a check from the
 * monitored set". Retiring one of those rows manufactures exactly that symptom
 * with no cause. Executed by the gate:
 *
 *   MISSING after one retireHealthyCheckRows: ["do_storage","failure_signals",
 *     "cron_legs","sweep_coverage","sweep_signals","alert_delivery"]
 *
 * Four of the six were rewritten later in the same tick and so had no observable
 * gap; `do_storage` and `failure_signals` are written BEFORE retirement runs and
 * carried a one-cron-period false `missing` every 7 days.
 *
 * Excluding them costs nothing S5 was for. S5 bounds the PER-ENTITY families —
 * `domain_dns_aging:`, `cred_push_aging:`, `mailbox_orphan:` — which are
 * unbounded in COUNT because they grow with every entity the platform has ever
 * held. The roster is a code-defined, single-digit set. And it stays
 * self-correcting: the roster is computed from `env`, so a check that genuinely
 * goes away (ENGINE_BASE_URL unset ⇒ no `engine`) drops out of the roster and
 * its stale row becomes retirable again on the very next tick.
 */
export async function retireHealthyCheckRows(env: Env, nowMs: number): Promise<{ retired: number }> {
  const roster = expectedCheckRoster(env);
  const result = await env.DB.prepare(
    `DELETE FROM watchtower_state
      WHERE status = 'healthy'
        AND since_ts <= ?
        AND check_name NOT IN (${roster.map(() => "?").join(", ") || "''"})`,
  )
    .bind(nowMs - CHECK_RETENTION_MS, ...roster)
    .run();
  return { retired: result.meta.changes ?? 0 };
}

async function upsertWatchtowerState(
  env: Env,
  params: { name: string; state: AlertState; detail: string; nowMs: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_state
       (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count, healthy_obs, realert_count, announced_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(check_name) DO UPDATE SET
       status = excluded.status,
       since_ts = excluded.since_ts,
       last_alert_ts = excluded.last_alert_ts,
       last_detail = excluded.last_detail,
       updated_at = excluded.updated_at,
       unhealthy_obs = excluded.unhealthy_obs,
       alert_count = excluded.alert_count,
       healthy_obs = excluded.healthy_obs,
       realert_count = excluded.realert_count,
       announced_keys = excluded.announced_keys`,
  )
    .bind(
      params.name,
      params.state.status,
      params.state.sinceTs,
      params.state.lastAlertTs,
      params.detail,
      params.nowMs,
      params.state.unhealthyObs,
      params.state.alertCount,
      params.state.healthyObs,
      params.state.realertCount,
      JSON.stringify(params.state.announcedKeys),
    )
    .run();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
