#!/usr/bin/env node
import { ApiError } from "./client.js";
import { parseArgs } from "./flags.js";
import { runAccount } from "./commands/account.js";
import { runCampaign } from "./commands/campaign.js";
import { runDemo } from "./commands/demo.js";
import { runSetup, runStatus } from "./commands/infra.js";
import { runInbox } from "./commands/inbox.js";
import { runMcp } from "./commands/mcp.js";
import { runMetrics } from "./commands/metrics.js";
import { runPause } from "./commands/pause.js";
import { runSignup } from "./commands/signup.js";

const HELP = `agent-cold-email — CLI for the agent-cold-email cold-email infrastructure API

Usage:
  agent-cold-email <command> [options]

Commands:
  demo                          Run the full sandbox pipeline, no signup required.
  signup                        Create a tenant and mint a bearer token.
  setup                         Provision domains/mailboxes + start warmup.
  status                        Infrastructure/warmup status.
  campaign launch --file <f>    Launch a campaign from a JSON body file.
  campaign results <id>         Campaign results.
  inbox                         List inbox threads.
  inbox thread <id>             Full thread detail.
  inbox reply <id> <body>       Reply on a thread.
  inbox mark <id> <status>      Mark a thread read | unread | archived.
  metrics                       Account-wide metrics.
  pause <campaignId>            Pause one campaign.
  pause --all                   Pause every campaign.
  account                       Usage, billing, and quota.
  mcp                           Serve MCP over stdio, bridged to the hosted endpoint.

Env:
  AGENT_COLD_EMAIL_API        API base URL (default: https://agent-cold-email-api.yaakovscher.workers.dev)
  AGENT_COLD_EMAIL_TOKEN      Bearer token (or pass --token per-command)
  AGENT_COLD_EMAIL_API_KEY    Bearer token for \`mcp\` mode
  AGENT_COLD_EMAIL_BASE_URL   API base URL override for \`mcp\` mode
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "demo":
      return runDemo(args);
    case "signup":
      return runSignup(args);
    case "setup":
      return runSetup(args);
    case "status":
      return runStatus(args);
    case "campaign":
      return runCampaign(args);
    case "inbox":
      return runInbox(args);
    case "metrics":
      return runMetrics(args);
    case "pause":
      return runPause(args);
    case "account":
      return runAccount(args);
    case "mcp":
      return runMcp();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  if (err instanceof ApiError) {
    console.error(`API error (${err.status}): ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exitCode = 1;
});
