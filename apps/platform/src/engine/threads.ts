import { NotFoundError } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

// sent_message_keys rows are evicted at write time once older than this — the
// same unbounded-growth guard request_idempotency uses (NB1). After the TTL an
// identical-body manual reply is treated as new, which also bounds how long a
// legitimate repeat reply stays suppressed. Measured on ctx.clock, same time
// base that stamps sent_at.
const SENT_MESSAGE_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

// v1's listInbox() lived here (last-event-per-thread + a per-row markStatus
// lookup — an N+1, one query per thread). Replaced by the single-JOINed
// `engine/inbox.ts` listInbox() (SPEC.md §19.4, M1) — moved to its own file
// since it also needs campaigns/mailboxes/thread_labels joins this file has
// no other reason to import.

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
  /** Backend gaps brief item 2 / M4 — the mailbox that sent this thread's
   * last step (same resolution replyToThread already uses for its own
   * "reply from" address); null before any step has sent. Lets the composer
   * show "Replying from X" on a deep-linked thread (?thread=<id>) that never
   * went through the inbox LIST row this used to depend on. */
  mailboxEmail: string | null;
  messages: ThreadMessage[];
}

export function getThread(ctx: TenantContext, threadId: string): ThreadDetail {
  const ref = lookupThreadRef(ctx, threadId);
  if (!ref) throw new NotFoundError(`thread ${threadId} not found`);

  const leadEmail = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM leads WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId)
    .one().email;

  const mailboxEmail = resolveSendingMailboxEmail(ctx, threadId) ?? null;

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
    mailboxEmail,
    messages: events.map((e) => ({
      type: e.type,
      ts: e.ts,
      messageId: e.message_id,
      metadata: JSON.parse(e.metadata_json) as Record<string, unknown>,
    })),
  };
}

/** The mailbox that sent this thread's last step so far — shared by
 * `getThread` (mailboxEmail, backend gaps brief item 2) and `replyToThread`
 * (its own "reply from" address), so there's exactly one join, not two. */
function resolveSendingMailboxEmail(ctx: TenantContext, threadId: string): string | undefined {
  return ctx.sql
    .exec<{ email: string }>(
      `SELECT m.email as email FROM scheduled_sends ss
       JOIN mailboxes m ON m.id = ss.mailbox_id
       WHERE ss.thread_id = ? AND ss.tenant_id = ? AND ss.mailbox_id IS NOT NULL LIMIT 1`,
      threadId,
      ctx.tenantId,
    )
    .toArray()[0]?.email;
}

/** SHA-256 hex of a UTF-8 string — the stable content component of a manual
 * reply's vendor idempotency key when no request key is supplied (B3). */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function replyToThread(
  ctx: TenantContext,
  threadId: string,
  body: string,
  idempotencyKey?: string,
): Promise<{ messageId: string }> {
  const ref = lookupThreadRef(ctx, threadId);
  if (!ref) throw new NotFoundError(`thread ${threadId} not found`);

  const leadEmail = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM leads WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId)
    .one().email;

  const mailboxEmail = resolveSendingMailboxEmail(ctx, threadId);
  if (!mailboxEmail) throw new NotFoundError(`no sending mailbox on record for thread ${threadId}`);

  // B3 (CLASS B): the vendor-send idempotency key must derive from STABLE
  // inputs so a retried reply reuses it (email.send returns the cached result,
  // not a second send). Embedding the wall clock (the pre-fix `:${now}`)
  // defeated itself — every retry produced a fresh key + a duplicate send.
  // Prefer the caller's request idempotency key; else a content hash so an
  // identical-body retry still dedupes.
  const now = ctx.clock.now();
  const keyBasis = idempotencyKey ? `k:${idempotencyKey}` : `h:${await sha256Hex(body)}`;
  const sendKey = `manual-reply:${ctx.tenantId}:${threadId}:${keyBasis}`;

  // B3 durability (NB4): the sandbox vendor's send-cache is in-memory, so across
  // a DO cold start a retried no-key reply would mint a fresh messageId and
  // double-send. Consult the DURABLE send-key -> messageId map first: a hit means
  // this exact reply already went out — return the recorded id WITHOUT a second
  // send (the matching 'sent' event is already durable from the first send).
  const persisted = ctx.sql
    .exec<{ message_id: string }>(`SELECT message_id FROM sent_message_keys WHERE send_key = ?`, sendKey)
    .toArray()[0];
  if (persisted) return { messageId: persisted.message_id };

  const result = await ctx.adapters.email.send(
    { fromEmail: mailboxEmail, toEmail: leadEmail, subject: "Re:", body, threadId, inReplyToMessageId: null },
    sendKey,
  );

  // Persist the mapping so the dedupe survives DO eviction. OR IGNORE: a
  // concurrent same-key send that already recorded its id wins — never clobbered.
  ctx.sql.exec(`DELETE FROM sent_message_keys WHERE sent_at < ?`, now - SENT_MESSAGE_KEY_TTL_MS);
  ctx.sql.exec(
    `INSERT OR IGNORE INTO sent_message_keys (send_key, message_id, sent_at) VALUES (?, ?, ?)`,
    sendKey,
    result.messageId,
    result.sentAt,
  );

  // OR IGNORE against the events dedupe index: a no-request-key retry with the
  // same body reproduces the same messageId (via the stable key above), so the
  // second reply is a no-op at the event layer instead of a duplicate row.
  ctx.sql.exec(
    `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
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
