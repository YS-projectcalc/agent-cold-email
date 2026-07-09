import type { PolledEvent } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { lookupThreadRef, type ThreadRef } from "./threads.js";

/** Cancel every still-pending future step for a lead — the stop-on-reply / bounce-suppression guard. */
function cancelPendingSteps(ctx: TenantContext, leadId: string): void {
  ctx.sql.exec(
    `UPDATE scheduled_sends SET status = 'skipped' WHERE lead_id = ? AND tenant_id = ? AND status = 'pending'`,
    leadId,
    ctx.tenantId,
  );
}

function processReply(ctx: TenantContext, ev: Extract<PolledEvent, { kind: "reply" }>, ref: ThreadRef): void {
  // Reply status + event are recorded unconditionally. Cancelling the
  // remaining sequence steps is gated on the campaign's stop_on_reply flag —
  // a customer who set stopOnReply:false wants the sequence to continue after
  // a reply (e.g. tolerating auto-responder/OOO replies). See panel-02.
  ctx.sql.exec(`UPDATE leads SET global_status = 'replied' WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId);

  const stopOnReply = ctx.sql
    .exec<{ stop_on_reply: number }>(
      `SELECT stop_on_reply FROM campaigns WHERE id = ? AND tenant_id = ?`,
      ref.campaign_id,
      ctx.tenantId,
    )
    .toArray()[0]?.stop_on_reply;
  if (stopOnReply === 1) cancelPendingSteps(ctx, ref.lead_id);

  ctx.sql.exec(
    `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
     VALUES (?, ?, ?, ?, 'reply', 0, ?, ?, ?, ?)`,
    newId("evt"),
    ctx.tenantId,
    ref.campaign_id,
    ref.lead_id,
    ev.messageId,
    ev.threadId,
    ev.receivedAt,
    JSON.stringify({ fromEmail: ev.fromEmail, body: ev.body }),
  );
}

function processBounce(ctx: TenantContext, ev: Extract<PolledEvent, { kind: "bounce" }>, ref: ThreadRef): void {
  ctx.sql.exec(`UPDATE leads SET global_status = 'bounced' WHERE id = ? AND tenant_id = ?`, ref.lead_id, ctx.tenantId);
  cancelPendingSteps(ctx, ref.lead_id);
  ctx.sql.exec(
    `INSERT INTO suppressions (tenant_id, email, reason, ts) VALUES (?, ?, 'bounce', ?)
     ON CONFLICT (tenant_id, email) DO UPDATE SET reason = excluded.reason, ts = excluded.ts`,
    ctx.tenantId,
    ev.toEmail,
    ev.receivedAt,
  );
  ctx.sql.exec(
    `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
     VALUES (?, ?, ?, ?, 'bounce', 0, ?, ?, ?, ?)`,
    newId("evt"),
    ctx.tenantId,
    ref.campaign_id,
    ref.lead_id,
    ev.originalMessageId,
    ev.threadId,
    ev.receivedAt,
    JSON.stringify({ reason: ev.reason, toEmail: ev.toEmail }),
  );
}

/**
 * poll_inbox — SPEC.md §6 flow step 6. Fetches new replies/bounces per
 * mailbox from EmailPort.poll, lands replies in the unified inbox,
 * stop-on-reply cancels remaining steps, bounces suppress the lead.
 */
export async function runPollInbox(ctx: TenantContext): Promise<{ replies: number; bounces: number }> {
  const mailboxes = ctx.sql
    .exec<{ email: string }>(`SELECT email FROM mailboxes WHERE tenant_id = ?`, ctx.tenantId)
    .toArray();

  let replies = 0;
  let bounces = 0;

  for (const mailbox of mailboxes) {
    const events = await ctx.adapters.email.poll(mailbox.email);
    for (const ev of events) {
      const ref = lookupThreadRef(ctx, ev.threadId);
      if (!ref) continue; // defensive: unknown thread, nothing to attribute it to

      if (ev.kind === "reply") {
        processReply(ctx, ev, ref);
        replies++;
      } else {
        processBounce(ctx, ev, ref);
        bounces++;
      }
    }
  }

  return { replies, bounces };
}
