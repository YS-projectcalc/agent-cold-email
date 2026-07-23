import { DurableObject } from "cloudflare:workers";
import type {
  AcknowledgeByoConsentInput,
  ActivityQueryInput,
  CheckoutInput,
  ConnectByoMailboxInput,
  DashboardLayout,
  InboxQueryInput,
  LaunchCampaignInput,
  ListLeadsQueryInput,
  Provenance,
  RegisterByoDomainInput,
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
import { RateLimitError, TenantIsolationError } from "@coldstart/shared";
import { RealClock, VirtualClock } from "./clock.js";
import type { StripeEventInput } from "./billing/stripe-webhook.js";
import type { Env } from "./env.js";
import {
  applyStripeWebhookEvent,
  completeSimulatedCheckout,
  startCheckout,
  type CheckoutResult,
  type CompleteCheckoutResult,
  type WebhookApplyResult,
} from "./engine/billing.js";
import { runDemo, type DemoRunSummary } from "./engine/demo.js";
import { cancelTenant, terminateTenant, type CancelResult, type TerminateResult } from "./engine/lifecycle.js";
import { getInfrastructureStatus, runSetupInfrastructure } from "./engine/provisioning.js";
import { launchCampaign, listCampaigns, pauseAllCampaigns, pauseCampaign, type CampaignListItem } from "./engine/campaigns.js";
import { runTick } from "./engine/tick.js";
import { withRequestIdempotency } from "./engine/idempotency.js";
import { reconcileMailboxCredentialPushes } from "./engine/mailbox-credential-push.js";
import { runDeliverabilitySweep } from "./engine/deliverability-actions.js";
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
  type ManagedMailboxesResult,
} from "./engine/byo-mailbox-composition.js";
import { newId, TENANT_DO_SCHEMA } from "./schema.js";
import type { TenantContext } from "./tenant-context.js";
import { readActivationState } from "./engine/activation.js";
import { clearScreeningStatus, LIST_UNAVAILABLE_VERSION, screenTenant } from "./ofac/screening.js";
import { createVendorAdapters, type VendorAdapterBundle } from "./vendors/factory.js";
import type { EngineClientConfig } from "./vendors/real/email-port.js";
import type { InboxKitClientConfig } from "./vendors/real/inboxkit-client.js";

export interface InitTenantInput {
  tenantId: string;
  brand: string;
  plan: TenantPlan;
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
  private clock: VirtualClock | null = null;
  // Only the SANDBOX bundle instance is cached for the DO's lifetime — several
  // sandbox ports hold in-memory state (SandboxEmailPort's send/poll queues,
  // SandboxDomainPort/SandboxMailboxPort's seen/released sets,
  // SandboxBillingPort's idempotency map) that must survive across calls
  // within one DO instance, or (e.g.) a poll() right after a send() would
  // never see what was just queued. The ACTIVATION DECISION itself is never
  // cached (design §2.2 option-1 / adversarial finding F3) — see
  // buildAdapters() below.
  private sandboxAdapters: VendorAdapterBundle | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(TENANT_DO_SCHEMA);
    this.ensureColumnMigrations();
    this.grandfatherActiveScreening();

    const row = this.ctx.storage.sql
      .exec<{ id: string; plan: TenantPlan; clock_base: number; clock_offset: number; clock_multiplier: number }>(
        `SELECT id, plan, clock_base, clock_offset, clock_multiplier FROM tenant_profile LIMIT 1`,
      )
      .toArray()[0];

    if (row) {
      this.tenantId = row.id;
      this.plan = row.plan;
      this.clock = new VirtualClock(row.clock_base, row.clock_offset, row.clock_multiplier);
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
    this.addColumnIfMissing("domains", "first_send_eligible_at", "INTEGER");
    this.addColumnIfMissing("mailboxes", "source", "TEXT NOT NULL DEFAULT 'provisioned'");
    this.addColumnIfMissing("mailboxes", "transport_kind", "TEXT NOT NULL DEFAULT 'smtp'");
    this.addColumnIfMissing("mailboxes", "transport_json", "TEXT");
    // GA gate G4 — real-plan-slot marker for precise teardown slot accounting (see schema.ts).
    this.addColumnIfMissing("mailboxes", "slot_counted", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("deliverability_actions", "alerted_at", "INTEGER");
    // G1 (ga-gates-design-2026-07-22.md §G1) — OFAC/SDN screening verdict
    // columns (see schema.ts's tenant_profile comment for the field contract).
    this.addColumnIfMissing("tenant_profile", "screening_status", "TEXT NOT NULL DEFAULT 'clear'");
    this.addColumnIfMissing("tenant_profile", "screening_list_version", "TEXT");
    this.addColumnIfMissing("tenant_profile", "screened_at", "INTEGER");
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

    this.tenantId = input.tenantId;
    this.plan = input.plan;
    this.clock = new VirtualClock(baseMs, 0, multiplier);

    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_profile (id, brand, plan, status, created_at, clock_base, clock_offset, clock_multiplier)
       VALUES (?, ?, ?, 'active', ?, ?, 0, ?)`,
      input.tenantId,
      input.brand,
      input.plan,
      baseMs,
      baseMs,
      multiplier,
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
    if (!this.tenantId || !this.clock) throw new Error("tenant not initialized");
    this.sandboxAdapters ??= createVendorAdapters(this.plan, this.clock, false, this.engineConfig());
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
    // regardless of InboxKit. Everything downstream (withSpendCeiling, G3) exists
    // to make this flip SPEND-SAFE.
    const real = createVendorAdapters(this.plan, this.clock, activated, this.engineConfig(), this.inboxKitConfig());
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
    if (!this.tenantId || !this.clock) throw new Error("tenant not initialized");
    return {
      sql: this.ctx.storage.sql,
      tenantId: this.tenantId,
      plan: this.plan,
      clock: this.clock,
      adapters: this.buildAdapters(),
      env: this.env,
    };
  }

  // --- The facade intents (bearer-token-authed, tenant-scoped) ---

  async setupInfrastructure(input: SetupInfrastructureInput, idempotencyKey?: string) {
    const ctx = this.requireContext();
    return withRequestIdempotency(
      ctx,
      idempotencyKey ? `setup_infrastructure:${idempotencyKey}` : undefined,
      () => runSetupInfrastructure(ctx, input),
    );
  }

  infrastructureStatus() {
    return getInfrastructureStatus(this.requireContext());
  }

  async launchCampaign(input: LaunchCampaignInput, idempotencyKey?: string) {
    const ctx = this.requireContext();
    return withRequestIdempotency(
      ctx,
      idempotencyKey ? `launch_campaign:${idempotencyKey}` : undefined,
      () => launchCampaign(ctx, input),
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

  async requestManagedByoMailboxes(id: string, input: RequestManagedByoMailboxesInput): Promise<ManagedMailboxesResult> {
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
      () => replyToThread(ctx, threadId, body, idempotencyKey),
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

  async completeCheckoutSimulated(sessionId: string): Promise<CompleteCheckoutResult> {
    const result = await completeSimulatedCheckout(this.requireContext(), sessionId);
    // Keep the in-memory plan in sync for the REST of this DO instance's
    // lifetime (quota checks + the demo/free-only sandbox guards below both
    // read `this.plan`, not a fresh SQL read, on every call).
    if (result.upgraded) this.plan = result.plan;
    return result;
  }

  async handleStripeWebhook(event: StripeEventInput): Promise<WebhookApplyResult> {
    const result = await applyStripeWebhookEvent(this.requireContext(), event);
    if (result.plan) this.plan = result.plan;
    return result;
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

  // --- D2/D6 admin surface RPCs (src/admin/README.md) — called ONLY from
  // src/routes/admin-*.ts (never a tenant facade route: these read/mutate
  // state an authed TENANT must never trigger for itself). Cross-tenant
  // aggregation reads the D1 tenants_index for the id list, then calls
  // opsSummary() on each tenant's own DO stub — never touches another
  // tenant's SqlStorage directly (ARCHITECTURE.md #3 + CLAUDE.md rule h). ---

  opsSummary(sinceMs: number): TenantOpsSummary {
    return getOpsSummary(this.requireContext(), sinceMs);
  }

  /** Cron-triggerable: runs just the monitor->decide->act loop (no send scheduling — that's tick()/B2). */
  async deliverabilitySweep() {
    const ctx = this.requireContext();
    const result = await runDeliverabilitySweep(ctx);
    // Self-serve I3 (F6) — retry any mailbox whose credential push to the engine
    // is still 'pending'. INERT unless armed (config-gated inside), so a no-op in
    // the default build and every test; a stuck push resolves on the next sweep.
    await reconcileMailboxCredentialPushes(ctx);
    return result;
  }

  /** D2 dunning sweep's "suspend after grace" action — a real local state transition (not a vendor call), armed now. */
  suspendForDunning(): void {
    suspendTenant(this.requireContext(), "dunning");
  }

  /** G1b admin resolution — POST /admin/tenants/:id/screening {decision:'clear'} (routes/admin-screening.ts). */
  clearScreening(): void {
    clearScreeningStatus(this.requireContext());
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
    if (!this.clock || !this.tenantId) throw new Error("tenant not initialized");
    const newOffset = this.clock.advanceVirtual(virtualMs);
    this.ctx.storage.sql.exec(`UPDATE tenant_profile SET clock_offset = ? WHERE id = ?`, newOffset, this.tenantId);
    return newOffset;
  }
}
