// The 12 MCP tools (AGENTS.md tool list — names match exactly). Each tool
// dispatches to the SAME TenantDO method the equivalent HTTP route calls
// (src/routes/*.ts) — the MCP surface is a second transport onto the exact
// same facade, never a parallel implementation (CLAUDE.md rule c).

import type { ZodType } from "zod";
import { LaunchCampaignInput, SetupInfrastructureInput } from "@coldstart/shared";
import type { TenantDO } from "../tenant-do.js";
import { CampaignIdInput, EmptyInput, ThreadIdInput, ThreadMarkInput, ThreadReplyInput } from "./schemas.js";

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
    "Buy branded lookalike domains, provision mailboxes, and start the warmup ramp. Returns immediately (async job); poll infrastructure_status for progress.",
    SetupInfrastructureInput,
    (stub, args) => stub.setupInfrastructure(args),
  ),
  tool(
    "infrastructure_status",
    "Provisioning + warmup progress, per-mailbox health (warmup + deliverability: throttle/pause state, complaint/bounce rates, vendor reputation/placement), and send-readiness.",
    EmptyInput,
    (stub) => stub.infrastructureStatus(),
  ),
  tool(
    "launch_campaign",
    "Create and activate a campaign against a lead list. The caller supplies the offer and sequence step content — this platform does not generate outreach copy.",
    LaunchCampaignInput,
    (stub, args) => stub.launchCampaign(args),
  ),
  tool(
    "campaign_results",
    "Sends, replies, bounces, and complaints for one campaign.",
    CampaignIdInput,
    (stub, args) => stub.campaignResults(args.campaignId),
  ),
  tool("metrics", "Account-wide deliverability + warmup health.", EmptyInput, (stub) => stub.metrics()),
  tool("inbox", "Unified reply inbox across all mailboxes for the tenant.", EmptyInput, (stub) => stub.inbox()),
  tool("thread", "Full message history for one thread.", ThreadIdInput, (stub, args) => stub.thread(args.threadId)),
  tool("reply", "Send a reply on an existing thread.", ThreadReplyInput, (stub, args) =>
    stub.reply(args.threadId, args.body),
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
];
