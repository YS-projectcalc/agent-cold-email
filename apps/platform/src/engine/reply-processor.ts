import type { PolledEvent } from "@coldstart/shared";
import { CRON_PERIOD_MS } from "../admin/ops-sweep.js";
import { BUDGET_EXPIRED, rotationOffset, withItemBudget } from "../isolated-loop.js";
import type { TenantContext } from "../tenant-context.js";
import { logAction } from "./deliverability-actions.js";
import { recordEventIfNew } from "./events.js";
import { cancelPendingSteps, suppress, unsubscribeEmail } from "./suppression.js";
import { lookupThreadRef, type ThreadRef } from "./threads.js";

// IN-9's two constants, both derived from the 5-rung ordering ladder in
// vendors/real/email-port.ts. Read that comment before changing either.
//
// PER-MAILBOX: a poll is SAFELY ABANDONABLE in a way a send is not — abandoning
// one leaves the consumer-owned cursor un-advanced, so the events are simply
// redelivered next cycle and deduped on message_id. That is why this sits far
// below ENGINE_REQUEST_TIMEOUT_MS (120s), which was sized around the engine's
// ~100s worst-case SMTP TRANSACTION (ladder rung 1) and has no counterpart on
// the poll path: a poll is one bounded IMAP fetch of at most POLL_BATCH_CAP
// (300) UIDs. 30s is well above any honest fetch and a quarter of the time a
// wedged mailbox used to hold the whole tenant.
const POLL_MAILBOX_BUDGET_MS = 30_000;

// PHASE: checked BETWEEN mailboxes, so the poll can never consume the tick's
// share of SEND_PIPELINE_TENANT_BUDGET_MS (135s). Worst case is this deadline
// plus one mailbox budget = 90s (the deadline is checked before starting a
// mailbox, exactly like the leg deadline in ops-sweep.ts), leaving >= 45s of the
// tenant budget for the tick — against 0s today, which is the whole harm.
const POLL_PHASE_BUDGET_MS = 60_000;

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
      // IN-14 — a second DSN for this send cannot get its own row (the key is
      // the ORIGINAL send's id), so let it correct the reason it supersedes.
      refreshMetadataOnRepeat: true,
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
    // IN-14 — the greylisting case this exists for: 4.4.1 "delayed" then a
    // later 4.2.2 "mailbox full" on one key. Keep ONE event and one streak
    // increment, keep the LATER reason.
    refreshMetadataOnRepeat: true,
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
    // IN-14 — same shape as the bounce paths: an ARF report carries no id of
    // its own, so a second one for this send can only correct the first.
    refreshMetadataOnRepeat: true,
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
  // Injectable budgets — the same seam `runSendPipelineAllTenants` exposes for
  // the leg above, and for the same reason: the fairness property (IN-9) is
  // about wall-clock starvation, so it cannot be asserted without shrinking the
  // clock. Production callers pass nothing.
  opts: { mailboxBudgetMs?: number; phaseBudgetMs?: number } = {},
): Promise<{ replies: number; bounces: number; complaints: number }> {
  const mailboxBudgetMs = opts.mailboxBudgetMs ?? POLL_MAILBOX_BUDGET_MS;
  const phaseBudgetMs = opts.phaseBudgetMs ?? POLL_PHASE_BUDGET_MS;
  // N6 (wave-2 design v2 §7) — RELEASED mailboxes are excluded at the root.
  // Without this, every torn-down mailbox cost a doomed engine round trip on
  // every poll, forever: the cron drives this every 5 minutes, and a released
  // mailbox is unknown to the engine (its credentials were revoked), so each
  // one burns a full request timeout against a slow engine and then throws.
  // The tick's picker excluded them already; this query did not.
  //
  // ORDER BY is load-bearing, not tidiness (head-of-line class sweep
  // 2026-08-17, IN-9): without it SQLite returns whatever order the index walk
  // produces, which is stable in practice — so which mailbox is starved by the
  // rotation below would be arbitrary AND unrepeatable, and the fairness
  // property would be untestable.
  const mailboxes = ctx.sql
    .exec<{ email: string; poll_cursor: number }>(
      `SELECT email, poll_cursor FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL ORDER BY email`,
      ctx.tenantId,
    )
    .toArray();

  let replies = 0;
  let bounces = 0;
  let complaints = 0;

  // IN-9, THE STALL VARIANT. The per-mailbox catch below has always been correct
  // for THROWS, and this loop is in-class anyway: every mailbox drew on ONE
  // shared SEND_PIPELINE_TENANT_BUDGET_MS (135s) and a single engine poll may
  // consume ENGINE_REQUEST_TIMEOUT_MS (120s), so one mailbox whose IMAP host
  // black-holes connections burned nearly the whole tenant budget — mailboxes
  // 2..N were never polled AND runScheduledTick never ran, so the tenant sent
  // nothing, every 5-minute cycle, permanently. ops-sweep.ts reasons about this
  // only for a WHOLLY wedged engine ("the tick could not have sent anything
  // either"); that argument does not hold when exactly one mailbox is wedged.
  //
  // The fix is the pattern this repo already invented one layer up, pushed down
  // inside the tenant: a per-mailbox sub-budget + a cycle-derived rotation
  // offset. Both halves are required — a budget alone still re-starves the same
  // head mailbox every cycle, and rotation alone still lets one mailbox eat the
  // tick's share of the budget.
  const startedAt = ctx.clock.now();
  const offset = rotationOffset(startedAt, CRON_PERIOD_MS, mailboxes.length);

  for (let i = 0; i < mailboxes.length; i++) {
    if (ctx.clock.now() - startedAt >= phaseBudgetMs) {
      console.warn(
        `poll phase budget reached after ${i}/${mailboxes.length} mailbox(es) for tenant ${ctx.tenantId} — the rest are deferred to a later cycle (rotation reaches them), and the tick keeps its share of the budget`,
      );
      break;
    }
    const mailbox = mailboxes[(offset + i) % mailboxes.length] as { email: string; poll_cursor: number };
    // PER-MAILBOX ISOLATION (N6). One mailbox's throw — an uncredentialed
    // address, a transient engine failure, a vendor hiccup — used to abort the
    // WHOLE tenant's poll, so a single bad mailbox silently stopped every
    // other mailbox's replies/bounces from ever being processed. The failed
    // mailbox's cursor stays un-advanced (nothing below it ran), so its events
    // are redelivered on the next poll and deduped on message_id — no event
    // loss, exactly like a lost poll response.
    try {
      // CONSUMER-OWNED CURSOR (persist-after-confirm class fix): pass our stored
      // high-water, process, then advance it. The engine holds no cursor, so a
      // lost poll response leaves poll_cursor un-advanced and the next poll
      // redelivers the same events (deduped below on message_id).
      const outcome = await withItemBudget(mailboxBudgetMs, () =>
        ctx.adapters.email.poll(mailbox.email, mailbox.poll_cursor),
      );
      if (outcome === BUDGET_EXPIRED) {
        // Abandoned, not failed. Nothing below ran, so this mailbox's cursor is
        // un-advanced and its events are redelivered next cycle and deduped on
        // message_id — the same no-loss position as a lost poll response. The
        // abandoned request keeps running engine-side; it writes nothing here.
        console.warn(`poll for mailbox ${mailbox.email} exceeded its ${mailboxBudgetMs}ms budget — abandoned for this cycle`);
        continue;
      }
      const { events, cursor, unreadable } = outcome;
      // IN-7 — the engine permanently skipped a message it could not parse, so
      // the cursor below can move past it and this mailbox keeps working. That
      // is a reply/bounce we will never see, so it is recorded where an operator
      // reads it rather than only in the engine's container log. Bounded by
      // construction: the cursor advances past the poison message, so it is
      // reported once, not every cycle.
      if (unreadable) {
        logAction(ctx, "INBOUND_MESSAGE_UNREADABLE", mailbox.email, {
          count: unreadable,
          reason: "the mail engine could not parse these messages and skipped them so this mailbox keeps processing — they are not recoverable",
          throughCursor: cursor,
        });
      }
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
      // last_polled_at (Settings→Mailboxes UI claim). The clock is read HERE,
      // after this mailbox's own await, rather than hoisted above the loop: a
      // hoisted value would record every mailbox in a long poll as synced at the
      // moment the first one started (wave-2 N7's class).
      ctx.sql.exec(
        `UPDATE mailboxes SET last_polled_at = ?, poll_cursor = ? WHERE email = ? AND tenant_id = ?`,
        ctx.clock.now(),
        cursor,
        mailbox.email,
        ctx.tenantId,
      );
    } catch (err) {
      console.error(`poll failed for mailbox ${mailbox.email} (cursor left un-advanced; other mailboxes still polled)`, err);
    }
  }

  return { replies, bounces, complaints };
}
