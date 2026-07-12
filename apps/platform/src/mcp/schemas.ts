// zod schemas for MCP `tools/call` arguments. Reuses the SAME schemas the
// HTTP facade validates request bodies against (@coldstart/shared) for the
// tools whose HTTP body IS the tool's arguments; adds small path-param
// schemas for the tools whose HTTP shape is `id in URL + optional body`
// (MCP tools have no URL, so the id becomes an argument field instead).

import { z } from "zod";
import { LaunchCampaignInput, MarkInput, ReplyInput, SetupInfrastructureInput } from "@coldstart/shared";

export const EmptyInput = z.object({});

export const CampaignIdInput = z.object({
  campaignId: z.string().min(1).describe("The campaign id returned by launch_campaign."),
});

export const ThreadIdInput = z.object({
  threadId: z.string().min(1).describe("The thread id, e.g. from inbox() or campaign events."),
});

// B2 (CLASS B) — optional request-idempotency key for MUTATING tools. An agent
// that retries a dropped call SHOULD resend the same key: the first call runs,
// a replay returns the recorded result without re-executing (no second
// campaign / double-provision / duplicate send). Mirrors the HTTP
// `Idempotency-Key` header. Advertised on the tool inputSchema so agents send it.
const idempotencyKeyField = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Optional idempotency key: resend the SAME key when retrying this call so a dropped-response retry is not applied twice (no duplicate campaign/provision/send).",
  );

export const SetupInfrastructureToolInput = SetupInfrastructureInput.extend({ idempotencyKey: idempotencyKeyField });

export const LaunchCampaignToolInput = LaunchCampaignInput.extend({ idempotencyKey: idempotencyKeyField });

export const ThreadReplyInput = ThreadIdInput.extend(ReplyInput.shape).extend({ idempotencyKey: idempotencyKeyField });

export const ThreadMarkInput = ThreadIdInput.extend(MarkInput.shape);
