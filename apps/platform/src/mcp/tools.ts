// The 17 MCP tools (AGENTS.md tool list — names match exactly; tools 13-15
// added by SPEC.md §19.5, tools 16-17 by the §19.0 parity-gap follow-up).
// Each tool dispatches to the SAME TenantDO method the equivalent HTTP route
// calls (src/routes/*.ts) — the MCP surface is a second transport onto the
// exact same facade, never a parallel implementation (CLAUDE.md rule c).

import type { ZodType } from "zod";
import { ActivityQueryInput, InboxQueryInput } from "@coldstart/shared";
import type { TenantDO } from "../tenant-do.js";
import {
  CampaignIdInput,
  ConfigureDashboardInput,
  EmptyInput,
  GetDashboardInput,
  LabelThreadInput,
  LaunchCampaignToolInput,
  SetupInfrastructureToolInput,
  ThreadIdInput,
  ThreadMarkInput,
  ThreadReplyInput,
} from "./schemas.js";

export interface McpTool<T = unknown> {
  name: string;
  description: string;
  schema: ZodType<T>;
  call: (stub: DurableObjectStub<TenantDO>, args: T) => unknown;
}

function tool<T>(
  name: string,
  description: string,
  schema: ZodType<T>,
  call: (stub: DurableObjectStub<TenantDO>, args: T) => unknown,
): McpTool<T> {
  return { name, description, schema, call };
}

export const MCP_TOOLS: McpTool<any>[] = [
  tool(
    "setup_infrastructure",
    "Provision sending infrastructure: buy branded lookalike domains, create mailboxes, start warmup. Inputs: brand, primaryDomain, domains + inboxesEach counts, persona, physicalAddress, senderIdentity. Async — returns { jobId }; poll infrastructure_status for progress. Resend the same idempotencyKey on retry to avoid double-provisioning.",
    SetupInfrastructureToolInput,
    (stub, { idempotencyKey, ...args }) => stub.setupInfrastructure(args, idempotencyKey),
  ),
  tool(
    "infrastructure_status",
    "Warmup + provisioning progress per mailbox. Returns { domains, mailboxes, sendReady, mailboxHealth[] }; each mailbox: warmupDay, dailyCap, sentToday, sendReady, delivStatus (healthy/throttled/paused), complaint/bounce/softBounce rates, reputationScore + placementRate, lastPolledAt. Use account/metrics for account-wide rollups.",
    EmptyInput,
    (stub) => stub.infrastructureStatus(),
  ),
  tool(
    "launch_campaign",
    "Create and activate a campaign on a lead list. You supply name, offer, leads[], sequence[] (per step: subject, body, delayDays), sendWindow, timezone, stopOnReply — the platform does not write copy. Steps schedule up front; suppressed leads are skipped. Returns { campaignId }. Resend the same idempotencyKey on retry to avoid a duplicate.",
    LaunchCampaignToolInput,
    (stub, { idempotencyKey, ...args }) => stub.launchCampaign(args, idempotencyKey),
  ),
  tool(
    "campaign_results",
    "Outcome counts for ONE campaign. Input: campaignId (from launch_campaign). Returns { campaignId, sent, reply, bounce, complaint, unsubscribe, failed, soft_bounce } — bounce = HARD only, soft_bounce separate, opens not tracked. 404 if unknown. Use metrics for account-wide totals, list_campaigns for every campaign at once.",
    CampaignIdInput,
    (stub, args) => stub.campaignResults(args.campaignId),
  ),
  tool(
    "metrics",
    "Account-wide outcome totals across ALL campaigns: { sent, reply, bounce, complaint, unsubscribe, failed, soft_bounce } — same shape as campaign_results but summed tenant-wide (bounce = hard only, opens not tracked). Use campaign_results for one campaign, list_campaigns per-campaign, or account for billing/quota.",
    EmptyInput,
    (stub) => stub.metrics(),
  ),
  tool(
    "inbox",
    "Unified reply inbox across mailboxes. Cursor-paginated → { threads[], nextCursor }; each row: threadId, campaignName, leadEmail, subject, mailboxEmail, label, lastEventType, markStatus. Filters: mailbox, campaign, label, read, includeNonreply (bounces/OOO, default true), archived (exclude|include|only). Use thread for one thread's history.",
    InboxQueryInput,
    (stub, args) => stub.inbox(args),
  ),
  tool(
    "thread",
    "Full message history for ONE thread. Input: threadId (from inbox). Returns { threadId, campaignId, leadId, leadEmail, mailboxEmail (null before first send), messages[] }, each message { type (sent/reply/bounce/...), ts, messageId, metadata }, oldest first. 404 if unknown. Use inbox to LIST threads; reply to respond; mark/label_thread to triage.",
    ThreadIdInput,
    (stub, args) => stub.thread(args.threadId),
  ),
  tool(
    "reply",
    "Send a reply on an existing thread, from the mailbox that sent it. Inputs: threadId, body. Returns { messageId }. Idempotent: identical retries collapse to one send — pass a stable idempotencyKey (else a body hash is used) so a dropped-response retry can't double-send. 404 if no sending mailbox is on record for the thread.",
    ThreadReplyInput,
    (stub, args) => stub.reply(args.threadId, args.body, args.idempotencyKey),
  ),
  tool(
    "mark",
    "Set a thread's READ-STATE for inbox triage. Inputs: threadId, status = 'read' | 'unread' | 'archived' (archived hides it from the default inbox; refetch with inbox archived='include'/'only'). Returns { marked: true }. 404 if unknown. This is the read/archive flag ONLY — use label_thread for a triage label chip, reply to respond.",
    ThreadMarkInput,
    async (stub, args) => {
      await stub.mark(args.threadId, args.status);
      return { marked: true };
    },
  ),
  tool(
    "pause",
    "Pause ONE campaign: its status → 'paused', so the tick schedules no further steps (already-sent mail is unaffected; there is no resume tool). Input: campaignId. Returns { paused: true }. 404 if not found. Use pause_all to pause every active campaign at once.",
    CampaignIdInput,
    async (stub, args) => {
      await stub.pause(args.campaignId);
      return { paused: true };
    },
  ),
  tool(
    "pause_all",
    "Pause EVERY active campaign for the tenant at once (each active status → 'paused'; the tick then schedules no further sends). No inputs. Returns { pausedAll: true }. Use pause to pause a single campaign by id.",
    EmptyInput,
    async (stub) => {
      await stub.pauseAll();
      return { pausedAll: true };
    },
  ),
  tool(
    "account",
    "Account overview: brand, plan, status, billingState, resource counts, usageCents, quota, deliverability (loop state: paused/throttled mailboxes, burning domains, auto-replacements, recentActions[]), and teardown (reclaim summary once canceled, else null). Use metrics for counts, infrastructure_status for per-mailbox health.",
    EmptyInput,
    (stub) => stub.account(),
  ),
  // --- SPEC.md §19.5 (M1 dashboard+inbox) — tools 13-15. Parity law (§19.0):
  // the agent can read/write every bit of dashboard state a human can. ---
  tool(
    "get_dashboard",
    "Read saved dashboard views. No id → list all: [{ id, name, isDefault, rev, editedBy }]. With id → that view's full layout + rev (pass this rev as the CAS base to configure_dashboard update). Views are both agent- and human-editable; write them with configure_dashboard.",
    GetDashboardInput,
    (stub, args) => (args.id ? stub.dashboardView(args.id) : stub.dashboardViews()),
  ),
  tool(
    "configure_dashboard",
    "Write a saved dashboard view. action = create (needs name+layout) | update (needs id+rev+layout; optional name renames) | promote (id → default) | delete (id). update is rev-CAS: a stale rev returns { currentRev, currentLayout } to rebase and retry. Optional note. Read the current rev+layout via get_dashboard first.",
    ConfigureDashboardInput,
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
    (stub, args) => stub.labelThread(args.threadId, args.label, "mcp"),
  ),
  // --- Parity gap follow-up (SPEC.md §19.0) — tools 16-17. GET /campaigns and
  // GET /activity (§19.4) were dashboard-only until now; thin wrappers over
  // the same TenantDO methods the HTTP routes call. ---
  tool(
    "list_campaigns",
    "List every campaign at once: [{ campaignId, name, status, counts{sent,reply,bounce,complaint,unsubscribe,failed,soft_bounce} }], newest first — no per-campaign lookup needed. Use campaign_results for one campaign's counts, metrics for account-wide totals.",
    EmptyInput,
    (stub) => stub.campaigns(),
  ),
  tool(
    "activity",
    "Unified activity feed: campaign events (sent/reply/bounce/...) merged with deliverability loop actions (pause/throttle/replace-domain). Cursor-paginated → { items[], nextCursor }; each item { id, kind:'event'|'deliverability', label, ts, target, detail }. Filters: kind, limit (default 50, max 200). Use inbox for replies only.",
    ActivityQueryInput,
    (stub, args) => stub.activity(args),
  ),
];
