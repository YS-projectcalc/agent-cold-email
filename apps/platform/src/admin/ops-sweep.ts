// D2/D6 (brief) — the sweep/digest logic shared by the on-demand admin
// routes (routes/admin-ops.ts) AND the cron `scheduled()` handler
// (../scheduled.ts), so cron never re-implements what the HTTP route already
// does (CLAUDE.md rule c). Every function here takes `env` + iterates the D1
// tenants_index, dispatching into each tenant's own DO via RPC — see
// admin/README.md for why this is the aggregation boundary.

import { RealClock } from "../clock.js";
import { countWaitlistEmails, lookupTenantContactEmail } from "../db.js";
import type { Env } from "../env.js";
import type { TenantOpsSummary } from "../engine/ops-summary.js";
import { escapeHtml } from "../html-escape.js";
import { BUDGET_EXPIRED, rotationOffset, withItemBudget } from "../isolated-loop.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import { newId } from "../schema.js";
import { countSupportTicketsByStatus, countTerminatedTenants, hasDunningEventForCycle, insertDunningEventIfNew, listAllTenantIds } from "./db.js";
import { decideDunningAction } from "./dunning.js";

export interface DunningSweepResult {
  tenantId: string;
  cycle: number;
  action: string;
  applied: boolean;
}

export interface DunningSweepSummary {
  scannedTenants: number;
  pastDueTenants: number;
  results: DunningSweepResult[];
  /** Tenants whose sweep body threw (a wedged/overloaded DO, storage error,
   * etc). Never aborts the sweep for the rest — mirrors the 3 sibling sweeps
   * below (audit F1, 2026-08-05). */
  errors: number;
}

/** D2 dunning sweep — scans every tenant, actions only the 'past_due' ones,
 * idempotent per (tenant, failure-count cycle). On a NEWLY-applied suspend it
 * emails the tenant a plain honest notice + the founder a copy via the
 * OpsMailer (`mailer` is injectable for tests; production builds a real/dark
 * one). Email failure NEVER blocks the suspend — the suspend commits first. */
export async function runDunningSweep(
  env: Env,
  nowMs: number,
  mailer: OpsMailer = createOpsMailer(env),
): Promise<DunningSweepSummary> {
  const tenantIds = await listAllTenantIds(env);
  const results: DunningSweepResult[] = [];
  let errors = 0;

  for (const tenantId of tenantIds) {
    try {
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      const summary = await stub.opsSummary(nowMs);
      if (summary.billingState !== "past_due") continue;

      const cycle = summary.billingFailureCount;
      // A5: a permanent decline code makes this suspend immediately, regardless
      // of cycle count (see admin/dunning.ts).
      const action = decideDunningAction(cycle, summary.lastDeclineCode);
      const recordEvent = () =>
        insertDunningEventIfNew(env, {
          id: newId("dun"),
          tenantId,
          cycle,
          action,
          detail: { billingFailureCount: cycle, plan: summary.plan, declineCode: summary.lastDeclineCode },
          ts: nowMs,
        });

      let applied: boolean;
      if (action === "suspend") {
        // F2 (audit 2026-08-05): apply the suspend EFFECT before recording the
        // idempotency guard row — the reverse of the old order left a
        // committed guard row with the tenant never actually suspended on a
        // crash/RPC-failure in between, and since `cycle` freezes once
        // Stripe's payment_failed retries are exhausted, the suspend was never
        // retried (permanent miss). suspendForDunning is safe to re-run: it's
        // a conditional UPDATE (F3), a no-op if already suspended or no
        // longer past_due.
        //
        // The guard-row INSERT can no longer gate BEFORE the effect now that
        // it commits AFTER it, so a cheap read-only pre-check stands in for
        // it: without this, an already-suspended tenant stays 'past_due'
        // forever (suspending never changes billing_state) and would be
        // re-suspended + re-emailed the notice on every subsequent tick.
        const alreadyActioned = await hasDunningEventForCycle(env, tenantId, cycle);
        if (alreadyActioned) {
          applied = false;
        } else {
          const suspended = await stub.suspendForDunning();
          if (suspended) {
            await sendDunningSuspendNotice(env, mailer, { tenantId, brand: summary.brand, cycle, declineCode: summary.lastDeclineCode });
            applied = await recordEvent();
          } else {
            // F3: billing_state was no longer 'past_due' at write time — a
            // recovery webhook landed in the read/write gap. Nothing happened;
            // don't record a suspend event or email one that didn't occur.
            applied = false;
          }
        }
      } else {
        applied = await recordEvent();
      }
      results.push({ tenantId, cycle, action, applied });
    } catch (err) {
      // One tenant's failure must never abort the sweep for every other
      // tenant, nor (via runScheduledOpsSweep) every other cron leg — mirrors
      // the 3 sibling sweeps below (audit F1, 2026-08-05).
      errors++;
      console.error(`dunning sweep failed for tenant ${tenantId}`, err);
    }
  }

  return { scannedTenants: tenantIds.length, pastDueTenants: results.length, results, errors };
}

/**
 * Best-effort dunning-suspend notification: a plain honest notice to the
 * tenant's contact email (from D1 — captured at signup, migrations/0007) plus
 * a founder copy. If no contact email is on file (a tenant that predates the
 * column, or the test-only mintTenant path) the tenant notice is FLAGGED, not
 * faked — the founder copy still goes out and says so. Every send is wrapped:
 * a dark/unconfigured OpsMailer must never break the sweep.
 */
async function sendDunningSuspendNotice(
  env: Env,
  mailer: OpsMailer,
  params: { tenantId: string; brand: string; cycle: number; declineCode: string | null },
): Promise<void> {
  const { tenantId, brand, cycle, declineCode } = params;
  let contactEmail: string | null = null;
  try {
    contactEmail = await lookupTenantContactEmail(env, tenantId);
  } catch (err) {
    console.error(`dunning notice: contact-email lookup failed for tenant ${tenantId}`, err);
  }

  if (contactEmail) {
    const text =
      `Your coldrig account "${brand}" has been suspended after ${cycle} failed payment attempt(s).\n\n` +
      `Sending is paused. To restore your account, update your payment method and complete checkout again — ` +
      `it reactivates automatically once payment succeeds.\n\n` +
      `If you believe this is a mistake, reply to this email and it will reach our team.`;
    await trySendNotice(mailer, {
      to: contactEmail,
      subject: `[coldrig] Your account "${brand}" has been suspended for non-payment`,
      text,
      html: `<p>Your coldrig account <strong>${escapeHtml(brand)}</strong> has been suspended after ${cycle} failed payment attempt(s).</p>` +
        `<p>Sending is paused. To restore your account, update your payment method and complete checkout again — it reactivates automatically once payment succeeds.</p>` +
        `<p>If you believe this is a mistake, reply to this email and it will reach our team.</p>`,
    });
  }

  if (env.OPS_ALERT_EMAIL) {
    const notified = contactEmail ? `tenant notified at ${contactEmail}` : `NO contact email on file — tenant NOT notified (flag)`;
    const text =
      `Tenant "${brand}" (${tenantId}) was suspended by the dunning sweep.\n` +
      `Cycle: ${cycle}. Decline code: ${declineCode ?? "none/unknown"}.\n` +
      `${notified}.`;
    await trySendNotice(mailer, {
      to: env.OPS_ALERT_EMAIL,
      subject: `[coldrig] tenant "${brand}" suspended (dunning)`,
      text,
      html: `<p>Tenant <strong>${escapeHtml(brand)}</strong> (<code>${escapeHtml(tenantId)}</code>) was suspended by the dunning sweep.</p>` +
        `<p>Cycle: ${cycle}. Decline code: ${escapeHtml(declineCode ?? "none/unknown")}.</p>` +
        `<p>${escapeHtml(notified)}.</p>`,
    });
  }
}

async function trySendNotice(mailer: OpsMailer, msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
  try {
    await mailer.send(msg);
  } catch (err) {
    console.error(`dunning notice: send to ${msg.to} failed (dark or transient)`, err);
  }
}

export interface DeliverabilitySweepAllSummary {
  tenantsSwept: number;
  errors: number;
}

/** Runs the deliverability monitor->decide->act loop for EVERY tenant — the cron lane (no send scheduling, that's tick()/B2). */
export async function runDeliverabilitySweepAllTenants(env: Env): Promise<DeliverabilitySweepAllSummary> {
  const tenantIds = await listAllTenantIds(env);
  let errors = 0;
  for (const tenantId of tenantIds) {
    try {
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      await stub.deliverabilitySweep();
    } catch (err) {
      // One tenant's failure must not abort the sweep for every other tenant.
      errors++;
      console.error(`deliverability sweep failed for tenant ${tenantId}`, err);
    }
  }
  return { tenantsSwept: tenantIds.length, errors };
}

export interface WarmupCancelSweepAllSummary {
  tenantsSwept: number;
  cancelled: number;
  errors: number;
}

/**
 * Cancels ramp-complete warmup subscriptions for EVERY tenant — the cron lane
 * for the founder's 2026-08-02 auto-cancel ruling (ROADMAP.md:25).
 *
 * A1 (adversary warmup-wave review): this runner is what makes the sweep
 * REACHABLE in production. It previously ran only inside `runTick`, which no
 * scheduler, route, MCP tool, or DO alarm invokes — so no subscription would
 * ever have been cancelled while the site claimed otherwise. Kept out of
 * `tick()` on purpose: driving the full tick from cron would arm automatic
 * campaign sending, a separate founder-gated decision. Carries no send
 * scheduling, exactly like `runDeliverabilitySweepAllTenants`.
 *
 * One tenant's failure never aborts the sweep for the rest, and the per-tenant
 * sweep itself grades each mailbox independently and never throws.
 */
export async function runWarmupCancelSweepAllTenants(env: Env): Promise<WarmupCancelSweepAllSummary> {
  const tenantIds = await listAllTenantIds(env);
  let cancelled = 0;
  let errors = 0;
  for (const tenantId of tenantIds) {
    try {
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      const result = await stub.warmupCancelSweep();
      cancelled += result.cancelled;
    } catch (err) {
      errors++;
      console.error(`warmup cancel sweep failed for tenant ${tenantId}`, err);
    }
  }
  return { tenantsSwept: tenantIds.length, cancelled, errors };
}

export interface ProvisioningReconcileSweepSummary {
  /** True iff PROVISIONING_RECONCILE_ENABLED was dark and NOTHING ran. */
  disabled: boolean;
  tenantsSwept: number;
  /** Domains re-driven across all tenants. */
  reconciled: number;
  /** Re-drives that finished cleanly. */
  completed: number;
  /** Committed intents skipped for want of a durable spec (legacy rows). */
  skippedNoSpec: number;
  /** Per-tenant reconcile failures (a deferred domain, or a wedged DO) — never aborts the sweep. */
  errors: number;
}

/**
 * Is the C3-part-d out-of-band provisioning reconcile ARMED? DARK (false) unless
 * PROVISIONING_RECONCILE_ENABLED is set to a genuinely-affirmative value — empty,
 * "0", "false", "off" (case-insensitive) all read as OFF, so a founder who sets a
 * disabling word gets what they meant instead of the "any-non-empty-value"
 * footgun. Shipped default (unset) is dark.
 */
function provisioningReconcileArmed(env: Env): boolean {
  const raw = (env.PROVISIONING_RECONCILE_ENABLED ?? "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * C3 part d — the out-of-band provisioning-reconcile leg for EVERY tenant.
 * DARK by default: the arming flag is checked ONCE here (mirroring
 * AUTOSEND_DISABLED's single leg-level check in runSendPipelineAllTenants), so
 * while the flag is unset this is a cheap no-op that constructs no tenant DO and
 * spends nothing. Once armed, each tenant's own DO re-drives its pending setup
 * domains to completion against its own storage; one tenant's failure never
 * aborts the sweep for the rest.
 */
export async function runProvisioningReconcileAllTenants(env: Env): Promise<ProvisioningReconcileSweepSummary> {
  const empty: ProvisioningReconcileSweepSummary = {
    disabled: false,
    tenantsSwept: 0,
    reconciled: 0,
    completed: 0,
    skippedNoSpec: 0,
    errors: 0,
  };
  if (!provisioningReconcileArmed(env)) {
    // Shipped default — no deploy, no code change arms it; a `wrangler secret put`
    // / `[vars]` entry does, and only then does auto-completion (which SPENDS on
    // an armed tenant) begin. Logged loudly on the rare armed tick, silent here.
    return { ...empty, disabled: true };
  }

  const tenantIds = await listAllTenantIds(env);
  const summary: ProvisioningReconcileSweepSummary = { ...empty, tenantsSwept: tenantIds.length };
  for (const tenantId of tenantIds) {
    try {
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      const result = await stub.provisioningReconcileSweep();
      summary.reconciled += result.reconciled;
      summary.completed += result.completed;
      summary.skippedNoSpec += result.skippedNoSpec;
      summary.errors += result.errors;
    } catch (err) {
      // One tenant's failure must never abort the sweep for every other tenant,
      // nor (via runScheduledOpsSweep) every other cron leg.
      summary.errors++;
      console.error(`provisioning reconcile sweep failed for tenant ${tenantId}`, err);
    }
  }
  return summary;
}

export interface WebhookDeliverySweepSummary {
  tenantsSwept: number;
  errors: number;
}

/**
 * Drives the outbound webhook delivery pump for EVERY tenant — the cron wake
 * for the retry/backoff queue (ROADMAP.md WIN-THE-COMPARISON (d)). Each
 * tenant's own DO owns its queue; runWebhookDeliveries attempts every due
 * pending delivery on REAL wall-clock and reschedules failures per the backoff
 * ladder, so this cron cadence is the delivery clock. Idempotent (only due rows
 * fire); one tenant's failure never aborts the sweep for the rest.
 */
export async function runWebhookDeliveriesAllTenants(env: Env): Promise<WebhookDeliverySweepSummary> {
  const tenantIds = await listAllTenantIds(env);
  let errors = 0;
  for (const tenantId of tenantIds) {
    try {
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      await stub.runWebhookDeliveries();
    } catch (err) {
      errors++;
      console.error(`webhook delivery sweep failed for tenant ${tenantId}`, err);
    }
  }
  return { tenantsSwept: tenantIds.length, errors };
}

// --- Wave-2 §5: the send-pipeline leg (the auto-send driver) ---------------

/**
 * How long ONE tenant's poll+tick pair may occupy the leg. Rung 3 of the
 * ordering ladder documented in vendors/real/email-port.ts — it MUST exceed
 * ENGINE_REQUEST_TIMEOUT_MS (120s), or a tenant behind a slow-but-alive engine
 * is abandoned having completed zero work on every single cycle, forever
 * (adversary round-2, R5). Read that comment before changing this.
 *
 * The pair shares ONE budget, per the design. Consequence, stated rather than
 * hidden: against a WEDGED engine a tenant's poll can consume the whole budget
 * and its tick never runs — but a wedged engine is exactly the state in which
 * the tick could not have sent anything either, so nothing is lost that was
 * otherwise available.
 */
export const SEND_PIPELINE_TENANT_BUDGET_MS = 135_000;

/**
 * The whole leg's wall-clock ceiling, checked BETWEEN tenants. Converts "the
 * tenants behind a stalled one never run" into "some tenants this cycle, all
 * tenants across cycles" (with the rotation below). True worst case is this
 * plus one tenant budget — 285s, under the 300s cron period, which is what
 * keeps a wedged engine from making every sweep overlap the next.
 */
export const SEND_PIPELINE_LEG_DEADLINE_MS = 150_000;

/** The `[triggers] crons` period this leg is sized against (5 minutes). */
export const CRON_PERIOD_MS = 300_000;

export interface SendPipelineSweepSummary {
  tenantsScanned: number;
  /** Tenants whose DO actually ran the pipeline (the activation predicate allowed it). */
  tenantsRan: number;
  sent: number;
  replies: number;
  /** Tenants whose poll+tick pair threw. Never aborts the sweep for the rest. */
  errors: number;
  /** Tenants abandoned mid-pair at the per-tenant budget. */
  budgetExpiries: number;
  /** Tenants not reached this cycle because the leg deadline was hit. */
  skippedForLegDeadline: number;
  /** True iff AUTOSEND_DISABLED tripped and NOTHING ran. */
  disabled: boolean;
}

// The wall-clock budget racer this leg invented now lives in
// src/isolated-loop.ts beside forEachIsolated (head-of-line class sweep
// 2026-08-17): the per-tenant STALL it guards against here is the same class as
// the per-mailbox one inside a tenant's own inbox poll, and one implementation
// is what stops the two from drifting apart. Behaviour is unchanged — the
// abandoned RPC keeps running, which is safe because every effect it can still
// land is protected by the tick's atomic row claim and the engine's send
// idempotency, and a next-cycle overlap serializes on the DO input gate.

/**
 * WAVE 2 — the auto-send driver. For every tenant: poll, then tick.
 *
 * WHY A CRON LEG AND NOT DO ALARMS (design DECISION 1). The 5-minute cron
 * already fans out several DO-RPC legs across every tenant, so this is +O(N)
 * RPCs on DOs that are being woken anyway; alarms would add three new failure
 * classes (re-arm-after-throw, alarm lost on error, constructor re-arm for
 * existing DOs) whose failure mode is a silently-never-sending tenant — strictly
 * harder to detect than a loud cron-leg error. Cold-email cadence is day- and
 * hour-granular, so 5-minute worst-case latency is immaterial.
 *
 * POLL BEFORE TICK, always: a reply that arrived since the last cycle must land
 * (and stop-on-reply must cancel the remaining steps) BEFORE this cycle decides
 * what to send, or we mail someone who already answered.
 *
 * NO D1 PRE-FILTER. `tenants_index.plan` is stale by design (it is written once
 * at signup and never updated), so a D1 plan filter would exclude the only
 * paying customer. The activation predicate lives ONLY inside the DO
 * (tenant-do.ts's runScheduledTick / runScheduledPoll).
 *
 * `nowMs` seeds the rotation only; the budget/deadline clock is read live.
 */
export async function runSendPipelineAllTenants(
  env: Env,
  nowMs: number = new RealClock().now(),
  opts: { tenantBudgetMs?: number; legDeadlineMs?: number } = {},
): Promise<SendPipelineSweepSummary> {
  const empty: SendPipelineSweepSummary = {
    tenantsScanned: 0,
    tenantsRan: 0,
    sent: 0,
    replies: 0,
    errors: 0,
    budgetExpiries: 0,
    skippedForLegDeadline: 0,
    disabled: false,
  };

  // The ops emergency brake (design predicate leg 6), checked ONCE for the whole
  // leg. Ships ENABLED per the founder ruling; setting AUTOSEND_DISABLED to any
  // non-empty value stops every tenant's automatic sending on the next cycle
  // without a deploy. Logged loudly — a silently-disabled send pipeline is the
  // failure shape this whole wave exists to make impossible.
  if (env.AUTOSEND_DISABLED) {
    console.warn("send pipeline: AUTOSEND_DISABLED is set — no tenant was polled or ticked this cycle (ops kill switch)");
    return { ...empty, disabled: true };
  }

  const tenantIds = await listAllTenantIds(env);
  const summary: SendPipelineSweepSummary = { ...empty, tenantsScanned: tenantIds.length };
  if (tenantIds.length === 0) return summary; // R6 zero-guard: `% 0` is NaN

  const budgetMs = opts.tenantBudgetMs ?? SEND_PIPELINE_TENANT_BUDGET_MS;
  const legDeadlineMs = opts.legDeadlineMs ?? SEND_PIPELINE_LEG_DEADLINE_MS;
  const clock = new RealClock();
  const legStartedAt = clock.now();

  // ROTATION (src/isolated-loop.ts documents the mechanism). `listAllTenantIds`
  // has no ORDER BY, i.e. a stable practical ordering — so without an offset a
  // tenant that consistently burns the budget would occupy the head of the queue
  // on every cycle and starve everyone behind it permanently.
  const offset = rotationOffset(nowMs, CRON_PERIOD_MS, tenantIds.length);

  for (let i = 0; i < tenantIds.length; i++) {
    if (clock.now() - legStartedAt >= legDeadlineMs) {
      summary.skippedForLegDeadline = tenantIds.length - i;
      console.warn(
        `send pipeline: leg deadline reached after ${i}/${tenantIds.length} tenant(s) — ${summary.skippedForLegDeadline} deferred to a later cycle (rotation reaches them)`,
      );
      break;
    }
    const tenantId = tenantIds[(offset + i) % tenantIds.length] as string;
    try {
      const outcome = await withItemBudget(budgetMs, async () => {
        const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
        const poll = await stub.runScheduledPoll();
        const tick = await stub.runScheduledTick();
        return { poll, tick };
      });
      if (outcome === BUDGET_EXPIRED) {
        summary.budgetExpiries++;
        console.warn(`send pipeline: tenant ${tenantId} exceeded its ${budgetMs}ms budget — abandoned for this cycle`);
        continue;
      }
      if (outcome.tick.ran || outcome.poll.ran) summary.tenantsRan++;
      summary.sent += outcome.tick.sent;
      summary.replies += outcome.poll.replies;
    } catch (err) {
      // One tenant's failure must never abort the sweep for every other tenant,
      // nor (via runScheduledOpsSweep) every other cron leg.
      summary.errors++;
      console.error(`send pipeline failed for tenant ${tenantId}`, err);
    }
  }

  return summary;
}

export interface OpsDigest {
  windowHours: number;
  tenants: { total: number; activeByPlan: Record<string, number> };
  mrrCents: number;
  totalUsageCents: number;
  /** Item 3d (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, D8) —
   * cross-tenant sum of `sendPipeline.mailboxOrphans` + `domainOrphans`
   * (engine/ops-summary.ts): mailbox/domain intents at a post-purchase
   * status with no matching live row, past the grace bound. NOT a general
   * "provisioning saga failed" counter (no such signal exists yet) — the name
   * predates this wiring; kept for API stability. */
  provisioningFailureCount: number;
  deliverability: { pausedMailboxesTotal: number; burningDomainsTotal: number; actionsInWindow: number };
  /** Warmup-pool cancellations the platform GAVE UP on in the window (adversary
   * N-b) — each one is an InboxKit subscription that may still be billing. Its
   * own field, never folded into `deliverability.actionsInWindow`: a pause is
   * routine control-loop work, this is money leaking. */
  gaveUpWarmupCancels: number;
  /** H-alert (pipeline F5) — mailboxes across all tenants whose engine
   * credential push has never landed; they cannot send or poll yet. */
  pendingCredentialPushes: number;
  support: { open: number; escalated: number };
  pastDueCount: number;
  /** D5 lifecycle health — canceled/terminated/disputed tenant counts + total annual-domain liability (integer cents). */
  lifecycle: { canceled: number; terminated: number; disputed: number; annualDomainLiabilityCents: number };
  /** C6 — total durable waitlist leads (adversarial panel-03 finding #9: owner visibility into the funnel). */
  waitlist: { count: number };
  watchdogAlerts: string[];
  /** Tenants whose opsSummary call failed this window (wedged/overloaded DO,
   * storage error) — skipped, never zero out the rest of the digest (audit
   * class-sweep sibling fix, 2026-08-06, mirrors runDunningSweep's `errors`). */
  errors: number;
}

/** D6 — the owner's single cross-tenant business-health rollup (SPEC.md §0.10). */
export async function buildOpsDigest(env: Env, nowMs: number, windowHours: number): Promise<OpsDigest> {
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  const tenantIds = await listAllTenantIds(env);
  const summaries: TenantOpsSummary[] = [];
  let errors = 0;
  for (const id of tenantIds) {
    try {
      summaries.push(await env.TENANT.get(env.TENANT.idFromName(id)).opsSummary(sinceMs));
    } catch (err) {
      // One tenant's failure must never zero out the digest for every other
      // tenant, nor 500 the on-demand GET /admin/ops/digest route (audit
      // class-sweep sibling fix, 2026-08-06).
      errors++;
      console.error(`ops digest: opsSummary failed for tenant ${id}`, err);
    }
  }

  const activeByPlan: Record<string, number> = {};
  let mrrCents = 0;
  let totalUsageCents = 0;
  let pastDueCount = 0;
  let pausedMailboxesTotal = 0;
  let burningDomainsTotal = 0;
  let deliverabilityActionsInWindow = 0;
  let gaveUpWarmupCancels = 0;
  let pendingCredentialPushes = 0;
  let canceledCount = 0;
  let disputedCount = 0;
  let annualDomainLiabilityCents = 0;
  // Item 3d (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, D8) —
  // the real cross-tenant count, replacing the hardcoded literal below.
  let provisioningFailureCount = 0;

  for (const s of summaries) {
    if (s.status === "active") activeByPlan[s.plan] = (activeByPlan[s.plan] ?? 0) + 1;
    mrrCents += s.mrrCents;
    totalUsageCents += s.usageCents;
    if (s.billingState === "past_due") pastDueCount++;
    // 'canceling' (end-of-period) and 'canceled' (immediate / Stripe-finalized)
    // both count as lifecycle-canceled for the owner's view.
    if (s.billingState === "canceling" || s.billingState === "canceled") canceledCount++;
    if (s.billingState === "disputed") disputedCount++;
    annualDomainLiabilityCents += s.annualDomainLiabilityCents;
    pausedMailboxesTotal += s.deliverability.pausedMailboxes;
    burningDomainsTotal += s.deliverability.burningDomains;
    deliverabilityActionsInWindow += s.actionsInWindow.paused + s.actionsInWindow.replaced;
    gaveUpWarmupCancels += s.actionsInWindow.gaveUpWarmupCancels;
    pendingCredentialPushes += s.pendingCredentialPushes;
    provisioningFailureCount += s.sendPipeline.mailboxOrphans.length + s.sendPipeline.domainOrphans.length;
  }

  // Terminated tenants come from the D1 enforcement_actions audit log (an
  // abuse TERMINATE is orthogonal to billing_state — see admin/db.ts).
  const terminatedCount = await countTerminatedTenants(env);
  const support = await countSupportTicketsByStatus(env);
  const waitlistCount = await countWaitlistEmails(env);

  // Watchdog alerts — simple threshold-crossing prose, not a separate
  // alerting system (YAGNI, CLAUDE.md rule i). Item 3d (docs/adversarial/
  // class-sweep-vendor-truth-2026-08-18.md, D8) — `provisioningFailureCount`
  // (below) is no longer the hardcoded literal this comment used to describe;
  // it is the real cross-tenant sum of engine/ops-summary.ts's
  // mailboxOrphans + domainOrphans, computed in the loop above.
  const watchdogAlerts: string[] = [];
  if (provisioningFailureCount > 0) {
    watchdogAlerts.push(
      `${provisioningFailureCount} mailbox/domain intent(s) may be orphaned (vendor holds a resource with no matching platform row) — see GET /admin/ops/checks for the named mailbox_orphan:/domain_orphan: entries`,
    );
  }
  if (pausedMailboxesTotal > 0) {
    watchdogAlerts.push(`${pausedMailboxesTotal} mailbox(es) paused by the deliverability loop across all tenants`);
  }
  if (pastDueCount > 0) {
    watchdogAlerts.push(`${pastDueCount} tenant(s) past_due — run POST /admin/ops/dunning-sweep`);
  }
  if (support.escalated > 0) {
    watchdogAlerts.push(`${support.escalated} support ticket(s) escalated, awaiting owner review`);
  }
  if (disputedCount > 0) {
    watchdogAlerts.push(`${disputedCount} tenant(s) frozen by an open chargeback dispute`);
  }
  if (pendingCredentialPushes > 0) {
    watchdogAlerts.push(
      `${pendingCredentialPushes} mailbox(es) still awaiting an engine credential push — they cannot send or poll until an OAuth grant is minted for them (manual-grant step)`,
    );
  }
  if (gaveUpWarmupCancels > 0) {
    watchdogAlerts.push(
      `${gaveUpWarmupCancels} warmup-pool cancellation(s) GAVE UP after retries — those InboxKit subscriptions may still be billing; verify in the vendor console`,
    );
  }

  return {
    windowHours,
    tenants: { total: tenantIds.length, activeByPlan },
    mrrCents,
    totalUsageCents,
    provisioningFailureCount,
    deliverability: { pausedMailboxesTotal, burningDomainsTotal, actionsInWindow: deliverabilityActionsInWindow },
    gaveUpWarmupCancels,
    pendingCredentialPushes,
    support,
    pastDueCount,
    lifecycle: { canceled: canceledCount, terminated: terminatedCount, disputed: disputedCount, annualDomainLiabilityCents },
    waitlist: { count: waitlistCount },
    watchdogAlerts,
    errors,
  };
}
