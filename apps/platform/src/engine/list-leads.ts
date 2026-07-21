import type { LeadInterestStatus, ListLeadsQueryInput } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// list_leads — SPEC.md §22 tool 22 (read-only; doubles as the export surface,
// Q6 — paginated JSON, no separate CSV endpoint). One row per `leads` row
// (campaign-scoped, schema.ts:194-203 — NOT collapsed to one row per contact:
// SPEC.md §22 names the JOIN target as `leads`, and a `campaign` filter only
// makes sense against a per-campaign-lead row). JOINs lead_dispositions
// (contact-level status/notes/tags) + suppressions (tenant-wide opt-out) +
// a last-event-per-lead CTE, reusing the exact "last row per key via a
// correlated-subquery rowid match" pattern `inbox.ts`'s `last_event` CTE uses
// (there keyed per thread_id; here keyed per lead_id) — same composite
// cursor-pagination shape (`inbox.ts:49-61`) too.

export interface LeadListRow {
  leadId: string;
  email: string;
  firstName: string;
  company: string;
  campaignId: string;
  campaignName: string;
  globalStatus: string;
  interestStatus: LeadInterestStatus;
  notes: string;
  tags: string[];
  suppressed: boolean;
  lastEventType: string | null;
  lastEventTs: number | null;
  createdAt: number;
}

export interface LeadListPage {
  leads: LeadListRow[];
  nextCursor: string | null;
}

// The raw SQL row shape — `leadRowid` is the cursor tiebreaker, `tagsJson` is
// un-parsed, and `suppressed` is SQLite's raw 0/1 — all stripped/converted
// before returning `LeadListRow[]` to callers (mirrors inbox.ts's
// InboxQueryRow/InboxRow split and webhooks.ts's SubscriptionRow.active).
interface LeadQueryRow {
  leadId: string;
  email: string;
  firstName: string;
  company: string;
  campaignId: string;
  campaignName: string;
  globalStatus: string;
  createdAt: number;
  leadRowid: number;
  interestStatus: LeadInterestStatus;
  notes: string;
  tagsJson: string;
  suppressed: number;
  lastEventType: string | null;
  lastEventTs: number | null;
  [column: string]: SqlStorageValue;
}

/** Opaque composite cursor `(createdAt, rowid)`, matching `ORDER BY
 * l.created_at DESC, l.rowid DESC` — same tiebreaker rationale as
 * inbox.ts's encodeCursor/decodeCursor (same-`created_at` ties are routine
 * for leads inserted in the same launch_campaign call). */
function encodeCursor(createdAt: number, rowid: number): string {
  return `${createdAt}:${rowid}`;
}

function decodeCursor(cursor: string): { createdAt: number; rowid: number } | null {
  const match = /^(-?\d+):(-?\d+)$/.exec(cursor);
  if (!match) return null;
  return { createdAt: Number(match[1]), rowid: Number(match[2]) };
}

export function listLeads(ctx: TenantContext, query: ListLeadsQueryInput): LeadListPage {
  const conditions: string[] = [];
  // One tenant_id bind per place it's needed: the last_event CTE's own WHERE,
  // then the outer query's WHERE l.tenant_id = ? (the CTE's inner correlated
  // subquery uses e2.tenant_id = e.tenant_id — a correlation, not a bind).
  const binds: SqlStorageValue[] = [ctx.tenantId, ctx.tenantId];

  if (query.campaign) {
    conditions.push(`l.campaign_id = ?`);
    binds.push(query.campaign);
  }
  if (query.interestStatus) {
    conditions.push(`COALESCE(ld.interest_status, 'none') = ?`);
    binds.push(query.interestStatus);
  }
  if (query.suppressed === true) {
    conditions.push(`sup.email IS NOT NULL`);
  } else if (query.suppressed === false) {
    conditions.push(`sup.email IS NULL`);
  }
  if (query.replied === true) {
    conditions.push(`l.global_status = 'replied'`);
  } else if (query.replied === false) {
    conditions.push(`l.global_status != 'replied'`);
  }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor) {
    conditions.push(`(l.created_at < ? OR (l.created_at = ? AND l.rowid < ?))`);
    binds.push(cursor.createdAt, cursor.createdAt, cursor.rowid);
  }

  // Fetch one extra row to know whether a next page exists without a second
  // COUNT query (mirrors inbox.ts/activity.ts).
  binds.push(query.limit + 1);

  const rows = ctx.sql
    .exec<LeadQueryRow>(
      `WITH last_event AS (
         SELECT e.*, e.rowid as rowid FROM events e
         WHERE e.tenant_id = ?
           AND e.rowid = (
             SELECT e2.rowid FROM events e2
             WHERE e2.lead_id = e.lead_id AND e2.tenant_id = e.tenant_id
             ORDER BY e2.ts DESC, e2.rowid DESC LIMIT 1
           )
       )
       SELECT
         l.id as leadId,
         l.email as email,
         l.first_name as firstName,
         l.company as company,
         l.campaign_id as campaignId,
         c.name as campaignName,
         l.global_status as globalStatus,
         l.created_at as createdAt,
         l.rowid as leadRowid,
         COALESCE(ld.interest_status, 'none') as interestStatus,
         COALESCE(ld.notes, '') as notes,
         COALESCE(ld.tags_json, '[]') as tagsJson,
         CASE WHEN sup.email IS NOT NULL THEN 1 ELSE 0 END as suppressed,
         le.type as lastEventType,
         le.ts as lastEventTs
       FROM leads l
       JOIN campaigns c ON c.id = l.campaign_id
       LEFT JOIN lead_dispositions ld ON ld.tenant_id = l.tenant_id AND ld.email = l.email
       LEFT JOIN suppressions sup ON sup.tenant_id = l.tenant_id AND sup.email = l.email
       LEFT JOIN last_event le ON le.lead_id = l.id
       WHERE l.tenant_id = ? ${conditions.map((c) => `AND ${c}`).join(" ")}
       ORDER BY l.created_at DESC, l.rowid DESC
       LIMIT ?`,
      ...binds,
    )
    .toArray();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    leads: page.map(({ leadRowid: _leadRowid, tagsJson, suppressed, ...row }) => ({
      ...row,
      tags: JSON.parse(tagsJson) as string[],
      suppressed: Boolean(suppressed),
    })),
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.leadRowid) : null,
  };
}
