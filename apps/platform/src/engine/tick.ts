import { VendorError, type SequenceStep } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { reportUsageToStripeIfConfigured } from "./billing.js";
import { isLifecycleFrozen } from "./billing-state.js";
import { runDeliverabilitySweep } from "./deliverability-actions.js";
import { refreshMailboxWarmupState } from "./mailbox-state.js";
import { isWithinSendWindow, pickMailboxWithCapacity, type SendWindow } from "./scheduler.js";
import { renderTemplate } from "./template.js";

interface DueSend {
  id: string;
  campaign_id: string;
  lead_id: string;
  step: number;
  thread_id: string;
  lead_email: string;
  lead_first_name: string;
  lead_company: string;
  lead_status: string;
  campaign_status: string;
  sequence_json: string;
  send_window_json: string;
  suppressed: number;
  attempts: number;
  [column: string]: SqlStorageValue;
}

const SEND_USAGE_FEE_CENTS = 2;

// A4 (CLASS A) — retry ceiling for a RETRYABLE vendor failure on the post-send
// billing step. At the cap the send is marked 'failed' (ops-visible) instead of
// reverted-to-pending forever, so no infinite-retry path survives.
const MAX_SEND_ATTEMPTS = 5;

// Stuck-'sending' reclaim TTL (persist-before-confirm class). A row claimed
// 'sending' is only held across ONE send()+billing round trip (seconds); a DO
// that dies in that window leaves the row stuck 'sending' with no in-tick catch
// to grade it. A later tick reclaims a 'sending' row older than this back to
// 'pending' (send is idempotent on its key, so a re-send is a no-op). Sized far
// above a legitimate in-flight send yet well under the idempotency 'pending'
// reclaim window, so a genuinely orphaned row unblocks promptly.
const SEND_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * RFC 8058 List-Unsubscribe header value (SPEC.md §0.8 / ARCHITECTURE.md #8).
 * The `mailto:` opt-out is expressible today (the sending mailbox is a real,
 * polled inbox). TODO(B4): the https one-click form + the matching
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header need the
 * hosted unsubscribe endpoint + inbound opt-out parsing built in the
 * "Sequencing + reply engine — full CAN-SPAM opt-out flow" lane (ROADMAP B4);
 * until then only the mailto form is populated (never a silent gap).
 */
function buildListUnsubscribe(mailboxEmail: string, threadId: string): string {
  return `<mailto:${mailboxEmail}?subject=${encodeURIComponent(`unsubscribe ${threadId}`)}>`;
}

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

  // Reclaim rows orphaned in 'sending' — a DO that died between the claim and
  // the terminal update (no in-tick catch ran to grade them), or an engine send
  // that stalled past the reclaim TTL. TTL-bounded like the idempotency
  // 'pending' reclaim (engine/idempotency.ts). Each reclaim BUMPS attempts and
  // is capped by MAX_SEND_ATTEMPTS: without the bump an endlessly-orphaned row
  // would reclaim→retry forever with no ceiling (engine-host-review-2026-07-14).
  // Under the cap the row reverts to 'pending' for a later tick — email.send is
  // idempotent on its key, and the engine's in-flight claim (apps/engine/src/
  // engine.ts) makes a re-send that races a still-live send safe, so a re-send
  // of one that DID go out is a no-op; at the cap it is graded 'failed' with an
  // ops-visible 'failed' event, exactly like the in-tick send-failure taxonomy
  // below (a 'failed' row with no event would be invisible to campaign_results).
  const orphaned = ctx.sql
    .exec<{ id: string; campaign_id: string; lead_id: string; step: number; thread_id: string; attempts: number }>(
      `SELECT id, campaign_id, lead_id, step, thread_id, attempts FROM scheduled_sends
       WHERE tenant_id = ? AND status = 'sending' AND sending_since IS NOT NULL AND sending_since < ?`,
      ctx.tenantId,
      now - SEND_CLAIM_TTL_MS,
    )
    .toArray();
  for (const orphan of orphaned) {
    const nextAttempts = orphan.attempts + 1;
    if (nextAttempts < MAX_SEND_ATTEMPTS) {
      ctx.sql.exec(
        `UPDATE scheduled_sends SET status = 'pending', sending_since = NULL, attempts = ? WHERE id = ?`,
        nextAttempts,
        orphan.id,
      );
      continue;
    }
    // At the cap — stop reclaiming and fail the row (ops-visible). message_id is
    // NULL: we don't know whether the orphaned send actually went out.
    ctx.sql.exec(
      `UPDATE scheduled_sends SET status = 'failed', sending_since = NULL, attempts = ? WHERE id = ?`,
      nextAttempts,
      orphan.id,
    );
    ctx.sql.exec(
      `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
       VALUES (?, ?, ?, ?, 'failed', ?, NULL, ?, ?, ?)`,
      newId("evt"),
      ctx.tenantId,
      orphan.campaign_id,
      orphan.lead_id,
      orphan.step,
      orphan.thread_id,
      now,
      JSON.stringify({ stage: "reclaim", reason: "orphaned in 'sending' past the reclaim cap", attempts: nextAttempts }),
    );
  }

  const due = ctx.sql
    .exec<DueSend>(
      `SELECT ss.id, ss.campaign_id, ss.lead_id, ss.step, ss.thread_id, ss.attempts,
              l.email as lead_email, l.first_name as lead_first_name, l.company as lead_company,
              l.global_status as lead_status,
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

    // SPEC.md §19.4 [NEW-3] root cause fix (backend gaps brief item 5): render
    // the sequence step's `{{firstName}}`/`{{company}}` template against THIS
    // lead's own fields — this is the ONLY place a step's raw template is
    // turned into what a real recipient sees, so both the vendor send AND the
    // 'sent' event's own recorded metadata (read back by thread detail/inbox
    // v2 below) get the rendered value, never the literal template.
    const renderedSubject = renderTemplate(step.subject, { firstName: row.lead_first_name, company: row.lead_company });
    const renderedBody = renderTemplate(step.body, { firstName: row.lead_first_name, company: row.lead_company });

    // Atomic claim BEFORE the network await: another concurrent/retried tick
    // that reads this row as still 'pending' will fail this conditional UPDATE
    // (rowsWritten === 0) and skip it, so the row is sent exactly once even
    // when the real EmailPort's fetch() opens the DO input gate.
    const claim = ctx.sql.exec(
      `UPDATE scheduled_sends SET status = 'sending', sending_since = ? WHERE id = ? AND status = 'pending'`,
      now,
      row.id,
    );
    if (claim.rowsWritten !== 1) continue; // another tick already owns this row

    // The send() network call can THROW with the real EmailPort (the sandbox
    // never does): a transient VendorError (SMTP 4xx, engine 5xx, unreachable)
    // or a permanent one (unknown mailbox, engine 4xx). An unguarded throw
    // propagates out of runTick and leaves this row stuck 'sending' forever
    // (only the TTL reclaim above would eventually free it). Grade it in place,
    // mirroring the billing-failure taxonomy below: transient (or unknown, if
    // under the attempt cap) reverts to 'pending' for a later tick; permanent
    // or at-cap marks the row 'failed' (ops-visible). Either way the batch never
    // throws. No message went out, so no 'sent' side effects run.
    let result: Awaited<ReturnType<typeof ctx.adapters.email.send>>;
    try {
      result = await ctx.adapters.email.send(
        {
          fromEmail: picked.email,
          toEmail: row.lead_email,
          subject: renderedSubject,
          body: renderedBody,
          threadId: row.thread_id,
          inReplyToMessageId: null,
          listUnsubscribe: buildListUnsubscribe(picked.email, row.thread_id),
        },
        `send:${ctx.tenantId}:${row.id}`,
      );
    } catch (err) {
      const retryable = err instanceof VendorError ? err.retryable : true;
      const nextAttempts = row.attempts + 1;
      if (retryable && nextAttempts < MAX_SEND_ATTEMPTS) {
        ctx.sql.exec(
          `UPDATE scheduled_sends SET status = 'pending', sending_since = NULL, attempts = ? WHERE id = ?`,
          nextAttempts,
          row.id,
        );
        deferred++; // left pending — a later tick retries this row
        continue;
      }
      // Permanent, or the retry cap is reached: the email never went out, so
      // mark the row 'failed' with an ops-visible 'failed' event (message_id
      // NULL — there is no send result to key it on).
      ctx.sql.exec(
        `UPDATE scheduled_sends SET status = 'failed', sending_since = NULL, attempts = ? WHERE id = ?`,
        nextAttempts,
        row.id,
      );
      ctx.sql.exec(
        `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, ?, ?, 'failed', ?, NULL, ?, ?, ?)`,
        newId("evt"),
        ctx.tenantId,
        row.campaign_id,
        row.lead_id,
        row.step,
        row.thread_id,
        now,
        JSON.stringify({ stage: "send", reason: err instanceof Error ? err.message : String(err), retryable, attempts: nextAttempts }),
      );
      continue;
    }

    // Record usage BEFORE committing 'sent' + cap consumption, so a row is
    // never left sent-but-unbilled. Wrapped per-row: a billing failure is
    // graded (A4, CLASS A) instead of retried forever. A RETRYABLE failure
    // reverts JUST this row to 'pending' (email.send is idempotent on its key)
    // and bumps an attempt counter, up to MAX_SEND_ATTEMPTS; a non-retryable
    // failure (or the cap) marks the row 'failed' + records an ops-visible
    // 'failed' event. Either way the batch never throws.
    try {
      await ctx.adapters.billing.recordUsage(
        ctx.tenantId,
        "email send",
        SEND_USAGE_FEE_CENTS,
        `usage:${ctx.tenantId}:${row.id}`,
      );
    } catch (err) {
      // Unknown (non-VendorError) failures are treated as transient — but still
      // capped, so even a mis-graded permanent error can't loop forever.
      const retryable = err instanceof VendorError ? err.retryable : true;
      const nextAttempts = row.attempts + 1;
      if (retryable && nextAttempts < MAX_SEND_ATTEMPTS) {
        ctx.sql.exec(`UPDATE scheduled_sends SET status = 'pending', sending_since = NULL, attempts = ? WHERE id = ?`, nextAttempts, row.id);
        deferred++; // left pending — a later tick retries this row
        continue;
      }
      // Non-retryable, or the retry cap is reached: the email already went out
      // (send() precedes this step and is idempotent), but usage could not be
      // recorded — fail the row so ops sees the unbilled send, rather than an
      // infinite retry. metrics()/campaign_results surface the 'failed' event;
      // ops-summary counts the failed row.
      ctx.sql.exec(`UPDATE scheduled_sends SET status = 'failed', sending_since = NULL, attempts = ? WHERE id = ?`, nextAttempts, row.id);
      ctx.sql.exec(
        `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`,
        newId("evt"),
        ctx.tenantId,
        row.campaign_id,
        row.lead_id,
        row.step,
        result.messageId,
        row.thread_id,
        now,
        JSON.stringify({ reason: err instanceof Error ? err.message : String(err), retryable, attempts: nextAttempts }),
      );
      continue;
    }

    // Usage is durably recorded: now commit 'sent' + cap + event + local ledger
    // mirror together. These are all synchronous with no await between them, so
    // within the DO they land as one unit. The ledger insert is idempotent on
    // source_send_id, a second defense against a double-counted usage entry.
    ctx.sql.exec(
      `UPDATE scheduled_sends SET status = 'sent', sending_since = NULL, mailbox_id = ?, message_id = ?, sent_at = ? WHERE id = ?`,
      picked.id,
      result.messageId,
      result.sentAt,
      row.id,
    );
    ctx.sql.exec(`UPDATE mailboxes SET sent_today = sent_today + 1 WHERE id = ?`, picked.id);
    // NOTE (A2): a send does NOT reset the soft-bounce streak. In this
    // architecture the EmailPort has no delivery receipt — a soft bounce is
    // always the async result of a PRIOR send, polled AFTER it, so resetting on
    // send would clear the streak just before the bounce it produced is counted
    // (threshold unreachable). The streak resets ONLY on positive engagement (a
    // reply) — see engine/reply-processor.ts.
    // OR IGNORE mirrors the ledger insert below: the events dedupe index makes
    // this a no-op on the (impossible-under-the-atomic-claim, but guarded)
    // chance the same send lands twice, instead of crashing the batch.
    ctx.sql.exec(
      `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
       VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?)`,
      newId("evt"),
      ctx.tenantId,
      row.campaign_id,
      row.lead_id,
      row.step,
      result.messageId,
      row.thread_id,
      result.sentAt,
      JSON.stringify({ fromEmail: picked.email, toEmail: row.lead_email, subject: renderedSubject, body: renderedBody }),
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
    await reportUsageToStripeIfConfigured(ctx, 1, row.id); // inert without env.STRIPE_SECRET_KEY — see engine/billing.ts

    sent++;
  }

  return { sent, skipped, deferred };
}
