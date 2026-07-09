import { NotFoundError } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

export interface ThreadRef {
  lead_id: string;
  campaign_id: string;
  [column: string]: SqlStorageValue;
}

/** Shared by engine/reply-processor.ts and the inbox/thread/reply/mark intents below. */
export function lookupThreadRef(ctx: TenantContext, threadId: string): ThreadRef | undefined {
  return ctx.sql
    .exec<ThreadRef>(
      `SELECT lead_id, campaign_id FROM scheduled_sends WHERE thread_id = ? AND tenant_id = ? LIMIT 1`,
      threadId,
      ctx.tenantId,
    )
    .toArray()[0];
}

export interface ThreadSummary {
  threadId: string;
  campaignId: string;
  leadEmail: string;
  lastEventType: string;
  lastEventTs: number;
  markStatus: string;
}

// Picks exactly one row per thread — the last-inserted event (ties on `ts`,
// which the sandbox simulator can produce for a send + its immediate
// simulated reply/bounce, broken by `rowid`, i.e. true insertion order).
// Deliberately NOT a GROUP BY + MAX(ts) bare-column trick: that's ambiguous
// on ties, which this schema hits routinely.
export function listInbox(ctx: TenantContext): ThreadSummary[] {
  const rows = ctx.sql
    .exec<{
      threadId: string;
      campaignId: string;
      leadEmail: string;
      lastEventType: string;
      lastEventTs: number;
    }>(
      `SELECT e.thread_id as threadId, e.campaign_id as campaignId, l.email as leadEmail,
              e.type as lastEventType, e.ts as lastEventTs
       FROM events e
       JOIN leads l ON l.id = e.lead_id
       WHERE e.tenant_id = ?
         AND e.rowid = (
           SELECT e2.rowid FROM events e2
           WHERE e2.thread_id = e.thread_id AND e2.tenant_id = e.tenant_id
           ORDER BY e2.ts DESC, e2.rowid DESC LIMIT 1
         )
       ORDER BY lastEventTs DESC`,
      ctx.tenantId,
    )
    .toArray();

  return rows.map((row) => ({
    ...row,
    markStatus: ctx.sql.exec<{ status: string }>(`SELECT status FROM thread_marks WHERE thread_id = ?`, row.threadId).toArray()[0]?.status ?? "unread",
  }));
}

export interface ThreadMessage {
  type: string;
  ts: number;
  messageId: string | null;
  metadata: Record<string, unknown>;
}

export interface ThreadDetail {
  threadId: string;
  campaignId: string;
  leadId: string;
  leadEmail: string;
  messages: ThreadMessage[];
}

export function getThread(ctx: TenantContext, threadId: string): ThreadDetail {
  const ref = lookupThreadRef(ctx, threadId);
  if (!ref) throw new NotFoundError(`thread ${threadId} not found`);

  const leadEmail = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM leads WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId)
    .one().email;

  const events = ctx.sql
    .exec<{ type: string; ts: number; message_id: string | null; metadata_json: string }>(
      `SELECT type, ts, message_id, metadata_json FROM events WHERE tenant_id = ? AND thread_id = ? ORDER BY ts ASC, rowid ASC`,
      ctx.tenantId,
      threadId,
    )
    .toArray();

  return {
    threadId,
    campaignId: ref.campaign_id,
    leadId: ref.lead_id,
    leadEmail,
    messages: events.map((e) => ({
      type: e.type,
      ts: e.ts,
      messageId: e.message_id,
      metadata: JSON.parse(e.metadata_json) as Record<string, unknown>,
    })),
  };
}

export async function replyToThread(
  ctx: TenantContext,
  threadId: string,
  body: string,
): Promise<{ messageId: string }> {
  const ref = lookupThreadRef(ctx, threadId);
  if (!ref) throw new NotFoundError(`thread ${threadId} not found`);

  const leadEmail = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM leads WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId)
    .one().email;

  const mailboxEmail = ctx.sql
    .exec<{ email: string }>(
      `SELECT m.email as email FROM scheduled_sends ss
       JOIN mailboxes m ON m.id = ss.mailbox_id
       WHERE ss.thread_id = ? AND ss.tenant_id = ? AND ss.mailbox_id IS NOT NULL LIMIT 1`,
      threadId,
      ctx.tenantId,
    )
    .toArray()[0]?.email;
  if (!mailboxEmail) throw new NotFoundError(`no sending mailbox on record for thread ${threadId}`);

  const now = ctx.clock.now();
  const result = await ctx.adapters.email.send(
    { fromEmail: mailboxEmail, toEmail: leadEmail, subject: "Re:", body, threadId, inReplyToMessageId: null },
    `manual-reply:${ctx.tenantId}:${threadId}:${now}`,
  );

  ctx.sql.exec(
    `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
     VALUES (?, ?, ?, ?, 'sent', 0, ?, ?, ?, ?)`,
    newId("evt"),
    ctx.tenantId,
    ref.campaign_id,
    ref.lead_id,
    result.messageId,
    threadId,
    result.sentAt,
    JSON.stringify({ fromEmail: mailboxEmail, toEmail: leadEmail, body, manual: true }),
  );

  return { messageId: result.messageId };
}

export function markThread(ctx: TenantContext, threadId: string, status: string): void {
  if (!lookupThreadRef(ctx, threadId)) throw new NotFoundError(`thread ${threadId} not found`);
  ctx.sql.exec(
    `INSERT INTO thread_marks (thread_id, status) VALUES (?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET status = excluded.status`,
    threadId,
    status,
  );
}
