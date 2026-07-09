import type { SequenceStep } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { reportUsageToStripeIfConfigured } from "./billing.js";
import { isLifecycleFrozen } from "./billing-state.js";
import { runDeliverabilitySweep } from "./deliverability-actions.js";
import { refreshMailboxWarmupState } from "./mailbox-state.js";
import { isWithinSendWindow, pickMailboxWithCapacity, type SendWindow } from "./scheduler.js";

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
  send_window_json: string;
  suppressed: number;
  [column: string]: SqlStorageValue;
}

const SEND_USAGE_FEE_CENTS = 2;

const DEFAULT_SEND_WINDOW: SendWindow = { startHour: 0, endHour: 23 };

function parseSendWindow(raw: string): SendWindow {
  try {
    const parsed = JSON.parse(raw) as Partial<SendWindow>;
    if (typeof parsed?.startHour === "number" && typeof parsed?.endHour === "number") {
      return { startHour: parsed.startHour, endHour: parsed.endHour };
    }
  } catch {
    // fall through to the permissive default
  }
  return DEFAULT_SEND_WINDOW;
}

/**
 * The engine tick — SPEC.md §6 flow step 5. Sends every scheduled_send that's
 * due, enforcing at SEND TIME (not just at launch): per-mailbox daily caps,
 * lead/campaign status, the suppressions table, and the campaign send window.
 * Each row is claimed atomically (status pending -> sending) before the network
 * send so a concurrent/retried tick cannot double-process it; usage is recorded
 * before the 'sent'/cap side-effects commit so a row is never left
 * sent-but-unbilled. Represents what a DO-alarm would do once fired; B0 exposes
 * it as a directly-callable RPC method since real alarm-driven scheduling is B2.
 */
export async function runTick(ctx: TenantContext): Promise<{ sent: number; skipped: number; deferred: number }> {
  // D5 tenant-level freeze (kill switch). A suspended tenant (dunning SUSPEND
  // or an abuse TERMINATE), a chargeback-disputed tenant, OR a canceled/
  // canceling tenant sends NOTHING (adversarial panel-03 finding #5 added
  // canceled/canceling — a voluntary cancel used to leave the tick unfrozen, so
  // a canceled tenant kept sending). The single predicate is shared with the
  // deliverability sweep + the setup/launch guards (engine/billing-state.ts).
  // Reads state cheaply, no await added before it — the forced sync shape of
  // the send loop below is preserved.
  const lifecycle = ctx.sql
    .exec<{ status: string; billing_state: string }>(
      `SELECT status, billing_state FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();
  if (isLifecycleFrozen(lifecycle.status, lifecycle.billing_state)) {
    return { sent: 0, skipped: 0, deferred: 0 };
  }

  refreshMailboxWarmupState(ctx);
  // Deliverability control loop runs BEFORE scheduling (B6): a mailbox whose
  // complaint/bounce rate has crossed a threshold is throttled/paused, and a
  // burning domain is retired + replaced, so the send loop below never sends
  // more from a degrading mailbox this tick. Paused mailboxes are excluded from
  // the capacity picker query, which realizes the ROTATE reroute.
  await runDeliverabilitySweep(ctx);
  const now = ctx.clock.now();

  const due = ctx.sql
    .exec<DueSend>(
      `SELECT ss.id, ss.campaign_id, ss.lead_id, ss.step, ss.thread_id,
              l.email as lead_email, l.global_status as lead_status,
              c.status as campaign_status, c.sequence_json, c.send_window_json,
              CASE WHEN sup.email IS NOT NULL THEN 1 ELSE 0 END as suppressed
       FROM scheduled_sends ss
       JOIN leads l ON l.id = ss.lead_id
       JOIN campaigns c ON c.id = ss.campaign_id
       LEFT JOIN suppressions sup ON sup.tenant_id = ss.tenant_id AND sup.email = l.email
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
    // Skip: lead no longer active, campaign not active, or the address is
    // suppressed (bounce/complaint/unsub) — checked HERE at send time, across
    // every campaign, so a suppression created after launch is honored.
    if (row.lead_status !== "active" || row.campaign_status !== "active" || row.suppressed) {
      ctx.sql.exec(`UPDATE scheduled_sends SET status = 'skipped' WHERE id = ?`, row.id);
      skipped++;
      continue;
    }

    // Defer (leave 'pending'): outside the campaign's configured send window.
    if (!isWithinSendWindow(now, parseSendWindow(row.send_window_json))) {
      deferred++;
      continue;
    }

    const mailboxes = ctx.sql
      .exec<{ id: string; email: string; sentToday: number; dailyCap: number }>(
        `SELECT id, email, sent_today as sentToday, daily_cap as dailyCap FROM mailboxes
         WHERE tenant_id = ? AND deliv_status != 'paused'`,
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

    // Atomic claim BEFORE the network await: another concurrent/retried tick
    // that reads this row as still 'pending' will fail this conditional UPDATE
    // (rowsWritten === 0) and skip it, so the row is sent exactly once even
    // when the real EmailPort's fetch() opens the DO input gate.
    const claim = ctx.sql.exec(
      `UPDATE scheduled_sends SET status = 'sending' WHERE id = ? AND status = 'pending'`,
      row.id,
    );
    if (claim.rowsWritten !== 1) continue; // another tick already owns this row

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

    // Record usage BEFORE committing 'sent' + cap consumption, so a row is
    // never left sent-but-unbilled. Wrapped per-row: one billing failure
    // reverts JUST this row to 'pending' for retry (email.send is idempotent
    // on that idempotency key) instead of throwing out of the whole batch.
    try {
      await ctx.adapters.billing.recordUsage(
        ctx.tenantId,
        "email send",
        SEND_USAGE_FEE_CENTS,
        `usage:${ctx.tenantId}:${row.id}`,
      );
    } catch {
      ctx.sql.exec(`UPDATE scheduled_sends SET status = 'pending' WHERE id = ?`, row.id);
      deferred++; // left pending — a later tick retries this row
      continue;
    }

    // Usage is durably recorded: now commit 'sent' + cap + event + local ledger
    // mirror together. These are all synchronous with no await between them, so
    // within the DO they land as one unit. The ledger insert is idempotent on
    // source_send_id, a second defense against a double-counted usage entry.
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
    ctx.sql.exec(
      `INSERT OR IGNORE INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts, source_send_id)
       VALUES (?, ?, 'usage', ?, 'email send', ?, ?)`,
      newId("ledg"),
      ctx.tenantId,
      SEND_USAGE_FEE_CENTS,
      result.sentAt,
      row.id,
    );
    await reportUsageToStripeIfConfigured(ctx, 1); // inert without env.STRIPE_SECRET_KEY — see engine/billing.ts

    sent++;
  }

  return { sent, skipped, deferred };
}
