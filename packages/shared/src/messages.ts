// list_messages — msgchannel increment 3 (system->agent message channel,
// apps/platform/src/engine/tenant-messages.ts). Shared by BOTH transports
// (HTTP facade + MCP tool), exactly like leads.ts/dashboard.ts back their own
// features.

import { z } from "zod";

// NATIVE types (number/optional string) — exactly like ListLeadsQueryInput/
// InboxQueryInput/ActivityQueryInput: the HTTP route layer parses raw query
// STRINGS into these; MCP tool arguments arrive already-typed, so both
// transports validate the exact same shape (CLAUDE.md rule c).
export const ListMessagesQueryInput = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListMessagesQueryInput = z.infer<typeof ListMessagesQueryInput>;
