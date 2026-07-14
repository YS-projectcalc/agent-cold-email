// Domain types shared across the platform. Mirrors ARCHITECTURE.md's table
// list: these shapes are stored in D1 (control-plane index) and mirrored /
// owned per-tenant inside TenantDO SQLite (the runtime source of truth).

// "paid" was the pre-B1 placeholder; the concrete paid tiers are named
// (SPEC.md §18) so quota/checkout logic can index PLAN_QUOTAS directly.
export type TenantPlan = "demo" | "free" | "launch" | "growth" | "scale";
export type TenantStatus = "active" | "suspended" | "closed";

export interface TenantProfile {
  id: string;
  brand: string;
  plan: TenantPlan;
  physicalAddress: string;
  senderIdentity: string;
  status: TenantStatus;
  createdAt: number;
}

export type MailboxStatus = "warming" | "active" | "paused" | "quarantined";

export interface Mailbox {
  id: string;
  tenantId: string;
  domainId: string;
  domain: string;
  email: string;
  dailyCap: number;
  sentToday: number;
  status: MailboxStatus;
  warmupDay: number;
  warmupStartedAt: number;
  createdAt: number;
}

export type DomainStatus = "active" | "burning" | "retired";

export interface Domain {
  id: string;
  tenantId: string;
  domain: string;
  status: DomainStatus;
  purchasedAt: number;
}

export type CampaignStatus = "active" | "paused" | "completed";

export interface SequenceStep {
  step: number;
  subject: string;
  body: string;
  delayDays: number;
}

export interface Campaign {
  id: string;
  tenantId: string;
  name: string;
  status: CampaignStatus;
  sequence: SequenceStep[];
  stopOnReply: boolean;
  sendWindow: { startHour: number; endHour: number };
  timezone: string;
  createdAt: number;
}

export type LeadGlobalStatus = "active" | "replied" | "bounced" | "suppressed";

export interface Lead {
  id: string;
  tenantId: string;
  campaignId: string;
  email: string;
  firstName: string;
  company: string;
  globalStatus: LeadGlobalStatus;
  createdAt: number;
}

export type ScheduledSendStatus = "pending" | "sent" | "skipped" | "failed";

export interface ScheduledSend {
  id: string;
  campaignId: string;
  leadId: string;
  mailboxId: string;
  step: number;
  variant: string;
  sendAt: number;
  status: ScheduledSendStatus;
  threadId: string;
  messageId: string | null;
  sentAt: number | null;
}

export type EventType =
  | "sent"
  | "reply"
  | "bounce"
  | "complaint"
  | "unsubscribe"
  | "failed";

export interface PlatformEvent {
  id: string;
  tenantId: string;
  campaignId: string;
  leadId: string;
  type: EventType;
  step: number;
  messageId: string | null;
  threadId: string;
  ts: number;
  metadata: Record<string, unknown>;
}

// B4 opt-out: widened to add "soft_bounce" — reply-processor.ts's
// SOFT_BOUNCE_SUPPRESS_THRESHOLD escalation already persisted this exact
// string (engine/reply-processor.ts's processBounce), a real, already-stored
// value this type had never declared. Surfaced now because engine/
// suppression.ts's extracted `suppress()` (CLAUDE.md rule c — one shared
// implementation, replacing reply-processor.ts's former private copy) takes
// a typed `SuppressionReason` instead of a loose `string`, which would
// otherwise reject that pre-existing call site.
export type SuppressionReason = "bounce" | "soft_bounce" | "complaint" | "unsubscribe" | "manual";

export interface Suppression {
  tenantId: string;
  email: string;
  reason: SuppressionReason;
  ts: number;
}

export interface LedgerEntry {
  id: string;
  tenantId: string;
  kind: "usage" | "credit" | "adjustment";
  amountCents: number;
  description: string;
  ts: number;
}
