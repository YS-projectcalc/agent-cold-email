// The 24 MCP tools (tools 13-15 added by SPEC.md §19.5, tools 16-17 by the
// §19.0 parity-gap follow-up, tools 18-19 by the ROADMAP.md WIN-THE-COMPARISON
// (d) webhooks lane, tools 20-21 by SPEC.md §20's BYO domain intake, tools
// 22-24 by SPEC.md §22's warm-lead thin layer (increments #1-#3, founder-gated
// 2026-07-21) — AGENTS.md's public tool table is a canonical doc folded by the
// orchestrator, not updated here).
// Each tool dispatches to the SAME TenantDO method the equivalent HTTP route
// calls (src/routes/*.ts) — the MCP surface is a second transport onto the
// exact same facade, never a parallel implementation (CLAUDE.md rule c).

import type { ZodType } from "zod";
import { ActivityQueryInput, InboxQueryInput, ListLeadsQueryInput, SuppressLeadInput, UpdateLeadInput } from "@coldstart/shared";
import type { TenantDO } from "../tenant-do.js";
import {
  CampaignIdInput,
  ConfigureByoDomainInput,
  ConfigureDashboardInput,
  ConfigureWebhookInput,
  EmptyInput,
  GetByoDomainsInput,
  GetDashboardInput,
  GetWebhooksInput,
  LabelThreadInput,
  LaunchCampaignToolInput,
  SetupInfrastructureToolInput,
  ThreadIdInput,
  ThreadMarkInput,
  ThreadReplyInput,
} from "./schemas.js";

// MCP-spec tool annotations (ToolAnnotationsSchema — @modelcontextprotocol/sdk
// spec.types.d.ts): hints only, but required by the Anthropic Connectors
// Directory review ("all tools must include a title and the applicable
// readOnlyHint or destructiveHint"). `title` is mandatory here (every tool
// needs one); `readOnlyHint`/`destructiveHint` are set explicitly per tool
// below rather than left to the spec's default (destructiveHint defaults to
// `true` when omitted) so an additive-but-mutating tool doesn't read as
// destructive by omission.
export interface McpToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface McpTool<T = unknown> {
  name: string;
  description: string;
  schema: ZodType<T>;
  annotations: McpToolAnnotations;
  call: (stub: DurableObjectStub<TenantDO>, args: T) => unknown;
}

function tool<T>(
  name: string,
  description: string,
  schema: ZodType<T>,
  annotations: McpToolAnnotations,
  call: (stub: DurableObjectStub<TenantDO>, args: T) => unknown,
): McpTool<T> {
  return { name, description, schema, annotations, call };
}

export const MCP_TOOLS: McpTool<any>[] = [
  tool(
    "setup_infrastructure",
    "Provision sending infrastructure: buy branded lookalike domains, create mailboxes, start warmup. Inputs: brand, primaryDomain, domains + inboxesEach counts, persona, physicalAddress, senderIdentity. Async — returns { jobId }; poll infrastructure_status for progress. Resend the same idempotencyKey on retry to avoid double-provisioning.",
    SetupInfrastructureToolInput,
    // Domains/mailboxes/ledger are additive (insert-only, never deleted).
    // tenant_profile's brand/primaryDomain/physicalAddress/senderIdentity ARE
    // overwritten with the given input on every call (provisioning.ts
    // runSetupInfrastructure) — no operational resource is ever destroyed,
    // which is what destructiveHint:false claims.
    { title: "Set Up Sending Infrastructure", destructiveHint: false },
    (stub, { idempotencyKey, ...args }) => stub.setupInfrastructure(args, idempotencyKey),
  ),
  tool(
    "infrastructure_status",
    "Warmup + provisioning progress per mailbox. Returns { domains, mailboxes, sendReady, mailboxHealth[] }; each mailbox: warmupDay, dailyCap, sentToday, sendReady, delivStatus (healthy/throttled/paused), complaint/bounce/softBounce rates (first-party measured), vendorReputationScore + vendorPlacementRate (VENDOR-REPORTED approximations, not first-party measurements — the control loop uses local signals only), lastPolledAt. Use account/metrics for account-wide rollups.",
    EmptyInput,
    { title: "Infrastructure Status", readOnlyHint: true },
    (stub) => stub.infrastructureStatus(),
  ),
  tool(
    "launch_campaign",
    "Create and activate a campaign on a lead list. You supply name, offer, leads[], sequence[] (per step: subject, body, delayDays), sendWindow, timezone, stopOnReply — the platform does not write copy. Steps schedule up front; suppressed leads are skipped. Returns { campaignId }. Resend the same idempotencyKey on retry to avoid a duplicate.",
    LaunchCampaignToolInput,
    // Schedules real outbound sends against the lead list — irreversible
    // once a step fires.
    { title: "Launch Campaign", destructiveHint: true },
    (stub, { idempotencyKey, ...args }) => stub.launchCampaign(args, idempotencyKey),
  ),
  tool(
    "campaign_results",
    "Outcome counts for ONE campaign. Input: campaignId (from launch_campaign). Returns { campaignId, sent, reply, bounce, complaint, unsubscribe, failed, soft_bounce } — bounce = HARD only, soft_bounce separate, opens not tracked. 404 if unknown. Use metrics for account-wide totals, list_campaigns for every campaign at once.",
    CampaignIdInput,
    { title: "Campaign Results", readOnlyHint: true },
    (stub, args) => stub.campaignResults(args.campaignId),
  ),
  tool(
    "metrics",
    "Account-wide outcome totals across ALL campaigns: { sent, reply, bounce, complaint, unsubscribe, failed, soft_bounce } — same shape as campaign_results but summed tenant-wide (bounce = hard only, opens not tracked). Use campaign_results for one campaign, list_campaigns per-campaign, or account for billing/quota.",
    EmptyInput,
    { title: "Account Metrics", readOnlyHint: true },
    (stub) => stub.metrics(),
  ),
  tool(
    "inbox",
    "Unified reply inbox across mailboxes. Cursor-paginated → { threads[], nextCursor }; each row: threadId, campaignName, leadEmail, subject, mailboxEmail, label, lastEventType, markStatus. Filters: mailbox, campaign, label, read, includeNonreply (bounces/OOO, default true), archived (exclude|include|only). Use thread for one thread's history.",
    InboxQueryInput,
    { title: "Inbox", readOnlyHint: true },
    (stub, args) => stub.inbox(args),
  ),
  tool(
    "thread",
    "Full message history for ONE thread. Input: threadId (from inbox). Returns { threadId, campaignId, leadId, leadEmail, mailboxEmail (null before first send), messages[] }, each message { type (sent/reply/bounce/...), ts, messageId, metadata }, oldest first. 404 if unknown. Use inbox to LIST threads; reply to respond; mark/label_thread to triage.",
    ThreadIdInput,
    { title: "Thread History", readOnlyHint: true },
    (stub, args) => stub.thread(args.threadId),
  ),
  tool(
    "reply",
    "Send a reply on an existing thread, from the mailbox that sent it. Inputs: threadId, body. Returns { messageId }. Idempotent: identical retries collapse to one send — pass a stable idempotencyKey (else a body hash is used) so a dropped-response retry can't double-send. 404 if no sending mailbox is on record for the thread.",
    ThreadReplyInput,
    // A real outbound send — irreversible once sent.
    { title: "Reply to Thread", destructiveHint: true },
    (stub, args) => stub.reply(args.threadId, args.body, args.idempotencyKey),
  ),
  tool(
    "mark",
    "Set a thread's READ-STATE for inbox triage. Inputs: threadId, status = 'read' | 'unread' | 'archived' (archived hides it from the default inbox; refetch with inbox archived='include'/'only'). Returns { marked: true }. 404 if unknown. This is the read/archive flag ONLY — use label_thread for a triage label chip, reply to respond.",
    ThreadMarkInput,
    // Freely reversible flag (read/unread/archived all toggle back).
    { title: "Mark Thread", destructiveHint: false },
    async (stub, args) => {
      await stub.mark(args.threadId, args.status);
      return { marked: true };
    },
  ),
  tool(
    "pause",
    "Pause ONE campaign: its status → 'paused', so the tick schedules no further steps (already-sent mail is unaffected; there is no resume tool). Input: campaignId. Returns { paused: true }. 404 if not found. Use pause_all to pause every active campaign at once.",
    CampaignIdInput,
    // No resume tool exists — this is unrecoverable via the API.
    { title: "Pause Campaign", destructiveHint: true },
    async (stub, args) => {
      await stub.pause(args.campaignId);
      return { paused: true };
    },
  ),
  tool(
    "pause_all",
    "Pause EVERY active campaign for the tenant at once (each active status → 'paused'; the tick then schedules no further sends). No inputs. Returns { pausedAll: true }. Use pause to pause a single campaign by id.",
    EmptyInput,
    // Same irreversibility as pause, applied tenant-wide.
    { title: "Pause All Campaigns", destructiveHint: true },
    async (stub) => {
      await stub.pauseAll();
      return { pausedAll: true };
    },
  ),
  tool(
    "account",
    "Account overview: brand, plan, status, billingState, activationState, resource counts, usageCents, quota, deliverability (loop state: paused/throttled mailboxes, burning domains, auto-replacements, recentActions[]), and teardown (reclaim summary once canceled, else null). activationState is the HONEST send state — trust it over 'sent' counts: 'active' = real sending live; 'pending_provisioning' = paid but infrastructure still being armed, sends shown are sandbox previews that DON'T leave; 'capacity_pending' = provisioning held at a spend/plan-slot limit; 'screening_hold' = account under review; 'sandbox' = demo/free. Use metrics for counts, infrastructure_status for per-mailbox health.",
    EmptyInput,
    { title: "Account Overview", readOnlyHint: true },
    (stub) => stub.account(),
  ),
  // --- SPEC.md §19.5 (M1 dashboard+inbox) — tools 13-15. Parity law (§19.0):
  // the agent can read/write every bit of dashboard state a human can. ---
  tool(
    "get_dashboard",
    "Read saved dashboard views. No id → list all: [{ id, name, isDefault, rev, editedBy }]. With id → that view's full layout + rev (pass this rev as the CAS base to configure_dashboard update). Views are both agent- and human-editable; write them with configure_dashboard.",
    GetDashboardInput,
    { title: "Get Dashboard View", readOnlyHint: true },
    (stub, args) => (args.id ? stub.dashboardView(args.id) : stub.dashboardViews()),
  ),
  tool(
    "configure_dashboard",
    "Write a saved dashboard view. action = create (needs name+layout) | update (needs id+rev+layout; optional name renames) | promote (id → default) | delete (id). update is rev-CAS: a stale rev returns { currentRev, currentLayout } to rebase and retry. Optional note. Read the current rev+layout via get_dashboard first.",
    ConfigureDashboardInput,
    // action=delete permanently removes a saved view — the tool as a whole
    // is honestly flagged for its worst-case action.
    { title: "Configure Dashboard View", destructiveHint: true },
    (stub, args) => {
      // The schema's `.refine()` (schemas.ts) already guarantees these fields
      // are present for the matched action — it just can't narrow the TS type
      // per-branch the way z.discriminatedUnion would (see schemas.ts's doc
      // for why this isn't a discriminatedUnion).
      switch (args.action) {
        case "create":
          return stub.createDashboardView({ name: args.name!, layout: args.layout!, note: args.note }, "mcp");
        case "update":
          return stub.updateDashboardView(args.id!, { rev: args.rev!, layout: args.layout!, name: args.name, note: args.note }, "mcp");
        case "promote":
          return stub.promoteDashboardViewDefault(args.id!, "mcp");
        case "delete":
          return stub.deleteDashboardView(args.id!);
      }
    },
  ),
  tool(
    "label_thread",
    "Set or clear a triage LABEL on an inbox thread — the same chip the dashboard shows. Inputs: threadId, label (string; pass label:null to clear). Distinct from mark (read/unread/archived state): a label is a free-form category, not a read flag. Filterable via inbox's label param.",
    LabelThreadInput,
    // Freely reversible (a label can always be reset or cleared).
    { title: "Label Thread", destructiveHint: false },
    (stub, args) => stub.labelThread(args.threadId, args.label, "mcp"),
  ),
  // --- Parity gap follow-up (SPEC.md §19.0) — tools 16-17. GET /campaigns and
  // GET /activity (§19.4) were dashboard-only until now; thin wrappers over
  // the same TenantDO methods the HTTP routes call. ---
  tool(
    "list_campaigns",
    "List every campaign at once: [{ campaignId, name, status, counts{sent,reply,bounce,complaint,unsubscribe,failed,soft_bounce} }], newest first — no per-campaign lookup needed. Use campaign_results for one campaign's counts, metrics for account-wide totals.",
    EmptyInput,
    { title: "List Campaigns", readOnlyHint: true },
    (stub) => stub.campaigns(),
  ),
  tool(
    "activity",
    "Unified activity feed: campaign events (sent/reply/bounce/...) merged with deliverability loop actions (pause/throttle/replace-domain). Cursor-paginated → { items[], nextCursor }; each item { id, kind:'event'|'deliverability', label, ts, target, detail }. Filters: kind, limit (default 50, max 200). Use inbox for replies only.",
    ActivityQueryInput,
    { title: "Activity Feed", readOnlyHint: true },
    (stub, args) => stub.activity(args),
  ),
  // --- Outbound webhooks (ROADMAP.md WIN-THE-COMPARISON (d)) — tools 18-19.
  // Push reply/bounce/complaint events to your own HTTPS endpoint instead of
  // polling activity(). Mirrors get_dashboard/configure_dashboard. ---
  tool(
    "get_webhooks",
    "List your outbound webhook subscriptions, or (with id) one subscription plus its recent delivery + attempt log. No id → [{ id, url, eventTypes, active, status, disabledReason, consecutiveFailures }]. With id → { subscription, recentDeliveries[], recentAttempts[] }. Secrets are never returned on reads — they are shown once at create/rotate.",
    GetWebhooksInput,
    { title: "Get Webhooks", readOnlyHint: true },
    (stub, args) => (args.id ? stub.webhook(args.id) : stub.webhooks()),
  ),
  tool(
    "configure_webhook",
    "Manage an outbound webhook subscription. action = create (needs url + eventTypes: reply|bounce|soft_bounce|complaint; optional secret/active) | update (needs id + one changed field; active:true re-enables an auto-disabled one, active:false pauses; secret rotates) | delete (needs id). create/rotate return the HMAC signing secret ONCE. URLs must be https to a public host (private/metadata IPs rejected). Deliveries are signed X-Coldrig-Signature: sha256=HMAC-SHA256(secret, raw body).",
    ConfigureWebhookInput,
    // action=delete permanently removes a subscription — the tool is honestly
    // flagged for its worst-case action (mirrors configure_dashboard).
    { title: "Configure Webhook", destructiveHint: true },
    (stub, args) => {
      switch (args.action) {
        case "create":
          return stub.createWebhook({ url: args.url!, eventTypes: args.eventTypes!, secret: args.secret, active: args.active ?? true });
        case "update":
          return stub.updateWebhook(args.id!, { url: args.url, eventTypes: args.eventTypes, secret: args.secret, active: args.active });
        case "delete":
          return stub.deleteWebhook(args.id!);
      }
    },
  ),
  // --- SPEC.md §20 — BYO domains & mailboxes. Tools 20-21, mirroring
  // get_dashboard/configure_dashboard + get_webhooks/configure_webhook exactly. ---
  tool(
    "get_byo_domains",
    "List your BYO (bring-your-own) domains, or (with id) one domain's full intake detail. No id → [{ domainId, domain, isPrimary, dnsMode, byoStatus, breakerTier, reputationBranch, mailboxCount }]. With id → adds the pre-flight scan result, abuse-gate verdict, and consent-acknowledgment status. byoStatus progresses pending_kyc|pending_consent|pending_dns → active (or rejected/abandoned). Use configure_byo_domain to register a new one or advance it.",
    GetByoDomainsInput,
    { title: "Get BYO Domains", readOnlyHint: true },
    (stub, args) => (args.id ? stub.byoDomain(args.id) : stub.byoDomains()),
  ),
  tool(
    "configure_byo_domain",
    "Register or advance a BYO domain/mailbox intake (SPEC.md §20). action = register (needs domain + domainRelationship: fresh_standalone|subdomain_of_primary|is_primary — runs the pre-flight live-infra scan + abuse gate + reputation ladder, returns the starting byoStatus) | poll_dns (needs id — re-checks DNS delegation/records, advances pending_dns → active, or → abandoned after 7 idle days) | acknowledge_consent (needs id + acknowledged:true — REQUIRED before a primary domain can proceed past pending_consent; this does not remove your business's exposure, it documents informed consent) | request_managed_mailboxes (needs id + count — platform-provisioned mailboxes on an ALREADY-ACTIVE domain, the primary shape) | connect_mailbox (needs id + email + transport — declares an EXISTING OAuth/SMTP+IMAP connection you already have, bypassing provisioning; transport is { kind:'smtp', host, port, secure, user, pass } | { kind:'gmail_api', clientId, clientSecret, refreshToken } | { kind:'ms_graph', mode, tenantId, clientId, clientSecret, refreshToken? }).",
    ConfigureByoDomainInput,
    // request_managed_mailboxes provisions real (sandbox-mode) infra + accrues
    // metering on paid tiers; connect_mailbox stores a connection secret.
    // Neither destroys an existing resource, but both have real side effects
    // — flagged honestly rather than claiming destructiveHint:false.
    { title: "Configure BYO Domain", destructiveHint: true },
    (stub, args) => {
      switch (args.action) {
        case "register":
          return stub.registerByoDomain({ domain: args.domain!, domainRelationship: args.domainRelationship! });
        case "poll_dns":
          return stub.pollByoDomainDns(args.id!);
        case "acknowledge_consent":
          return stub.acknowledgeByoConsent(args.id!, { acknowledged: true });
        case "request_managed_mailboxes":
          return stub.requestManagedByoMailboxes(args.id!, { count: args.count!, personaSlug: args.personaSlug });
        case "connect_mailbox":
          return stub.connectByoMailbox(args.id!, { email: args.email!, transport: args.transport! });
      }
    },
  ),
  // --- SPEC.md §22 — warm-lead thin layer (increments #1-#3, ratified +
  // founder-gated 2026-07-21). Tools 22-24: suppress_lead / update_lead /
  // list_leads. schedule_followup (SPEC.md §22's tool 23 in the frozen dive's
  // own numbering) is OUT OF SCOPE for this build — see docs/adversarial/
  // warm-lead-thin-layer-design-2026-07-16.md R1/R2 (a new guarded
  // single-send primitive is a build-gated increment #4). ---
  tool(
    "suppress_lead",
    "Permanently suppress an email address tenant-wide (every current and future campaign) — the manual/free-text 'stop emailing me' path for opt-outs the strict typed-unsubscribe matcher misses. Inputs: email, reason (fixed 'manual' — the only value this tool honestly claims; bounce/complaint/unsubscribe are recorded automatically elsewhere), note (accepted, not persisted). Cancels every pending send + marks every campaign-lead row 'suppressed'. Last-write-wins: re-suppressing a bounce/complaint/unsubscribe row relabels its reason to 'manual'. There is no un-suppress tool.",
    SuppressLeadInput,
    // Cancels pending sends + permanently reclassifies every lead row sharing
    // this email — irreversible via this API (no un-suppress tool exists).
    { title: "Suppress Lead", destructiveHint: true },
    (stub, args) => stub.suppressLead(args),
  ),
  tool(
    "update_lead",
    "Record what you learned about a contact (their reply, your triage) as a durable, contact-level disposition — keyed by email, visible across every campaign that lists them. Inputs: email, interestStatus (none|interested|meeting_booked|not_now|not_interested|bad_fit|out_of_office|wrong_person — a server-enforced enum; 'do not contact' is NOT a member, use suppress_lead instead), notes, tags (free-form). A PARTIAL patch — only the fields you pass are changed; at least one of interestStatus/notes/tags is required. Filterable via list_leads.",
    UpdateLeadInput,
    // Upserts a disposition row — never deletes/destroys anything; a later
    // call always overwrites only the fields it names, freely revisable.
    { title: "Update Lead Disposition", destructiveHint: false },
    (stub, args) => stub.updateLead(args, "mcp"),
  ),
  tool(
    "list_leads",
    "List/export leads with their contact-level disposition, cursor-paginated. Returns { leads[], nextCursor }; each row: leadId, email, firstName, company, campaignId, campaignName, globalStatus, interestStatus, notes, tags, suppressed, lastEventType, lastEventTs, createdAt. Filters: campaign, interestStatus, suppressed, replied. This IS the export surface — paginate to dump the full book of business as JSON (no separate CSV endpoint). Use update_lead to write disposition, suppress_lead to opt an address out.",
    ListLeadsQueryInput,
    { title: "List Leads", readOnlyHint: true },
    (stub, args) => stub.listLeads(args),
  ),
];
