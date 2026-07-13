// The 15 MCP tools (AGENTS.md tool list — names match exactly; tools 13-15
// added by SPEC.md §19.5). Each tool dispatches to the SAME TenantDO method
// the equivalent HTTP route calls (src/routes/*.ts) — the MCP surface is a
// second transport onto the exact same facade, never a parallel
// implementation (CLAUDE.md rule c).

import type { ZodType } from "zod";
import { InboxQueryInput } from "@coldstart/shared";
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
    "Buy branded lookalike domains, provision mailboxes, and start the warmup ramp. Returns immediately (async job); poll infrastructure_status for progress. Pass a stable idempotencyKey and resend it on retry so a dropped response can't re-provision duplicate infrastructure.",
    SetupInfrastructureToolInput,
    (stub, { idempotencyKey, ...args }) => stub.setupInfrastructure(args, idempotencyKey),
  ),
  tool(
    "infrastructure_status",
    "Provisioning + warmup progress, per-mailbox health (warmup + deliverability: throttle/pause state, complaint/bounce rates, vendor reputation/placement), and send-readiness.",
    EmptyInput,
    (stub) => stub.infrastructureStatus(),
  ),
  tool(
    "launch_campaign",
    "Create and activate a campaign against a lead list. The caller supplies the offer and sequence step content — this platform does not generate outreach copy. Pass a stable idempotencyKey and resend it on retry so a dropped response can't create a duplicate campaign.",
    LaunchCampaignToolInput,
    (stub, { idempotencyKey, ...args }) => stub.launchCampaign(args, idempotencyKey),
  ),
  tool(
    "campaign_results",
    "Sends, replies, bounces, and complaints for one campaign.",
    CampaignIdInput,
    (stub, args) => stub.campaignResults(args.campaignId),
  ),
  tool("metrics", "Account-wide deliverability + warmup health.", EmptyInput, (stub) => stub.metrics()),
  tool(
    "inbox",
    "Unified reply inbox across all mailboxes for the tenant. Cursor-paginated (limit default 50); optional filters: mailbox, campaign, label, read, includeNonreply (bounces/OOO, default true), archived ('exclude' default | 'include' | 'only').",
    InboxQueryInput,
    (stub, args) => stub.inbox(args),
  ),
  tool("thread", "Full message history for one thread.", ThreadIdInput, (stub, args) => stub.thread(args.threadId)),
  tool(
    "reply",
    "Send a reply on an existing thread. Pass a stable idempotencyKey and resend it on retry so a dropped response can't dispatch a duplicate email.",
    ThreadReplyInput,
    (stub, args) => stub.reply(args.threadId, args.body, args.idempotencyKey),
  ),
  tool("mark", "Mark a thread read, unread, or archived.", ThreadMarkInput, async (stub, args) => {
    await stub.mark(args.threadId, args.status);
    return { marked: true };
  }),
  tool("pause", "Pause one campaign.", CampaignIdInput, async (stub, args) => {
    await stub.pause(args.campaignId);
    return { paused: true };
  }),
  tool("pause_all", "Pause every campaign for the tenant.", EmptyInput, async (stub) => {
    await stub.pauseAll();
    return { pausedAll: true };
  }),
  tool(
    "account",
    "Usage, billing state, quota, and what the AI deliverability control loop has done (paused/throttled mailboxes, burning domains, auto-replacements, recent actions).",
    EmptyInput,
    (stub) => stub.account(),
  ),
  // --- SPEC.md §19.5 (M1 dashboard+inbox) — tools 13-15. Parity law (§19.0):
  // the agent can read/write every bit of dashboard state a human can. ---
  tool(
    "get_dashboard",
    "List every saved dashboard view (id, name, isDefault, rev, editedBy) or, with `id`, fetch one view's full layout + rev.",
    GetDashboardInput,
    (stub, args) => (args.id ? stub.dashboardView(args.id) : stub.dashboardViews()),
  ),
  tool(
    "configure_dashboard",
    "Create, update, promote-to-default, or delete a dashboard saved view. `update` requires the `rev` you last read; a stale rev returns a structured conflict (currentRev + currentLayout) so you can rebase and retry. `update` also accepts an optional `name` to rename the view (same rev-CAS semantics; omit to leave the name unchanged). Pass an optional `note` to record why you made the change.",
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
    "Set (or, with label: null, clear) a triage label on an inbox thread — the same labels the dashboard UI shows as chips.",
    LabelThreadInput,
    (stub, args) => stub.labelThread(args.threadId, args.label, "mcp"),
  ),
];
