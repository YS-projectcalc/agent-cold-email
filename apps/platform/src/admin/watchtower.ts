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
import { listAllTenantIds } from "./db.js";
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
  policyFor,
  reasonForNoEmail,
  trySend,
  CRED_PUSH_AGING_CHECK,
  CUSTOMER_PROGRESS_AGENT_CHECK,
  CUSTOMER_PROGRESS_OPERATOR_CHECK,
  D1_CHECK,
  DOMAIN_DNS_AGING_CHECK,
  DOMAIN_ORPHAN_CHECK,
  MAILBOX_ORPHAN_CHECK,
  MAILBOX_PROVISIONING_CHECK,
  MAILBOX_REBUY_CHECK,
  SEND_STARVED_CHECK,
  TENANT_DO_WEDGED_CHECK,
  type AlertOutcome,
  type CheckResult,
} from "./watchtower-alerts.js";
import { decideAlert, normalizeAlertState, withheldAlertState, type AlertState } from "./watchtower-policy.js";
import { FAILURE_SIGNAL_WINDOW_MS, gradeFailureSignals } from "./watchtower-grading.js";
import { reconcileD1Alert, recordWatchtowerCompleted } from "./watchtower-infra.js";
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
    results.push({ name: D1_CHECK, healthy: true, detail: "D1 SELECT 1 ok", basis: "reobserved" });
  } catch (err) {
    d1Healthy = false;
    results.push({ name: D1_CHECK, healthy: false, detail: `D1 unreachable: ${errMsg(err)}` });
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
          : { name: "engine", healthy: false, detail: `engine /health -> HTTP ${res.status}` },
      );
    } catch (err) {
      results.push({ name: "engine", healthy: false, detail: `engine /health unreachable: ${errMsg(err)}` });
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
      results.push(
        ...sendPipelineChecks(tenantId, s, reported, {
          stallMs: customerProgressStallMs(env),
          owedMaxMs: customerProgressOwedMaxMs(env),
        }),
      );
      if (reported.has(wedgedName)) {
        // reobserved: this line is inside the try where the opsSummary RPC
        // actually returned, so the positive claim was just proven.
        results.push({ name: wedgedName, healthy: true, detail: `Tenant ${tenantId} (${s.brand}) is answering again.`, basis: "reobserved" });
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
    const failureDetail = grade
      ? `no failed sends or complaints in the last ${windowMin} min`
      : `${failed} terminal-failed send(s) + ${complaints} complaint(s) in the last ${windowMin} min, across all tenants`;
    results.push({
      name: "failure_signals",
      // reobserved: the healthy claim is a freshly counted window, not an
      // entity dropping out of a filter.
      ...(grade ? { healthy: true as const, basis: "reobserved" as const } : { healthy: false as const }),
      detail: failureDetail,
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

  for (const result of results) {
    try {
      const prev = stateByName.get(result.name) ?? null;
      const policy = policyFor(result.name);
      const transition = decideAlert(prev, result.healthy, nowMs, policy);

      // A blame flip is a RE-CLASSIFICATION, not a recovery: suppress the
      // SEND, never the state transition. `transition.next` (the ordinary
      // clear-to-healthy state) still persists — this tenant is still
      // stalled, just under the sibling's name now, and the abandoned name
      // must not re-alert on its own 24h step.
      const sibling = customerProgressSiblingName(result.name);
      const reclassified = result.healthy && sibling !== null && unhealthyProgressNames.has(sibling);
      // An email was genuinely OWED (would have rendered on the email
      // channel) but this check's channel is not email — distinct from
      // "nothing was owed yet" (pending/suppressed/steady-healthy), which
      // keeps its ordinary `reasonForNoEmail`.
      const wouldEmail = transition.action === "alerted" || transition.action === "realerted" || transition.action === "recovered";
      const digestSuppressed = !reclassified && policy.channel === "digest" && wouldEmail;

      const email = reclassified ? null : alertEmailFor(env, result, transition, prev?.sinceTs ?? null, nowMs, policy);
      // `null` = no email was OWED (suppressed / pending / steady-healthy /
      // digest channel / reclassified). That is not a delivery, and it is not
      // a failure either — it must not withhold the transition, and it must
      // not be recorded as "sent". The two used to be one boolean, which is
      // the same conflation member 5 is about, one level down.
      const notified: Notified | null = email ? await trySend(mailer, email) : null;
      const withheld = notified !== null && !notified.delivered;
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
      const siblingState = sibling !== null ? normalizeAlertState(stateByName.get(sibling) ?? null) : null;
      const stallOnsetTs =
        !result.healthy && siblingState !== null && siblingState.status === "unhealthy"
          ? Math.min(decided.sinceTs, siblingState.sinceTs)
          : decided.sinceTs;
      const state = stallOnsetTs < decided.sinceTs ? { ...decided, sinceTs: stallOnsetTs } : decided;
      await upsertWatchtowerState(env, { name: result.name, state, detail: result.detail, nowMs });

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
        why: notified?.why ?? (reclassified ? "reclassified" : digestSuppressed ? "digest_only" : reasonForNoEmail(transition.action)),
      });
    } catch (err) {
      console.error(`watchtower: check "${result.name}" could not be reconciled — it is UNREPORTED this tick`, err);
      outcomes.push({ name: result.name, action: "unreportable", emailSent: false, why: "send_failed" });
    }
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
  const d1 = results.find((r) => r.name === D1_CHECK) as CheckResult;

  const outcomes: AlertOutcome[] = [await reconcileD1Alert(env, mailer, d1, nowMs)];
  if (!d1.healthy) return outcomes;

  outcomes.push(...(await reconcileAlerts(env, mailer, results.filter((r) => r.name !== D1_CHECK), nowMs)));
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

/**
 * Every persisted check row, unfiltered — for `GET /admin/ops/checks`
 * (`../routes/admin-ops.ts`), the operator's own agent polling per-check
 * health instead of parsing `OPS_ALERT_EMAIL` alerts. Pure SELECT: it shares
 * `watchtower_state` with `reconcileAlerts` but never writes to it, so this
 * read path cannot affect alert emission, dedup state or the 6h cooldown.
 */
export async function readAllCheckRows(env: Env): Promise<WatchtowerCheckRow[]> {
  const result = await env.DB.prepare(
    `SELECT check_name, status, since_ts, last_alert_ts, last_detail, updated_at FROM watchtower_state`,
  ).all<{
    check_name: string;
    status: "healthy" | "unhealthy";
    since_ts: number;
    last_alert_ts: number | null;
    last_detail: string;
    updated_at: number;
  }>();
  return result.results.map((row) => ({
    name: row.check_name,
    healthy: row.status === "healthy",
    detail: row.last_detail,
    sinceTs: row.since_ts,
    lastAlertTs: row.last_alert_ts,
    updatedAt: row.updated_at,
  }));
}

async function readWatchtowerState(env: Env): Promise<Map<string, AlertState>> {
  const result = await env.DB.prepare(
    `SELECT check_name, status, since_ts, last_alert_ts, unhealthy_obs, alert_count FROM watchtower_state`,
  ).all<{
    check_name: string;
    status: "healthy" | "unhealthy";
    since_ts: number;
    last_alert_ts: number | null;
    unhealthy_obs: number;
    alert_count: number;
  }>();
  const map = new Map<string, AlertState>();
  for (const row of result.results) {
    map.set(row.check_name, {
      status: row.status,
      sinceTs: row.since_ts,
      lastAlertTs: row.last_alert_ts,
      unhealthyObs: row.unhealthy_obs,
      alertCount: row.alert_count,
    });
  }
  return map;
}

async function upsertWatchtowerState(
  env: Env,
  params: { name: string; state: AlertState; detail: string; nowMs: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_state (check_name, status, since_ts, last_alert_ts, last_detail, updated_at, unhealthy_obs, alert_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(check_name) DO UPDATE SET
       status = excluded.status,
       since_ts = excluded.since_ts,
       last_alert_ts = excluded.last_alert_ts,
       last_detail = excluded.last_detail,
       updated_at = excluded.updated_at,
       unhealthy_obs = excluded.unhealthy_obs,
       alert_count = excluded.alert_count`,
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
    )
    .run();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
