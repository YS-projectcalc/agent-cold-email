// D2/D6 (brief) — the lightweight per-tenant summary the admin surface reads
// via TenantDO RPC (never direct SQL — tenant-do.ts is the only thing that
// touches a tenant's own SqlStorage). ARCHITECTURE.md #3 + the brief: D1
// only holds the control-plane INDEX (tenant ids); the authoritative
// plan/billing/deliverability state lives in each tenant's own DO, so the
// dunning sweep (routes/admin-ops.ts) and the owner digest both call this
// exact function through TenantDO.opsSummary() rather than trusting D1's
// (possibly stale — see db.ts's insertTenantIndex, never updated post-signup)
// mirror of plan/status.

import { isPaidPlan, monthlyRevenueCents, type NextStepReason } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { readActivationState } from "./activation.js";
import { clampedAge, realNowMs } from "./clamped-age.js";
import { DNS_PENDING_MAX_MS, dnsUnreadyForMs } from "./domain-dns.js";
import { countSendEligibleMailboxes } from "./mailbox-eligibility.js";
import { deriveNextStepsWithResolved, owedSignals } from "./next-steps.js";
import { expireResolvedSystemMessages } from "./tenant-messages.js";
import { getDeliverabilitySummary } from "./reporting.js";

export interface TenantOpsSummary {
  tenantId: string;
  brand: string;
  plan: string;
  status: string;
  billingState: string;
  usageCents: number;
  /** D5 — total annual-domain liability booked for this tenant (ledger kind='liability'), integer cents. */
  annualDomainLiabilityCents: number;
  /** priceCents of the tenant's plan if it's a paid tier AND billing is 'active'; 0 otherwise (SPEC.md §18). */
  mrrCents: number;
  /** Count of invoice.payment_failed webhook events recorded since this tenant's
   *  last billing recovery — the dunning "cycle" (admin/dunning.ts). */
  billingFailureCount: number;
  /** A5 — the most recent charge decline code (permanent codes make the dunning sweep suspend immediately); null if none/unknown. */
  lastDeclineCode: string | null;
  /** A4 — count of sends that exhausted the retry cap / hit a non-retryable vendor error (engine/tick.ts) — ops-visible. */
  failedSends: number;
  /** All-time deliverability rollup — same shape account() surfaces to the tenant. */
  deliverability: { pausedMailboxes: number; throttledMailboxes: number; burningDomains: number; domainsReplaced: number };
  /** Deliverability actions logged strictly since `sinceMs` — what the D6 digest windows over. */
  actionsInWindow: { paused: number; replaced: number; gaveUpWarmupCancels: number };
  /** H-alert (pipeline F5) — mailboxes still awaiting a successful engine
   * credential push. Non-zero means those mailboxes cannot actually send/poll
   * yet, regardless of how healthy `infrastructure_status` reports them. */
  pendingCredentialPushes: number;
  /** Watchtower failure-signal scan — terminal-'failed' sends (includes CAN-SPAM
   * compliance refusals, engine/tick.ts) + spam-complaint events (engine/
   * reply-processor.ts) with `events`.ts >= sinceMs. Windowed so the watchtower
   * alerts on NEW failures since its last sweep, not all-time totals. */
  failureSignalsInWindow: { failed: number; complaints: number };
  /**
   * The two windows THIS object was actually computed with.
   *
   * Carried because the sweep now fetches ONE summary per tenant per tick and
   * hands it to three legs that ask about three different spans
   * (`buildOpsDigest` 24h, `runWatchtower` 1h, `runDunningSweep` window-
   * independent). Before that dedupe each leg made its own RPC and the window
   * was implicit in the call; sharing the object makes it a property OF the
   * object, and an unstated one would be a silent mis-window — a 24h failure
   * count graded against a 1h threshold reads as an incident, and a 1h
   * deliverability count reported as a day's worth reads as calm. Consumers can
   * assert what they were handed instead of trusting the plumbing.
   */
  windows: { actionsSinceMs: number; failureSignalsSinceMs: number };
  /** Wave-2 §1c — read-only signals for the two send-pipeline watchtower checks
   * (admin/watchtower.ts). Read-only by construction: nothing here writes. */
  sendPipeline: SendPipelineSignals;
  /** Wave-2 §9-U2 — the PRE-ARM provenance read. Every mailbox this tenant has
   * ever held, with the columns that decide whether it may be sent from, so the
   * arm-verification runbook can confirm (i) the clock migration classified every
   * row correctly and (ii) which demo-era rows it retired, BEFORE auto-send is
   * armed for a real customer. Any real-but-classified-'sandbox' row blocks
   * arming until an operator reclassifies it. Field names mirror the mailboxes
   * COLUMN names on purpose — a runbook reader is checking this against the
   * schema, not against a product API. Stays as standing ops visibility. */
  mailboxProvenance: MailboxProvenanceRow[];
}

export interface SendPipelineSignals {
  /** The existing activation predicate — both checks below only mean anything for an activated tenant. */
  activated: boolean;
  /** Non-demo 'pending' scheduled_sends whose send_at has come and gone. */
  dueNonDemoPendingSends: number;
  /** Mailboxes the tick's capacity picker could actually choose right now —
   * computed by the SHARED predicate (engine/mailbox-eligibility.ts), never a
   * restatement of it. A copy that drifts would report capacity while the picker
   * finds none: a silent zero-send with the alarm asleep (adversary round-2, R4). */
  eligibleMailboxes: number;
  /** Credential pushes stuck 'pending' longer than AGING_CRED_PUSH_MS, named. */
  agingPendingPushes: { email: string; pendingForMs: number }[];
  /**
   * Provisioned setup domains whose mail DNS has been un-ready longer than
   * DNS_PENDING_MAX_MS — the escalation edge the vendor-verdict class fix owed
   * (Finding 3 of the C3 re-attack: `DOMAIN_DNS_PENDING` was logged with ZERO
   * readers, no timer, no ceiling, so an indefinitely-stalled paid domain paged
   * nobody). Named, so the founder alert says WHICH domain.
   *
   * Keyed on THREE disjuncts, not on `dns_gave_up_at` alone: the give-up is
   * only stamped when something CALLS setDnsWithRetry, and the whole hazard is
   * a tenant whose agent has stopped retrying. The anchor (`dns_first_checked_at`)
   * ages a row that HAS been observed at least once; a NULL anchor is not
   * covered by that disjunct at all (identical dependency on setDnsWithRetry
   * having run) — it is the pre-deploy population, aged instead off
   * `purchased_at` (see the query's own comment, engine/ops-summary.ts).
   */
  agingPendingDomains: { domain: string; pendingForMs: number; gaveUp: boolean }[];
  /**
   * Every provisioned domain this tenant holds, with the two columns that
   * decide whether an aging alert may be cleared as GOOD news.
   *
   * Read as the ownership set for clearing an aging-domain alert (a check row
   * names a domain, and the watchtower must not clear another tenant's) — the
   * exact role `mailboxProvenance` plays for the credential-push checks — and
   * deliberately NOT status-filtered, so a domain that has since left 'active'
   * can still have its own stale alert cleared instead of being pinned
   * unhealthy forever.
   *
   * That is also why the row carries `dnsStatus`/`status` rather than just a
   * name (F10, docs/adversarial/agent-channel-product-audit-2026-08-17.md):
   * `agingPendingDomains` additionally requires `status='active'` AND
   * `dns_status != 'ready'`, so a released or burning domain LEAVES that set
   * without its DNS ever having come up, and the watchtower used to clear it
   * claiming the opposite.
   */
  provisionedDomains: { domain: string; dnsStatus: string; status: string }[];
  /**
   * Every credential push row this tenant holds, with its status — the
   * re-read the aging-push CLEAR needs (signal-inversion arm B, the exact
   * sibling of provisionedDomains above). `agingPendingPushes` requires
   * status='pending', and lifecycle.ts writes 'revoked' on suspend/teardown,
   * so a mailbox whose credentials were revoked leaves that query exactly like
   * one that finally received them.
   */
  credentialPushes: { email: string; status: string }[];
  /**
   * Item 2 (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md, class C
   * stage 1: "vendor-vs-platform divergence — direction A: the vendor holds a
   * resource, no platform row"). A `mailbox_intents` row stuck at 'bought' /
   * 'dangling' / 'warming' (the vendor accepted a purchase, or the purchase
   * call threw and we cannot tell) with NO matching live `mailboxes` row,
   * older than the grace bound — the vendor may hold a mailbox that bills
   * every month with no platform record of it. Grace-bounded (not "any such
   * row") because a purchase in flight legitimately sits in one of these
   * statuses for the seconds it takes to write the mailboxes row.
   */
  mailboxOrphans: { email: string; pendingForMs: number }[];
  /**
   * Every email this tenant's `mailbox_intents` table has EVER named,
   * unconditional on status — the ownership-check set for clearing a
   * `mailbox_orphan:` alert, the exact role `provisionedDomains`/
   * `credentialPushes` play for their own checks above. `mailboxProvenance`
   * cannot serve this role: an intent that never reached a `mailboxes` row
   * (the exact case this check exists to catch) would never appear there,
   * which would make ownership always read "not mine" and the alert could
   * never clear.
   */
  mailboxIntentEmails: string[];
  /** The domain twin of `mailboxOrphans` — a `domain_intents` row marked
   * 'committed' with no matching `domains` row, older than the grace bound. */
  domainOrphans: { domain: string; pendingForMs: number }[];
  /** The domain twin of `mailboxIntentEmails`. */
  domainIntentCandidates: string[];
  /**
   * §7.10.3 — the MINIMIZED `nextSteps` projection this RPC carries. Sourced
   * from `deriveNextSteps` + `owedSignals` — the SAME primitive responses
   * embed and the nudge renders from (one derivation, three consumers).
   * Never `NextStep[]`: full `why` prose and profile fields must not enter
   * this RPC, which feeds alert bodies and `buildOpsDigest`.
   */
  owedReasons: NextStepReason[];
  owedCount: number;
  oldestOwedSinceMs: number | null;
  /** §7.11 — whether any owed step blames the operator; decides which of the
   *  two `customer_progress_*` names (and therefore which channel) a stall
   *  reports under. */
  anyOwedWaitingOnOperator: boolean;
  /**
   * §7.10.2 — the liveness anchor's AGE at this read, already clamped to
   * real wall-clock (`clampedAge`, §7.19) — never a raw timestamp, so no
   * consumer of this RPC can reach for `now - lastAgentActivityAt` and
   * reintroduce the exact hazard the clamp exists to close. Null when this
   * tenant has never had a bearer-authed call.
   */
  lastAgentActivityAgeMs: number | null;
}

/** How long a post-purchase mailbox/domain intent may sit with no matching
 * live row before it is a founder problem (Item 2, class-sweep-vendor-truth).
 * Env-tunable (`PROVISIONING_ORPHAN_GRACE_MS`) — a purchase legitimately sits
 * in an intermediate status for the seconds/minutes it takes the saga to
 * write the resource's own row; 30 minutes comfortably exceeds any legitimate
 * in-flight window (mirrors AGING_CRED_PUSH_MS's own reasoning above). */
export const DEFAULT_PROVISIONING_ORPHAN_GRACE_MS = 30 * 60 * 1000;

/** Exported so `engine/next-steps.ts`'s `ordinal_incomplete` ages against the SAME bound the orphan checks use, rather than inventing a second one. */
export function provisioningOrphanGraceMs(ctx: TenantContext): number {
  const raw = ctx.env.PROVISIONING_ORPHAN_GRACE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROVISIONING_ORPHAN_GRACE_MS;
}

/** §7.11 — the two bounds the `customer_progress_*` unhealthy predicate uses:
 *  the agent silence bound and the oldest-owed-step bound. Read from the
 *  Worker `env` (not a `TenantContext`) since `admin/watchtower.ts`'s
 *  per-tenant check derivation runs outside any one tenant's DO. */
export const DEFAULT_CUSTOMER_PROGRESS_STALL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS = 48 * 60 * 60 * 1000;

function envMsOrDefault(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function customerProgressStallMs(env: { CUSTOMER_PROGRESS_STALL_MS?: string }): number {
  return envMsOrDefault(env.CUSTOMER_PROGRESS_STALL_MS, DEFAULT_CUSTOMER_PROGRESS_STALL_MS);
}

export function customerProgressOwedMaxMs(env: { CUSTOMER_PROGRESS_OWED_MAX_MS?: string }): number {
  return envMsOrDefault(env.CUSTOMER_PROGRESS_OWED_MAX_MS, DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS);
}

/** §7.12 (founder ruling Q1) — the one-shot continuity nudge fires one day
 *  after a stall episode's onset. Same non-arming, detection-timing-bound
 *  reasoning as the two bounds above. */
export const DEFAULT_CONTINUITY_NUDGE_DELAY_MS = 24 * 60 * 60 * 1000;

export function continuityNudgeDelayMs(env: { CONTINUITY_NUDGE_DELAY_MS?: string }): number {
  return envMsOrDefault(env.CONTINUITY_NUDGE_DELAY_MS, DEFAULT_CONTINUITY_NUDGE_DELAY_MS);
}

export interface MailboxProvenanceRow {
  email: string;
  source: string;
  slot_counted: number;
  provider: string;
  released_at: number | null;
  warmup_started_at: number;
  /** Read straight out of SqlStorage — the index signature is what `exec<T>` requires of its row type. */
  [column: string]: SqlStorageValue;
}

/** How long a 'pending' credential push may sit before it is a founder problem.
 * A push clears only on success, and on the manual-mint path that means an
 * operator has to add an OAuth grant to a Worker secret — so "still pending"
 * past this is a human's cue, not a transient. */
export const AGING_CRED_PUSH_MS = 30 * 60 * 1000;

function countActionsInWindow(ctx: TenantContext, action: string, sinceMs: number): number {
  return ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM deliverability_actions WHERE tenant_id = ? AND action = ? AND ts >= ?`,
      ctx.tenantId,
      action,
      sinceMs,
    )
    .one().n;
}

export type SuspendReason = "dunning" | "terminate";

/**
 * Suspends a tenant (tick freeze via status='suspended'). `reason` records
 * WHY, so a later billing-recovery event can reactivate a DUNNING suspension
 * (a now-paying customer) WITHOUT resurrecting an abuse TERMINATE (adversarial
 * panel-03 finding #6). Distinguishing them via a stored reason avoids reading
 * D1 from inside the DO (the DO/D1 write boundary invariant — see the file
 * header). Called by the D2 dunning sweep (reason='dunning') and the abuse
 * terminate lane (reason='terminate').
 *
 * Adversarial audit F3 (2026-08-05, docs/adversarial/audit-dunning-2026-08-05.md):
 * a dunning suspend races an async billing-recovery webhook (engine/billing.ts's
 * checkout.session.completed / subscription.updated / dispute.closed handlers)
 * that can flip billing_state to 'active' in the gap between the sweep's read
 * (opsSummary) and this write (two separate DO RPCs, admin/ops-sweep.ts's
 * runDunningSweep) — an unconditional UPDATE there clobbered a customer who
 * had just paid. Re-checking `billing_state = 'past_due'` atomically here (the
 * house conditional-UPDATE pattern — mirrors `resolveScreeningReview` +
 * withSpendCeiling's reserve) makes a recovery that lands in that gap win: the
 * suspend becomes a no-op (return false) instead of overwriting it. A
 * 'terminate' suspend is abuse enforcement, not a billing race, so it stays
 * unconditional. Returns true iff the suspend actually applied.
 */
export function suspendTenant(ctx: TenantContext, reason: SuspendReason): boolean {
  const result =
    reason === "dunning"
      ? ctx.sql.exec(
          `UPDATE tenant_profile SET status = 'suspended', suspend_reason = ? WHERE id = ? AND billing_state = 'past_due'`,
          reason,
          ctx.tenantId,
        )
      : ctx.sql.exec(
          `UPDATE tenant_profile SET status = 'suspended', suspend_reason = ? WHERE id = ?`,
          reason,
          ctx.tenantId,
        );
  return result.rowsWritten > 0;
}

/**
 * Clears a DUNNING suspension on a billing-recovery transition
 * (subscription.updated->active / checkout.session.completed / dispute won).
 * Scoped to `suspend_reason = 'dunning'` so an abuse TERMINATE is NEVER lifted
 * by a stray billing event (adversarial panel-03 finding #6). Idempotent: a
 * no-op for an already-active or terminate-suspended tenant. Returns true iff
 * it actually un-suspended a dunning-frozen tenant.
 */
export function reactivateFromDunning(ctx: TenantContext): boolean {
  const res = ctx.sql.exec(
    `UPDATE tenant_profile SET status = 'active', suspend_reason = NULL
     WHERE id = ? AND status = 'suspended' AND suspend_reason = 'dunning'`,
    ctx.tenantId,
  );
  return res.rowsWritten > 0;
}

/**
 * @param sinceMs                 window for `actionsInWindow` (the digest's span).
 * @param failureSignalsSinceMs   window for `failureSignalsInWindow` (the
 *   watchtower's span). Defaults to `sinceMs`, so every existing single-window
 *   caller is unchanged; only the cron's shared prefetch passes both.
 */
export function getOpsSummary(ctx: TenantContext, sinceMs: number, failureSignalsSinceMs: number = sinceMs): TenantOpsSummary {
  const profile = ctx.sql
    .exec<{ brand: string; plan: string; status: string; billing_state: string; last_decline_code: string | null; checkout_discount_pct: number }>(
      `SELECT brand, plan, status, billing_state, last_decline_code, checkout_discount_pct FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();

  const failedSends = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM scheduled_sends WHERE tenant_id = ? AND status = 'failed'`,
      ctx.tenantId,
    )
    .one().n;

  const usageCents = ctx.sql
    .exec<{ total: number | null }>(
      `SELECT SUM(amount_cents) as total FROM ledger_entries WHERE tenant_id = ? AND kind = 'usage'`,
      ctx.tenantId,
    )
    .one().total ?? 0;

  const annualDomainLiabilityCents = ctx.sql
    .exec<{ total: number | null }>(
      `SELECT SUM(amount_cents) as total FROM ledger_entries WHERE tenant_id = ? AND kind = 'liability'`,
      ctx.tenantId,
    )
    .one().total ?? 0;

  // webhook_events is scoped per-DO already (one tenant per DO instance) —
  // no tenant_id column/filter needed, same as engine/billing.ts's idempotency check.
  // Scoped to the CURRENT dunning cycle (audit-stripe-webhook-2026-08-06.md
  // finding 6): unwindowed, this was a lifetime count that survived a full
  // recovery, so a customer who had a rough month a year ago was suspended on
  // their FIRST failure thereafter — cycle 4 on one new failure, skipping the
  // whole four-strike grace period. `dunning_cycle_basis` (schema.ts) holds the
  // webhook_events rowid at the last billing recovery; 0 when a tenant has
  // never recovered, which counts everything exactly as before.
  // `applied = 1` excludes events that were CLAIMED and then refused as out of
  // order (gate residual N-2): those changed no state, so counting them let
  // three refused redeliveries suspend a recovered payer on their first
  // genuine failure — the same grace-period skip the basis above exists to stop.
  const billingFailureCount = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM webhook_events
       WHERE type = 'invoice.payment_failed'
         AND applied = 1
         AND rowid > (SELECT COALESCE(MAX(basis_rowid), 0) FROM dunning_cycle_basis)`,
    )
    .one().n;

  // MRR follows the per-mailbox curve on the LIVE provisioned count (design §9),
  // folding any discount captured at checkout — not a fixed tier price. Zero
  // unless the tenant is on the paid plan AND billing is active.
  const provisionedMailboxes = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
    .one().n;
  const mrrCents =
    isPaidPlan(profile.plan) && profile.billing_state === "active"
      ? monthlyRevenueCents(provisionedMailboxes, profile.checkout_discount_pct)
      : 0;

  // Windowed failure signals (watchtower). One GROUP-free aggregate over the
  // events log: terminal-'failed' sends + spam complaints since `sinceMs`.
  const failureSignals = ctx.sql
    .exec<{ failed: number | null; complaints: number | null }>(
      `SELECT
         SUM(CASE WHEN type = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN type = 'complaint' THEN 1 ELSE 0 END) AS complaints
       FROM events WHERE tenant_id = ? AND ts >= ?`,
      ctx.tenantId,
      failureSignalsSinceMs,
    )
    .one();

  return {
    tenantId: ctx.tenantId,
    brand: profile.brand,
    plan: profile.plan,
    status: profile.status,
    billingState: profile.billing_state,
    usageCents,
    annualDomainLiabilityCents,
    mrrCents,
    billingFailureCount,
    lastDeclineCode: profile.last_decline_code,
    failedSends,
    windows: { actionsSinceMs: sinceMs, failureSignalsSinceMs },
    deliverability: getDeliverabilitySummary(ctx),
    actionsInWindow: {
      paused: countActionsInWindow(ctx, "PAUSE", sinceMs),
      replaced: countActionsInWindow(ctx, "REPLACE_DOMAIN", sinceMs),
      // Adversary N-b (2026-08-02): a warmup-cancel give-up means an InboxKit
      // subscription that may STILL BE BILLING. It is written to
      // deliverability_actions, but that table is read by the tenant's activity
      // feed and report — surfaces the CUSTOMER sees and cannot act on. This is
      // our COGS, so the owner digest is where it has to land.
      gaveUpWarmupCancels: countActionsInWindow(ctx, "WARMUP_CANCEL_GAVE_UP", sinceMs),
    },
    // H-alert (INCIDENT 2026-08-05, pipeline F5) — mailboxes whose engine
    // credential push has never succeeded. The push CANNOT succeed on a first
    // provisioning by construction (the manual OAuth minter is keyed by mailbox
    // emails that do not exist until the provisioning that needs them has run),
    // and the failure is swallowed by design and retried forever with no cap
    // and no alert. `mailbox_cred_pushes.status` is read by nothing but the
    // reconcile sweep, so the customer sees healthy mailboxes that have no
    // credentials on the engine and nobody is told. Surfacing the count is the
    // narrow slice: it tells the founder the manual-grant moment has arrived.
    // Rewiring the minter is the class wave, deliberately not done here.
    pendingCredentialPushes: ctx.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) as n FROM mailbox_cred_pushes WHERE tenant_id = ? AND status = 'pending'`,
        ctx.tenantId,
      )
      .one().n,
    failureSignalsInWindow: {
      failed: failureSignals.failed ?? 0,
      complaints: failureSignals.complaints ?? 0,
    },
    sendPipeline: readSendPipelineSignals(ctx),
    mailboxProvenance: ctx.sql
      .exec<MailboxProvenanceRow>(
        `SELECT email, source, slot_counted, provider, released_at, warmup_started_at
         FROM mailboxes WHERE tenant_id = ? ORDER BY created_at ASC`,
        ctx.tenantId,
      )
      .toArray(),
  };
}

/**
 * §1c — the two conditions the wave-2 watchtower checks alert on, read (never
 * written) from this tenant's own state.
 *
 * The clock is the TENANT's clock, not the sweep's `sinceMs`: on a migrated
 * paid tenant that is real wall time, which is the only base the due-window and
 * the push age mean anything against. A demo tenant reads its virtual clock and
 * is never `activated`, so neither check fires for it.
 */
function readSendPipelineSignals(ctx: TenantContext): SendPipelineSignals {
  const now = ctx.clock.now();
  const { activated } = readActivationState(ctx.sql, ctx.tenantId);

  const dueNonDemoPendingSends = ctx.sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) as n FROM scheduled_sends ss
        WHERE ss.tenant_id = ? AND ss.status = 'pending' AND ss.send_at <= ?
          AND ss.campaign_id IN (SELECT id FROM campaigns WHERE tenant_id = ? AND is_demo = 0)`,
      ctx.tenantId,
      now,
      ctx.tenantId,
    )
    .one().n;

  const agingPendingPushes = ctx.sql
    .exec<{ email: string; updated_at: number }>(
      `SELECT email, updated_at FROM mailbox_cred_pushes
        WHERE tenant_id = ? AND status = 'pending' AND updated_at <= ?
        ORDER BY updated_at ASC`,
      ctx.tenantId,
      now - AGING_CRED_PUSH_MS,
    )
    .toArray()
    .map((row) => ({ email: row.email, pendingForMs: now - row.updated_at }));

  // Provisioned (lookalike) domains only: a BYO domain's own intake pipeline
  // owns its DNS wait and has its own 7-day abandon (engine/byo-intake.ts), so
  // alerting on it here would double-report a bounded condition. Scoped to
  // 'active' to match the reconcile's own scope — a burned/released domain is
  // already being handled by the deliverability loop and is not a stall.
  //
  // THREE ways in (gate delta, Finding 2, docs/adversarial/
  // vendor-verdict-gate-2026-08-14.md): a domain whose ANCHOR is older than the
  // bound (the slow stall — fires even if nobody ever calls setDnsWithRetry
  // again, which is the whole hazard), one already marked given-up (the sharp
  // failure — a terminal vendor verdict on the first poll is given up on
  // immediately and would otherwise be too young for the age test), OR — the
  // disjunct this wave owed — a row whose anchor is NULL because it predates
  // this wave's columns entirely, aged instead off `purchased_at`: the ONLY
  // population the escalation exists for (a tenant whose agent has stopped
  // retrying) includes rows this deploy has never observed at all, and neither
  // of the first two disjuncts can ever match a NULL anchor. `purchased_at`
  // clock skew fails SAFE for this is-it-old test: a future `purchased_at`
  // simply never satisfies `<= now - DNS_PENDING_MAX_MS`, so it never fires —
  // the same skew direction that makes `purchased_at` unusable as the BOUND's
  // own anchor (schema.ts) is harmless here.
  const agingPendingDomains = ctx.sql
    .exec<{ domain: string; dns_first_checked_at: number | null; dns_gave_up_at: number | null; purchased_at: number }>(
      `SELECT domain, dns_first_checked_at, dns_gave_up_at, purchased_at FROM domains
        WHERE tenant_id = ? AND source = 'provisioned' AND status = 'active' AND dns_status != 'ready'
          AND (
            dns_gave_up_at IS NOT NULL
            OR (dns_first_checked_at IS NOT NULL AND dns_first_checked_at <= ?)
            OR (dns_first_checked_at IS NULL AND purchased_at <= ?)
          )
        ORDER BY dns_first_checked_at ASC`,
      ctx.tenantId,
      now - DNS_PENDING_MAX_MS,
      now - DNS_PENDING_MAX_MS,
    )
    .toArray()
    .map((row) => ({
      domain: row.domain,
      // N1 (delta re-gate, non-blocking): the admission criteria (above) and
      // this arithmetic are two separate pieces of code. A NULL anchor no
      // longer means "just admitted, age unknown" — the third disjunct admits
      // rows this deploy never observed, and for those `purchased_at` IS the
      // age signal (same fallback the admission query itself uses).
      //
      // Now literally the same function the customer-facing bound uses
      // (domain-dns.ts's dnsUnreadyForMs) rather than a restatement of it, so
      // the two surfaces cannot drift apart about the same domain
      // (docs/adversarial/agent-channel-product-audit-2026-08-17.md, Q4). The
      // purchase stamp is passed unguarded here — unlike the bound, this
      // surface is only consulted for ACTIVATED tenants (admin/watchtower.ts),
      // and activation implies the clock migration, so `purchased_at` is
      // already comparable to `now` wherever this value is read.
      pendingForMs: dnsUnreadyForMs(now, row.dns_first_checked_at, row.purchased_at),
      gaveUp: row.dns_gave_up_at !== null,
    }));

  const credentialPushes = ctx.sql
    .exec<{ email: string; status: string }>(
      `SELECT email, status FROM mailbox_cred_pushes WHERE tenant_id = ?`,
      ctx.tenantId,
    )
    .toArray()
    .map((row) => ({ email: row.email, status: row.status }));

  const provisionedDomains = ctx.sql
    .exec<{ domain: string; dns_status: string; status: string }>(
      `SELECT domain, dns_status, status FROM domains WHERE tenant_id = ? AND source = 'provisioned'`,
      ctx.tenantId,
    )
    .toArray()
    .map((row) => ({ domain: row.domain, dnsStatus: row.dns_status, status: row.status }));

  // Item 2 (class-sweep-vendor-truth-2026-08-18, class C stage 1) — see
  // SendPipelineSignals.mailboxOrphans. Rides this same opsSummary RPC (no
  // new subrequests, no vendor calls): a purely local join against
  // mailbox_intents, which every provisioning saga already writes.
  const orphanGraceMs = provisioningOrphanGraceMs(ctx);
  const mailboxOrphans = ctx.sql
    .exec<{ email: string; updated_at: number }>(
      `SELECT mi.email AS email, mi.updated_at AS updated_at
       FROM mailbox_intents mi
       WHERE mi.tenant_id = ?
         AND mi.status IN ('bought', 'dangling', 'warming')
         AND mi.updated_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM mailboxes m WHERE m.tenant_id = mi.tenant_id AND m.email = mi.email AND m.released_at IS NULL
         )
       ORDER BY mi.updated_at ASC`,
      ctx.tenantId,
      now - orphanGraceMs,
    )
    .toArray()
    .map((row) => ({ email: row.email, pendingForMs: now - row.updated_at }));

  const mailboxIntentEmails = ctx.sql
    .exec<{ email: string }>(`SELECT DISTINCT email FROM mailbox_intents WHERE tenant_id = ?`, ctx.tenantId)
    .toArray()
    .map((row) => row.email);

  // The domain twin: a domain_intents row already marked 'committed' (see
  // provision-intents.ts's status vocabulary) whose domains row is missing —
  // the local record claims full provisioning while the resource table
  // disagrees, direction-A's shape one table over.
  const domainOrphans = ctx.sql
    .exec<{ candidate_domain: string; updated_at: number }>(
      `SELECT di.candidate_domain AS candidate_domain, di.updated_at AS updated_at
       FROM domain_intents di
       WHERE di.tenant_id = ?
         AND di.status = 'committed'
         AND di.updated_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM domains d WHERE d.tenant_id = di.tenant_id AND d.domain = di.candidate_domain
         )
       ORDER BY di.updated_at ASC`,
      ctx.tenantId,
      now - orphanGraceMs,
    )
    .toArray()
    .map((row) => ({ domain: row.candidate_domain, pendingForMs: now - row.updated_at }));

  const domainIntentCandidates = ctx.sql
    .exec<{ candidate_domain: string }>(`SELECT DISTINCT candidate_domain FROM domain_intents WHERE tenant_id = ?`, ctx.tenantId)
    .toArray()
    .map((row) => row.candidate_domain);

  // §7.11/§7.10.3 — the one derivation, read here (never re-derived): the
  // stuck-customer checks ride this SAME opsSummary fan-out, no new RPC.
  //
  // BLOCKING-2 — and the same derivation BANKS its own conclusion. A
  // `retry_setup`/`setup_failed` row whose condition no longer derives owed is
  // expired here, so operator surfaces stop showing a dead action item instead
  // of waiting on a customer ack that will never come. This is the site
  // because it is the only per-tenant path that already re-derives on a
  // cadence: a dedicated sweep RPC would add a subrequest per tenant per tick
  // and break §7.17.7's `8.0N + 29` bound, and the derivation itself must stay
  // pure (§7.16 invariant 3). The ids stay inside the DO — the cross-DO
  // projection below is unchanged (§7.10.3).
  const derived = deriveNextStepsWithResolved(ctx);
  expireResolvedSystemMessages(ctx, derived.expirableSystemMessageIds);
  const owed = owedSignals(derived.next);

  const lastAgentActivityAt = ctx.sql
    .exec<{ last_agent_activity_at: number | null }>(`SELECT last_agent_activity_at FROM tenant_profile WHERE id = ?`, ctx.tenantId)
    .one().last_agent_activity_at;

  return {
    activated,
    dueNonDemoPendingSends,
    eligibleMailboxes: countSendEligibleMailboxes(ctx, now),
    agingPendingPushes,
    agingPendingDomains,
    provisionedDomains,
    credentialPushes,
    mailboxOrphans,
    mailboxIntentEmails,
    domainOrphans,
    domainIntentCandidates,
    owedReasons: owed.owedReasons,
    owedCount: owed.owedCount,
    oldestOwedSinceMs: owed.oldestOwedSinceMs,
    anyOwedWaitingOnOperator: owed.anyOwedWaitingOnOperator,
    // §7.19 — clamped at READ time (real wall-clock), the same timing
    // precedent this file already uses for `pendingForMs` above.
    lastAgentActivityAgeMs: clampedAge(lastAgentActivityAt, realNowMs()),
  };
}
