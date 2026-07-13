// SPEC.md §19 — dashboard + unified inbox: the optional human surface. Layout
// is DATA (zod-validated here), never interpolated into markup — the SPA
// (apps/dashboard, M2) renders whatever widget registry entry matches a
// stored `type`; the platform (apps/platform, M1) only stores/validates it.
// Parity law (§19.0): every dashboard mutation calls the SAME TenantDO method
// MCP calls, so these schemas are shared by both transports (mirrors how
// intents.ts backs both the HTTP facade and mcp/schemas.ts).

import { z } from "zod";

// --- Provenance (§19.4) — server-derived from TRANSPORT, never a
// client-supplied actor claim. 'system' is reserved for the lazy-seeded
// default view (§19.2) — never produced by a request handler. ---
export const ProvenanceSchema = z.enum(["dashboard", "mcp", "api", "system"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

// --- Canonical thread labels (§19.2) — a RECOMMENDATION styled in the UI,
// not a server-side enum: `thread_labels.label` stores free-form text so an
// agent's own taxonomy is never rejected. ---
export const CANONICAL_THREAD_LABELS = [
  "interested",
  "meeting_booked",
  "not_now",
  "out_of_office",
  "wrong_person",
  "do_not_contact",
] as const;
export type CanonicalThreadLabel = (typeof CANONICAL_THREAD_LABELS)[number];

// --- Widget registry v1 (§19.3) — exactly these 8 types. Adding a 9th is a
// registry change (both here AND the SPA's render map), not a per-tenant
// config. ---
export const WIDGET_TYPES = [
  "kpi_row",
  "mailbox_health",
  "campaign_performance",
  "activity_feed",
  "inbox_preview",
  "agent_log",
  "agent_note",
  "quota_usage",
] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

// 12-col grid (§19.3). `y` is a row index, not a pixel value — the SPA packs
// widgets top-down; mobile collapses to a single column ordered by (y, x).
export const GridPosSchema = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(20),
});
export type GridPos = z.infer<typeof GridPosSchema>;

// Every widget shares these two data-fetching/display knobs (§19.1: TanStack
// Query interval polling, per-widget `refreshSeconds`); everything else is
// typed per widget type below.
const refreshSeconds = z.number().int().min(5).max(3600).default(30);
const title = z.string().max(200).optional();

export const KpiRowPropsSchema = z.object({
  refreshSeconds,
  title,
  metrics: z
    .array(z.enum(["sent", "reply", "bounce", "soft_bounce", "complaint", "unsubscribe", "failed"]))
    .min(1)
    .max(7)
    .default(["sent", "reply", "bounce"]),
});
export const MailboxHealthPropsSchema = z.object({ refreshSeconds, title, showWarmup: z.boolean().default(true) });
export const CampaignPerformancePropsSchema = z.object({ refreshSeconds, title, campaignId: z.string().min(1).max(200).optional() });
export const ActivityFeedPropsSchema = z.object({ refreshSeconds, title, limit: z.number().int().min(1).max(100).default(20) });
export const InboxPreviewPropsSchema = z.object({
  refreshSeconds,
  title,
  limit: z.number().int().min(1).max(50).default(5),
  label: z.string().min(1).max(100).optional(),
});
export const AgentLogPropsSchema = z.object({ refreshSeconds, title, limit: z.number().int().min(1).max(100).default(20) });
// agent_note (§19.1 content-safety class 2): the string itself is UNTRUSTED
// markdown, rendered through a restricted DOMPurify-strict pipeline by the
// SPA (M2/M3) — this schema only bounds its size; sanitization is a
// rendering-layer concern, not a storage-layer one.
export const AgentNotePropsSchema = z.object({ refreshSeconds, title, markdown: z.string().max(10_000).default("") });
export const QuotaUsagePropsSchema = z.object({ refreshSeconds, title });

export const WidgetSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1).max(100), type: z.literal("kpi_row"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: KpiRowPropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("mailbox_health"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: MailboxHealthPropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("campaign_performance"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: CampaignPerformancePropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("activity_feed"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: ActivityFeedPropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("inbox_preview"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: InboxPreviewPropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("agent_log"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: AgentLogPropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("agent_note"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: AgentNotePropsSchema }),
  z.object({ id: z.string().min(1).max(100), type: z.literal("quota_usage"), gridPos: GridPosSchema, visible: z.boolean().default(true), props: QuotaUsagePropsSchema }),
]);
export type Widget = z.infer<typeof WidgetSchema>;

export const DASHBOARD_LAYOUT_SCHEMA_VERSION = 1;

export const DashboardLayoutSchema = z.object({
  schemaVersion: z.literal(DASHBOARD_LAYOUT_SCHEMA_VERSION),
  widgets: z.array(WidgetSchema).max(50),
});
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

/**
 * A starter layout for the lazy-seeded `default` view (§19.2) — a fresh
 * tenant always renders something instead of an empty crash.
 *
 * M5 R2 item 3 — redesigned to sell the AI-native thesis on FIRST load
 * rather than the minimal 3-widget M2 placeholder: a live inbox and "what my
 * agent did" log sit above the fold alongside KPIs/mailbox health/plan
 * usage, plus an `agent_note` placeholder that invites the tenant's own
 * agent to start writing here via MCP. `gridPos.y`/`x` only drive DOM
 * order/mobile-stack order (Grid.tsx's `sortByYX` — actual desktop row
 * placement is the browser's own dense-packing algorithm), so the y values
 * below encode exactly the mobile single-column order: KPIs → inbox →
 * mailboxes → agent log → quota → note.
 *
 * ONLY applies to a brand-new tenant — `ensureDefaultViewSeeded`'s `count >
 * 0` guard makes this a no-op for every tenant that already has a view row,
 * so changing this function never touches an existing tenant's stored
 * layout (apps/platform/test/dashboard-views.test.ts covers the guard).
 */
export function starterDashboardLayout(): DashboardLayout {
  return {
    schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION,
    widgets: [
      { id: "w_kpi", type: "kpi_row", gridPos: { x: 0, y: 0, w: 12, h: 2 }, visible: true, props: KpiRowPropsSchema.parse({}) },
      { id: "w_inbox", type: "inbox_preview", gridPos: { x: 0, y: 1, w: 7, h: 5 }, visible: true, props: InboxPreviewPropsSchema.parse({}) },
      { id: "w_mailbox", type: "mailbox_health", gridPos: { x: 7, y: 1, w: 5, h: 5 }, visible: true, props: MailboxHealthPropsSchema.parse({}) },
      { id: "w_agent_log", type: "agent_log", gridPos: { x: 0, y: 2, w: 7, h: 3 }, visible: true, props: AgentLogPropsSchema.parse({}) },
      { id: "w_quota", type: "quota_usage", gridPos: { x: 7, y: 2, w: 5, h: 3 }, visible: true, props: QuotaUsagePropsSchema.parse({}) },
      {
        id: "w_note",
        type: "agent_note",
        gridPos: { x: 0, y: 3, w: 12, h: 2 },
        visible: true,
        props: AgentNotePropsSchema.parse({ markdown: "Your agent can leave notes here — connect it via MCP." }),
      },
    ],
  };
}

// --- §19.4 API request bodies (shared by the HTTP facade AND MCP tools,
// exactly like intents.ts) ---

export const DashboardSessionInput = z.object({ token: z.string().min(1).max(500) });
export type DashboardSessionInput = z.infer<typeof DashboardSessionInput>;

export const DashboardViewCreateInput = z.object({
  name: z.string().min(1).max(200),
  layout: DashboardLayoutSchema,
  note: z.string().max(2000).optional(),
});
export type DashboardViewCreateInput = z.infer<typeof DashboardViewCreateInput>;

export const DashboardViewUpdateInput = z.object({
  rev: z.number().int().min(1),
  layout: DashboardLayoutSchema,
  // Optional rename, same rev-CAS semantics as the layout upsert (the backend
  // gap this closes: PUT was a full-layout upsert with no way to rename a
  // view). Omitted -> the existing name is left untouched.
  name: z.string().min(1).max(200).optional(),
  note: z.string().max(2000).optional(),
});
export type DashboardViewUpdateInput = z.infer<typeof DashboardViewUpdateInput>;

// label: null/omitted clears the thread's label (POST /threads/:id/label).
export const ThreadLabelInput = z.object({ label: z.string().min(1).max(100).nullable().default(null) });
export type ThreadLabelInput = z.infer<typeof ThreadLabelInput>;

// --- §19.4 inbox v2 / activity query params. NATIVE types (number/boolean) —
// the HTTP route layer parses raw query STRINGS into these; MCP tool
// arguments arrive already-typed, so both transports validate the exact same
// shape (CLAUDE.md rule c). Every field optional/defaulted = backward-
// compatible with a bare `GET /inbox` / `inbox` tool call with no args. ---
export const InboxQueryInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  mailbox: z.string().min(1).max(320).optional(),
  campaign: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(100).optional(),
  read: z.boolean().optional(),
  // Default TRUE: preserves the pre-v2 GET /inbox behavior (every thread,
  // bounces included) for a caller that passes no filters at all — the
  // dashboard UI (M3) sets this to `false` itself for its default "Bounces &
  // OOO" toggle-off inbox view. See tenant-do.ts inbox() doc for the tests
  // this backward-compat default protects.
  includeNonreply: z.boolean().default(true),
  // Backend gaps brief item 1 — M3 filtered `markStatus !== "archived"`
  // CLIENT-side (a wasted page slot per archived thread at scale). Default
  // "exclude" moves that filter server-side; "include" restores the old
  // "everything" shape; "only" is the archived-queue triage view.
  archived: z.enum(["exclude", "include", "only"]).default("exclude"),
});
export type InboxQueryInput = z.infer<typeof InboxQueryInput>;

export const ActivityQueryInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  // Backend gap closed: the agent_log widget was over-fetching (~4x) and
  // filtering client-side. Omitted (the backward-compatible default) ->
  // every kind, matching the pre-filter GET /activity shape.
  kind: z.enum(["event", "deliverability"]).optional(),
});
export type ActivityQueryInput = z.infer<typeof ActivityQueryInput>;
