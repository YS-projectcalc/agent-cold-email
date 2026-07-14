import type { PollResult, SendEmailInput, SendEmailResult } from "@coldstart/shared";
import { classifyMessage } from "./classify.js";
import type { CredentialsMap } from "./config.js";
import { SendInProgressError, UnknownMailboxError } from "./errors.js";
import type { ImapFetcher } from "./imap.js";
import { mintMessageId } from "./message-id.js";
import type { SmtpSender } from "./smtp.js";
import type { EngineStore } from "./store.js";

export interface EngineDeps {
  credentials: CredentialsMap;
  store: EngineStore;
  smtp: SmtpSender;
  imap: ImapFetcher;
  /** Injected for tests; defaults to wall-clock (the engine is real infra). */
  now?: () => number;
}

/**
 * The engine service core — the real EmailPort, implemented off-Worker. `send`
 * and `poll` mirror the frozen EmailPort contract (packages/shared/src/
 * vendor-ports.ts) exactly; the Worker's RealEmailPort forwards to these over
 * HTTP. Credentials are resolved from the per-mailbox config by address (the
 * frozen port carries only the email, never creds — so the engine owns cred
 * resolution).
 */
export class EmailEngine {
  private readonly credentials: CredentialsMap;
  private readonly store: EngineStore;
  private readonly smtp: SmtpSender;
  private readonly imap: ImapFetcher;
  private readonly now: () => number;

  constructor(deps: EngineDeps) {
    this.credentials = deps.credentials;
    this.store = deps.store;
    this.smtp = deps.smtp;
    this.imap = deps.imap;
    this.now = deps.now ?? Date.now;
  }

  async send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult> {
    // Idempotent on the key: a retried/at-least-once redelivered send returns the
    // SAME Message-ID without a second SMTP transaction (EmailPort contract).
    const cached = this.store.getSend(idempotencyKey);
    if (cached) return { messageId: cached.messageId, sentAt: cached.sentAt };

    // Claim the key in-flight BEFORE the SMTP await (no await between the miss
    // above and this claim, so both land in one input-gate turn). A SECOND
    // send() for the same key that arrives while the first is still executing —
    // e.g. the consumer's stuck-'sending' TTL reclaim retries a send whose
    // socket has merely stalled, not failed — sees the claim and is rejected
    // with a RETRYABLE SendInProgressError instead of opening a second SMTP
    // transaction. The retry re-runs after the first completes and records its
    // result, so it hits the cache above and returns the same Message-ID: the
    // lead is mailed exactly once. Bare check-then-act (no claim) was the
    // double-send hole (engine-host-review-2026-07-14).
    if (!this.store.claimSend(idempotencyKey)) {
      throw new SendInProgressError(idempotencyKey);
    }
    try {
      const creds = this.resolve(input.fromEmail);
      const messageId = mintMessageId(input.fromEmail, creds.messageIdDomain);
      await this.smtp.send(creds.smtp, input, messageId);
      const sentAt = this.now();
      // Record AFTER a successful send: a failed send throws before this, so its
      // key is never cached and a retry genuinely re-sends. The messageId→threadId
      // mapping is what the poll path uses to reconstruct an inbound event's thread.
      await this.store.recordSend(idempotencyKey, messageId, input.threadId, sentAt);
      return { messageId, sentAt };
    } finally {
      // Release whether the send succeeded (now cached) or threw (never cached,
      // so a retry SHOULD re-send). Either exit leaves the claim clear for the
      // next legitimate attempt.
      this.store.releaseSend(idempotencyKey);
    }
  }

  /**
   * Cursor-stateless poll: fetch INBOX messages with UID > `sinceCursor`
   * (the consumer's stored high-water), classify them, and return the events
   * plus the new `cursor` (the max UID seen). The engine persists NOTHING about
   * the cursor — the consumer advances its own high-water only after
   * transactionally processing these events, so a lost response redelivers the
   * exact same batch on the next poll (the Worker dedupes on Message-ID).
   */
  async poll(mailboxEmail: string, sinceCursor: number): Promise<PollResult> {
    const creds = this.resolve(mailboxEmail);
    const messages = await this.imap.fetchSince(creds.imap, sinceCursor);

    const events: PollResult["events"] = [];
    let cursor = sinceCursor;
    for (const msg of messages) {
      const event = await classifyMessage(
        msg.source,
        mailboxEmail,
        (id) => this.store.resolveThread(id),
        this.now(),
      );
      if (event) events.push(event);
      if (msg.uid > cursor) cursor = msg.uid;
    }
    return { events, cursor };
  }

  private resolve(email: string) {
    const creds = this.credentials[email];
    if (!creds) throw new UnknownMailboxError(email);
    return creds;
  }
}
