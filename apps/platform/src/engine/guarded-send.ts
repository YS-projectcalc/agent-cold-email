import { SendBlockedError, type SendEmailInput, type SendEmailResult } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { refreshMailboxWarmupState } from "./mailbox-state.js";

/**
 * The shared GUARDED single-send primitive — warm-lead Q3 (ROADMAP.md:76,
 * founder-ratified) and adversary R1/R2 (`docs/adversarial/
 * warm-lead-thin-layer-design-2026-07-16.md`), which named exactly this
 * function as the required reuse target: "the honest reuse target is a *new
 * shared guarded-send primitive*, not `replyToThread`."
 *
 * Every ONE-OFF send (a manual thread reply today; `schedule_followup`'s drain
 * when it is built) goes through here so it is subject to the SAME send
 * governance the campaign tick enforces inline — a manual reply is real
 * sending volume from a real mailbox, and before this existed an agent could
 * loop `reply` and send unbounded mail from a day-1 or deliverability-paused
 * mailbox while `infrastructure_status` still reported `sentToday: 0`.
 *
 * NOT a copy of `runTick`'s loop, and deliberately narrower than it:
 * - the mailbox is GIVEN (the thread's own sending mailbox), not picked, so
 *   there is no `pickMailboxWithCapacity` call — capacity is asserted against
 *   that one mailbox instead.
 * - the tick's `lead_status !== 'active'` skip is NOT applied. A lead that
 *   replied is exactly who a manual reply is for, and `global_status` moves
 *   off 'active' on reply — reusing that check would refuse the entire warm
 *   conversation this path exists to serve. Suppression (the compliance
 *   signal) is re-checked; lead lifecycle status (a sequencing signal) is not.
 * - send-window deferral is a CAMPAIGN setting with no campaign in scope for a
 *   human-triggered one-off, and a `scheduled_sends` claim has no analogue
 *   (there is no row to claim — the caller owns its own idempotency; see
 *   `threads.ts`'s durable send-key map).
 */
export interface GuardedSendInput {
  /** The already-resolved sending mailbox. `message.fromEmail` must be its address. */
  mailbox: { id: string; email: string };
  message: SendEmailInput;
  /** Vendor idempotency key — the caller owns its stability (B3). */
  sendKey: string;
}

export async function sendWithGuards(ctx: TenantContext, input: GuardedSendInput): Promise<SendEmailResult> {
  const { mailbox, message } = input;

  // GUARD ORDER is by permanence, most-permanent first, so the reason a caller
  // is told is the one that actually needs acting on: a suppression never
  // clears by itself, a deliverability pause clears only when the operator/
  // control loop lifts it (nothing in this codebase auto-un-pauses a mailbox),
  // and a daily cap clears on its own at the next virtual-day rollover.

  // 1. Suppression re-check, tenant-scoped. Re-checked HERE at send time, not
  //    at whatever earlier moment the thread was created, so an opt-out that
  //    landed after the conversation started is honored — the same send-time
  //    (not launch-time) discipline `tick.ts`'s suppressions LEFT JOIN applies.
  const suppressed = ctx.sql
    .exec<{ email: string }>(
      `SELECT email FROM suppressions WHERE tenant_id = ? AND email = ?`,
      ctx.tenantId,
      message.toEmail,
    )
    .toArray().length > 0;
  if (suppressed) {
    throw new SendBlockedError(
      "suppressed",
      `${message.toEmail} is suppressed for this account (bounce, complaint, or opt-out) — no further email may be sent to it.`,
      false,
    );
  }

  // Bring daily_cap/status/sent_today in line with the injected clock BEFORE
  // reading capacity — identical to what `runTick` does at its top, and what
  // makes the cap below the LIVE warmup-ramp cap (and any deliverability
  // throttle, which persists as `cap_override` and is MIN'd in) rather than a
  // stale column. It also performs the virtual-day `sent_today` reset, so a
  // reply on a new day is not refused against yesterday's tally.
  refreshMailboxWarmupState(ctx);

  const row = ctx.sql
    .exec<{ deliv_status: string; sent_today: number; daily_cap: number }>(
      `SELECT deliv_status, sent_today, daily_cap FROM mailboxes WHERE id = ? AND tenant_id = ?`,
      mailbox.id,
      ctx.tenantId,
    )
    .toArray()[0];
  if (!row) {
    throw new SendBlockedError(
      "mailbox_paused",
      `mailbox ${mailbox.email} is no longer available for sending on this account.`,
      false,
    );
  }

  // 2. Deliverability pause — the control loop's hard stop (engine/
  //    deliverability-actions.ts). The tick realizes it by excluding paused
  //    mailboxes from its capacity picker; with a fixed mailbox the equivalent
  //    is a refusal, since there is nowhere else to route a same-thread reply.
  if (row.deliv_status === "paused") {
    throw new SendBlockedError(
      "mailbox_paused",
      `mailbox ${mailbox.email} is paused by the deliverability control loop — sending from it is blocked until it is reviewed.`,
      false,
    );
  }

  // 3. Daily cap, RESERVED atomically rather than read-then-checked. The
  //    vendor send below is an await, which reopens the DO input gate — two
  //    concurrent replies that had each merely READ `sent_today < daily_cap`
  //    could both proceed and overshoot the cap. This single conditional
  //    UPDATE is the check and the increment in one synchronous statement
  //    (the same `rowsWritten` claim idiom `tick.ts` uses on scheduled_sends),
  //    so capacity is consumed before anything can interleave.
  const reserved = ctx.sql.exec(
    `UPDATE mailboxes SET sent_today = sent_today + 1 WHERE id = ? AND tenant_id = ? AND sent_today < daily_cap`,
    mailbox.id,
    ctx.tenantId,
  );
  if (reserved.rowsWritten !== 1) {
    throw new SendBlockedError(
      "daily_cap_reached",
      `mailbox ${mailbox.email} has used its full send allowance for today (${row.sent_today}/${row.daily_cap}) — a warming mailbox ramps up over ~4 weeks. Retry after the daily counter rolls over.`,
      true,
    );
  }

  try {
    return await ctx.adapters.email.send(message, input.sendKey);
  } catch (err) {
    // The send never landed, so release the reservation: `sent_today` must end
    // up incremented ONLY on success (the tick's semantics — it increments
    // after a successful send and not at all on a graded failure). Without
    // this, a run of transient vendor failures would silently burn the whole
    // day's allowance for zero delivered mail. Guarded by `sent_today > 0` so
    // a concurrent day-rollover reset can't drive the counter negative.
    ctx.sql.exec(
      `UPDATE mailboxes SET sent_today = sent_today - 1 WHERE id = ? AND tenant_id = ? AND sent_today > 0`,
      mailbox.id,
      ctx.tenantId,
    );
    throw err;
  }
}
