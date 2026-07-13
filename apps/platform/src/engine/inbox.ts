import type { InboxQueryInput } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// SPEC.md §19.4 — GET /inbox v2 (+ the MCP `inbox` tool, same shared DO
// method/params). A SINGLE JOINed query (kills the pre-v2 N+1 — the old
// listInbox ran one extra query PER ROW to resolve markStatus): CTEs compute
// "the last event per thread" (existing correlated-subquery trick, extended
// to carry step/rowid), "the highest campaign step actually sent" (NOT the
// last EVENT's step — a reply/bounce always has step=0, so keying off it
// would blank the subject/mailbox the moment a thread gets its first reply),
// and "the mailbox that sent that step" — then one outer SELECT joins
// everything else (lead, campaign, label, mark). [NEW-3]: subject/snippet are
// not columns — subject is resolved via `json_extract` against
// `campaigns.sequence_json` at the resolved step's array index (steps are
// 1-indexed, the JSON array is 0-indexed); snippet via `json_extract` against
// the last event's own `metadata_json.body` (present on both 'sent' —
// engine/tick.ts / engine/threads.ts — and 'reply' — engine/reply-
// processor.ts — events; NULL for bounce/complaint, which have no body).
export interface InboxRow {
  threadId: string;
  campaignId: string;
  campaignName: string;
  leadEmail: string;
  subject: string | null;
  snippet: string | null;
  mailboxEmail: string | null;
  mailboxDelivStatus: string | null;
  label: string | null;
  labelSource: string | null;
  lastEventType: string;
  lastEventTs: number;
  markStatus: string;
}

export interface InboxPage {
  threads: InboxRow[];
  nextCursor: string | null;
}

// The raw SQL row shape — `lastEventRowid` is the cursor tiebreaker, stripped
// before returning `InboxRow[]` to callers. The index signature is required
// by `ctx.sql.exec<T>`'s constraint; kept off the PUBLIC `InboxRow` type so
// callers don't see it.
interface InboxQueryRow extends InboxRow {
  lastEventRowid: number;
  [column: string]: SqlStorageValue;
}

/** Opaque composite cursor `(lastEventTs, rowid)` matching `ORDER BY
 * lastEventTs DESC, rowid DESC` [NEW-2]. Same-`ts` ties are routine here (a
 * send + its immediate simulated reply/bounce can share a timestamp) — the
 * `rowid` tiebreaker is what makes the boundary lossless/dup-free. */
function encodeCursor(ts: number, rowid: number): string {
  return `${ts}:${rowid}`;
}

function decodeCursor(cursor: string): { ts: number; rowid: number } | null {
  const match = /^(-?\d+):(-?\d+)$/.exec(cursor);
  if (!match) return null;
  return { ts: Number(match[1]), rowid: Number(match[2]) };
}

export function listInbox(ctx: TenantContext, query: InboxQueryInput): InboxPage {
  const conditions: string[] = [];
  // One tenant_id bind per CTE that scopes on it: last_event, last_sent,
  // last_sent_event, last_mailbox (all four literally the same value, so
  // their relative order doesn't matter — only the COUNT has to match the
  // four `tenant_id = ?` placeholders in the query text below).
  const binds: SqlStorageValue[] = [ctx.tenantId, ctx.tenantId, ctx.tenantId, ctx.tenantId];

  if (query.mailbox) {
    conditions.push(`lm.mailbox_email = ?`);
    binds.push(query.mailbox);
  }
  if (query.campaign) {
    conditions.push(`le.campaign_id = ?`);
    binds.push(query.campaign);
  }
  if (query.label) {
    conditions.push(`tl.label = ?`);
    binds.push(query.label);
  }
  if (query.read === true) {
    conditions.push(`COALESCE(tm.status, 'unread') = 'read'`);
  } else if (query.read === false) {
    conditions.push(`COALESCE(tm.status, 'unread') != 'read'`);
  }
  if (!query.includeNonreply) {
    conditions.push(`le.type NOT IN ('bounce', 'soft_bounce', 'complaint')`);
  }
  if (query.archived === "exclude") {
    conditions.push(`COALESCE(tm.status, 'unread') != 'archived'`);
  } else if (query.archived === "only") {
    conditions.push(`COALESCE(tm.status, 'unread') = 'archived'`);
  }
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (cursor) {
    conditions.push(`(le.ts < ? OR (le.ts = ? AND le.rowid < ?))`);
    binds.push(cursor.ts, cursor.ts, cursor.rowid);
  }

  // Fetch one extra row to know whether a next page exists without a second
  // COUNT query.
  binds.push(query.limit + 1);

  const rows = ctx.sql
    .exec<InboxQueryRow>(
      `WITH last_event AS (
         -- \`SELECT *\` alone does NOT carry \`rowid\` (it's an implicit column,
         -- not a named one, since events.id is a TEXT — not INTEGER — primary
         -- key) — must be selected explicitly or \`le.rowid\` below is undefined.
         SELECT e.*, e.rowid as rowid FROM events e
         WHERE e.tenant_id = ?
           AND e.rowid = (
             SELECT e2.rowid FROM events e2
             WHERE e2.thread_id = e.thread_id AND e2.tenant_id = e.tenant_id
             ORDER BY e2.ts DESC, e2.rowid DESC LIMIT 1
           )
       ),
       last_sent AS (
         SELECT thread_id, MAX(step) as step
         FROM scheduled_sends
         WHERE tenant_id = ? AND status = 'sent'
         GROUP BY thread_id
       ),
       -- SPEC.md §19.4 [NEW-3] root cause fix: the 'sent' event for the
       -- resolved step now carries the RENDERED subject (engine/tick.ts
       -- substitutes {{firstName}}/{{company}} before recording it) — read
       -- IT, not the raw campaigns.sequence_json template, so a real send's
       -- lead-specific subject is what inbox v2 displays.
       last_sent_event AS (
         SELECT e.thread_id, e.metadata_json
         FROM events e
         JOIN last_sent lsn ON lsn.thread_id = e.thread_id AND lsn.step = e.step
         WHERE e.tenant_id = ? AND e.type = 'sent'
       ),
       last_mailbox AS (
         SELECT ss.thread_id, m.email as mailbox_email, m.deliv_status as mailbox_deliv_status
         FROM scheduled_sends ss
         JOIN mailboxes m ON m.id = ss.mailbox_id
         JOIN last_sent lsn ON lsn.thread_id = ss.thread_id AND lsn.step = ss.step
         WHERE ss.tenant_id = ?
       )
       SELECT
         le.thread_id as threadId,
         le.campaign_id as campaignId,
         c.name as campaignName,
         l.email as leadEmail,
         le.type as lastEventType,
         le.ts as lastEventTs,
         le.rowid as lastEventRowid,
         CASE
           -- Rendered subject from the actual sent event's own metadata (the
           -- common case post-fix). Falls back to the campaign template ONLY
           -- when no sent-event subject is on record (pre-fix historical rows
           -- or a hypothetical missing key) — graceful, never a blank/NULL
           -- subject where a step is known to have gone out.
           WHEN lse.metadata_json IS NOT NULL
             THEN COALESCE(json_extract(lse.metadata_json, '$.subject'), json_extract(c.sequence_json, '$[' || (lsn.step - 1) || '].subject'))
           WHEN lsn.step IS NOT NULL THEN json_extract(c.sequence_json, '$[' || (lsn.step - 1) || '].subject')
           ELSE NULL
         END as subject,
         json_extract(le.metadata_json, '$.body') as snippet,
         lm.mailbox_email as mailboxEmail,
         lm.mailbox_deliv_status as mailboxDelivStatus,
         tl.label as label,
         tl.source as labelSource,
         COALESCE(tm.status, 'unread') as markStatus
       FROM last_event le
       JOIN leads l ON l.id = le.lead_id
       JOIN campaigns c ON c.id = le.campaign_id
       LEFT JOIN last_sent lsn ON lsn.thread_id = le.thread_id
       LEFT JOIN last_sent_event lse ON lse.thread_id = le.thread_id
       LEFT JOIN last_mailbox lm ON lm.thread_id = le.thread_id
       LEFT JOIN thread_labels tl ON tl.thread_id = le.thread_id
       LEFT JOIN thread_marks tm ON tm.thread_id = le.thread_id
       WHERE 1=1 ${conditions.map((c) => `AND ${c}`).join(" ")}
       ORDER BY le.ts DESC, le.rowid DESC
       LIMIT ?`,
      ...binds,
    )
    .toArray();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    threads: page.map(({ lastEventRowid: _lastEventRowid, ...row }) => row),
    nextCursor: hasMore && last ? encodeCursor(last.lastEventTs, last.lastEventRowid) : null,
  };
}
