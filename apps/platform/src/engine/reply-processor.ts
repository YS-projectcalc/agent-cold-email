import type { PolledEvent } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { recordEventIfNew } from "./events.js";
import { cancelPendingSteps, suppress, unsubscribeEmail } from "./suppression.js";
import { lookupThreadRef, type ThreadRef } from "./threads.js";

// A2 (CLASS A) — a soft (transient 4.x.x) bounce is tallied, not permanently
// suppressed; only after this many soft bounces for one address — with NO reply
// (positive engagement) in between — is the address escalated into the permanent
// suppression list, on the theory that a persistently-unreachable soft is
// effectively hard. The streak is cumulative-until-reply BY DESIGN: this
// architecture has no delivery receipt, so a send can't prove the mailbox is
// alive; only a reply resets the streak (see processReply). Three soft bounces
// with zero engagement between them, across any time span or campaign, is treated
// as an effectively-dead mailbox.
export const SOFT_BOUNCE_SUPPRESS_THRESHOLD = 3;

// backend gaps brief item 3 / B4 TODO (tick.ts:46-56) — this engine had ZERO
// inbound opt-out parsing: a prospect typing "unsubscribe" landed as an
// ordinary reply. Deliberately CONSERVATIVE (a false positive silently drops
// a real, engaged lead — worse than missing an oddly-worded genuine opt-out,
// which can always be retried via the hosted one-click link or a plainer
// reply): matches ONLY when, after stripping quoted-reply noise and a
// leading/trailing "please", the ENTIRE remaining reply body is exactly one
// of these phrases — not merely a body that MENTIONS one of them.
const UNSUBSCRIBE_INTENT_PHRASES = new Set([
  "unsubscribe",
  "unsubscribe me",
  "remove me",
  "remove me from this list",
  "remove me from your list",
  "remove me from this mailing list",
  "remove me from your mailing list",
  "opt out",
  "opt-out",
  "stop emailing me",
  "take me off this list",
  "take me off your list",
  "take me off this mailing list",
]);

// Matches a standard top-posting quote header ("On <date>, <name> wrote:")
// or a plain-text client's "-----Original Message-----" separator — either
// marks the start of quoted history below the human's own typed reply.
const QUOTE_HEADER_PATTERN = /^\s*on .+ wrote:\s*$/im;
const ORIGINAL_MESSAGE_PATTERN = /^-{2,}\s*original message\s*-{2,}$/im;

/**
 * Conservative unsubscribe-INTENT matcher (see the phrase-set comment
 * above). Exported for direct unit testing (test/unsubscribe-intent-
 * matcher.test.ts) in addition to the end-to-end coverage through
 * runPollInbox — the string-cleanup edge cases (quoting, punctuation,
 * "please") are cheaper to prove exhaustively as a pure function.
 */
export function isUnsubscribeIntentReply(body: string): boolean {
  let primary = body
    .split(/\r?\n/)
    // Drop quoted-reply lines (top-posting clients prefix quoted history
    // with '>') before looking for a quote-header/separator line.
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .split(QUOTE_HEADER_PATTERN)[0]!
    .split(ORIGINAL_MESSAGE_PATTERN)[0]!
    .trim()
    .toLowerCase()
    .replace(/[.!?,\s]+$/g, ""); // trailing punctuation/whitespace only

  primary = primary.replace(/^please\s+/, "").replace(/\s+please$/, "");

  return UNSUBSCRIBE_INTENT_PHRASES.has(primary);
}

function processReply(ctx: TenantContext, ev: Extract<PolledEvent, { kind: "reply" }>, ref: ThreadRef): boolean {
  // Idempotency-first: a re-polled reply (same messageId) writes no second
  // event row and applies none of the side effects below a second time.
  const isNew = recordEventIfNew(ctx, {
    campaignId: ref.campaign_id,
    leadId: ref.lead_id,
    type: "reply",
    step: 0,
    messageId: ev.messageId,
    threadId: ev.threadId,
    ts: ev.receivedAt,
    metadata: { fromEmail: ev.fromEmail, body: ev.body },
  });
  if (!isNew) return false;

  // A2 (CLASS A): a reply is the ONLY positive-engagement signal this
  // architecture can observe (no delivery receipts), so it — and only it —
  // resets the soft-bounce streak for this address. Keyed on the lead's own
  // email (the address we send to / bounce on), matching the streak's key.
  const leadEmail = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM leads WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId)
    .toArray()[0]?.email;
  if (leadEmail) {
    ctx.sql.exec(`DELETE FROM soft_bounces WHERE tenant_id = ? AND email = ?`, ctx.tenantId, leadEmail);
  }

  // backend gaps brief item 3 / B4 TODO — a typed opt-out ALWAYS wins over
  // stopOnReply (an explicit "unsubscribe" must stop future sends even on a
  // campaign configured to keep sending through an OOO-style reply, unlike a
  // generic reply where continuing is the customer's deliberate choice) and
  // supersedes the unconditional 'replied' status below with the correct
  // terminal 'suppressed' state (unsubscribeEmail sets it) — the same way a
  // complaint/hard-bounce below never visit 'replied' either. The reply event
  // itself is already durably recorded above regardless of this branch.
  if (leadEmail && isUnsubscribeIntentReply(ev.body)) {
    unsubscribeEmail(ctx, leadEmail, ev.receivedAt);
    return true;
  }

  // Reply status is recorded unconditionally. Cancelling the remaining sequence
  // steps is gated on the campaign's stop_on_reply flag — a customer who set
  // stopOnReply:false wants the sequence to continue after a reply (e.g.
  // tolerating auto-responder/OOO replies). See panel-02.
  ctx.sql.exec(`UPDATE leads SET global_status = 'replied' WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId);

  const stopOnReply = ctx.sql
    .exec<{ stop_on_reply: number }>(
      `SELECT stop_on_reply FROM campaigns WHERE id = ? AND tenant_id = ?`,
      ref.campaign_id,
      ctx.tenantId,
    )
    .toArray()[0]?.stop_on_reply;
  if (stopOnReply === 1) cancelPendingSteps(ctx, ref.lead_id);
  return true;
}

function processBounce(ctx: TenantContext, ev: Extract<PolledEvent, { kind: "bounce" }>, ref: ThreadRef): boolean {
  // A2 (CLASS A): branch on the bounce's transient-vs-permanent grade. A hard
  // (5.x.x) bounce is permanent — suppress + cancel now. A soft (4.x.x) bounce
  // is transient — tally only, and suppress ONLY after a streak of soft bounces
  // with no reply in between (see SOFT_BOUNCE_SUPPRESS_THRESHOLD).
  if (ev.severity === "hard") {
    const isNew = recordEventIfNew(ctx, {
      campaignId: ref.campaign_id,
      leadId: ref.lead_id,
      type: "bounce",
      step: 0,
      messageId: ev.originalMessageId,
      threadId: ev.threadId,
      ts: ev.receivedAt,
      metadata: { reason: ev.reason, toEmail: ev.toEmail, severity: "hard" },
    });
    if (!isNew) return false;
    ctx.sql.exec(`UPDATE leads SET global_status = 'bounced' WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId);
    cancelPendingSteps(ctx, ref.lead_id);
    suppress(ctx, ev.toEmail, "bounce", ev.receivedAt);
    // The address is now permanently suppressed — the soft-bounce streak (if any)
    // is moot; drop the row so no dead tally lingers.
    ctx.sql.exec(`DELETE FROM soft_bounces WHERE tenant_id = ? AND email = ?`, ctx.tenantId, ev.toEmail);
    return true;
  }

  // Soft bounce: recorded as a DISTINCT 'soft_bounce' event type so the
  // deliverability control loop's hard-bounce-rate counting (engine/
  // deliverability.ts) excludes it — a soft bounce never triggers pause/burn/
  // spend — while it stays visible in mailbox-health output (A3).
  const isNew = recordEventIfNew(ctx, {
    campaignId: ref.campaign_id,
    leadId: ref.lead_id,
    type: "soft_bounce",
    step: 0,
    messageId: ev.originalMessageId,
    threadId: ev.threadId,
    ts: ev.receivedAt,
    metadata: { reason: ev.reason, toEmail: ev.toEmail, severity: "soft" },
  });
  if (!isNew) return false;

  // Non-idempotent tally — guarded above so a re-polled soft never double-counts.
  // The streak is CUMULATIVE-UNTIL-REPLY: absence-of-bounce is unobservable here
  // (no delivery receipt), so a send can't clear it — only a reply does (see
  // processReply). It therefore accumulates soft bounces with zero engagement in
  // between, across any time span or campaign.
  ctx.sql.exec(
    `INSERT INTO soft_bounces (tenant_id, email, streak, last_ts) VALUES (?, ?, 1, ?)
     ON CONFLICT (tenant_id, email) DO UPDATE SET streak = streak + 1, last_ts = excluded.last_ts`,
    ctx.tenantId,
    ev.toEmail,
    ev.receivedAt,
  );
  const streak = ctx.sql
    .exec<{ streak: number }>(
      `SELECT streak FROM soft_bounces WHERE tenant_id = ? AND email = ?`,
      ctx.tenantId,
      ev.toEmail,
    )
    .one().streak;

  // Escalate a persistently-soft address to permanent suppression (treat as
  // hard). The lead stays 'active' and the sequence keeps running below the
  // threshold — that is the whole point of the soft/hard split.
  if (streak >= SOFT_BOUNCE_SUPPRESS_THRESHOLD) {
    ctx.sql.exec(`UPDATE leads SET global_status = 'bounced' WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId);
    cancelPendingSteps(ctx, ref.lead_id);
    suppress(ctx, ev.toEmail, "soft_bounce", ev.receivedAt);
    // Now permanently suppressed — the streak row is moot; drop it.
    ctx.sql.exec(`DELETE FROM soft_bounces WHERE tenant_id = ? AND email = ?`, ctx.tenantId, ev.toEmail);
  }
  return true;
}

function processComplaint(ctx: TenantContext, ev: Extract<PolledEvent, { kind: "complaint" }>, ref: ThreadRef): boolean {
  // A spam complaint is terminal for the lead: suppress the address (never
  // re-mail a complainer — legal + deliverability hygiene) and cancel any
  // remaining sequence steps, exactly like a hard bounce. The event is recorded
  // with the ORIGINAL send's message id so the deliverability control loop
  // (engine/deliverability.ts) can join it back to the sending mailbox.
  // Idempotency-first (B1): a re-polled complaint applies nothing twice.
  const isNew = recordEventIfNew(ctx, {
    campaignId: ref.campaign_id,
    leadId: ref.lead_id,
    type: "complaint",
    step: 0,
    messageId: ev.originalMessageId,
    threadId: ev.threadId,
    ts: ev.receivedAt,
    metadata: { toEmail: ev.toEmail, mailboxEmail: ev.mailboxEmail },
  });
  if (!isNew) return false;

  ctx.sql.exec(
    `UPDATE leads SET global_status = 'suppressed' WHERE id = ? AND tenant_id = ?`,
    ref.lead_id,
    ctx.tenantId,
  );
  cancelPendingSteps(ctx, ref.lead_id);
  suppress(ctx, ev.toEmail, "complaint", ev.receivedAt);
  return true;
}

/**
 * poll_inbox — SPEC.md §6 flow step 6. Fetches new replies/bounces/complaints
 * per mailbox from EmailPort.poll, lands replies in the unified inbox,
 * stop-on-reply cancels remaining steps, hard bounces AND complaints suppress
 * the lead, soft bounces are tallied (A2). Every event is deduped on its
 * message id (B1) so an at-least-once re-poll applies each side effect at most
 * once. Complaints/hard-bounces additionally feed the deliverability control
 * loop's per-mailbox rate (engine/deliverability.ts).
 */
export async function runPollInbox(
  ctx: TenantContext,
): Promise<{ replies: number; bounces: number; complaints: number }> {
  const mailboxes = ctx.sql
    .exec<{ email: string; poll_cursor: number }>(`SELECT email, poll_cursor FROM mailboxes WHERE tenant_id = ?`, ctx.tenantId)
    .toArray();

  let replies = 0;
  let bounces = 0;
  let complaints = 0;
  const now = ctx.clock.now();

  for (const mailbox of mailboxes) {
    // CONSUMER-OWNED CURSOR (persist-after-confirm class fix): pass our stored
    // high-water, process, then advance it. The engine holds no cursor, so a
    // lost poll response leaves poll_cursor un-advanced and the next poll
    // redelivers the same events (deduped below on message_id).
    const { events, cursor } = await ctx.adapters.email.poll(mailbox.email, mailbox.poll_cursor);
    for (const ev of events) {
      const ref = lookupThreadRef(ctx, ev.threadId);
      if (!ref) continue; // defensive: unknown thread, nothing to attribute it to

      // A duplicate (already-processed) event returns false and is NOT counted,
      // so a double poll of the same reply yields metrics().replies === 1.
      if (ev.kind === "reply") {
        if (processReply(ctx, ev, ref)) replies++;
      } else if (ev.kind === "bounce") {
        if (processBounce(ctx, ev, ref)) bounces++;
      } else {
        if (processComplaint(ctx, ev, ref)) complaints++;
      }
    }
    // Advance the cursor + stamp last-sync in the SAME synchronous stretch as
    // the event processing above (no await between) — the DO commits the event
    // side effects and the cursor advance as one unit at the next await/return.
    // SPEC.md §19.2/§19.6 (M1): every poll, including a zero-event one, stamps
    // last_polled_at (Settings→Mailboxes UI claim).
    ctx.sql.exec(
      `UPDATE mailboxes SET last_polled_at = ?, poll_cursor = ? WHERE email = ? AND tenant_id = ?`,
      now,
      cursor,
      mailbox.email,
      ctx.tenantId,
    );
  }

  return { replies, bounces, complaints };
}
