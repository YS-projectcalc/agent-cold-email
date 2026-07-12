// VendorPort interfaces — ARCHITECTURE.md decision #1 & #5.
// Every external dependency sits behind a typed port with two
// implementations (sandbox = active, real = coded-but-unactivated stub).
// Every side-effecting op takes an idempotencyKey so at-least-once retries
// (Queues, DO alarms) are safe.

export interface LookalikeCandidate {
  domain: string;
  available: boolean;
}

export interface PurchasedDomain {
  domain: string;
  purchasedAt: number;
  registrar: string;
}

export interface DnsRecordSet {
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  rdns: boolean;
}

/** Result of releasing a provisioned resource back to the vendor (D5 teardown). */
export interface ReleaseResult {
  released: boolean;
  releasedAt: number;
}

export interface DomainPort {
  searchLookalikes(brand: string, primaryDomain: string, count: number): Promise<LookalikeCandidate[]>;
  buy(domain: string, idempotencyKey: string): Promise<PurchasedDomain>;
  setDns(domain: string, idempotencyKey: string): Promise<DnsRecordSet>;
  /**
   * Releases a domain back to the registrar on tenant teardown/reclaim (D5).
   * Idempotency-keyed like every side-effecting op (ARCHITECTURE.md #5). The
   * real adapter calls the registrar's release/delete endpoint at activation;
   * the sandbox executes it in-memory now.
   */
  release(domain: string, idempotencyKey: string): Promise<ReleaseResult>;
}

export interface ProvisionedMailbox {
  email: string;
  provider: "sandbox" | "google" | "microsoft";
  provisionedAt: number;
}

export interface MailboxHealth {
  email: string;
  reputationScore: number; // 0-100
  bounceRate: number; // fraction, 0-1
  complaintRate: number; // fraction, 0-1
  placementRate: number; // fraction landing in inbox vs spam
}

export interface MailboxPort {
  provision(domain: string, localPart: string, idempotencyKey: string): Promise<ProvisionedMailbox>;
  getHealth(email: string): Promise<MailboxHealth>;
  startWarmup(email: string, idempotencyKey: string): Promise<{ started: boolean; startedAt: number }>;
  /**
   * Releases a mailbox back to the vendor on tenant teardown/reclaim (D5).
   * Idempotency-keyed. Real adapter calls Inboxkit's delete-mailbox endpoint at
   * activation; sandbox executes it in-memory now.
   */
  release(email: string, idempotencyKey: string): Promise<ReleaseResult>;
}

export interface SendEmailInput {
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  threadId: string;
  inReplyToMessageId: string | null;
  /**
   * RFC 8058 one-click-unsubscribe headers (SPEC.md §0.8 / ARCHITECTURE.md #8
   * compliance surface; A5 spike finding F1). `listUnsubscribe` is the
   * `List-Unsubscribe` header value (a `mailto:` and/or `https:` form, each
   * angle-bracket-wrapped); `listUnsubscribePost` is the `List-Unsubscribe-Post`
   * header value (`List-Unsubscribe=One-Click`), set ONLY alongside an https
   * form. Optional so a non-marketing/internal send can omit them; the real
   * adapter emits them as SMTP headers, the sandbox round-trips them for tests.
   */
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
}

export interface SendEmailResult {
  /**
   * ADAPTER CONTRACT (A5 spike finding F3): a REAL RFC 5322 Message-ID
   * (`<local@domain>`), stored verbatim in `scheduled_sends.message_id` and
   * echoed on every event. It MUST be a real Message-ID because the real
   * IMAP adapter reconstructs a reply/bounce's `threadId` by matching the
   * inbound `In-Reply-To`/`References` headers back to this id — an opaque
   * token the sandbox invents (the old `msg_<uuid>` shape) has no analogue on
   * a real server. The sandbox emits `<uuid@sandbox.local>` to hold this shape.
   */
  messageId: string;
  sentAt: number;
}

export interface PolledReply {
  kind: "reply";
  mailboxEmail: string;
  threadId: string;
  messageId: string;
  fromEmail: string;
  body: string;
  receivedAt: number;
}

export interface PolledBounce {
  kind: "bounce";
  mailboxEmail: string;
  threadId: string;
  originalMessageId: string;
  toEmail: string;
  reason: string;
  /**
   * Transient-vs-permanent grade (A5 spike CLASS A). The real adapter derives
   * it from the RFC 3464 delivery-status-notification enhanced status class:
   * a 5.x.x status is "hard" (permanent — the address will never accept mail,
   * suppress it) and a 4.x.x status is "soft" (transient — mailbox full,
   * greylisted, temporary — tally but do NOT permanently suppress on one).
   * reply-processor.ts branches on this; a bounce with no grade must never be
   * treated as unconditionally permanent (the pre-fix defect).
   */
  severity: "hard" | "soft";
  receivedAt: number;
}

/**
 * A spam-complaint fed back from the mailbox vendor (Gmail/MS feedback loop,
 * surfaced by Inboxkit in the real adapter). Carries the sending mailbox and
 * the original send's message id so the deliverability control loop
 * (engine/deliverability.ts) can attribute the complaint to the exact mailbox
 * that sent it and compute a per-mailbox complaint RATE. Complaints suppress
 * the recipient like a bounce — you never re-mail a complainer.
 */
export interface PolledComplaint {
  kind: "complaint";
  mailboxEmail: string;
  threadId: string;
  originalMessageId: string;
  toEmail: string;
  receivedAt: number;
}

export type PolledEvent = PolledReply | PolledBounce | PolledComplaint;

export interface EmailPort {
  send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult>;
  /**
   * New replies/bounces/complaints observed for this mailbox. AT-LEAST-ONCE
   * (A5 spike finding): the sandbox "returns and clears", but a real IMAP
   * adapter has no such atomic clear — a re-poll after a crash, or overlapping
   * poll cycles, WILL re-deliver an event already processed. The consumer
   * (engine/reply-processor.ts) therefore dedupes on the event's messageId
   * (events unique index + INSERT OR IGNORE), applying each event's side
   * effects at most once. Every returned event carries a real RFC 5322
   * `messageId`/`originalMessageId` (see SendEmailResult) so that dedupe key is
   * stable across re-polls.
   */
  poll(mailboxEmail: string): Promise<PolledEvent[]>;
}

export interface BillingCustomer {
  customerId: string;
  createdAt: number;
}

export interface UsageRecordResult {
  recordId: string;
  recordedAt: number;
}

export interface BillingPort {
  createCustomer(tenantId: string, idempotencyKey: string): Promise<BillingCustomer>;
  recordUsage(
    tenantId: string,
    description: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<UsageRecordResult>;
}

export interface PlacementResult {
  mailboxEmail: string;
  inboxRate: number;
  spamRate: number;
  checkedAt: number;
}

export interface MetricsPort {
  getPlacement(mailboxEmail: string): Promise<PlacementResult>;
}

/** All five VendorPort seams, grouped for a per-tenant adapter bundle. */
export interface VendorAdapters {
  domain: DomainPort;
  mailbox: MailboxPort;
  email: EmailPort;
  billing: BillingPort;
  metrics: MetricsPort;
}
