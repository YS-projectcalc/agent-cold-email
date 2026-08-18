import { DurableObject } from "cloudflare:workers";
import type {
  AcknowledgeByoConsentInput,
  ActivityQueryInput,
  CheckoutInput,
  ConnectByoMailboxInput,
  ContactOperatorInput,
  DashboardLayout,
  DomainPort,
  InboxQueryInput,
  LaunchCampaignInput,
  ListLeadsQueryInput,
  ListMessagesQueryInput,
  Provenance,
  RegisterByoDomainInput,
  RemoveMailboxesInput,
  RequestManagedByoMailboxesInput,
  SetupInfrastructureInput,
  SuppressLeadInput,
  TenantPlan,
  UpdateLeadInput,
  WebhookCreateInput,
  WebhookUpdateInput,
} from "@coldstart/shared";
// Not type-only: demoRun()'s default parameter value needs the runtime
// schema (`DemoRunInput.parse({})`), not just the inferred type.
import { DemoRunInput } from "@coldstart/shared";
import { isPaidPlan, RateLimitError, RequestInProgressError, TenantIsolationError, type Clock } from "@coldstart/shared";
import { terminal } from "@coldstart/shared";
import { DelegatingClock, RealClock, requireVirtualClock, VirtualClock } from "./clock.js";
import { migrateTenantClockToReal } from "./engine/clock-migration.js";
import { reconcileLegacyDomainIntentKeys } from "./engine/legacy-domain-intent-keys.js";
import type { StripeEventInput } from "./billing/stripe-webhook.js";
import type { Env } from "./env.js";
import {
  applyStripeWebhookEvent,
  completeSimulatedCheckout,
  removeMailboxes,
  startCheckout,
  syncMailboxQuantity,
  type CheckoutResult,
  type CompleteCheckoutResult,
  type RemoveMailboxesResult,
  type WebhookApplyResult,
} from "./engine/billing.js";
import { runDemo, type DemoRunSummary } from "./engine/demo.js";
import { cancelTenant, terminateTenant, type CancelResult, type TerminateResult } from "./engine/lifecycle.js";
import { getInfrastructureStatus } from "./engine/infrastructure-status.js";
import { runSetupInfrastructure } from "./engine/provisioning.js";
import { settleSetupInfrastructure } from "./engine/setup-terminality.js";
import { settleRemoveMailboxes } from "./engine/remove-mailboxes-terminality.js";
import { runProvisioningReconcile } from "./engine/provisioning-reconcile.js";
import { launchCampaign, listCampaigns, pauseAllCampaigns, pauseCampaign, type CampaignListItem } from "./engine/campaigns.js";
import { runTick } from "./engine/tick.js";
import { runWarmupCancellationSweep } from "./engine/warmup-cancel.js";
import { withRequestIdempotency } from "./engine/idempotency.js";
import { reconcileMailboxCredentialPushes } from "./engine/mailbox-credential-push.js";
import { runDeliverabilitySweep } from "./engine/deliverability-actions.js";
import {
  ackMessage,
  emitOperatorMessage,
  listMessagesForOperator,
  listMessagesPage,
  pruneTenantMessages,
  type AckMessageResult,
  type EmitOperatorMessageInput,
  type ListMessagesForOperatorOptions,
  type MessageListPage,
  type OperatorMessageListResult,
} from "./engine/tenant-messages.js";
import { getProvisioningStateForOperator, type ProvisioningState } from "./engine/provisioning-state.js";
import { contactOperator, type ContactOperatorResult } from "./engine/contact-operator.js";
import { reconcileOrphanedAdmissions } from "./engine/contact-operator-reconcile.js";
import { runPollInbox } from "./engine/reply-processor.js";
import { suppressLead, unsubscribeEmail, type UnsubscribeResult } from "./engine/suppression.js";
import { upsertLeadDisposition, type LeadDispositionView } from "./engine/lead-dispositions.js";
import { listLeads, type LeadListPage } from "./engine/list-leads.js";
import { getThread, markThread, replyToThread } from "./engine/threads.js";
import { listInbox, type InboxPage } from "./engine/inbox.js";
import { getActivityFeed, type ActivityPage } from "./engine/activity.js";
import { setThreadLabel, type ThreadLabelResult } from "./engine/thread-labels.js";
import {
  createDashboardView,
  deleteDashboardView,
  getDashboardView,
  listDashboardViews,
  promoteDashboardViewDefault,
  updateDashboardView,
  type DashboardViewDetail,
  type DashboardViewSummary,
} from "./engine/dashboard-views.js";
import { getAccount, getCampaignResults, getMetrics } from "./engine/reporting.js";
import { getOpsSummary, suspendTenant, type TenantOpsSummary } from "./engine/ops-summary.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  updateWebhook,
  type WebhookDetail,
  type WebhookSummary,
} from "./engine/webhooks.js";
import { pumpWebhookDeliveries, type PumpSummary } from "./engine/webhook-delivery.js";
import { realWebhookDeliverer } from "./engine/webhook-security.js";
import {
  acknowledgePrimaryDomainConsent,
  getByoDomain,
  listByoDomains,
  pollByoDomainDns,
  registerByoDomain,
  type ByoDomainRecord,
  type ByoDomainSummary,
  type PollDnsResult,
} from "./engine/byo-intake.js";
import {
  connectByoMailbox,
  requestManagedByoMailboxes,
  type ConnectByoMailboxResult,
  type RequestManagedByoMailboxesResult,
} from "./engine/byo-mailbox-composition.js";
import { newId, TENANT_DO_SCHEMA } from "./schema.js";
import type { TenantContext } from "./tenant-context.js";
import { readActivationState, readSendDriverGate } from "./engine/activation.js";
import { clearScreeningStatus, LIST_UNAVAILABLE_VERSION, screenTenant } from "./ofac/screening.js";
import { createVendorAdapters, selectRealDomainPort, type VendorAdapterBundle } from "./vendors/factory.js";
import type { EngineClientConfig } from "./vendors/real/email-port.js";
import type { InboxKitClientConfig } from "./vendors/real/inboxkit-client.js";
import { deriveInboxKitRegistrant, isInboxKitRegistrarArmed, readRegistrarArming, readRegistrarOptInState } from "./vendors/registrar-arming.js";

export interface InitTenantInput {
  tenantId: string;
  brand: string;
  plan: TenantPlan;
}

/**
 * What the cron's send-pipeline leg gets back from one tenant. `ran: false`
 * with a `reason` is the NORMAL outcome for almost every tenant on the
 * platform (63 tenants, one paying) — it is a quiet skip, not an error, and
 * the counters are zero rather than absent so the leg's log line reads the
 * same either way.
 */
export interface ScheduledTickResult {
  ran: boolean;
  reason: string;
  sent: number;
  skipped: number;
  deferred: number;
}

export interface ScheduledPollResult {
  ran: boolean;
  reason: string;
  replies: number;
  bounces: number;
  complaints: number;
}

const DEMO_RUN_MIN_INTERVAL_MS = 60_000; // at most 1 demo run / minute / tenant
const DEMO_RUN_LIFETIME_CAP = 20; // total demo runs a single sandbox tenant may make

/**
 * TenantDO — per-tenant state + the SQLite money ledger (ARCHITECTURE.md
 * decision #3). Holds no business logic itself: every RPC method builds a
 * `TenantContext` and dispatches into `src/engine/*.ts`. Callable directly
 * via the stub (Workers RPC), never over an internal HTTP protocol.
 */
export class TenantDO extends DurableObject<Env> {
  private tenantId: string | null = null;
  private plan: TenantPlan = "demo";
  /**
   * The tenant's CURRENT clock (wave-2 DECISION 2): VirtualClock for a
   * demo/free tenant, RealClock once the one-shot migration has committed.
   * Swapped in place by `switchToRealClock()`; never handed out directly — see
   * `contextClock` below.
   */
  private currentClock: Clock | null = null;
  /**
   * The single clock instance every TenantContext (and the cached sandbox
   * adapter bundle) receives. It resolves `currentClock` on each now(), so a
   * mid-call flip is visible to a saga that captured its context before the
   * flip, and the cached bundle needs no invalidation (design v2 §4).
   */
  private readonly contextClock: Clock = new DelegatingClock(() => {
    if (!this.currentClock) throw new Error("tenant not initialized");
    return this.currentClock;
  });
  // Only the SANDBOX bundle instance is cached for the DO's lifetime — several
  // sandbox ports hold in-memory state (SandboxEmailPort's send/poll queues,
  // SandboxDomainPort/SandboxMailboxPort's seen/released sets,
  // SandboxBillingPort's idempotency map) that must survive across calls
  // within one DO instance, or (e.g.) a poll() right after a send() would
  // never see what was just queued. The ACTIVATION DECISION itself is never
  // cached (design §2.2 option-1 / adversarial finding F3) — see
  // buildAdapters() below.
  private sandboxAdapters: VendorAdapterBundle | null = null;

  // BLOCKING-2 single-flight latch for mailbox release — see removeMailboxes()
  // for why this is deliberately in-memory and not a durable claim.
  private releaseInFlight = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(TENANT_DO_SCHEMA);
    this.ensureColumnMigrations();
    this.grandfatherActiveScreening();

    const row = this.ctx.storage.sql
      .exec<{ id: string; plan: TenantPlan; clock_base: number; clock_offset: number; clock_multiplier: number; clock_mode: string }>(
        `SELECT id, plan, clock_base, clock_offset, clock_multiplier, clock_mode FROM tenant_profile LIMIT 1`,
      )
      .toArray()[0];

    if (row) {
      this.tenantId = row.id;
      this.plan = row.plan;
      const clock = this.selectClockOnRehydrate(row);
      this.currentClock = clock;
      // AFTER the clock is settled — the rebind stamps `updated_at` on the
      // tenant's own time base, and for a paid tenant that base is only correct
      // once the migration above has run.
      this.reconcileLegacyDomainIntents(row.id, clock.now());
    }
  }

  /**
   * The 2026-08-13 one-shot legacy domain-intent-key rebind
   * (engine/legacy-domain-intent-keys.ts), applied on first touch after deploy
   * with no operator step — the same self-applying shape as the clock migration
   * above, and the same failure posture: a throw has already rolled the whole
   * rebind set back, so we log loudly and carry on rather than bricking the
   * tenant's DO permanently.
   *
   * Runs on the constructor rather than inside `setupInfrastructure` because
   * the orphan distorts what a tenant is TOLD it has as well as what a retry
   * buys — `infrastructure_status` and the provisioning plan both read the
   * reconciled state on the very next request, whatever that request is.
   */
  private reconcileLegacyDomainIntents(tenantId: string, nowMs: number): void {
    try {
      const rebinds = reconcileLegacyDomainIntentKeys(this.ctx.storage, tenantId, nowMs);
      for (const rebind of rebinds) {
        console.log(
          `legacy domain-intent key rebound for ${tenantId}: ${rebind.from} -> ${rebind.to} (${rebind.domain}), ordinal ${rebind.originalOrdinal} -> ${rebind.ordinal}`,
        );
      }
    } catch (err) {
      console.error(`legacy domain-intent key reconciliation FAILED for ${tenantId}; state unchanged, will retry on next construction`, err);
    }
  }

  /**
   * Clock selection at rehydrate (wave-2 DECISION 2, swap site 1). A paid
   * tenant that has not migrated yet is migrated HERE — synchronously, in this
   * construction turn — so the flip self-applies to a live tenant DO on its
   * first touch after deploy, with no operator step.
   *
   * FAILURE IS SAFE BY DESIGN. The migration's transaction rolls back
   * everything (including the clock_mode marker) on any throw, so we simply
   * log loudly and keep the virtual clock: status quo, no new harm, and the
   * next construction retries against clean state. The clock_mode interlock
   * keeps the auto-send driver off an unmigrated tenant in the meantime, so
   * "still virtual" is a quiet hold, not a silent wrong-time send. Deliberately
   * NOT rethrown — a throw out of this constructor would brick the tenant's DO
   * permanently (every request 500s), which is strictly worse.
   */
  private selectClockOnRehydrate(row: {
    id: string;
    plan: TenantPlan;
    clock_base: number;
    clock_offset: number;
    clock_multiplier: number;
    clock_mode: string;
  }): Clock {
    if (row.clock_mode === "real") return new RealClock();

    const virtual = new VirtualClock(row.clock_base, row.clock_offset, row.clock_multiplier);
    if (!isPaidPlan(row.plan)) return virtual;

    try {
      const summary = migrateTenantClockToReal(this.ctx.storage, row.id, virtual.now(), new RealClock().now());
      console.log(`clock migration applied for ${row.id}`, summary);
      return new RealClock();
    } catch (err) {
      console.error(
        `clock migration FAILED for ${row.id}; keeping the virtual clock this boot (clock_mode stays 'virtual', auto-send stays gated off) — will retry on next construction`,
        err,
      );
      return virtual;
    }
  }

  /**
   * Swap sites 3 and 4 — called from both checkout completion paths after an
   * upgrade to the paid plan. Same failure posture as the constructor: a throw
   * has already rolled the migration back, so we keep the virtual clock and let
   * the next construction retry rather than failing the customer's checkout.
   */
  private switchToRealClock(): void {
    if (!this.tenantId || this.currentClock instanceof RealClock) return;
    const frozenNow = this.currentClock ? this.currentClock.now() : new RealClock().now();
    try {
      const summary = migrateTenantClockToReal(this.ctx.storage, this.tenantId, frozenNow, new RealClock().now());
      console.log(`clock migration applied at checkout for ${this.tenantId}`, summary);
      // The cached sandbox bundle holds `contextClock`, which resolves this
      // field on every now() — so swapping it here is the whole flip; there is
      // no adapter cache to invalidate (design v2 §4).
      this.currentClock = new RealClock();
    } catch (err) {
      console.error(
        `clock migration FAILED at checkout for ${this.tenantId}; keeping the virtual clock (auto-send stays gated off) — will retry on next construction`,
        err,
      );
    }
  }

  /**
   * Idempotent column back-fill for DOs created before a column was added to
   * TENANT_DO_SCHEMA (CREATE TABLE IF NOT EXISTS never alters an existing
   * table). New DOs already have the columns from the schema, so the PRAGMA
   * check skips the ALTER. Keeps schema.ts the single source of truth while
   * not breaking already-instantiated tenant DOs on deploy.
   */
  private ensureColumnMigrations(): void {
    this.addColumnIfMissing("campaigns", "is_demo", "INTEGER NOT NULL DEFAULT 0");
    // Campaign double-submit guard (see schema.ts + engine/campaigns.ts).
    this.addColumnIfMissing("campaigns", "content_hash", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("campaigns", "launched_at_real", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("ledger_entries", "source_send_id", "TEXT");
    this.addColumnIfMissing("tenant_profile", "billing_state", "TEXT NOT NULL DEFAULT 'none'");
    this.addColumnIfMissing("tenant_profile", "stripe_customer_id", "TEXT");
    this.addColumnIfMissing("tenant_profile", "stripe_subscription_id", "TEXT");
    // D5 dunning-vs-terminate suspension reason (adversarial panel-03 #6).
    this.addColumnIfMissing("tenant_profile", "suspend_reason", "TEXT");
    this.addColumnIfMissing("tenant_profile", "primary_domain", "TEXT NOT NULL DEFAULT ''");
    // GA gate G3 — provisioning back-pressure marker (see schema.ts).
    this.addColumnIfMissing("tenant_profile", "provisioning_state", "TEXT NOT NULL DEFAULT 'ok'");
    // B6 deliverability control-loop state on mailboxes (see schema.ts).
    this.addColumnIfMissing("mailboxes", "deliv_status", "TEXT NOT NULL DEFAULT 'healthy'");
    this.addColumnIfMissing("mailboxes", "cap_override", "INTEGER");
    // D5 teardown/reclaim marker on mailboxes (see schema.ts).
    this.addColumnIfMissing("mailboxes", "released_at", "INTEGER");
    // A teardown that left mailboxes live at the vendor (see schema.ts). 0 for
    // every pre-existing record: before per-item isolation a failed release
    // threw, so no historical teardown can have been partial.
    this.addColumnIfMissing("teardown_records", "mailbox_release_failures", "INTEGER NOT NULL DEFAULT 0");
    // A4 (CLASS A) — per-send retry counter (see schema.ts).
    this.addColumnIfMissing("scheduled_sends", "attempts", "INTEGER NOT NULL DEFAULT 0");
    // Stuck-'sending' reclaim marker (persist-before-confirm class; see
    // schema.ts + engine/tick.ts). Nullable — set on claim, cleared on terminal.
    this.addColumnIfMissing("scheduled_sends", "sending_since", "INTEGER");
    // A5 (CLASS A) — last charge decline code for dunning severity (see schema.ts).
    this.addColumnIfMissing("tenant_profile", "last_decline_code", "TEXT");
    // SPEC.md §19.2 (M1 dashboard+inbox) — per-mailbox last-sync marker, set by
    // runPollInbox on every poll (engine/reply-processor.ts). Backs the
    // Settings→Mailboxes "last polled" UI claim (§19.6).
    this.addColumnIfMissing("mailboxes", "last_polled_at", "INTEGER");
    // Consumer-owned IMAP poll cursor (persist-after-confirm class fix; see
    // schema.ts + engine/reply-processor.ts). DEFAULT -1 (never-polled
    // sentinel) so a DO that predates the column treats its existing
    // mailboxes as never-polled -- initializing at their current high-water
    // on the next poll rather than re-pulling their full history. Existing
    // DOs where this column already exists are unaffected (addColumnIfMissing
    // is a no-op then); see schema.ts's poll_cursor comment for the -1/0
    // distinction and the finding this closes.
    this.addColumnIfMissing("mailboxes", "poll_cursor", "INTEGER NOT NULL DEFAULT -1");
    // Warmup-pool auto-cancel at ramp completion (founder ruling 2026-08-02,
    // ROADMAP.md:25). NULL default = "not cancelled yet", so any mailbox in an
    // existing DO that is ALREADY past day 28 is picked up by the sweep's
    // catch-up pass on the next tick rather than being silently skipped.
    this.addColumnIfMissing("mailboxes", "warmup_cancelled_at", "INTEGER");
    this.addColumnIfMissing("mailboxes", "warmup_cancel_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("mailboxes", "warmup_cancel_gave_up_at", "INTEGER");
    // INCIDENT 2026-08-05 (H2). DEFAULT 'ready' so every pre-existing domain row
    // — provisioned before DNS state was tracked, and whose setDns did succeed
    // (it was a precondition of the row existing at all) — keeps its meaning.
    this.addColumnIfMissing("domains", "dns_status", "TEXT NOT NULL DEFAULT 'ready'");
    // INCIDENT 2026-08-05 root cause — which DNS operation applies (see
    // schema.ts). NULL for every pre-existing row: unknown, which the adapters
    // treat as 'purchased' (the read-only poll), so a legacy row can never drive
    // the connect-existing handshake that stranded the incident domain.
    this.addColumnIfMissing("domains", "connection_type", "TEXT");
    // SPEC.md §20 BYO domains & mailboxes — every default below reproduces an
    // EXISTING provisioned domain/mailbox's implicit state exactly (flag-dark:
    // see schema.ts's TENANT_DO_SCHEMA comment on these same columns).
    this.addColumnIfMissing("domains", "source", "TEXT NOT NULL DEFAULT 'provisioned'");
    this.addColumnIfMissing("domains", "is_primary", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("domains", "dns_mode", "TEXT");
    this.addColumnIfMissing("domains", "byo_status", "TEXT NOT NULL DEFAULT 'active'");
    this.addColumnIfMissing("domains", "scan_json", "TEXT");
    this.addColumnIfMissing("domains", "abuse_gate_json", "TEXT");
    this.addColumnIfMissing("domains", "consent_json", "TEXT");
    this.addColumnIfMissing("domains", "reputation_branch", "TEXT");
    this.addColumnIfMissing("domains", "breaker_tier", "TEXT NOT NULL DEFAULT 'standard'");
    this.addColumnIfMissing("domains", "dns_check_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("domains", "dns_first_checked_at", "INTEGER");
    // Vendor-verdict class fix, facet 2 (see schema.ts). NULL for every
    // pre-existing row: nothing has been given up on, so an existing DO's
    // domains keep their exact current behavior until a poll observes one.
    this.addColumnIfMissing("domains", "dns_gave_up_at", "INTEGER");
    this.addColumnIfMissing("domains", "first_send_eligible_at", "INTEGER");
    this.addColumnIfMissing("mailboxes", "source", "TEXT NOT NULL DEFAULT 'provisioned'");
    this.addColumnIfMissing("mailboxes", "transport_kind", "TEXT NOT NULL DEFAULT 'smtp'");
    this.addColumnIfMissing("mailboxes", "transport_json", "TEXT");
    // GA gate G4 — real-plan-slot marker for precise teardown slot accounting (see schema.ts).
    this.addColumnIfMissing("mailboxes", "slot_counted", "INTEGER NOT NULL DEFAULT 0");
    // Wave-2 §1 — vendor provenance. DEFAULT '' ("unclassified") is deliberate:
    // the clock migration's backfill classifies every existing row INSIDE its
    // transaction, so a rolled-back migration leaves '' everywhere, which the
    // send-eligibility picker excludes. See schema.ts's provider comment (R8).
    this.addColumnIfMissing("mailboxes", "provider", "TEXT NOT NULL DEFAULT ''");
    // Wave-2 DECISION 2 — the virtual->real clock interlock + its forensics
    // (see schema.ts). DEFAULT 'virtual' keeps every existing DO byte-identical
    // until its own migration commits.
    this.addColumnIfMissing("tenant_profile", "clock_mode", "TEXT NOT NULL DEFAULT 'virtual'");
    this.addColumnIfMissing("tenant_profile", "clock_migration_delta_ms", "INTEGER");
    this.addColumnIfMissing("tenant_profile", "clock_migrated_at", "INTEGER");
    this.addColumnIfMissing("deliverability_actions", "alerted_at", "INTEGER");
    // Gate residual N-2 — "claimed" vs "applied" (see schema.ts). DEFAULT 1
    // keeps every event an existing DO already recorded counting exactly as it
    // did before; only events refused from here on read 0.
    this.addColumnIfMissing("webhook_events", "applied", "INTEGER NOT NULL DEFAULT 1");
    // G1 (ga-gates-design-2026-07-22.md §G1) — OFAC/SDN screening verdict
    // columns (see schema.ts's tenant_profile comment for the field contract).
    this.addColumnIfMissing("tenant_profile", "screening_status", "TEXT NOT NULL DEFAULT 'clear'");
    this.addColumnIfMissing("tenant_profile", "screening_list_version", "TEXT");
    this.addColumnIfMissing("tenant_profile", "screened_at", "INTEGER");
    // Quantity-billing migration (design §9) — Stripe subscription-item ids +
    // drift-detection quantity + interval + captured discount (see schema.ts).
    // All defaults keep existing (demo) rows byte-identical.
    this.addColumnIfMissing("tenant_profile", "stripe_platform_item_id", "TEXT");
    this.addColumnIfMissing("tenant_profile", "stripe_mailbox_item_id", "TEXT");
    this.addColumnIfMissing("tenant_profile", "mailbox_qty_synced", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("tenant_profile", "billing_interval", "TEXT NOT NULL DEFAULT 'month'");
    this.addColumnIfMissing("tenant_profile", "checkout_discount_pct", "INTEGER NOT NULL DEFAULT 0");
    // G5 gate (a) follow-up — InboxKit-as-registrar per-tenant opt-in (see schema.ts).
    this.addColumnIfMissing("tenant_profile", "register_domains", "INTEGER NOT NULL DEFAULT 0");
    // C3 part d — the desired provisioning spec persisted per domain ordinal, so
    // the out-of-band reconcile sweep can re-drive completion with the ORIGINAL
    // persona + mailbox count (see schema.ts). NULL for every pre-existing intent
    // row; the reconcile skips a NULL-spec row rather than guessing.
    this.addColumnIfMissing("domain_intents", "persona_slug", "TEXT");
    this.addColumnIfMissing("domain_intents", "inboxes_each", "INTEGER");
    // Registrar-arming follow-up (2026-07-28) — the tenant's structured
    // registrant-of-record, persisted as JSON (see schema.ts).
    this.addColumnIfMissing("tenant_profile", "registrant_json", "TEXT");
    // CREDSTORE F1 (wave2-design §"CREDSTORE F1") — Worker-owned monotonic
    // push claim sequence (see schema.ts's mailbox_cred_pushes comment).
    // DEFAULT 0 so an existing row's first claim under the new code reads 1.
    this.addColumnIfMissing("mailbox_cred_pushes", "push_seq", "INTEGER NOT NULL DEFAULT 0");
    // Created here, not in TENANT_DO_SCHEMA, so they run only after the columns
    // above are guaranteed to exist (safe for DOs that predate the column). Each
    // collapses any pre-existing rows that would violate the unique key BEFORE
    // creating it (NB3): a DO instantiated before the index — whose plain-INSERT
    // path could have produced duplicate rows on a re-poll/reprocess — must not
    // throw a UNIQUE-constraint error out of this constructor (that would 500
    // every intent for the tenant, permanently).
    this.ensureDedupeIndex("idx_ledger_source_send", "ledger_entries", ["source_send_id"], "source_send_id");
    // B1 (CLASS B) — inbound-event idempotency anchor: an at-least-once IMAP
    // re-poll (or a client/queue retry) can re-deliver the same reply/bounce/
    // complaint; INSERT OR IGNORE against this unique key applies each event's
    // side effects at most once (engine/reply-processor.ts). (type, message_id)
    // is unique per real inbound message; NULLs are distinct in SQLite, so the
    // few event rows without a message id never collide.
    this.ensureDedupeIndex("idx_events_dedupe", "events", ["tenant_id", "type", "message_id"], "message_id");
    // H4 (INCIDENT 2026-08-05) — at most ONE LIVE mailbox per (tenant, email).
    // A replayed provision used to re-INSERT the row, and syncMailboxQuantity
    // BILLS by row count, so the duplicate became a real customer charge for a
    // mailbox that does not exist.
    //
    // PARTIAL (`WHERE released_at IS NULL`) on purpose: a full unique index
    // would also block legitimate RE-provisioning after a cancel, since the
    // released row keeps its address forever. Only live rows must be unique.
    // Goes through the partial-index helper (B3) — it collapses pre-existing
    // duplicate LIVE rows first and swallows a failure, so a tenant DO already
    // carrying duplicates boots instead of throwing out of the constructor and
    // bricking itself permanently.
    this.ensurePartialDedupeIndex("idx_mailboxes_live_email", "mailboxes", ["tenant_id", "email"], "released_at IS NULL");
  }

  // G1 (ga-gates-design-2026-07-22.md, Founder Q2 ADOPTED — "already-active
  // pilot tenants are grandfathered clear ... so turning screening on can
  // never strand the live pilot"). Self-applying exactly like
  // ensureColumnMigrations()/addColumnIfMissing() above: runs on every DO
  // construction, but is idempotent and a no-op after the first successful
  // stamp — `screening_list_version IS NOT NULL` (set either by this stamp OR
  // by a real screen at checkout, src/ofac/screening.ts) means "never touch
  // this tenant's verdict again here". A tenant that was NOT yet
  // billing_state='active' when this code first deploys (a fresh signup, or
  // one that later checks out) gets screened for REAL at its next checkout
  // instead — this only back-fills tenants that are ALREADY paying+active at
  // the moment G1 ships, so screening can never retroactively strand them.
  private static readonly SCREENING_GRANDFATHER_VERSION = "grandfathered-2026-07-23";

  private grandfatherActiveScreening(): void {
    const row = this.ctx.storage.sql
      .exec<{ id: string; billing_state: string; screening_list_version: string | null }>(
        `SELECT id, billing_state, screening_list_version FROM tenant_profile LIMIT 1`,
      )
      .toArray()[0];
    if (!row) return; // fresh DO, no tenant_profile row yet (initTenant creates it)
    if (row.screening_list_version !== null) return; // already screened (for real OR grandfathered) — never re-stamp
    if (row.billing_state !== "active") return; // nothing to strand — not currently paid+active

    this.ctx.storage.sql.exec(
      `UPDATE tenant_profile SET screening_status = 'clear', screening_list_version = ?, screened_at = ? WHERE id = ?`,
      TenantDO.SCREENING_GRANDFATHER_VERSION,
      new RealClock().now(),
      row.id,
    );
  }

  /**
   * Creates a UNIQUE INDEX after collapsing any pre-existing duplicate rows that
   * would violate it (NB3), keeping the lowest rowid per key. Only rows whose
   * `nullableKey` is non-NULL are collapsed — SQLite treats NULLs as DISTINCT in
   * a unique index, so NULL-key rows never collide and must be preserved
   * (non-usage ledger entries; events without a source Message-ID). Non-wedging:
   * a failure is swallowed rather than thrown out of the constructor — a bricked
   * DO (every intent 500s) is strictly worse than best-effort idempotency for one
   * boot, and the next successful construction retries. Idempotent (IF NOT EXISTS
   * + a no-op DELETE once deduped). Table/column names are code-literal (never
   * tenant input), so the interpolation is safe.
   */
  private ensureDedupeIndex(indexName: string, table: string, keyColumns: string[], nullableKey: string): void {
    const cols = keyColumns.join(", ");
    try {
      this.ctx.storage.sql.exec(
        `DELETE FROM ${table} WHERE ${nullableKey} IS NOT NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM ${table} WHERE ${nullableKey} IS NOT NULL GROUP BY ${cols}
         )`,
      );
      this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${cols})`);
    } catch (err) {
      console.error(`ensureDedupeIndex(${indexName}) failed; continuing without it this boot`, err);
    }
  }

  /**
   * The PARTIAL-index sibling of `ensureDedupeIndex`, with both of its safeties
   * intact (B3, gate 2026-08-05).
   *
   * The H4 index was originally exec'd RAW in this constructor because the
   * helper above "has no partial-index form" — which dropped the two things
   * that make it safe. Against a DO already carrying duplicate live rows (the
   * deep-dive's F12 proves those are producible today) the CREATE throws, the
   * throw escapes the constructor, and that tenant's DO can never instantiate
   * again — every request fails permanently with no API repair path. A phantom
   * billable row is recoverable; an unbootable DO is not, so the collapse and
   * the try/catch are mandatory, not decorative.
   *
   * Collapses duplicates within the PREDICATE's row set only (rows outside it
   * are not covered by the index and must not be touched), keeping the lowest
   * rowid — the original — and dropping the later replay artifacts.
   */
  private ensurePartialDedupeIndex(indexName: string, table: string, keyColumns: string[], predicate: string): void {
    const cols = keyColumns.join(", ");
    try {
      this.ctx.storage.sql.exec(
        `DELETE FROM ${table} WHERE ${predicate} AND rowid NOT IN (
           SELECT MIN(rowid) FROM ${table} WHERE ${predicate} GROUP BY ${cols}
         )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${table}(${cols}) WHERE ${predicate}`,
      );
    } catch (err) {
      console.error(`ensurePartialDedupeIndex(${indexName}) failed; continuing without it this boot`, err);
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (!columns.some((c) => c.name === column)) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  /** Bootstraps a freshly-signed-up tenant. Idempotent: a second call is a no-op. */
  async initTenant(input: InitTenantInput): Promise<void> {
    if (this.tenantId) return;

    const baseMs = new RealClock().now();
    const multiplier = input.plan === "demo" || input.plan === "free" ? 1440 : 1;
    // Swap site 2 (wave-2 DECISION 2): a tenant minted DIRECTLY on the paid
    // plan starts on real time — there is no demo-era state to rebase, so the
    // migration is not needed and 'real' is stamped at insert. The clock_*
    // columns are still written so the row shape stays uniform.
    const paid = isPaidPlan(input.plan);

    this.tenantId = input.tenantId;
    this.plan = input.plan;
    this.currentClock = paid ? new RealClock() : new VirtualClock(baseMs, 0, multiplier);

    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_profile (id, brand, plan, status, created_at, clock_base, clock_offset, clock_multiplier, clock_mode)
       VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?)`,
      input.tenantId,
      input.brand,
      input.plan,
      baseMs,
      baseMs,
      multiplier,
      paid ? "real" : "virtual",
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts)
       VALUES (?, ?, 'credit', 0, 'tenant created (sandbox)', ?)`,
      newId("ledg"),
      input.tenantId,
      baseMs,
    );

    await this.buildAdapters().billing.createCustomer(input.tenantId, `create-customer:${input.tenantId}`);
  }

  /**
   * Product-driven activation gate (I1, self-serve activation design §2.1 —
   * replaces `ENGINE_TENANTS`/`realAdaptersActivated`). Re-evaluates
   * `activated(tenant)` with a FRESH SQL read on EVERY call — adversarial
   * finding F3 (`docs/adversarial/selfserve-activation-design-review-2026-07-21.md`):
   * caching this decision (like the old `this.adapters ??= …` did) would let a
   * stale real/sandbox choice outlive a billing-state change (checkout,
   * webhook, dunning suspend, dispute) until the next DO restart. The design's
   * §2.2 option-1 (recommended, and REQUIRED per F3): only the SANDBOX bundle
   * instance is cached (its ports hold in-memory state that must persist —
   * see `sandboxAdapters` above); real ports are stateless HTTP clients, so
   * constructing a fresh one every call is cheap and correct.
   */
  private buildAdapters(): VendorAdapterBundle {
    if (!this.tenantId || !this.currentClock) throw new Error("tenant not initialized");
    // Every port gets `contextClock`, never the raw current clock: the cached
    // sandbox bundle below outlives a virtual->real flip, and the delegate is
    // what makes that safe (design v2 §4 — no cache invalidation needed).
    this.sandboxAdapters ??= createVendorAdapters(this.plan, this.contextClock, false, this.engineConfig());
    // Demo/free plans can NEVER activate (isTenantActivated requires
    // isPaidPlanTier — ARCHITECTURE.md #8), so this skips the fresh SQL read
    // entirely for them: there is no billing-state transition to go stale
    // against when the plan itself already forecloses activation. `this.plan`
    // is safe to trust here (kept in sync by initTenant/completeCheckoutSimulated/
    // handleStripeWebhook, the only writers) — this is a pure perf win (avoids
    // adding a query to every demo/free RPC call, e.g. GET /inbox's no-N+1
    // guarantee), not a correctness shortcut for a paid tenant.
    if (this.plan === "demo" || this.plan === "free") return this.sandboxAdapters;
    // `this.tenantId` is this DO's OWN verified identity (set from the
    // persisted tenant_profile row in the constructor, or from initTenant's
    // server-minted id — see routes/signup.ts's `newId("ten")` — never a
    // per-call/request-supplied value), so this read can't be spoofed by
    // anything a caller passes in.
    const { activated } = readActivationState(this.ctx.storage.sql, this.tenantId);
    if (!activated) return this.sandboxAdapters;
    // Activated. Build the real bundle with BOTH the engine (EmailPort) AND the
    // InboxKit (mailbox/domain) credentials. This is the GA wiring that CLOSES
    // the dark gap the G5 verdict flagged ("NEW out of scope": no call site ever
    // passed inboxKitConfig, so factory.ts's `useSandbox` was always true and
    // real mailbox provisioning was unreachable regardless of which secrets were
    // armed). Now, once INBOXKIT_API_KEY/INBOXKIT_WORKSPACE_ID are armed,
    // `createVendorAdapters`'s `useSandbox` flips false and the whole bundle goes
    // REAL — real mailbox provisioning becomes reachable. Every existing gate is
    // preserved: demo/free is foreclosed above, `activated` (isTenantActivated:
    // paid + billing active + not frozen + screening clear) still gates, and the
    // domain port stays the G5 gate-(a) hard-block (RegistrarUnarmedDomainPort)
    // UNLESS this tenant ALSO cleared the 2026-07-27 registrar-arming two-leg
    // check (registrarArming() below) — see vendors/factory.ts's three-way
    // domain branch. Everything downstream (withSpendCeiling, G3) exists to
    // make this flip SPEND-SAFE.
    const real = createVendorAdapters(
      this.plan,
      this.contextClock,
      activated,
      this.engineConfig(),
      this.inboxKitConfig(),
      readRegistrarArming(this.env, this.ctx.storage.sql, this.tenantId),
    );
    if (real.kind === "real") return real;
    // InboxKit NOT armed (the common state, and every test): only the EmailPort
    // may go real; every OTHER port stays the SAME cached sandbox instance (its
    // in-memory search/release/idempotency state must persist — design §2.2
    // option-1). Byte-identical to the pre-GA behavior.
    return { ...this.sandboxAdapters, email: real.email };
  }

  private engineConfig(): EngineClientConfig | undefined {
    const baseUrl = this.env.ENGINE_BASE_URL;
    const authSecret = this.env.ENGINE_AUTH_SECRET;
    return baseUrl && authSecret ? { baseUrl, authSecret } : undefined;
  }

  // InboxKit workspace credentials (ACTIVATION.md Gate 0). Absent in the deployed
  // build until the founder arms them (wrangler secret put); mirrors
  // engineConfig() above. Threaded into createVendorAdapters so real mailbox/
  // domain ports become reachable ONLY once both are set (factory.ts's
  // `useSandbox`).
  private inboxKitConfig(): InboxKitClientConfig | undefined {
    const apiKey = this.env.INBOXKIT_API_KEY;
    const workspaceId = this.env.INBOXKIT_WORKSPACE_ID;
    return apiKey && workspaceId ? { apiKey, workspaceId } : undefined;
  }

  private requireContext(): TenantContext {
    if (!this.tenantId || !this.currentClock) throw new Error("tenant not initialized");
    return {
      sql: this.ctx.storage.sql,
      tenantId: this.tenantId,
      plan: this.plan,
      clock: this.contextClock,
      adapters: this.buildAdapters(),
      env: this.env,
    };
  }

  // --- The facade intents (bearer-token-authed, tenant-scoped) ---

  async setupInfrastructure(input: SetupInfrastructureInput, idempotencyKey?: string) {
    const base = this.requireContext();
    // B1 (docs/adversarial/registrar-arming-review-2026-07-28.md): the domain
    // port buildAdapters() baked reflects the PRE-call persisted
    // register_domains/registrant_json — register_domains has no writer other
    // than runSetupInfrastructure's own UPDATE, which runs AFTER
    // requireContext(). For setup_infrastructure THIS call's validated opt-in +
    // registrant are authoritative at buy time in BOTH directions (orchestrator
    // ruling 2026-07-28): re-select ONLY the domain port from this call's input,
    // so a fresh single-call opt-in buys in the SAME call (no false
    // registrar_unarmed 503/alert) and an opt-out never fires a stale-persisted
    // buy. Every OTHER port stays byte-identical, and every OTHER flow that
    // selects a domain port (REPLACE_DOMAIN etc.) keeps reading persisted state.
    const ctx: TenantContext = {
      ...base,
      adapters: { ...base.adapters, domain: this.selectSetupDomainPort(base.adapters, input) },
    };
    return withRequestIdempotency(
      ctx,
      idempotencyKey ? `setup_infrastructure:${idempotencyKey}` : undefined,
      // The caller's key gates RESPONSE REPLAY ONLY. It has not seeded the
      // durable domain-intent rows since `85f48af`, which moved them onto
      // `domainIntentKey`'s tenant+ordinal derivation precisely so that no key
      // permutation — supplied, omitted, or changed between retries — can
      // decide whether a retry resumes the prior purchase or buys a second
      // domain. What makes the retry converge after idempotency.ts clears the
      // claim on a throw (the incident's exact path: the saga re-runs) is the
      // intent row at the ORDINAL, not this key.
      //
      // The version of this comment that claimed otherwise outlived the change
      // by four days and is why the 2026-08-13 P0 read as "idempotency not
      // gating the resume path": intents written under the OLD key were
      // orphaned, not un-consulted (ticket sup_3ca260e4; the rebind is
      // engine/legacy-domain-intent-keys.ts).
      // THE ONE CALL SITE WITH NON-TERMINAL RETURNS (docs/adversarial/
      // class-sweep-cached-terminal-2026-08-17.md members 1-3). This saga can
      // RETURN while still owing work, and until the wrapper made terminality a
      // written value, each such outcome froze as the permanent answer to a key
      // the platform's own retry_setup message tells the agent to reuse.
      async () => settleSetupInfrastructure(await runSetupInfrastructure(ctx, input, undefined, idempotencyKey)),
      // Pre-contract rows are 'done' regardless of what they recorded, so the
      // replay path re-classifies the stored payload for the population already
      // wedged in production.
      { recordedIsNonTerminal: (recorded) => !settleSetupInfrastructure(recorded).terminal },
    );
  }

  // The domain port for THIS setup_infrastructure call, chosen from the call's
  // own opt-in + registrant instead of the stale persisted profile (B1 fix). A
  // sandbox-eligible tenant's SandboxDomainPort is returned unchanged —
  // register_domains never selects it, and its cached in-memory search/release
  // state must persist across the request (see `sandboxAdapters`). A
  // real-eligible tenant re-runs the factory's two-leg gate via
  // selectRealDomainPort (the decouple guard stays inviolable: env leg absent →
  // hard-block regardless of what the call says). The registrant is derived
  // from this call's input exactly as readRegistrarOptInState derives it from
  // the just-persisted row (deriveInboxKitRegistrant — organization falls back
  // to brand), so the port's baked registrant and provisionDomainWithMailboxes's
  // post-UPDATE completeness pre-flight can never disagree.
  private selectSetupDomainPort(bundle: VendorAdapterBundle, input: SetupInfrastructureInput): DomainPort {
    if (bundle.kind !== "real") return bundle.domain;
    // H8b does NOT change this. Two adversary rulings meet here and they are
    // about different things:
    //   B1 (money)  — the port for THIS call is chosen from THIS call's own
    //                 explicit opt-in. Absent reads as NOT opted in, so a stale
    //                 persisted `register_domains=1` can never fire a real buy
    //                 for a call that didn't ask for one.
    //   H8b (state) — the persisted consent must not be ERASED by a call that
    //                 merely omitted the field (runSetupInfrastructure's write).
    // Falling back to the persisted opt-in here would have satisfied H8b and
    // broken B1 in the money direction, so the fallback lives only in the write
    // path. `?? false` makes the now-optional field's absence explicit.
    return selectRealDomainPort(this.inboxKitConfig(), {
      armed: isInboxKitRegistrarArmed(this.env),
      optIn: input.registerDomains ?? false,
      registrant: deriveInboxKitRegistrant({
        brand: input.brand,
        physicalAddress: input.physicalAddress,
        senderIdentity: input.senderIdentity,
        registrantJson: input.registrant ? JSON.stringify(input.registrant) : null,
      }),
    });
  }

  infrastructureStatus() {
    return getInfrastructureStatus(this.requireContext());
  }

  async launchCampaign(input: LaunchCampaignInput, idempotencyKey?: string) {
    const ctx = this.requireContext();
    return withRequestIdempotency(
      ctx,
      idempotencyKey ? `launch_campaign:${idempotencyKey}` : undefined,
      // TERMINAL: launchCampaign is fully synchronous and returns only after the
      // campaign, its leads and its scheduled_sends rows have landed; a duplicate
      // submit THROWS with the existing id rather than returning a success shape.
      async () => terminal(await launchCampaign(ctx, input)),
    );
  }

  campaignResults(campaignId: string) {
    return getCampaignResults(this.requireContext(), campaignId);
  }

  metrics() {
    return getMetrics(this.requireContext());
  }

  // SPEC.md §19.4 — v2: cursor-paginated, filterable. `query` defaults
  // (InboxQueryInput.parse({})) preserve the exact pre-v2 GET /inbox shape
  // for a caller that passes nothing (backward-compatible default — see
  // engine/inbox.ts). Shared by the HTTP route AND the MCP `inbox` tool.
  inbox(query: InboxQueryInput): InboxPage {
    return listInbox(this.requireContext(), query);
  }

  // GET /campaigns (§19.4) — NEW DO method, not a wrapper.
  campaigns(): CampaignListItem[] {
    return listCampaigns(this.requireContext());
  }

  // GET /activity (§19.4) — NEW DO method merging events + deliverability_actions.
  activity(query: ActivityQueryInput): ActivityPage {
    return getActivityFeed(this.requireContext(), query);
  }

  thread(threadId: string) {
    return getThread(this.requireContext(), threadId);
  }

  // POST /threads/:id/label (§19.2/§19.4/§19.5) — `source` is server-derived
  // from transport by the caller (route/tool), never a client-supplied claim.
  labelThread(threadId: string, label: string | null, source: Provenance): ThreadLabelResult {
    return setThreadLabel(this.requireContext(), threadId, label, source);
  }

  // --- SPEC.md §19.2/§19.4/§19.5 — agent-controlled dashboard saved views.
  // Parity law (§19.0): these are the SAME methods both the dashboard HTTP
  // routes (routes/dashboard.ts) and the MCP get_dashboard/configure_dashboard
  // tools call — no dashboard-only state exists outside this facade. ---

  dashboardViews(): DashboardViewSummary[] {
    return listDashboardViews(this.requireContext());
  }

  dashboardView(id: string): DashboardViewDetail {
    return getDashboardView(this.requireContext(), id);
  }

  createDashboardView(input: { name: string; layout: DashboardLayout; note?: string }, source: Provenance): DashboardViewDetail {
    return createDashboardView(this.requireContext(), input, source);
  }

  updateDashboardView(
    id: string,
    input: { rev: number; layout: DashboardLayout; name?: string; note?: string },
    source: Provenance,
  ): DashboardViewDetail {
    return updateDashboardView(this.requireContext(), id, input, source);
  }

  promoteDashboardViewDefault(id: string, source: Provenance): DashboardViewSummary[] {
    return promoteDashboardViewDefault(this.requireContext(), id, source);
  }

  deleteDashboardView(id: string): { deleted: true } {
    return deleteDashboardView(this.requireContext(), id);
  }

  // --- Outbound webhook subscriptions (ROADMAP.md WIN-THE-COMPARISON (d) /
  // forensics §5 (c)). The SAME facade both the HTTP routes
  // (routes/webhook-subscriptions.ts) and the MCP tools
  // (get_webhooks/configure_webhook) call — never a parallel implementation
  // (CLAUDE.md rule c). Tenant-isolated: a subscription lives in this DO's own
  // SQLite and can reference no other tenant's events (rule h). ---

  webhooks(): WebhookSummary[] {
    return listWebhooks(this.requireContext());
  }

  webhook(id: string): WebhookDetail {
    return getWebhook(this.requireContext(), id);
  }

  createWebhook(input: WebhookCreateInput): WebhookSummary & { secret: string } {
    return createWebhook(this.requireContext(), input, new RealClock().now());
  }

  updateWebhook(id: string, input: WebhookUpdateInput): WebhookSummary & { secret?: string } {
    return updateWebhook(this.requireContext(), id, input, new RealClock().now());
  }

  deleteWebhook(id: string): { deleted: true } {
    return deleteWebhook(this.requireContext(), id);
  }

  // Cron/test-driven delivery pump — NOT a tenant HTTP intent (like tick()/
  // pollInbox()): production uses REAL wall-clock + the real fetch deliverer;
  // tests drive pumpWebhookDeliveries directly with a fake deliverer + a
  // controlled nowMs. Called per-tenant by the cron sweep (admin/ops-sweep.ts).
  async runWebhookDeliveries(nowMs: number = new RealClock().now()): Promise<PumpSummary> {
    return pumpWebhookDeliveries(this.requireContext(), realWebhookDeliverer, nowMs);
  }

  // --- SPEC.md §20 BYO domains & mailboxes. The SAME facade both the HTTP
  // routes (routes/byo-domains.ts) and the MCP tools (get_byo_domains/
  // configure_byo_domain) call — never a parallel implementation (CLAUDE.md
  // rule c), exactly like the dashboard-views/webhooks facades above. ---

  byoDomains(): ByoDomainSummary[] {
    return listByoDomains(this.requireContext());
  }

  byoDomain(id: string): ByoDomainRecord {
    return getByoDomain(this.requireContext(), id);
  }

  async registerByoDomain(input: RegisterByoDomainInput): Promise<ByoDomainRecord> {
    return registerByoDomain(this.requireContext(), input);
  }

  async pollByoDomainDns(id: string): Promise<PollDnsResult> {
    return pollByoDomainDns(this.requireContext(), id);
  }

  async acknowledgeByoConsent(id: string, input: AcknowledgeByoConsentInput): Promise<ByoDomainRecord> {
    return acknowledgePrimaryDomainConsent(this.requireContext(), id, input);
  }

  async requestManagedByoMailboxes(id: string, input: RequestManagedByoMailboxesInput): Promise<RequestManagedByoMailboxesResult> {
    return requestManagedByoMailboxes(this.requireContext(), id, input);
  }

  async connectByoMailbox(id: string, input: ConnectByoMailboxInput): Promise<ConnectByoMailboxResult> {
    return connectByoMailbox(this.requireContext(), id, input);
  }

  async reply(threadId: string, body: string, idempotencyKey?: string) {
    const ctx = this.requireContext();
    return withRequestIdempotency(
      ctx,
      idempotencyKey ? `reply:${threadId}:${idempotencyKey}` : undefined,
      // TERMINAL: returns a messageId only after the send is confirmed; the
      // sent_message_keys short-circuit can only replay a send that provably went out.
      async () => terminal(await replyToThread(ctx, threadId, body, idempotencyKey)),
    );
  }

  mark(threadId: string, status: string) {
    markThread(this.requireContext(), threadId, status);
  }

  pause(campaignId: string) {
    pauseCampaign(this.requireContext(), campaignId);
  }

  pauseAll() {
    pauseAllCampaigns(this.requireContext());
  }

  account() {
    return getAccount(this.requireContext());
  }

  // --- B1 money path: checkout + Stripe webhook (bearer-token-authed except
  // the simulate-landing/webhook routes, which are keyed by the session id /
  // signature instead — see routes/checkout.ts + routes/webhooks.ts) ---

  async checkout(input: CheckoutInput, origin: string): Promise<CheckoutResult> {
    return startCheckout(this.requireContext(), input, origin);
  }

  /**
   * Customer-initiated downgrade (design §2) — releases N mailboxes now + syncs
   * the lower Stripe quantity (proration none). Tenant-authed, POST
   * /remove-mailboxes.
   *
   * BLOCKING-2 (audit-dashboard-idempotency-2026-08-06). "Release N" is
   * RELATIVE and irreversible through this API, so every unprotected repeat
   * destroyed another N: a same-key replay released twice, and a concurrent
   * double-submit released 2N. Three guards, because the shapes are different
   * failures:
   *
   *  - The KEY, honored durably: a replay of a FINISHED release returns the
   *    recorded response and re-releases nothing. This is the one the docs
   *    already promised.
   *  - The KEY AGAIN, as a durable INTENT (N1, wave-1-2-integration-gate-
   *    2026-08-18 round 2): the first execution records the addresses it
   *    resolved, and a same-key retry drives exactly those. The replay guard
   *    alone was not enough, because a partial release is deliberately NOT
   *    recorded (see settleRemoveMailboxes) — so the instructed retry re-ran a
   *    RELATIVE op and destroyed `count - failedCount` healthy mailboxes per
   *    pass, with no terminating condition while one mailbox stayed stuck.
   *  - SINGLE-FLIGHT, for the caller that sends no key (every browser caller):
   *    at most one release may be running for a tenant at a time. Deliberately
   *    an in-memory flag rather than a durable claim — both submits necessarily
   *    reach THIS instance (that is what makes the DO input gate the tenant's
   *    serialization point), the check-and-set is synchronous so no concurrent
   *    RPC can interleave before it, and an instance that dies mid-release takes
   *    the flag with the work. A durable claim would only add a stuck-claim
   *    failure mode: `releaseMailboxes` is already crash-retry-safe (driven by
   *    `released_at IS NULL`, with an idempotent release + revoke).
   *
   * What none of them can do is make an UNKEYED sequential retry safe — once the
   * first call has settled, "release 1 more" is genuinely what a second unkeyed
   * call says. Callers that need retry safety send the key.
   */
  async removeMailboxes(input: RemoveMailboxesInput, idempotencyKey?: string): Promise<RemoveMailboxesResult> {
    const ctx = this.requireContext();
    if (this.releaseInFlight) {
      throw new RequestInProgressError(
        "a mailbox release is already running for this tenant — wait for it to finish, then check your live mailbox count before retrying",
      );
    }
    this.releaseInFlight = true;
    // ONE key namespaces both the replay claim and the release intent: they are
    // two statements about the same request, and a set recorded under a
    // different anchor than the claim could be adopted by the wrong retry.
    const key = idempotencyKey ? `remove_mailboxes:${idempotencyKey}` : undefined;
    try {
      return await withRequestIdempotency(
        ctx,
        key,
        // Terminality is READ OFF THE RESULT (engine/remove-mailboxes-terminality.ts),
        // never inferred from "it did not throw": per-item isolation means a
        // vendor refusal now comes back as `failedCount` rather than an
        // exception, and a partial release still owes the mailbox it left live.
        async () => settleRemoveMailboxes(await removeMailboxes(ctx, input, key)),
      );
    } finally {
      this.releaseInFlight = false;
    }
  }

  async completeCheckoutSimulated(sessionId: string): Promise<CompleteCheckoutResult> {
    const result = await completeSimulatedCheckout(this.requireContext(), sessionId);
    this.reconcileClockWithDurablePlan(); // swap site 3
    return result;
  }

  async handleStripeWebhook(event: StripeEventInput): Promise<WebhookApplyResult> {
    const result = await applyStripeWebhookEvent(this.requireContext(), event);
    this.reconcileClockWithDurablePlan(); // swap site 4 — the real Stripe path
    return result;
  }

  /**
   * Swap sites 3 and 4 — reconciles the in-memory plan AND the clock against
   * what is DURABLY on disk after a checkout/webhook call.
   *
   * WHY DURABLE STATE, NOT THE CALL'S RESULT (integration audit FINDING 1).
   * Both paths used to gate the flip on a field of the result object
   * (`upgraded` / `plan`), and one real path writes the upgrade to disk without
   * ever populating those: a webhook delivery that FINISHES a previous attempt
   * which died mid-handler returns `{applied:false, duplicate:true,
   * completed:true}` with no `plan` at all (engine/billing.ts's completion
   * pass). The upgrade is committed, the tenant is paid — and the clock stayed
   * virtual until the DO happened to be evicted and reconstructed, so
   * `clock_mode` stayed 'virtual' and the auto-send driver's interlock held
   * that paying customer at zero sends for an unbounded time.
   *
   * Reading the row is also the honest way to keep `this.plan` current: it is
   * cached for the DO instance's lifetime and read by every quota check and
   * demo/free guard, so it must reflect disk rather than whichever field the
   * last call chose to return.
   *
   * Idempotent and cheap: `switchToRealClock` is a no-op once the clock is
   * real, and the migration itself is guarded by the `clock_mode` marker it
   * writes inside its own transaction — so calling this after EVERY webhook
   * (most of which change nothing) costs one indexed single-row read.
   */
  private reconcileClockWithDurablePlan(): void {
    if (!this.tenantId) return;
    const row = this.ctx.storage.sql
      .exec<{ plan: TenantPlan; clock_mode: string }>(
        `SELECT plan, clock_mode FROM tenant_profile WHERE id = ?`,
        this.tenantId,
      )
      .toArray()[0];
    if (!row) return;
    this.plan = row.plan;
    if (isPaidPlan(row.plan) && row.clock_mode !== "real") this.switchToRealClock();
  }

  // --- B4 opt-out: the hosted RFC 8058 one-click unsubscribe endpoint
  // (routes/unsubscribe.ts). PUBLIC, unauthenticated — like checkout()/
  // completeCheckoutSimulated() above, the credential is a signed token the
  // ROUTE already verified (unsubscribe-token.ts) before ever resolving this
  // tenant's stub, not a bearer token. ---

  unsubscribeByEmail(email: string): UnsubscribeResult {
    const ctx = this.requireContext();
    return unsubscribeEmail(ctx, email, ctx.clock.now());
  }

  // --- SPEC.md §22 — warm-lead thin layer (increments #1-#3, ratified +
  // founder-gated 2026-07-21). The SAME facade both the HTTP routes
  // (routes/leads.ts) and the MCP tools (suppress_lead/update_lead/list_leads)
  // call — never a parallel implementation (CLAUDE.md rule c). ---

  suppressLead(input: SuppressLeadInput): UnsubscribeResult {
    const ctx = this.requireContext();
    return suppressLead(ctx, input, ctx.clock.now());
  }

  updateLead(input: UpdateLeadInput, source: Provenance): LeadDispositionView {
    const ctx = this.requireContext();
    return upsertLeadDisposition(ctx, input, source, ctx.clock.now());
  }

  listLeads(query: ListLeadsQueryInput): LeadListPage {
    return listLeads(this.requireContext(), query);
  }

  // --- msgchannel increment 3 — list_messages/ack_message. The SAME facade
  // both the HTTP routes (routes/messages.ts) and the MCP tools call (parity
  // law), reading/writing the SAME tenant_messages store increment 1's
  // emitTenantMessage and increment 2's emitOperatorMessage write into. ---

  listMessages(query: ListMessagesQueryInput): MessageListPage {
    return listMessagesPage(this.requireContext(), query);
  }

  ackMessage(id: string): AckMessageResult {
    return ackMessage(this.requireContext(), id);
  }

  /**
   * msgchannel Inc5 — the reverse leg (agent->operator), called by BOTH
   * `contact_operator` (MCP) and POST /messages/contact-operator (REST —
   * routes/messages.ts), the same parity shape as list_messages/ack_message
   * above. No mailer param exposed on the RPC surface (defaults inside
   * engine/contact-operator.ts, same as setupInfrastructure's own
   * `runSetupInfrastructure(ctx, input, undefined, ...)` — a test that needs
   * to inspect the ops email injects a SandboxOpsMailer by calling
   * contactOperator directly via withTenantContext instead of through this RPC).
   */
  async contactOperator(input: ContactOperatorInput): Promise<ContactOperatorResult> {
    return contactOperator(this.requireContext(), input);
  }

  // --- D5 lifecycle: voluntary cancel (tenant-authed, POST /cancel) + abuse
  // terminate (ADMIN_TOKEN-authed, POST /admin/tenants/:id/terminate). Both
  // reclaim this tenant's OWN infra only — a DO can physically reach no other
  // tenant's storage (ARCHITECTURE.md #3 + CLAUDE.md rule h). ---

  async cancel(input: { immediate: boolean }): Promise<CancelResult> {
    return cancelTenant(this.requireContext(), input);
  }

  async terminate(): Promise<TerminateResult> {
    return terminateTenant(this.requireContext());
  }

  // --- Engine tick / poll — see engine/README.md for why these are directly-callable, not alarms ---

  async tick() {
    return runTick(this.requireContext());
  }

  async pollInbox() {
    return runPollInbox(this.requireContext());
  }

  // --- Wave-2 auto-send drivers. The CRON's only entry points into the send
  // pipeline (admin/ops-sweep.ts's runSendPipelineAllTenants). `tick()` and
  // `pollInbox()` above are deliberately untouched: they carry no activation
  // predicate and are what the demo path and the existing test surface drive.
  // The gate lives HERE rather than in the cron so that no future caller can
  // arm automatic sending by finding another door — engine/activation.ts's
  // readSendDriverGate re-reads everything it needs on every call. ---

  async runScheduledTick(): Promise<ScheduledTickResult> {
    const ctx = this.requireContext();
    const gate = readSendDriverGate(ctx.sql, ctx.tenantId, this.env);
    if (!gate.allowed) return { ran: false, reason: gate.reason, sent: 0, skipped: 0, deferred: 0 };
    return { ran: true, reason: "", ...(await runTick(ctx)) };
  }

  async runScheduledPoll(): Promise<ScheduledPollResult> {
    const ctx = this.requireContext();
    const gate = readSendDriverGate(ctx.sql, ctx.tenantId, this.env);
    if (!gate.allowed) return { ran: false, reason: gate.reason, replies: 0, bounces: 0, complaints: 0 };
    return { ran: true, reason: "", ...(await runPollInbox(ctx)) };
  }

  // --- D2/D6 admin surface RPCs (src/admin/README.md) — called ONLY from
  // src/routes/admin-*.ts (never a tenant facade route: these read/mutate
  // state an authed TENANT must never trigger for itself). Cross-tenant
  // aggregation reads the D1 tenants_index for the id list, then calls
  // opsSummary() on each tenant's own DO stub — never touches another
  // tenant's SqlStorage directly (ARCHITECTURE.md #3 + CLAUDE.md rule h). ---

  /**
   * Watchtower canary probe (src/admin/watchtower.ts). Called against a FIXED
   * canary id that is never a real tenant, so it touches no customer data and
   * needs no initialized profile — the value is that reaching this line at all
   * proves the class CONSTRUCTS: the constructor above runs the whole schema +
   * column migrations, and this repo has twice shipped a change that made that
   * throw, which 500s every RPC for every tenant simultaneously. The DO probe
   * used to ping only RateLimiterDO and reported healthy right through it.
   */
  async ping(): Promise<boolean> {
    await this.ctx.storage.get("__watchtower_probe__");
    return true;
  }

  opsSummary(sinceMs: number): TenantOpsSummary {
    return getOpsSummary(this.requireContext(), sinceMs);
  }

  /**
   * Cron-triggerable: cancels the InboxKit warmup-pool subscription of every
   * mailbox whose ramp has completed (founder ruling 2026-08-02,
   * ROADMAP.md:25). Its OWN cron lane, deliberately not folded into `tick()`.
   *
   * A1 (adversary warmup-wave review 2026-08-02): the sweep originally ran only
   * inside `runTick`, and nothing in production calls `tick()` — no cron entry,
   * no route, no MCP tool, no DO alarm (alarm-driven scheduling is still B2
   * backlog). So the shipped code could never have cancelled anything, while
   * the site claimed in the present tense that it does. Wiring `tick()` into
   * the cron instead would have armed automatic CAMPAIGN SENDING, a separate
   * founder-gated arc — hence a dedicated lane that carries no send scheduling,
   * exactly like `deliverabilitySweep` above.
   */
  async warmupCancelSweep() {
    return runWarmupCancellationSweep(this.requireContext());
  }

  /**
   * C3 part d — cron-triggerable out-of-band provisioning reconcile
   * (engine/provisioning-reconcile.ts). Re-drives this tenant's dns_status
   * 'pending' setup domains to completion so a benign propagation wait finishes
   * without an agent retry. Its own lane, exactly like `warmupCancelSweep` /
   * `deliverabilitySweep`: it carries no send scheduling.
   *
   * The arming gate (PROVISIONING_RECONCILE_ENABLED) is checked ONCE in
   * admin/ops-sweep.ts BEFORE this RPC is ever dispatched, so this method never
   * runs while the flag is dark. Reaching it at all also means this DO was just
   * constructed, which fires the P0 legacy-intent-key rebind first (constructor);
   * a rebound legacy intent has no persisted spec, so the reconcile below skips
   * it (an agent retry completes those) rather than guessing a mailbox count.
   */
  async provisioningReconcileSweep() {
    return runProvisioningReconcile(this.requireContext());
  }

  /** Cron-triggerable: runs just the monitor->decide->act loop (no send scheduling — that's tick()/B2). */
  async deliverabilitySweep() {
    const ctx = this.requireContext();
    const result = await runDeliverabilitySweep(ctx);
    // Self-serve I3 (F6) — retry any mailbox whose credential push to the engine
    // is still 'pending'. INERT unless armed (config-gated inside), so a no-op in
    // the default build and every test; a stuck push resolves on the next sweep.
    await reconcileMailboxCredentialPushes(ctx);
    // Quantity-billing reconcile (design §8.5) — re-push the Stripe mailbox
    // quantity for this tenant if `mailbox_qty_synced` drifted from the live
    // provisioned count (a lost push, or a release on a non-active tenant that
    // later recovered). Active-only + set-to-N idempotent inside; a no-op in the
    // default build and every test (no real Stripe subscription).
    await syncMailboxQuantity(ctx);
    // System->agent message channel, increment 1 — bounded, tenant-scoped
    // cleanup of expired/old-read tenant_messages rows, reusing this existing
    // per-tenant cron leg rather than a new cron (engine/tenant-messages.ts).
    pruneTenantMessages(ctx);
    // msgchannel Inc5 fast-follow — reconciles agent_contact_log admissions
    // an isolate death left with no D1 support_tickets record (engine/
    // contact-operator-reconcile.ts). REAL wall-clock, not ctx.clock: the
    // log's own created_at is always real time (contact-operator-guard.ts's
    // documented invariant — a demo tenant's up-to-1440x VirtualClock must
    // never gate this), so the reap threshold has to be measured the same way.
    await reconcileOrphanedAdmissions(ctx, new RealClock().now());
    return result;
  }

  /**
   * D2 dunning sweep's "suspend after grace" action — a real local state
   * transition (not a vendor call), armed now. Returns false (a no-op) when
   * billing_state is no longer 'past_due' at write time — a recovery webhook
   * landed in the gap between the sweep's read and this write (F3, audit
   * 2026-08-05); the caller must not record a suspend or notify one that
   * didn't happen.
   */
  suspendForDunning(): boolean {
    return suspendTenant(this.requireContext(), "dunning");
  }

  /** G1b admin resolution — POST /admin/tenants/:id/screening {decision:'clear'} (routes/admin-screening.ts). */
  clearScreening(): void {
    clearScreeningStatus(this.requireContext());
  }

  /**
   * msgchannel increment 2 — the operator route (POST
   * /admin/tenants/:id/messages, routes/admin-messages.ts ONLY; never a
   * tenant-facing route). Throws ValidationError (mapped to HTTP 400) when
   * this tenant is lifecycle-frozen and the message kind doesn't warrant an
   * exception — see engine/tenant-messages.ts's emitOperatorMessage doc.
   */
  emitOperatorMessage(input: EmitOperatorMessageInput): void {
    emitOperatorMessage(this.requireContext(), input);
  }

  /**
   * The read twin of emitOperatorMessage above — GET
   * /admin/tenants/:id/messages (routes/admin-messages.ts ONLY; never a
   * tenant-facing route). An operator audit view of this tenant's WHOLE
   * message store (see engine/tenant-messages.ts's listMessagesForOperator
   * doc for why it's unfiltered/newest-first, unlike the two agent-facing
   * surfaces above). Delivers regardless of lifecycle state, same rationale
   * as emitOperatorMessage (PURE SELECT — there is nothing to gate).
   */
  listMessagesForOperator(options: ListMessagesForOperatorOptions): OperatorMessageListResult {
    return listMessagesForOperator(this.requireContext(), options);
  }

  /**
   * GET /admin/tenants/:id/provisioning-state (routes/admin-provisioning-state.ts
   * ONLY; never a tenant-facing route) — see engine/provisioning-state.ts's
   * doc for what this closes (UNVERIFIABLE-1/2/3, agent-channel-product-audit
   * -2026-08-17.md). PURE SELECT across domains/domain_intents/
   * request_idempotency, same posture as listMessagesForOperator above.
   */
  getProvisioningStateForOperator(): ProvisioningState {
    return getProvisioningStateForOperator(this.requireContext());
  }

  /**
   * N-OF-1 fix (adversary OFAC build review, 2026-07-23) — called ONLY by the
   * ops-sweep recovery pass (ofac/screening-recovery.ts) for a tenant whose
   * `screening_list_version` is STILL the `LIST_UNAVAILABLE_VERSION` sentinel
   * (screening.ts). Fresh-SQL-read guarded (not a cached value): if the
   * verdict has already moved on since (a manual admin decision, or a prior
   * recovery pass already ran), this is a no-op — never re-screens a tenant
   * whose hold has a real resolution already.
   *
   * Race-guard addendum (adversary re-attack, 2026-07-23): the sweep reads its
   * pending-review list, THEN calls this RPC per tenant — an admin clear/
   * reject can land in that window. `clearScreening()` flips
   * `screening_status` to 'clear' but leaves `screening_list_version`
   * unchanged (by design, for audit — see clearScreeningStatus's doc
   * comment), so version-only guarding would let a recovery re-screen
   * OVERRIDE an admin's explicit 'clear' decision (re-blocking a tenant the
   * admin just cleared). ANDing in `screening_status === 'review'` closes
   * that: once an admin has cleared, this is a permanent no-op for that hold.
   * (A `reject` leaves `screening_status` at 'review' — unchanged by
   * terminate — but the tenant is suspended/token-locked regardless, so a
   * redundant re-screen here can't reactivate it; the review-QUEUE audit
   * corruption that scenario risked is closed at the write side instead —
   * `resolveScreeningReview`'s now-conditional-on-'pending' UPDATE, admin/
   * db.ts — so a stale re-screen here can never overwrite an already-
   * 'rejected' row.)
   */
  async rescreenIfListUnavailable(): Promise<{ rescreened: boolean; status?: string }> {
    const ctx = this.requireContext();
    const row = ctx.sql
      .exec<{ screening_status: string; screening_list_version: string | null }>(
        `SELECT screening_status, screening_list_version FROM tenant_profile WHERE id = ?`,
        ctx.tenantId,
      )
      .one();
    if (row.screening_list_version !== LIST_UNAVAILABLE_VERSION || row.screening_status !== "review") {
      return { rescreened: false };
    }
    const result = await screenTenant(ctx, { trigger: "list_unavailable_recovery" });
    return { rescreened: true, status: result.status };
  }

  // --- POST /demo/run (B5) — sandbox-only, structurally gated to demo/free plans ---

  // `params` defaults to DemoRunInput's own defaults (leads=3, campaigns=1) —
  // the exact original shape — so direct DO-RPC callers (test/demo-run.test.ts
  // calls `instance.demoRun()` with no argument) keep working unchanged.
  async demoRun(params: DemoRunInput = DemoRunInput.parse({})): Promise<DemoRunSummary> {
    if (this.plan !== "demo" && this.plan !== "free") {
      throw new TenantIsolationError(
        "demo run is a sandbox-only surface, unavailable for this tenant's plan — see ARCHITECTURE.md #8",
      );
    }
    this.enforceDemoRunThrottle();
    return runDemo(this.requireContext(), params);
  }

  // Per-tenant /demo/run throttle (adversarial panel-02): a single free token
  // could otherwise loop /demo/run forever, growing DO SQLite + burning DO
  // compute. Enforced on REAL wall time — the virtual clock advances ~weeks
  // per demo run, so it can't gate a real-rate limit. runDemo itself also
  // RESETs prior demo state so storage stays bounded regardless.
  private enforceDemoRunThrottle(): void {
    const nowReal = new RealClock().now();
    const state = this.ctx.storage.sql
      .exec<{ run_count: number; last_run_at: number }>(
        `SELECT run_count, last_run_at FROM demo_run_state WHERE id = 1`,
      )
      .toArray()[0] ?? { run_count: 0, last_run_at: 0 };

    if (state.run_count >= DEMO_RUN_LIFETIME_CAP) {
      throw new RateLimitError(
        `demo run lifetime cap reached (${DEMO_RUN_LIFETIME_CAP} runs) for this sandbox tenant — sign up a fresh demo tenant to keep exploring.`,
      );
    }
    if (nowReal - state.last_run_at < DEMO_RUN_MIN_INTERVAL_MS) {
      throw new RateLimitError("demo run rate limited — at most one /demo/run per minute per tenant.");
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO demo_run_state (id, run_count, last_run_at) VALUES (1, 1, ?)
       ON CONFLICT (id) DO UPDATE SET run_count = run_count + 1, last_run_at = excluded.last_run_at`,
      nowReal,
    );
  }

  // --- Sandbox/test-only clock control — never exposed as an HTTP facade intent ---

  advanceClock(virtualMs: number): number {
    if (this.plan !== "demo" && this.plan !== "free") {
      throw new Error("advanceClock is a sandbox-only control, unavailable for this tenant's plan");
    }
    if (!this.currentClock || !this.tenantId) throw new Error("tenant not initialized");
    // Structural belt behind the plan gate above: a tenant on the real clock
    // has no virtual offset to advance, and this throws rather than silently
    // doing nothing if the two guards ever disagree (clock.ts).
    const newOffset = requireVirtualClock(this.currentClock).advanceVirtual(virtualMs);
    this.ctx.storage.sql.exec(`UPDATE tenant_profile SET clock_offset = ? WHERE id = ?`, newOffset, this.tenantId);
    return newOffset;
  }
}
