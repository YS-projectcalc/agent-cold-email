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
import { countSupportTicketsByStatus, countTerminatedTenants, hasDunningEventForCycle, insertDunningEventIfNew } from "./db.js";
import { decideDunningAction } from "./dunning.js";
import { CRON_PERIOD_MS, SEND_PIPELINE_LEG_DEADLINE_MS, SEND_PIPELINE_TENANT_BUDGET_MS, SEND_PIPELINE_TENANT_CAP } from "./sweep-budget.js";
import { countTenants, resolveSweepTenants, sweepTenants, sweptSummary, type SweepScope } from "./tenant-slice.js";

/**
 * THE SHARED OPS-SUMMARY PREFETCH — one DO RPC per tenant per tick, serving the
 * three legs that each used to make their own.
 *
 * WHY A LEG AND NOT A LAZY CACHE. A cache that can MISS does not improve a
 * WORST-CASE budget, and the tenant slice is derived from the worst case: if
 * dunning might still have to fetch, `SWEEP_RPCS_PER_TENANT` cannot come down
 * and the slice cannot go up. Fetching deterministically, first, in its own
 * pass over the same slice under the same deadline, is what makes the saving
 * real rather than typical-case.
 *
 * It runs through `sweepTenants` like every other slice leg, so it carries the
 * deadline and folds into the rotation accumulator — a tenant this leg did not
 * reach is a tenant the legs behind it were not going to reach either.
 */
export interface OpsSummaryPrefetchSummary {
  tenantsSwept: number;
  fetched: number;
  errors: number;
  deferred: number;
  summaries: ReadonlyMap<string, TenantOpsSummary>;
  /**
   * The ORIGINAL throw, per tenant whose RPC failed — carried, not just logged.
   *
   * NB-1 (gate 2026-08-24, proven by execution). When this leg swallowed the
   * real error into a `console.error` and the consuming legs raised a synthetic
   * one in its place, two things broke at once on the ONLY production path:
   * the founder's wedged-DO alert body carried a tautology ("the shared
   * ops-summary prefetch did not supply tenant X") where "no such table:
   * scheduled_sends" or "Durable Object is overloaded" used to be; and
   * `tenantDoWedgedKey` reads `err.name`, which on a fresh `new Error` is
   * always "Error", so `constructor_throw` / `storage_throw` / `other` became
   * UNREACHABLE from the cron producer and a tenant whose failure MODE changed
   * could no longer re-alert.
   *
   * Sharing one fetch across three legs is only sound if it also shares what
   * the fetch learned. This map is the second half of the summaries map.
   */
  failures: ReadonlyMap<string, unknown>;
}

export async function runOpsSummaryPrefetch(
  env: Env,
  windows: { actionsSinceMs: number; failureSignalsSinceMs: number },
  scope: SweepScope = {},
): Promise<OpsSummaryPrefetchSummary> {
  const tenantIds = await resolveSweepTenants(env, scope);
  const summaries = new Map<string, TenantOpsSummary>();
  const failures = new Map<string, unknown>();
  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      summaries.set(tenantId, await env.TENANT.get(env.TENANT.idFromName(tenantId)).opsSummaryForSweep(windows));
    },
    // One wedged DO must not deny every OTHER tenant its summary — and the
    // three consuming legs each count their own miss, so the failure is still
    // reported three times over, exactly as it was when each leg fetched.
    //
    // THE ERROR IS BANKED, NOT JUST LOGGED (NB-1). A `console.error` here and a
    // synthetic `new Error` at the consumer is how the wedged-DO alert lost both
    // its message and its `err.name`-derived materiality key.
    (tenantId, err) => {
      failures.set(tenantId, err);
      console.error(`ops summary prefetch failed for tenant ${tenantId}`, err);
    },
  );
  return { tenantsSwept: swept.visited, fetched: summaries.size, errors: swept.errors, deferred: swept.deferred, summaries, failures };
}

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
  /** Tenants this call deliberately did NOT reach, because the tick's shared
   * fan-out deadline arrived first. A capacity number, never an error — see
   * admin/sweep-signals.ts (scale audit S4). */
  deferred: number;
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
  scope: SweepScope = {},
): Promise<DunningSweepSummary> {
  const tenantIds = await resolveSweepTenants(env, scope);
  const results: DunningSweepResult[] = [];

  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      // Window-INDEPENDENT reader: everything below is billing state, not a
      // windowed count, so this leg can consume whatever span the tick's shared
      // prefetch used. That is why it passes no `need`.
      const summary = await sweptSummary(env, scope, tenantId, {}, nowMs);
      if (summary === null) throw new Error(`dunning: the shared ops-summary prefetch did not supply tenant ${tenantId}`);
      if (summary.billingState !== "past_due") return;
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));

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
    },
    (tenantId, err) => console.error(`dunning sweep failed for tenant ${tenantId}`, err),
  );

  return {
    scannedTenants: swept.visited,
    pastDueTenants: results.length,
    results,
    errors: swept.errors,
    deferred: swept.deferred,
  };
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
  deferred: number;
}

/** Runs the deliverability monitor->decide->act loop for every tenant IN SCOPE
 * — the cron lane (no send scheduling, that's tick()/B2). The cron hands it the
 * tick's bounded slice (admin/tenant-slice.ts); an on-demand caller passes
 * nothing and gets a bounded full scan. */
export async function runDeliverabilitySweepAllTenants(env: Env, scope: SweepScope = {}): Promise<DeliverabilitySweepAllSummary> {
  const tenantIds = await resolveSweepTenants(env, scope);
  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      await env.TENANT.get(env.TENANT.idFromName(tenantId)).deliverabilitySweep();
    },
    (tenantId, err) => console.error(`deliverability sweep failed for tenant ${tenantId}`, err),
  );
  return { tenantsSwept: swept.visited, errors: swept.errors, deferred: swept.deferred };
}

export interface WarmupCancelSweepAllSummary {
  tenantsSwept: number;
  cancelled: number;
  errors: number;
  deferred: number;
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
export async function runWarmupCancelSweepAllTenants(env: Env, scope: SweepScope = {}): Promise<WarmupCancelSweepAllSummary> {
  const tenantIds = await resolveSweepTenants(env, scope);
  let cancelled = 0;
  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      const result = await env.TENANT.get(env.TENANT.idFromName(tenantId)).warmupCancelSweep();
      cancelled += result.cancelled;
    },
    (tenantId, err) => console.error(`warmup cancel sweep failed for tenant ${tenantId}`, err),
  );
  return { tenantsSwept: swept.visited, cancelled, errors: swept.errors, deferred: swept.deferred };
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
  /** Tenants left for a later tick by the shared fan-out deadline (capacity, not failure). */
  deferred: number;
}

/**
 * Is the C3-part-d out-of-band provisioning reconcile ARMED? DARK (false) unless
 * PROVISIONING_RECONCILE_ENABLED is set to a genuinely-affirmative value — empty,
 * "0", "false", "off" (case-insensitive) all read as OFF, so a founder who sets a
 * disabling word gets what they meant instead of the "any-non-empty-value"
 * footgun. Shipped default (unset) is dark.
 */
export function provisioningReconcileArmed(env: { PROVISIONING_RECONCILE_ENABLED?: string }): boolean {
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
export async function runProvisioningReconcileAllTenants(env: Env, scope: SweepScope = {}): Promise<ProvisioningReconcileSweepSummary> {
  const empty: ProvisioningReconcileSweepSummary = {
    disabled: false,
    tenantsSwept: 0,
    reconciled: 0,
    completed: 0,
    skippedNoSpec: 0,
    errors: 0,
    deferred: 0,
  };
  if (!provisioningReconcileArmed(env)) {
    // Shipped default — no deploy, no code change arms it; a `wrangler secret put`
    // / `[vars]` entry does, and only then does auto-completion (which SPENDS on
    // an armed tenant) begin. Logged loudly on the rare armed tick, silent here.
    return { ...empty, disabled: true };
  }

  const tenantIds = await resolveSweepTenants(env, scope);
  const summary: ProvisioningReconcileSweepSummary = { ...empty };
  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      const result = await env.TENANT.get(env.TENANT.idFromName(tenantId)).provisioningReconcileSweep();
      summary.reconciled += result.reconciled;
      summary.completed += result.completed;
      summary.skippedNoSpec += result.skippedNoSpec;
      summary.errors += result.errors;
    },
    (tenantId, err) => console.error(`provisioning reconcile sweep failed for tenant ${tenantId}`, err),
  );
  summary.tenantsSwept = swept.visited;
  summary.errors += swept.errors;
  summary.deferred = swept.deferred;
  return summary;
}

export interface WebhookDeliverySweepSummary {
  tenantsSwept: number;
  errors: number;
  deferred: number;
}

/**
 * Drives the outbound webhook delivery pump for EVERY tenant — the cron wake
 * for the retry/backoff queue (ROADMAP.md WIN-THE-COMPARISON (d)). Each
 * tenant's own DO owns its queue; runWebhookDeliveries attempts every due
 * pending delivery on REAL wall-clock and reschedules failures per the backoff
 * ladder, so this cron cadence is the delivery clock. Idempotent (only due rows
 * fire); one tenant's failure never aborts the sweep for the rest.
 */
export async function runWebhookDeliveriesAllTenants(env: Env, scope: SweepScope = {}): Promise<WebhookDeliverySweepSummary> {
  const tenantIds = await resolveSweepTenants(env, scope);
  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (tenantId) => {
      await env.TENANT.get(env.TENANT.idFromName(tenantId)).runWebhookDeliveries();
    },
    (tenantId, err) => console.error(`webhook delivery sweep failed for tenant ${tenantId}`, err),
  );
  return { tenantsSwept: swept.visited, errors: swept.errors, deferred: swept.deferred };
}

// --- Wave-2 §5: the send-pipeline leg (the auto-send driver) ---------------

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
  /**
   * Tenants not reached this cycle because the per-tick COUNT cap was hit.
   *
   * ITS OWN FIELD (NB-5, gate 2026-08-24). Two capacity causes sharing one
   * counter is the same defect one level down from the one this module's own
   * header is about: `cron_legs` would report a count-cap break as a leg-deadline
   * skip, and the two want opposite responses — a deadline skip means the tick
   * ran out of TIME (look at latency), a cap skip means the tenant count passed
   * what one tick may drive (look at the cap, or at the read-model).
   */
  skippedForTenantCap: number;
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
  // Only `tenantIds` is honoured, and THE CRON NO LONGER PASSES IT (2026-08-24).
  // This leg runs AFTER the fan-out phase and owns the rest of the cron period
  // by design — sweep-budget.ts derives the fan-out deadline as exactly what is
  // left over after this leg's two bounds — so applying the fan-out deadline
  // here would deduct the same time twice, and handing it the fan-out's SLICE
  // deducted the same constraint twice in the other dimension: automatic sending
  // was capped at whatever the HEALTH legs could afford in 15 seconds. The
  // parameter stays for the on-demand admin route, which legitimately targets a
  // named set.
  scope: Pick<SweepScope, "tenantIds"> = {},
): Promise<SendPipelineSweepSummary> {
  const empty: SendPipelineSweepSummary = {
    tenantsScanned: 0,
    tenantsRan: 0,
    sent: 0,
    replies: 0,
    errors: 0,
    budgetExpiries: 0,
    skippedForLegDeadline: 0,
    skippedForTenantCap: 0,
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

  const tenantIds = await resolveSweepTenants(env, scope);
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
    // THE COUNT BOUND (2026-08-24), beside the wall-clock one. This leg fans out
    // over its own population now that the cron no longer hands it the tenant
    // slice, and B1's lesson is that such a leg needs a DECLARED count its
    // subrequest term is derived from — "bounded by a population that is not the
    // tenant count" is not the same as "small". Derived from this leg's own
    // deadline, so it binds only if latency comes in far better than measured;
    // the rotation above reaches whatever it skips.
    if (i >= SEND_PIPELINE_TENANT_CAP) {
      summary.skippedForTenantCap = tenantIds.length - i;
      console.warn(
        `send pipeline: per-tick tenant cap (${SEND_PIPELINE_TENANT_CAP}) reached — ${summary.skippedForLegDeadline} deferred to a later cycle (rotation reaches them)`,
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
  /**
   * `total` is EVERY tenant in the control-plane index; `scanned` is how many
   * this pass actually reached.
   *
   * They differ whenever the cron hands this a bounded slice (scale audit S1),
   * and publishing both is the point: a monitoring read that shows only the
   * numerator lets a partial pass be read as the whole truth
   * (docs/adversarial/class-sweep-watch-completeness-2026-08-17.md). Every
   * aggregate below `scanned` is summed over the SCANNED tenants only.
   */
  tenants: { total: number; scanned: number; activeByPlan: Record<string, number> };
  /** True iff `scanned === total` — the one flag a consumer needs to know
   * whether a zero below means "none" or "none among the ones I looked at". */
  complete: boolean;
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
  /** Ticket counts WITH the unfiltered `total` they were drawn from — see
   * `countSupportTicketsByStatus`. `open + escalated + closed !== total` means a
   * status exists that neither this rollup nor the support digest's ticket list
   * accounts for. */
  support: { open: number; escalated: number; closed: number; total: number };
  pastDueCount: number;
  /** D5 lifecycle health — canceled/terminated/disputed tenant counts + total annual-domain liability (integer cents).
   *
   * `unbucketed` is the DENOMINATOR GUARD on the if-ladder above it
   * (docs/adversarial/class-sweep-watch-completeness-2026-08-17.md, platform
   * IN member 4): `billing_state` carries no CHECK constraint, so a value
   * nobody accounted for used to fall into no bucket at all — the tenant still
   * counted in `tenants.total` and then vanished from every lifecycle number
   * the founder reads, silently. Non-zero raises a `watchdogAlerts` line. */
  lifecycle: { canceled: number; terminated: number; disputed: number; annualDomainLiabilityCents: number; unbucketed: number };
  /** C6 — total durable waitlist leads (adversarial panel-03 finding #9: owner visibility into the funnel). */
  waitlist: { count: number };
  watchdogAlerts: string[];
  /** Tenants whose opsSummary call failed this window (wedged/overloaded DO,
   * storage error) — skipped, never zero out the rest of the digest (audit
   * class-sweep sibling fix, 2026-08-06, mirrors runDunningSweep's `errors`). */
  errors: number;
}

/**
 * Every `billing_state` the lifecycle rollup below has a line for, INCLUDING
 * the two it deliberately says nothing about ('none' — never subscribed;
 * 'active' — the paying norm, counted by `activeByPlan`). Anything else is
 * `lifecycle.unbucketed`.
 *
 * A SET rather than an `else` on the if-ladder: the column carries no CHECK
 * constraint (schema.ts:17, `DEFAULT 'none'`), so the only thing standing
 * between "someone added a state" and "that tenant left every number the
 * founder reads" is this enumeration and the alert it raises.
 */
const LIFECYCLE_BUCKETED_BILLING_STATES = new Set(["none", "active", "past_due", "canceling", "canceled", "disputed"]);

/**
 * The window the cron's D6 digest reports over.
 *
 * A NAMED CONSTANT since the ops-summary dedupe: the cron now computes the
 * digest's window ONCE, up front, to hand to the shared prefetch, and then
 * calls `buildOpsDigest` with it. A literal `24` in two places is precisely the
 * mis-window `sweptSummary` throws on — better that it cannot be written.
 */
export const DIGEST_WINDOW_HOURS = 24;

/** D6 — the owner's single cross-tenant business-health rollup (SPEC.md §0.10). */
export async function buildOpsDigest(env: Env, nowMs: number, windowHours: number, scope: SweepScope = {}): Promise<OpsDigest> {
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  const total = await countTenants(env);
  const tenantIds = await resolveSweepTenants(env, scope);
  const summaries: TenantOpsSummary[] = [];
  const swept = await sweepTenants(
    tenantIds,
    scope.fanout,
    async (id) => {
      // The digest reads `actionsInWindow`, so it MUST have been windowed at
      // this leg's own `sinceMs` — asserted, not assumed.
      const summary = await sweptSummary(env, scope, id, { actionsSinceMs: sinceMs }, sinceMs);
      if (summary === null) throw new Error(`ops digest: the shared ops-summary prefetch did not supply tenant ${id}`);
      summaries.push(summary);
    },
    // One tenant's failure must never zero out the digest for every other
    // tenant, nor 500 the on-demand GET /admin/ops/digest route (audit
    // class-sweep sibling fix, 2026-08-06).
    (id, err) => console.error(`ops digest: opsSummary failed for tenant ${id}`, err),
  );
  const errors = swept.errors;

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
  let unbucketedCount = 0;
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
    // The ELSE of the whole ladder, counted rather than dropped. 'none' and
    // 'active' are the two states this rollup deliberately has no line for
    // (they are the healthy default and the paying norm); ANY other value is a
    // tenant that exists and appears in no lifecycle number at all.
    if (!LIFECYCLE_BUCKETED_BILLING_STATES.has(s.billingState)) unbucketedCount++;
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
  const unaccountedTickets = support.total - (support.open + support.escalated + support.closed);
  if (unaccountedTickets > 0) {
    watchdogAlerts.push(
      `${unaccountedTickets} support ticket(s) carry a status this rollup and GET /admin/support/digest both ignore — ` +
        `they are in no list and no count. Add the status to admin/db.ts's countSupportTicketsByStatus and to the digest's WHERE clause.`,
    );
  }
  if (unbucketedCount > 0) {
    watchdogAlerts.push(
      `${unbucketedCount} tenant(s) carry a billing_state this digest has no bucket for — they are counted in tenants.total and in NO lifecycle number. ` +
        `Add the new state to LIFECYCLE_BUCKETED_BILLING_STATES (admin/ops-sweep.ts) and give it a line.`,
    );
  }
  const complete = swept.visited >= total;
  if (!complete) {
    // The denominator, ON THE WIRE and in the prose. Every zero above is
    // "none among the tenants this pass reached", and a reader who only sees
    // the numerator cannot tell the difference.
    watchdogAlerts.push(
      `PARTIAL PASS: ${swept.visited} of ${total} tenant(s) scanned this cycle (the cron sweeps a bounded slice — admin/sweep-budget.ts). ` +
        `Every count in this digest is over those ${swept.visited}; a zero is not evidence of a platform-wide zero.`,
    );
  }

  return {
    windowHours,
    tenants: { total, scanned: swept.visited, activeByPlan },
    complete,
    mrrCents,
    totalUsageCents,
    provisioningFailureCount,
    deliverability: { pausedMailboxesTotal, burningDomainsTotal, actionsInWindow: deliverabilityActionsInWindow },
    gaveUpWarmupCancels,
    pendingCredentialPushes,
    support,
    pastDueCount,
    lifecycle: {
      canceled: canceledCount,
      terminated: terminatedCount,
      disputed: disputedCount,
      annualDomainLiabilityCents,
      unbucketed: unbucketedCount,
    },
    waitlist: { count: waitlistCount },
    watchdogAlerts,
    errors,
  };
}
