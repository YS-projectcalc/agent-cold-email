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

export interface DomainPort {
  searchLookalikes(brand: string, primaryDomain: string, count: number): Promise<LookalikeCandidate[]>;
  buy(domain: string, idempotencyKey: string): Promise<PurchasedDomain>;
  setDns(domain: string, idempotencyKey: string): Promise<DnsRecordSet>;
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
}

export interface SendEmailInput {
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  threadId: string;
  inReplyToMessageId: string | null;
}

export interface SendEmailResult {
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
  receivedAt: number;
}

export type PolledEvent = PolledReply | PolledBounce;

export interface EmailPort {
  send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult>;
  /** Returns and clears any new replies/bounces observed for this mailbox since the last poll. */
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
