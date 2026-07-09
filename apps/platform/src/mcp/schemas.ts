// zod schemas for MCP `tools/call` arguments. Reuses the SAME schemas the
// HTTP facade validates request bodies against (@coldstart/shared) for the
// tools whose HTTP body IS the tool's arguments; adds small path-param
// schemas for the tools whose HTTP shape is `id in URL + optional body`
// (MCP tools have no URL, so the id becomes an argument field instead).

import { z } from "zod";
import { MarkInput, ReplyInput } from "@coldstart/shared";

export const EmptyInput = z.object({});

export const CampaignIdInput = z.object({
  campaignId: z.string().min(1).describe("The campaign id returned by launch_campaign."),
});

export const ThreadIdInput = z.object({
  threadId: z.string().min(1).describe("The thread id, e.g. from inbox() or campaign events."),
});

export const ThreadReplyInput = ThreadIdInput.extend(ReplyInput.shape);

export const ThreadMarkInput = ThreadIdInput.extend(MarkInput.shape);
