// VendorPort interfaces — ARCHITECTURE.md decision #1 & #5.
// Every external dependency sits behind a typed port with two
// implementations (sandbox = active, real = coded-but-unactivated stub).
// Every side-effecting op takes an idempotencyKey so at-least-once retries
// (Queues, DO alarms) are safe.

export interface LookalikeCandidate {
  domain: string;
  available: boolean;
}

/**
 * How the vendor came to hold a domain, and therefore which DNS operation
 * applies to it (INCIDENT 2026-08-05, docs/adversarial/sweep-domain-type-2026-08-05.md):
 *
 *  - 'purchased' — the vendor REGISTERED it for us, so it already owns the
 *    domain's nameservers and runs its own mail-DNS automation. The
 *    connect-an-existing-domain nameserver handshake does not apply and FAILS
 *    against it; readiness is observed by polling, never by asking for
 *    nameservers we would have to apply somewhere else.
 *  - 'connected' — the domain is registered elsewhere and was pointed AT the
 *    vendor, which is what the nameserver handshake is for.
 *  - 'unknown' — no discriminator available (a row that predates this field).
 *    Treated as 'purchased' by the adapters: every domain this platform sends
 *    through `setDns` arrived from `buy()` (purchased by construction) or from
 *    `listOwnedDomains` (which reports the real value), so the only source of
 *    'unknown' is legacy state — and polling is the read-only, non-destructive
 *    guess.
 *
 * Carrying this on the port types is the FIX for the enabler defect: the vendor
 * reports the discriminator, the adapter dropped it at the type boundary, and so
 * nothing downstream could branch on it.
 */
export type DomainConnectionType = "purchased" | "connected" | "unknown";

export interface PurchasedDomain {
  domain: string;
  purchasedAt: number;
  registrar: string;
  /** How the vendor holds it — a domain the registrar port BUYS is 'purchased'. */
  connectionType: DomainConnectionType;
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

/** Outcome of `MailboxPort.cancelWarmup` — the warmup-pool subscription is gone. */
export interface CancelWarmupResult {
  cancelled: boolean;
  cancelledAt: number;
}

/** One domain the vendor account already owns — `listOwnedDomains`'s element. */
export interface OwnedDomain {
  domain: string;
  /** Vendor-side lifecycle, e.g. 'active' | 'pending' | 'expired'. */
  status: string;
  /** Mailboxes already attached to it vendor-side; 0 means nothing depends on it. */
  assignedMailboxes: number;
  /** Which DNS operation applies to it — see `DomainConnectionType`. */
  connectionType: DomainConnectionType;
}

export interface DomainPort {
  searchLookalikes(brand: string, primaryDomain: string, count: number): Promise<LookalikeCandidate[]>;
  /**
   * Every domain this vendor account already owns — the ADOPT-BEFORE-BUY input
   * (INCIDENT 2026-08-05, H3). A registrar purchase that succeeded vendor-side
   * but never reached our DB leaves a domain we own and cannot see; asking the
   * vendor what it holds is the only way to recover it WITHOUT matching on
   * error strings ("already owned by your team"), which is the fragile pattern
   * this codebase has removed twice.
   */
  listOwnedDomains(): Promise<OwnedDomain[]>;
  buy(domain: string, idempotencyKey: string): Promise<PurchasedDomain>;
  /**
   * Brings the domain's mail DNS to a usable state and reports what is ACTUALLY
   * in effect — the returned flags are the readiness signal callers gate on, so
   * "did not throw" is never a substitute for "is ready".
   *
   * `connectionType` selects the operation (INCIDENT 2026-08-05): a 'purchased'
   * domain is polled, a 'connected' one goes through the nameserver handshake.
   * Running the handshake against a purchased domain is not merely redundant —
   * it FAILS permanently, which is what stranded the incident domain through
   * three customer retries.
   */
  setDns(domain: string, idempotencyKey: string, connectionType: DomainConnectionType): Promise<DnsRecordSet>;
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

/**
 * Vendor-side progress of an ASYNC mailbox buy (INCIDENT 2026-08-05, L2):
 *  - 'absent'  — the vendor does not list this mailbox (yet). A buy it accepted
 *                seconds ago looks exactly like a buy that never happened, so
 *                'absent' is NEVER by itself a licence to buy again.
 *  - 'pending' — listed, but not finished provisioning (InboxKit's 'scheduled').
 *  - 'ready'   — listed and usable.
 * `provision()` returning is only the vendor ACCEPTING the order; every
 * uid-resolving operation (warmup enrollment, health, credentials, release) and
 * the billable local row require 'ready'.
 */
export type MailboxProvisioningState = "absent" | "pending" | "ready";

export interface MailboxPort {
  provision(domain: string, localPart: string, idempotencyKey: string): Promise<ProvisionedMailbox>;
  /**
   * Where the vendor has got to with this mailbox. The poll-until-ready gate
   * between the buy and every uid consumer (INCIDENT 2026-08-05, L2), and the
   * "did our buy actually land?" question a retry must ask before it considers
   * buying again — asked of the VENDOR rather than parsed out of an error
   * message, the fragile pattern this codebase has removed twice.
   */
  provisioningState(email: string): Promise<MailboxProvisioningState>;
  getHealth(email: string): Promise<MailboxHealth>;
  startWarmup(email: string, idempotencyKey: string): Promise<{ started: boolean; startedAt: number }>;
  /**
   * Cancels the vendor-side warmup-pool subscription started by `startWarmup`
   * — founder ruling 2026-08-02 (ROADMAP.md:25, option b): the pool runs during
   * the ~28-day ramp and the platform cancels it at ramp completion, so the
   * add-on's recurring per-mailbox cost stops after roughly one month instead
   * of billing for the life of the mailbox.
   *
   * DISTINCT from `release`, which tears down the MAILBOX itself. A mailbox
   * whose warmup is cancelled keeps sending at its full post-ramp cap; only the
   * synthetic warmup traffic stops.
   *
   * Called by the engine's ramp-completion sweep, which retries on failure, so
   * an implementation must be safe to invoke more than once for the same
   * mailbox.
   */
  cancelWarmup(email: string, idempotencyKey: string): Promise<CancelWarmupResult>;
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

/**
 * Result of one poll. `cursor` is an OPAQUE monotonic position the CONSUMER
 * owns and persists: the consumer passes its stored cursor as `poll`'s
 * `sinceCursor`, processes `events`, then persists the returned `cursor` — the
 * persist landing in the SAME transaction as the event processing. For the real
 * IMAP engine `cursor` is the mailbox's UID high-water mark; the engine holds no
 * cursor state of its own, so a lost poll response (the events never reach the
 * consumer) leaves the consumer's cursor un-advanced and the next poll
 * redelivers the exact same events (CLASS: state must not advance before the
 * cross-boundary effect is confirmed). The sandbox is in-process (no lost-
 * response window) so it round-trips the cursor unchanged.
 */
export interface PollResult {
  events: PolledEvent[];
  cursor: number;
}

export interface EmailPort {
  send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult>;
  /**
   * Replies/bounces/complaints observed for this mailbox with position >
   * `sinceCursor`. AT-LEAST-ONCE (A5 spike finding): a real IMAP adapter has no
   * atomic "returns and clears" — a re-poll after a crash, or overlapping poll
   * cycles, WILL re-deliver an event already processed. Because the CONSUMER
   * (engine/reply-processor.ts) owns the cursor and only advances it AFTER
   * transactionally processing the events, a redelivery is expected and safe:
   * every event carries a stable RFC 5322 `messageId`/`originalMessageId` (see
   * SendEmailResult) and the consumer dedupes on it (events unique index +
   * INSERT OR IGNORE), applying each side effect at most once.
   */
  poll(mailboxEmail: string, sinceCursor: number): Promise<PollResult>;
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

/**
 * SPEC.md §20.1 — the mandatory pre-flight live-infra scan a BYO domain's
 * intake runs BEFORE any DNS-mode is offered. Raw DNS findings only (no
 * decision-making — engine/byo-preflight.ts's `interpretPreflightScan`/
 * `recommendDnsMode` are the pure decision layer that consumes this).
 */
export interface DnsScanResult {
  hasMx: boolean;
  aRecordResolved: boolean;
  isParkingPage: boolean;
  hasSpfInclude: boolean;
  dmarcPolicy: "none" | "quarantine" | "reject" | null;
  hasDnssecDs: boolean;
  /**
   * SPEC.md §20.1's `we_manage_zone` poll-verify signal: the hostname's
   * authoritative NS records now resolve to OUR nameservers (a real adapter
   * compares the live NS RRset against our known Cloudflare nameserver set).
   */
  delegatedToUs: boolean;
  /**
   * SPEC.md §20.1's `records_to_apply` poll-verify signal: the SPECIFIC
   * record(s) we asked the customer to add (MX/SPF-include/tracking CNAME/
   * DKIM selector) are now confirmed present with the expected value(s) — a
   * real adapter diffs expected-vs-actual, never a bare "some record exists."
   */
  recordsApplied: boolean;
}

export interface DnsScanPort {
  /** Scans the exact target hostname (not the registrable root — a subdomain and its apex can differ). */
  scan(hostname: string): Promise<DnsScanResult>;
}

/**
 * SPEC.md §20.5 — the non-primary reputation ladder's external signals. Age
 * and blocklist status are readily DNS/RDAP-queryable; `activeSendingEvidence`
 * is deliberately the hardest one to satisfy (real DMARC aggregate-report
 * ingestion) — see vendors/real/reputation-port.ts for what's actually wired
 * vs deferred.
 */
export interface DomainReputationResult {
  /** Domain age in days, or null if unavailable (RDAP registration date unknown/unqueryable). */
  ageDays: number | null;
  /** Hit on a public blocklist (Spamhaus DBL/SURBL-class). */
  blocklisted: boolean;
  /**
   * Positive evidence of an ACTIVE MX in real use (DMARC aggregate-report
   * volume, or an equivalent actual-send-volume signal) — NEVER satisfied by
   * passive-DNS/historical-resolution alone (SPEC.md §20.5's explicit
   * anti-gaming requirement against aged-dormant/marketplace-flipped domains).
   */
  activeSendingEvidence: boolean;
}

export interface DomainReputationPort {
  check(hostname: string): Promise<DomainReputationResult>;
}

/** All seven VendorPort seams, grouped for a per-tenant adapter bundle. */
export interface VendorAdapters {
  domain: DomainPort;
  mailbox: MailboxPort;
  email: EmailPort;
  billing: BillingPort;
  metrics: MetricsPort;
  dnsScan: DnsScanPort;
  reputation: DomainReputationPort;
}
