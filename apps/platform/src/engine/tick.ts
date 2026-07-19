import { VendorError, type SequenceStep } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { buildUnsubscribeUrl, signUnsubscribeToken } from "../unsubscribe-token.js";
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

// A4 (CLASS A) — retry ceiling for a RETRYABLE vendor failure on the send
// path. At the cap the send is marked 'failed' (ops-visible) instead of
// reverted-to-pending forever, so no infinite-retry path survives.
const MAX_SEND_ATTEMPTS = 5;

// Stuck-'sending' reclaim TTL (persist-before-confirm class). A row claimed
// 'sending' is only held across ONE send() round trip (seconds); a DO
// that dies in that window leaves the row stuck 'sending' with no in-tick catch
// to grade it. A later tick reclaims a 'sending' row older than this back to
// 'pending' (send is idempotent on its key, so a re-send is a no-op). Sized far
// above a legitimate in-flight send yet well under the idempotency 'pending'
// reclaim window, so a genuinely orphaned row unblocks promptly.
const SEND_CLAIM_TTL_MS = 5 * 60 * 1000;

// B4 — the deployed API's own https origin, embedded in the hosted one-click
// unsubscribe URL below. `env.PUBLIC_BASE_URL` (wrangler.toml `[vars]`, not a
// secret) overrides this; this exact string is that var's own default value
// (see wrangler.toml/env.ts), so an unconfigured local/test run still builds
// a well-formed (if inert) link instead of throwing.
const DEFAULT_PUBLIC_BASE_URL = "https://agent-cold-email-api.yaakovscher.workers.dev";

interface ListUnsubscribe {
  /** `List-Unsubscribe` header value — BOTH forms, per RFC 8058: the
   * existing mailto (a real, polled inbox) and the new hosted https
   * one-click URL, comma-separated, each angle-bracket-wrapped. */
  header: string;
  /** `List-Unsubscribe-Post` — set ONLY alongside an https form (SendEmailInput's
   * own doc comment), so it always accompanies `header` here. */
  post: string;
  /** The bare https URL, reused as the in-body opt-out link (CAN-SPAM
   * requires an opt-out mechanism IN the message itself, not only in a
   * header a recipient never sees). */
  url: string;
}

/**
 * RFC 8058 List-Unsubscribe (SPEC.md §0.8 / ARCHITECTURE.md #8; backend gaps
 * brief item 3 / B4 TODO — this used to emit ONLY the mailto form). The https
 * one-click URL is a STATELESS signed token (unsubscribe-token.ts) scoped to
 * this exact (tenantId, leadEmail) pair — no per-send row to create, since an
 * opt-out never expires and the same link is safe to reuse for every future
 * step to this lead.
 */
async function buildListUnsubscribe(
  ctx: TenantContext,
  mailboxEmail: string,
  threadId: string,
  leadEmail: string,
): Promise<ListUnsubscribe> {
  const sig = await signUnsubscribeToken(ctx.env.TOKEN_HASH_PEPPER, ctx.tenantId, leadEmail);
  const baseUrl = ctx.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL;
  const url = buildUnsubscribeUrl(baseUrl, ctx.tenantId, leadEmail, sig);
  const mailto = `<mailto:${mailboxEmail}?subject=${encodeURIComponent(`unsubscribe ${threadId}`)}>`;
  return { header: `${mailto}, <${url}>`, post: "List-Unsubscribe=One-Click", url };
}

/**
 * CAN-SPAM footer (15 U.S.C. §7704(a)(5)): a required valid physical postal
 * address, the sender identity captured at setup, and the opt-out mechanism
 * — appended after template rendering so `{{firstName}}`/`{{company}}`
 * substitution (above) never touches any of it. B4 fix-round: this used to
 * append ONLY the unsubscribe link (the physical-address/sender-identity
 * clause was a documented, deliberately-deferred gap — adversarial gate
 * finding #1, 2026-07-14, blocked on the site copy asserting it was already
 * done); both values now ride the same single per-tick `profile` read above.
 * This remains the one per-send composition point in the send path (no
 * separate footer-builder module exists to fold into — see runTick's
 * caller-side comment for the empty-field fail-safe this pairs with).
 */
function appendComplianceFooter(
  body: string,
  senderIdentity: string,
  physicalAddress: string,
  unsubscribeUrl: string,
): string {
  return `${body}\n\n${senderIdentity}\n${physicalAddress}\n\nTo stop receiving these emails, click here: ${unsubscribeUrl}`;
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
 * send so a concurrent/retried tick cannot double-process it. Represents what
 * a DO-alarm would do once fired; B0 exposes it as a directly-callable RPC
 * method since real alarm-driven scheduling is B2.
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
  //
  // B4 fix-round — physical_address/sender_identity ride along on this SAME
  // single-row read (one query, not one per send): tenant_profile has
  // exactly one row per tenant, and both columns are static for the whole
  // tick, so there is nothing to gain from re-reading them per due row.
  const profile = ctx.sql
    .exec<{ status: string; billing_state: string; physical_address: string; sender_identity: string }>(
      `SELECT status, billing_state, physical_address, sender_identity FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();
  if (isLifecycleFrozen(profile.status, profile.billing_state)) {
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

    // SPEC.md §20.2's mandatory DMARC p=none observation window: a BYO
    // domain's `first_send_eligible_at` (NULL for every provisioned/
    // non-gated domain -- always eligible, byte-identical to today) excludes
    // its mailboxes from the capacity picker until the window elapses. This
    // is a hard "not yet" gate, distinct from `deliv_status='paused'` (a
    // control-loop decision) -- neither state implies the other.
    const mailboxes = ctx.sql
      .exec<{ id: string; email: string; sentToday: number; dailyCap: number }>(
        `SELECT m.id as id, m.email as email, m.sent_today as sentToday, m.daily_cap as dailyCap
         FROM mailboxes m JOIN domains d ON d.id = m.domain_id
         WHERE m.tenant_id = ? AND m.deliv_status != 'paused'
           AND (d.first_send_eligible_at IS NULL OR d.first_send_eligible_at <= ?)`,
        ctx.tenantId,
        now,
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
    // when the real EmailPort's fetch() opens the DO input gate. MUST stay
    // the first `await`-free step after the SELECT above — B4's token signing
    // below is itself async (crypto.subtle), so it runs AFTER this claim, not
    // before, or a concurrent/retried tick could interleave between the
    // SELECT and the claim and double-process the row.
    const claim = ctx.sql.exec(
      `UPDATE scheduled_sends SET status = 'sending', sending_since = ? WHERE id = ? AND status = 'pending'`,
      now,
      row.id,
    );
    if (claim.rowsWritten !== 1) continue; // another tick already owns this row

    // B4 fix-round — CAN-SPAM fail-safe. physical_address/sender_identity are
    // NOT NULL DEFAULT '' and only ever populated by setup_infrastructure,
    // which validates both min(1) BEFORE any mailbox this tick could pick
    // exists (schema.ts, packages/shared/src/intents.ts's
    // SetupInfrastructureInput) — so this branch is not reachable through any
    // real API path today. It exists anyway as a hard belt-and-suspenders
    // gate: SEND TIME is the wrong moment to first discover a legally-
    // mandatory field is blank, and refusing to send (failed + ops-visible,
    // the SAME taxonomy as a permanent vendor-send failure below) is strictly
    // safer than mailing a non-CAN-SPAM-compliant message. Checked AFTER the
    // atomic claim (not hoisted above the loop) so a race between two
    // concurrent ticks reaching the same un-claimed row can't double-insert
    // this 'failed' event (message_id is NULL here, and the events dedupe
    // index treats every NULL message_id as distinct — see tenant-do.ts's
    // ensureDedupeIndex comment — so only the claim, not this check, is a
    // safe race boundary).
    if (!profile.physical_address || !profile.sender_identity) {
      ctx.sql.exec(`UPDATE scheduled_sends SET status = 'failed', sending_since = NULL WHERE id = ?`, row.id);
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
        JSON.stringify({
          stage: "compliance",
          reason: "tenant_profile missing physical_address/sender_identity — refused to send a non-CAN-SPAM-compliant email",
        }),
      );
      continue;
    }

    // B4 — the in-body footer becomes part of what's actually sent, so it
    // must exist before the send() call below; the SAME rendered body (with
    // footer) is what the 'sent' event records further down — matching the
    // [NEW-3] rule that the send and its recorded metadata never diverge (see
    // the renderTemplate comment above).
    const listUnsub = await buildListUnsubscribe(ctx, picked.email, row.thread_id, row.lead_email);
    const sentBody = appendComplianceFooter(renderedBody, profile.sender_identity, profile.physical_address, listUnsub.url);

    // The send() network call can THROW with the real EmailPort (the sandbox
    // never does): a transient VendorError (SMTP 4xx, engine 5xx, unreachable)
    // or a permanent one (unknown mailbox, engine 4xx). An unguarded throw
    // propagates out of runTick and leaves this row stuck 'sending' forever
    // (only the TTL reclaim above would eventually free it). Grade it in place:
    // transient (or unknown, if under the attempt cap) reverts to 'pending' for
    // a later tick; permanent or at-cap marks the row 'failed' (ops-visible).
    // Either way the batch never throws. No message went out, so no 'sent'
    // side effects run.
    let result: Awaited<ReturnType<typeof ctx.adapters.email.send>>;
    try {
      result = await ctx.adapters.email.send(
        {
          fromEmail: picked.email,
          toEmail: row.lead_email,
          subject: renderedSubject,
          body: sentBody,
          threadId: row.thread_id,
          inReplyToMessageId: null,
          listUnsubscribe: listUnsub.header,
          listUnsubscribePost: listUnsub.post,
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

    // Commit 'sent' + cap + event together. These are all synchronous with no
    // await between them, so within the DO they land as one unit.
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
    // OR IGNORE: the events dedupe index makes this a no-op on the
    // (impossible-under-the-atomic-claim, but guarded) chance the same send
    // lands twice, instead of crashing the batch.
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
      JSON.stringify({ fromEmail: picked.email, toEmail: row.lead_email, subject: renderedSubject, body: sentBody }),
    );

    sent++;
  }

  return { sent, skipped, deferred };
}
