import type { Clock, EmailPort, PolledEvent, SendEmailInput, SendEmailResult } from "@coldstart/shared";

/**
 * Sandbox EmailPort — the send/poll simulator the walking-skeleton test
 * exercises. Deterministic by design (no randomness) so tests are stable:
 * the recipient's local-part decides what happens next poll():
 *   - local-part contains "complaint"  -> a spam-complaint is queued (this is
 *     the deliverability-loop fault-injection driver: enough complaints from
 *     one mailbox drive it to 'burning' and the loop responds — B6)
 *   - local-part contains "softbounce" -> a SOFT (transient, RFC 3464 4.x.x)
 *     bounce is queued — tallied but not permanently suppressed (A5 CLASS A)
 *   - local-part contains "bounce"     -> a HARD (permanent, 5.x.x) bounce
 *   - local-part contains "reply"      -> a reply is queued for that mailbox
 *   - anything else                    -> silence (the common real-world case)
 * This is a first-class, documented simulator contract, not a happy-path
 * mock — deeper fault injection (rate limits, 5xx, latency) is a later,
 * budgeted lane (ROADMAP.md hardening-budget rule).
 *
 * Message ids are RFC 5322 (`<uuid@sandbox.local>`), not opaque `msg_<uuid>`,
 * to hold the SendEmailResult adapter contract (a real IMAP adapter threads
 * replies/bounces off real Message-IDs). `sentInputs` records every send so a
 * contract test can assert the RFC 8058 unsubscribe headers round-tripped
 * through the port (the A5 spike proved a real server round-trips them; the
 * old interface had no field to carry them at all — finding F1).
 */
export class SandboxEmailPort implements EmailPort {
  private readonly sentByIdempotencyKey = new Map<string, SendEmailResult>();
  private readonly pendingByMailbox = new Map<string, PolledEvent[]>();
  readonly sentInputs: SendEmailInput[] = [];

  constructor(private readonly clock: Clock) {}

  async send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult> {
    const cached = this.sentByIdempotencyKey.get(idempotencyKey);
    if (cached) return cached;

    this.sentInputs.push(input);
    const result: SendEmailResult = { messageId: sandboxMessageId(), sentAt: this.clock.now() };
    this.sentByIdempotencyKey.set(idempotencyKey, result);

    const behavior = classifyRecipient(input.toEmail);
    if (behavior === "complaint") {
      this.enqueue(input.fromEmail, {
        kind: "complaint",
        mailboxEmail: input.fromEmail,
        threadId: input.threadId,
        originalMessageId: result.messageId,
        toEmail: input.toEmail,
        receivedAt: result.sentAt,
      });
    } else if (behavior === "softbounce") {
      this.enqueue(input.fromEmail, {
        kind: "bounce",
        mailboxEmail: input.fromEmail,
        threadId: input.threadId,
        originalMessageId: result.messageId,
        toEmail: input.toEmail,
        // RFC 3464 enhanced status 4.2.2 = "mailbox full" — a transient 4.x.x.
        reason: "soft bounce 4.2.2 mailbox_full (sandbox-simulated)",
        severity: "soft",
        receivedAt: result.sentAt,
      });
    } else if (behavior === "bounce") {
      this.enqueue(input.fromEmail, {
        kind: "bounce",
        mailboxEmail: input.fromEmail,
        threadId: input.threadId,
        originalMessageId: result.messageId,
        toEmail: input.toEmail,
        // RFC 3464 enhanced status 5.1.1 = "bad destination mailbox" — permanent.
        reason: "hard bounce 5.1.1 mailbox_unavailable (sandbox-simulated)",
        severity: "hard",
        receivedAt: result.sentAt,
      });
    } else if (behavior === "reply") {
      this.enqueue(input.fromEmail, {
        kind: "reply",
        mailboxEmail: input.fromEmail,
        threadId: input.threadId,
        messageId: sandboxMessageId(),
        fromEmail: input.toEmail,
        body: `Sandbox-simulated reply to: ${input.subject}`,
        receivedAt: result.sentAt,
      });
    }
    return result;
  }

  async poll(mailboxEmail: string): Promise<PolledEvent[]> {
    const events = this.pendingByMailbox.get(mailboxEmail) ?? [];
    this.pendingByMailbox.set(mailboxEmail, []);
    return events;
  }

  private enqueue(mailboxEmail: string, event: PolledEvent): void {
    const existing = this.pendingByMailbox.get(mailboxEmail) ?? [];
    existing.push(event);
    this.pendingByMailbox.set(mailboxEmail, existing);
  }
}

/** RFC 5322 Message-ID shape (see SendEmailResult contract). */
function sandboxMessageId(): string {
  return `<${crypto.randomUUID()}@sandbox.local>`;
}

function classifyRecipient(toEmail: string): "complaint" | "softbounce" | "bounce" | "reply" | "none" {
  const local = (toEmail.split("@")[0] ?? "").toLowerCase();
  // "complaint" first: a complaint is the most severe signal and must not be
  // masked by an incidental "reply"/"bounce" substring in the same local-part.
  if (local.includes("complaint")) return "complaint";
  // "softbounce" BEFORE "bounce": "softbounce" contains "bounce", so the more
  // specific soft variant must be matched first or every soft would read hard.
  if (local.includes("softbounce")) return "softbounce";
  if (local.includes("bounce")) return "bounce";
  if (local.includes("reply")) return "reply";
  return "none";
}
