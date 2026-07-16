import type { PollResult, SendEmailInput, SendEmailResult } from "@coldstart/shared";
import { classifyMessage } from "./classify.js";
import type { CredentialsMap, MailboxCredentials } from "./config.js";
import { SendInProgressError, UnknownMailboxError } from "./errors.js";
import type { GmailSender } from "./gmail.js";
import type { GraphSender } from "./graph.js";
import type { ImapFetcher } from "./imap.js";
import { mintMessageId } from "./message-id.js";
import type { SmtpSender } from "./smtp.js";
import type { EngineStore } from "./store.js";

/**
 * Hard cap on how many UIDs a single incremental poll scans. Bounds the
 * per-call fetch to a small, tunable, KNOWN quantity of full RFC5322 sources
 * regardless of mailbox backlog size — the batch is capped by an explicit
 * numeric IMAP UID range (imap.ts fetchRange), not by truncating an
 * already-unbounded result client-side. A mailbox with a larger backlog than
 * one cap simply pages: the cursor advances by at most this much per poll and
 * the next scheduled tick (runPollInbox, apps/platform/src/engine/
 * reply-processor.ts) continues from where this one left off.
 */
const POLL_BATCH_CAP = 300;

export interface EngineDeps {
  credentials: CredentialsMap;
  store: EngineStore;
  smtp: SmtpSender;
  imap: ImapFetcher;
  /**
   * HTTPS/443 send transports. Optional so a test that only exercises SMTP need
   * not wire them; the real daemon (index.ts) always provides both, so a mailbox
   * configured for gmail_api/ms_graph resolves its sender. A mailbox needing an
   * un-wired transport fails as an internal (transient) error, never a silent
   * wrong-wire send.
   */
  gmail?: GmailSender;
  graph?: GraphSender;
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
  private readonly gmail?: GmailSender;
  private readonly graph?: GraphSender;
  private readonly now: () => number;

  constructor(deps: EngineDeps) {
    this.credentials = deps.credentials;
    this.store = deps.store;
    this.smtp = deps.smtp;
    this.imap = deps.imap;
    this.gmail = deps.gmail;
    this.graph = deps.graph;
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
      await this.dispatchSend(creds, input, messageId);
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
   * Cursor-stateless poll: fetch INBOX messages with UID in (`sinceCursor`,
   * `throughUid`], classify them, and return the events plus the new `cursor`.
   * The engine persists NOTHING about the cursor — the consumer advances its
   * own high-water only after transactionally processing these events, so a
   * lost response redelivers the exact same batch on the next poll (the
   * Worker dedupes on Message-ID).
   *
   * Two bounds close the unbounded-first-fetch defect (Gate-1 smoke, a real
   * pre-existing mailbox with UID >147k):
   *
   *   1. First contact (`sinceCursor === -1` — real IMAP UIDs start at 1, so
   *      -1 is a sentinel distinct from EVERY legitimate cursor value,
   *      including 0): initialize the cursor at the mailbox's CURRENT
   *      high-water (`uidNext - 1`, which is legitimately 0 for a genuinely
   *      empty mailbox) and fetch NOTHING. Poll's semantics are "events since
   *      we started watching," never "mirror the inbox" — every BYO mailbox
   *      arrives with existing history that must never be pulled in one
   *      shot. The consumer persists this cursor even though the poll
   *      returned zero events (reply-processor.ts stamps `poll_cursor`
   *      unconditionally), so the very next poll is a normal bounded
   *      incremental fetch. NOTE: 0 is NOT a first-contact sentinel — it is
   *      an ordinary incremental starting point (fetch strictly above UID 0,
   *      i.e. from UID 1). Overloading 0 as both meanings was a real,
   *      demonstrated defect: a genuinely empty mailbox's high-water is 0,
   *      so re-treating a persisted 0 as "never polled" on the NEXT tick
   *      permanently skipped that mailbox's first-ever inbound message
   *      (adversary poll-bounded-fetch-2026-07-16 finding 1).
   *   2. Every subsequent poll (including `sinceCursor === 0`) is capped to
   *      at most `POLL_BATCH_CAP` UIDs — the cursor advances to the full
   *      scanned range (`throughUid`), not just the max UID among messages
   *      actually returned, so a gap of deleted/expunged UIDs can never
   *      stall forward progress.
   */
  async poll(mailboxEmail: string, sinceCursor: number): Promise<PollResult> {
    const creds = this.resolve(mailboxEmail);
    const uidNext = await this.imap.currentUidNext(creds.imap);
    const mailboxHighWaterUid = Math.max(0, uidNext - 1);

    if (sinceCursor === -1) {
      return { events: [], cursor: mailboxHighWaterUid };
    }

    const throughUid = Math.min(mailboxHighWaterUid, sinceCursor + POLL_BATCH_CAP);
    if (throughUid <= sinceCursor) {
      return { events: [], cursor: sinceCursor }; // fully caught up, nothing new
    }

    const messages = await this.imap.fetchRange(creds.imap, sinceCursor, throughUid);
    const events: PollResult["events"] = [];
    for (const msg of messages) {
      const event = await classifyMessage(
        msg.source,
        mailboxEmail,
        (id) => this.store.resolveThread(id),
        this.now(),
      );
      if (event) events.push(event);
    }
    return { events, cursor: throughUid };
  }

  /**
   * Route the send to the mailbox's configured transport. The compliance-bearing
   * raw message is built by the SAME message.ts builder for every wire, so which
   * branch runs changes only the transport, never the bytes. An OMITTED `send`
   * means SMTP (backward-compatible). An API transport whose sender wasn't wired
   * is an internal misconfiguration surfaced as a transient error (the real
   * daemon always wires both), never a silent wrong-transport send.
   */
  private async dispatchSend(creds: MailboxCredentials, input: SendEmailInput, messageId: string): Promise<void> {
    const send = creds.send;
    if (!send || send.kind === "smtp") {
      if (!creds.smtp) throw new Error(`internal: mailbox ${input.fromEmail} selected smtp transport but has no smtp endpoint`);
      return this.smtp.send(creds.smtp, input, messageId);
    }
    if (send.kind === "gmail_api") {
      if (!this.gmail) throw new Error(`internal: mailbox ${input.fromEmail} needs the gmail_api transport but it is not wired`);
      return this.gmail.send(send, input, messageId);
    }
    if (!this.graph) throw new Error(`internal: mailbox ${input.fromEmail} needs the ms_graph transport but it is not wired`);
    return this.graph.send(send, input, messageId);
  }

  private resolve(email: string) {
    const creds = this.credentials[email];
    if (!creds) throw new UnknownMailboxError(email);
    return creds;
  }
}
