import type { Clock, EmailPort, PolledEvent, SendEmailInput, SendEmailResult } from "@coldstart/shared";

/**
 * Sandbox EmailPort — the send/poll simulator the walking-skeleton test
 * exercises. Deterministic by design (no randomness) so tests are stable:
 * the recipient's local-part decides what happens next poll():
 *   - local-part contains "bounce" -> a bounce is queued for that mailbox
 *   - local-part contains "reply"  -> a reply is queued for that mailbox
 *   - anything else                -> silence (the common real-world case)
 * This is a first-class, documented simulator contract, not a happy-path
 * mock — deeper fault injection (rate limits, 5xx, latency) is a later,
 * budgeted lane (ROADMAP.md hardening-budget rule), out of B0 scope.
 */
export class SandboxEmailPort implements EmailPort {
  private readonly sentByIdempotencyKey = new Map<string, SendEmailResult>();
  private readonly pendingByMailbox = new Map<string, PolledEvent[]>();

  constructor(private readonly clock: Clock) {}

  async send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult> {
    const cached = this.sentByIdempotencyKey.get(idempotencyKey);
    if (cached) return cached;

    const result: SendEmailResult = { messageId: `msg_${crypto.randomUUID()}`, sentAt: this.clock.now() };
    this.sentByIdempotencyKey.set(idempotencyKey, result);

    const behavior = classifyRecipient(input.toEmail);
    if (behavior === "bounce") {
      this.enqueue(input.fromEmail, {
        kind: "bounce",
        mailboxEmail: input.fromEmail,
        threadId: input.threadId,
        originalMessageId: result.messageId,
        toEmail: input.toEmail,
        reason: "mailbox_unavailable (sandbox-simulated)",
        receivedAt: result.sentAt,
      });
    } else if (behavior === "reply") {
      this.enqueue(input.fromEmail, {
        kind: "reply",
        mailboxEmail: input.fromEmail,
        threadId: input.threadId,
        messageId: `msg_${crypto.randomUUID()}`,
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

function classifyRecipient(toEmail: string): "bounce" | "reply" | "none" {
  const local = (toEmail.split("@")[0] ?? "").toLowerCase();
  if (local.includes("bounce")) return "bounce";
  if (local.includes("reply")) return "reply";
  return "none";
}
