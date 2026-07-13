import type { ActivityQueryInput } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// GET /activity (SPEC.md §19.4) — NEW DO method merging `events` (sends/
// replies/bounces/complaints) with `deliverability_actions` (the B6 AI
// control loop's throttle/pause/rotate/replace-domain log, already surfaced
// standalone via account().deliverability.recentActions) into one
// chronological feed, cursor-paginated. One query (a UNION ALL wrapped in a
// filtering/ordering outer SELECT) — not two round trips merged in JS.

export interface ActivityItem {
  id: string;
  kind: "event" | "deliverability";
  label: string;
  ts: number;
  target: string | null;
  detail: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

function encodeCursor(ts: number, id: string): string {
  return `${ts}:${id}`;
}

function decodeCursor(cursor: string): { ts: number; id: string } | null {
  const idx = cursor.indexOf(":");
  if (idx < 0) return null;
  const ts = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ts) || id.length === 0) return null;
  return { ts, id };
}

export function getActivityFeed(ctx: TenantContext, query: ActivityQueryInput): ActivityPage {
  const conditions: string[] = [];
  const binds: SqlStorageValue[] = [ctx.tenantId, ctx.tenantId];

  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor) {
    conditions.push(`(ts < ? OR (ts = ? AND id < ?))`);
    binds.push(cursor.ts, cursor.ts, cursor.id);
  }
  // Server-side kind filter (backend gap: the agent_log widget was fetching
  // everything and filtering client-side, ~4x over-fetch). Omitted -> every
  // kind, the backward-compatible default.
  if (query.kind) {
    conditions.push(`kind = ?`);
    binds.push(query.kind);
  }
  binds.push(query.limit + 1);

  const rows = ctx.sql
    .exec<{ id: string; kind: "event" | "deliverability"; label: string; ts: number; target: string | null; detail_json: string }>(
      `SELECT * FROM (
         SELECT id, 'event' as kind, type as label, ts, thread_id as target, metadata_json as detail_json
         FROM events WHERE tenant_id = ?
         UNION ALL
         SELECT id, 'deliverability' as kind, action as label, ts, target, detail_json
         FROM deliverability_actions WHERE tenant_id = ?
       ) combined
       WHERE 1=1 ${conditions.map((c) => `AND ${c}`).join(" ")}
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
      ...binds,
    )
    .toArray();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      ts: row.ts,
      target: row.target,
      detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.ts, last.id) : null,
  };
}
