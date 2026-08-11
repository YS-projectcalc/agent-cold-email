// msgchannel Inc5 (founder-ratified 2026-08-11) — the agent->operator
// direction, completing the two-way channel: increment 1 (engine/
// tenant-messages.ts) is system/operator->agent; this is the reverse leg. An
// agent calls contact_operator, which writes a support_tickets row (D1,
// tenant-scoped, source='agent' — migrations/0017) and fires one ops email
// through the SAME mailer registrar-alert.ts uses, mirroring its
// injectable-mailer/best-effort-send shape exactly. The operator's reply
// travels back through the EXISTING channel — POST /admin/tenants/:id/messages
// (routes/admin-messages.ts) — which the agent reads via list_messages /
// infrastructure_status.messages[]; this file never invents a second reply
// path.
//
// DELIBERATELY NOT lifecycle-gated — mirrors emitOperatorMessage's own ruling
// (gate fix, msgchannel-inc23-gate-2026-08-06 F2): a suspended tenant's agent
// reaching for human help is the canonical use case this channel exists to
// carry ("my card failed and I don't know why" is exactly the message a
// dunning-frozen tenant's agent needs to be able to send), not a case to
// block. No assertNotLifecycleFrozen call anywhere below, by design.

import { RateLimitError } from "@coldstart/shared";
import type { ContactOperatorInput } from "@coldstart/shared";
import { agentContactEmailThrottleState, insertSupportTicket, listRecentAgentSupportTickets, markSupportTicketEmailed } from "../admin/db.js";
import { lookupTenantContactEmail } from "../db.js";
import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import { RealClock } from "../clock.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

// Storm guards (brief: "this platform's cry-wolf lesson — the founder once
// got 160 alert emails"). ALL windows measured on REAL wall-clock time
// (RealClock, never ctx.clock) — the same class this codebase already
// enforces for every other abuse/rate-limit boundary (schema.ts's
// demo_run_state, campaigns.content_hash/launched_at_real,
// mailbox_buy_dispatches.last_dispatched_at): a demo/free tenant's
// VirtualClock runs up to 1440x accelerated, so gating on ctx.clock would let
// a demo tenant blow through every one of these caps in real seconds.
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_CALLS_PER_WINDOW = 5;
// Dedup shares the rate window on purpose — one D1 read (below) answers both.
const DEDUP_WINDOW_MS = RATE_WINDOW_MS;
const EMAIL_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

export interface ContactOperatorResult {
  ticketId: string;
  note: string;
}

const REPLY_NOTE =
  "Recorded for the operator. Their reply will arrive as a message on this account — check list_messages or infrastructure_status's messages[].";

/**
 * `mailer` is injectable (default a real/dark-per-env OpsMailer) — same
 * pattern as registrar-alert.ts's alertRegistrarUnarmed, so a test can assert
 * the alert content with a SandboxOpsMailer without the production call site
 * (TenantDO.contactOperator) needing to change.
 */
export async function contactOperator(
  ctx: TenantContext,
  input: ContactOperatorInput,
  mailer: OpsMailer = createOpsMailer(ctx.env),
): Promise<ContactOperatorResult> {
  const now = new RealClock().now();

  // 1. Dedup FIRST, ahead of the rate limit — an identical-body resend is a
  // safe replay (same shape as this codebase's idempotency-key convention:
  // "the first call runs, a replay returns the recorded result without
  // re-executing"), so it must succeed even for a tenant that is currently
  // rate-limited, and must never itself burn a second email.
  const recent = await listRecentAgentSupportTickets(ctx.env, ctx.tenantId, now - DEDUP_WINDOW_MS);
  const dupe = recent.find((r) => r.body === input.body);
  if (dupe) return { ticketId: dupe.id, note: REPLY_NOTE };

  // 2. Rate limit — `recent` is already exactly "this tenant's agent tickets
  // in the last hour" (the dedup window == the rate window), so its length
  // IS the count; the oldest entry (last, since the query orders DESC) sets
  // when the window next has room.
  if (recent.length >= MAX_CALLS_PER_WINDOW) {
    const oldest = recent[recent.length - 1]!;
    const retryAfter = Math.ceil((oldest.createdAt + RATE_WINDOW_MS - now) / 1000);
    throw new RateLimitError(`too many contact_operator calls — at most ${MAX_CALLS_PER_WINDOW} per hour per tenant.`, retryAfter);
  }

  // 3. Ops-email throttle — decide BEFORE inserting so the "and N more"
  // count reflects everything since the last real send, not including the
  // ticket we're about to write.
  const throttle = await agentContactEmailThrottleState(ctx.env, ctx.tenantId);
  const shouldEmail = throttle.lastEmailAt === null || now - throttle.lastEmailAt >= EMAIL_THROTTLE_MS;

  const contactEmail = await lookupTenantContactEmail(ctx.env, ctx.tenantId);
  const id = newId("sup");
  const urgencyTag = input.urgency === "needs_human" ? " [needs human]" : "";

  // Category 'other' + status 'escalated': this is not an FAQ-answerable
  // inbound email (no draftAnswerFor classification applies — the message is
  // an agent's own prose, always routed to a human), and `source='agent'`
  // (migrations/0017) is the field that actually distinguishes this from an
  // email-triaged ticket, per the brief.
  await insertSupportTicket(ctx.env, {
    id,
    // A synthetic, clearly-labeled fallback when no contact email is on file
    // (test tenants minted via mintTenant, or a signup that predates
    // migrations/0007) — never a real deliverable address, and nothing in
    // this codebase sends TO from_email (routes/admin-support.ts's own doc:
    // "'Reply' is a later, owner-reviewed action").
    fromEmail: contactEmail ?? `agent:${ctx.tenantId}`,
    subject: `Agent message from tenant ${ctx.tenantId}${urgencyTag}`,
    body: input.body,
    tenantId: ctx.tenantId,
    category: "other",
    draft: null,
    status: "escalated",
    createdAt: now,
    source: "agent",
  });

  if (shouldEmail && ctx.env.OPS_ALERT_EMAIL) {
    const pendingNote = throttle.pendingSinceLastEmail > 0 ? `\n\n...and ${throttle.pendingSinceLastEmail} more message(s) from this tenant since the last update.` : "";
    const text =
      `Tenant ${ctx.tenantId} contacted support via its coding agent (urgency: ${input.urgency}).\n\n` +
      `${input.body}${pendingNote}\n\n` +
      `Ticket: ${id}`;
    try {
      await mailer.send({
        to: ctx.env.OPS_ALERT_EMAIL,
        subject: `[coldrig] agent contacted support — tenant ${ctx.tenantId}${urgencyTag}`,
        text,
        html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
      });
      await markSupportTicketEmailed(ctx.env, id, now);
    } catch (mailErr) {
      // Best-effort — mirrors registrar-alert.ts/support-inbound.ts: an
      // unsendable ops email must never fail the tenant-facing call, and the
      // ticket (already inserted, email_sent_at still NULL) remains the
      // durable record; its message rolls into the next successful send.
      console.error(`contact_operator: ops alert send to ${ctx.env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
    }
  }

  return { ticketId: id, note: REPLY_NOTE };
}
