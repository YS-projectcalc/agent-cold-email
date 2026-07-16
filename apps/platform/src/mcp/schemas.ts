// zod schemas for MCP `tools/call` arguments. Reuses the SAME schemas the
// HTTP facade validates request bodies against (@coldstart/shared) for the
// tools whose HTTP body IS the tool's arguments; adds small path-param
// schemas for the tools whose HTTP shape is `id in URL + optional body`
// (MCP tools have no URL, so the id becomes an argument field instead).

import { z } from "zod";
import { DashboardLayoutSchema, LaunchCampaignInput, MarkInput, ReplyInput, SetupInfrastructureInput, ThreadLabelInput, WEBHOOK_EVENT_TYPES } from "@coldstart/shared";

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

// MCP tools 13-15 (SPEC.md §19.5) — get_dashboard / configure_dashboard /
// label_thread. Reuse the same shared layout/label schemas the HTTP facade
// validates against (parity law, §19.0).

export const GetDashboardInput = z.object({
  id: z.string().min(1).max(200).optional().describe("Omit to list every saved view (summary); pass a view id for its full layout + rev."),
});

const noteField = z.string().max(2000).optional().describe("Optional human-readable note recorded alongside this edit (edited_by_note).");

// A single flat object (not z.discriminatedUnion) DELIBERATELY: MCP's
// tools/list advertises inputSchema via z.toJSONSchema(), and every other
// tool's schema resolves to a top-level `{"type": "object"}` — a
// discriminatedUnion resolves to a top-level `oneOf` instead, which would be
// the only tool breaking that invariant (test/mcp.test.ts asserts it for
// every tool). Per-action required-field combinations are enforced by the
// `.refine()` below (invisible to JSON Schema, same as it would be for any
// zod refinement); mcp/tools.ts narrows with a small `must()` helper since
// zod's `.refine()` doesn't narrow the inferred TS type per branch.
export const ConfigureDashboardInput = z
  .object({
    action: z.enum(["create", "update", "promote", "delete"]),
    id: z.string().min(1).max(200).optional().describe("Required for update/promote/delete."),
    name: z.string().min(1).max(200).optional().describe("Required for create. Optional for update — pass it to rename the view; omit to leave the name unchanged."),
    rev: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Required for update — the rev this edit is based on; stale vs. the view's CURRENT rev returns a structured conflict with currentRev/currentLayout to rebase onto."),
    layout: DashboardLayoutSchema.optional().describe("Required for create/update."),
    note: noteField,
  })
  .refine(
    (v) => {
      if (v.action === "create") return typeof v.name === "string" && v.layout !== undefined;
      if (v.action === "update") return typeof v.id === "string" && typeof v.rev === "number" && v.layout !== undefined;
      return typeof v.id === "string"; // promote | delete
    },
    { message: "missing required fields for the given action (create needs name+layout; update needs id+rev+layout; promote/delete need id)" },
  );

export const LabelThreadInput = ThreadIdInput.extend(ThreadLabelInput.shape);

// Outbound webhook tools (ROADMAP.md WIN-THE-COMPARISON (d)) — get_webhooks /
// configure_webhook, mirroring the get_dashboard / configure_dashboard pattern
// exactly (CLAUDE.md rule c: one CRUD-over-one-tool shape, not a parallel set).

export const GetWebhooksInput = z.object({
  id: z.string().min(1).max(200).optional().describe("Omit to list every subscription; pass an id for that subscription plus its recent delivery + attempt log."),
});

// A single flat object (NOT z.discriminatedUnion) for the same reason as
// ConfigureDashboardInput: tools/list advertises inputSchema via
// z.toJSONSchema(), and every tool must resolve to a top-level object (a union
// resolves to `oneOf` and breaks the mcp.test.ts invariant). Per-action
// required-field combinations are enforced by the `.refine()`.
export const ConfigureWebhookInput = z
  .object({
    action: z.enum(["create", "update", "delete"]),
    id: z.string().min(1).max(200).optional().describe("Required for update/delete."),
    url: z.string().min(1).max(2048).optional().describe("Required for create. HTTPS endpoint; private/link-local/metadata IPs are rejected."),
    eventTypes: z
      .array(z.enum(WEBHOOK_EVENT_TYPES))
      .min(1)
      .max(WEBHOOK_EVENT_TYPES.length)
      .optional()
      .describe("Required for create: which events to push (reply | bounce | soft_bounce | complaint)."),
    secret: z.string().min(16).max(200).optional().describe("Optional signing secret (>=16 chars). Omit on create to have one generated; pass on update to rotate."),
    active: z.boolean().optional().describe("Optional. On update, active:true re-enables an auto-disabled subscription; active:false pauses delivery."),
    note: z.string().max(2000).optional().describe("Ignored placeholder for symmetry; webhooks record no provenance note."),
  })
  .refine(
    (v) => {
      if (v.action === "create") return typeof v.url === "string" && Array.isArray(v.eventTypes);
      if (v.action === "update") return typeof v.id === "string" && (v.url !== undefined || v.eventTypes !== undefined || v.secret !== undefined || v.active !== undefined);
      return typeof v.id === "string"; // delete
    },
    { message: "missing required fields for the given action (create needs url+eventTypes; update needs id + one changed field; delete needs id)" },
  );
