// D1 (brief) — inbound support@ ingestion. Cloudflare Email Routing delivers
// an inbound message to the Worker's `email()` handler (index.ts); this parses
// it, runs the EXISTING regex triage classifier (support-kb.ts), persists an
// ops-visible support ticket (same conventions as POST /admin/support/triage),
// and forwards a copy to the founder. It NEVER auto-replies — triage drafts
// stay drafts (it's regex, not AI). "Reply" is a later, owner-reviewed action.

import PostalMime from "postal-mime";
import { RealClock } from "../clock.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { insertSupportTicket } from "./db.js";
import { triageSupportMessage } from "./support-kb.js";

// Cap the stored body so a pathologically large inbound message can't bloat
// D1 (the triage regex + a human skim only need the opening). Truncation is
// marked so nothing is silently lost.
const MAX_STORED_BODY_CHARS = 16_000;

/**
 * Handle one inbound support email. Returns a small structured outcome for the
 * handler's log line + tests. Total and non-throwing on the forward leg: a
 * forward failure (unverified destination / dark routing) is caught and
 * logged — the ticket is already persisted, which is the durable record.
 *
 * `message.raw` is a SINGLE-USE stream (cloudflare-email-service skill) —
 * buffered exactly once here.
 */
export async function handleInboundSupportEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<{ ticketId: string | null; inserted: boolean; category: string; status: string; forwarded: boolean }> {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await PostalMime.parse(rawBuffer);

  const subject = (parsed.subject ?? "").trim() || "(no subject)";
  const rawBody = parsed.text ?? parsed.html ?? "";
  const body = rawBody.length > MAX_STORED_BODY_CHARS ? `${rawBody.slice(0, MAX_STORED_BODY_CHARS)}\n\n[truncated]` : rawBody;
  // Envelope sender (SMTP MAIL FROM) — trustworthy, unlike the spoofable
  // header From (parsed.from).
  const fromEmail = message.from;
  const messageId = message.headers.get("message-id");

  const triage = triageSupportMessage(subject, body);
  const ticketId = newId("sup");

  // tenant_id is null: an inbound support email isn't tied to a known tenant
  // (a prospect, or a tenant we can't identify from the envelope). Dedupe on
  // (tenant_id, message_id) therefore can't fire for these (SQLite NULLs are
  // distinct — the accepted trade documented in migrations/0005); we still
  // pass message_id so a resolved-tenant flow added later dedupes for free.
  const inserted = await insertSupportTicket(env, {
    id: ticketId,
    fromEmail,
    subject,
    body,
    tenantId: null,
    category: triage.category,
    draft: triage.draft,
    status: triage.status,
    createdAt: new RealClock().now(),
    messageId,
  });

  // Forward a copy to the founder — only when THIS call recorded a new ticket,
  // so a redelivery that deduped (resolved-tenant flow) doesn't re-forward.
  // The destination must be a VERIFIED Email Routing address (ACTIVATION.md);
  // until then this throws and we log — the ticket is the durable record.
  let forwarded = false;
  if (inserted && env.OPS_ALERT_EMAIL) {
    try {
      await message.forward(env.OPS_ALERT_EMAIL);
      forwarded = true;
    } catch (err) {
      console.error(`support inbound: forward to ${env.OPS_ALERT_EMAIL} failed (unverified destination / dark routing)`, err);
    }
  }

  return { ticketId, inserted, category: triage.category, status: triage.status, forwarded };
}
