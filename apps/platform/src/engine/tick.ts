import type { SequenceStep } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { refreshMailboxWarmupState } from "./mailbox-state.js";
import { pickMailboxWithCapacity } from "./scheduler.js";

interface DueSend {
  id: string;
  campaign_id: string;
  lead_id: string;
  step: number;
  thread_id: string;
  lead_email: string;
  lead_status: string;
  campaign_status: string;
  sequence_json: string;
  [column: string]: SqlStorageValue;
}

const SEND_USAGE_FEE_CENTS = 2;

/**
 * The engine tick — SPEC.md §6 flow step 5. Sends every scheduled_send
 * that's due, respecting per-mailbox daily caps and skipping any lead no
 * longer 'active' (stop-on-reply / suppression already applied by
 * engine/reply-processor.ts). Represents what a DO-alarm would do once
 * fired; B0 exposes it as a directly-callable RPC method since real
 * alarm-driven scheduling is B2 scope.
 */
export async function runTick(ctx: TenantContext): Promise<{ sent: number; skipped: number; deferred: number }> {
  refreshMailboxWarmupState(ctx);
  const now = ctx.clock.now();

  const due = ctx.sql
    .exec<DueSend>(
      `SELECT ss.id, ss.campaign_id, ss.lead_id, ss.step, ss.thread_id,
              l.email as lead_email, l.global_status as lead_status,
              c.status as campaign_status, c.sequence_json
       FROM scheduled_sends ss
       JOIN leads l ON l.id = ss.lead_id
       JOIN campaigns c ON c.id = ss.campaign_id
       WHERE ss.tenant_id = ? AND ss.status = 'pending' AND ss.send_at <= ?
       ORDER BY ss.send_at ASC`,
      ctx.tenantId,
      now,
    )
    .toArray();

  let sent = 0;
  let skipped = 0;
  let deferred = 0;

  for (const row of due) {
    if (row.lead_status !== "active" || row.campaign_status !== "active") {
      ctx.sql.exec(`UPDATE scheduled_sends SET status = 'skipped' WHERE id = ?`, row.id);
      skipped++;
      continue;
    }

    const mailboxes = ctx.sql
      .exec<{ id: string; email: string; sentToday: number; dailyCap: number }>(
        `SELECT id, email, sent_today as sentToday, daily_cap as dailyCap FROM mailboxes WHERE tenant_id = ?`,
        ctx.tenantId,
      )
      .toArray();
    const picked = pickMailboxWithCapacity(mailboxes);
    if (!picked) {
      deferred++; // no capacity this tick — stays 'pending' for a later tick
      continue;
    }

    const sequence = JSON.parse(row.sequence_json) as SequenceStep[];
    const step = sequence.find((s) => s.step === row.step);
    if (!step) {
      ctx.sql.exec(`UPDATE scheduled_sends SET status = 'skipped' WHERE id = ?`, row.id);
      skipped++;
      continue;
    }

    const result = await ctx.adapters.email.send(
      {
        fromEmail: picked.email,
        toEmail: row.lead_email,
        subject: step.subject,
        body: step.body,
        threadId: row.thread_id,
        inReplyToMessageId: null,
      },
      `send:${ctx.tenantId}:${row.id}`,
    );

    ctx.sql.exec(
      `UPDATE scheduled_sends SET status = 'sent', mailbox_id = ?, message_id = ?, sent_at = ? WHERE id = ?`,
      picked.id,
      result.messageId,
      result.sentAt,
      row.id,
    );
    ctx.sql.exec(`UPDATE mailboxes SET sent_today = sent_today + 1 WHERE id = ?`, picked.id);
    ctx.sql.exec(
      `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
       VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)`,
      newId("evt"),
      ctx.tenantId,
      row.campaign_id,
      row.lead_id,
      row.step,
      result.messageId,
      row.thread_id,
      result.sentAt,
      JSON.stringify({ fromEmail: picked.email, toEmail: row.lead_email, subject: step.subject, body: step.body }),
    );

    await ctx.adapters.billing.recordUsage(
      ctx.tenantId,
      "email send",
      SEND_USAGE_FEE_CENTS,
      `usage:${ctx.tenantId}:${row.id}`,
    );
    ctx.sql.exec(
      `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts)
       VALUES (?, ?, 'usage', ?, 'email send', ?)`,
      newId("ledg"),
      ctx.tenantId,
      SEND_USAGE_FEE_CENTS,
      result.sentAt,
    );

    sent++;
  }

  return { sent, skipped, deferred };
}
