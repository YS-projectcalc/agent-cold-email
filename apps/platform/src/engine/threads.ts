import { NotFoundError, type Collapsed } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { sendWithGuards } from "./guarded-send.js";

// sent_message_keys rows are evicted at write time once older than this — the
// same unbounded-growth guard request_idempotency uses (NB1). Measured on
// ctx.clock, same time base that stamps sent_at.
const SENT_MESSAGE_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the CONTENT-HASH fallback key stays replayable (IN-7,
 * docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md).
 *
 * A caller-supplied idempotency key is an explicit "this exact request" claim,
 * so it replays for the row's full life. A content hash is not that claim — it
 * is this codebase GUESSING, from the text alone, that two calls are one intent.
 * That guess is right for a retry seconds later and wrong for a genuine repeat:
 * over the 30-day row TTL it meant a customer replying "Following up on this."
 * on Monday and again on Thursday got ONE email and TWO successes, with no
 * second send and nothing said. The key encoded text identity; it never encoded
 * intent-to-send-again.
 *
 * 10 minutes is this codebase's own existing answer to "how long might one
 * logical attempt still be being retried" (REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS,
 * engine/idempotency.ts). Inside it the B3/NB4 guarantee is untouched — a
 * retried no-key reply after a dropped response still replays rather than
 * double-sending. Outside it, a repeat is treated as what it is.
 */
const CONTENT_HASH_REPLAY_WINDOW_MS = 10 * 60 * 1000;

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

  const mailboxEmail = resolveSendingMailbox(ctx, threadId)?.email ?? null;

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
 * (its own "reply from" address), so there's exactly one join, not two. Both
 * `id` and `email` are returned: the guarded send primitive meters capacity by
 * mailbox id, `getThread` surfaces only the address. */
function resolveSendingMailbox(ctx: TenantContext, threadId: string): { id: string; email: string } | undefined {
  return ctx.sql
    .exec<{ id: string; email: string }>(
      `SELECT m.id as id, m.email as email FROM scheduled_sends ss
       JOIN mailboxes m ON m.id = ss.mailbox_id
       WHERE ss.thread_id = ? AND ss.tenant_id = ? AND ss.mailbox_id IS NOT NULL LIMIT 1`,
      threadId,
      ctx.tenantId,
    )
    .toArray()[0];
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
): Promise<Collapsed<{ messageId: string }>> {
  const ref = lookupThreadRef(ctx, threadId);
  if (!ref) throw new NotFoundError(`thread ${threadId} not found`);

  const leadEmail = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM leads WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId)
    .one().email;

  const mailbox = resolveSendingMailbox(ctx, threadId);
  if (!mailbox) throw new NotFoundError(`no sending mailbox on record for thread ${threadId}`);

  // B3 (CLASS B): the vendor-send idempotency key must derive from STABLE
  // inputs so a retried reply reuses it (email.send returns the cached result,
  // not a second send). Embedding the wall clock (the pre-fix `:${now}`)
  // defeated itself — every retry produced a fresh key + a duplicate send.
  // Prefer the caller's request idempotency key; else a content hash so an
  // identical-body retry still dedupes.
  const now = ctx.clock.now();
  const callerKeyed = idempotencyKey !== undefined;
  const keyBasis = callerKeyed ? `k:${idempotencyKey}` : `h:${await sha256Hex(body)}`;
  const lookupKey = `manual-reply:${ctx.tenantId}:${threadId}:${keyBasis}`;

  // B3 durability (NB4): the sandbox vendor's send-cache is in-memory, so across
  // a DO cold start a retried no-key reply would mint a fresh messageId and
  // double-send. Consult the DURABLE send-key -> messageId map first: a hit means
  // this exact reply already went out — return the recorded id WITHOUT a second
  // send (the matching 'sent' event is already durable from the first send).
  //
  // A hit on the CONTENT-HASH fallback is believed only inside
  // CONTENT_HASH_REPLAY_WINDOW_MS (IN-7 — see the constant).
  const persisted = ctx.sql
    .exec<{ message_id: string; sent_at: number; epoch: number }>(
      `SELECT message_id, sent_at, epoch FROM sent_message_keys WHERE send_key = ?`,
      lookupKey,
    )
    .toArray()[0];
  let epoch = 0;
  if (persisted) {
    if (callerKeyed || now - persisted.sent_at < CONTENT_HASH_REPLAY_WINDOW_MS) {
      return { messageId: persisted.message_id, deduplicated: true };
    }
    epoch = persisted.epoch + 1;
  }

  // THE VENDOR KEY, WHICH IS NOT THE LOOKUP KEY (IN-7 root cause). Bounding the
  // durable map alone does not send the Thursday follow-up: the vendor dedups on
  // this key too — the sandbox port caches it in memory forever
  // (vendors/sandbox/email-port.ts:41) and so does the real engine daemon
  // (apps/engine/src/engine.ts:87, `store.getSend(idempotencyKey)`). A key that
  // is a pure function of the BODY is therefore spent at the vendor for as long
  // as the vendor remembers it, whatever this table says. Measured: with the
  // window fix alone, the three-days-later reply still came back with the first
  // send's messageId.
  //
  // So a genuine repeat gets a NEW vendor key, discriminated by an `epoch` that
  // is DURABLE and derived, never a wall-clock bucket — a bucket boundary
  // straddled by a crash-retry would double-send, which is the very thing the
  // pre-fix `:${now}` key did. Epoch 0 reuses the bare lookup key so every row
  // and key already recorded keeps its exact current meaning.
  //
  // The crash-retry path stays safe BECAUSE the epoch is derived from the same
  // durable row the retry re-reads: a retry after a crash mid-send re-computes
  // the identical epoch (the row is unchanged), so it re-presents the identical
  // vendor key and the vendor dedups it, exactly as before.
  const sendKey = epoch === 0 ? lookupKey : `${lookupKey}:e${epoch}`;

  // Warm-lead Q3 / adversary R1-R2: a manual reply is REAL sending volume, so
  // it goes through the shared guarded primitive (suppression re-check ->
  // deliverability pause -> daily cap reserve -> metered increment) instead of
  // calling the vendor port directly. A refused send throws SendBlockedError,
  // which surfaces as a structured 4xx naming the guard that tripped (index.ts
  // onError) — the caller is never told a blocked reply succeeded.
  //
  // Placed AFTER the durable send-key lookup above deliberately: a retry of a
  // reply that ALREADY went out must keep returning that recorded messageId
  // (B3's whole guarantee), not be refused because the mailbox has since hit
  // its cap. Nothing new is sent on that path, so it consumes no capacity.
  const result = await sendWithGuards(ctx, {
    mailbox,
    message: { fromEmail: mailbox.email, toEmail: leadEmail, subject: "Re:", body, threadId, inReplyToMessageId: null },
    sendKey,
  });

  // Persist the mapping under the LOOKUP key (not the epoch-suffixed vendor
  // key) so the next call finds it. A HIGHER epoch wins — that is a genuinely
  // later send episode superseding the one this row described. An equal epoch
  // does not clobber, which keeps the original OR IGNORE property that a
  // concurrent same-key send already recorded is never overwritten.
  ctx.sql.exec(`DELETE FROM sent_message_keys WHERE sent_at < ?`, now - SENT_MESSAGE_KEY_TTL_MS);
  ctx.sql.exec(
    `INSERT INTO sent_message_keys (send_key, message_id, sent_at, epoch) VALUES (?, ?, ?, ?)
     ON CONFLICT (send_key) DO UPDATE SET message_id = excluded.message_id, sent_at = excluded.sent_at, epoch = excluded.epoch
      WHERE excluded.epoch > sent_message_keys.epoch`,
    lookupKey,
    result.messageId,
    result.sentAt,
    epoch,
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
    JSON.stringify({ fromEmail: mailbox.email, toEmail: leadEmail, body, manual: true }),
  );

  return { messageId: result.messageId, deduplicated: false };
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
