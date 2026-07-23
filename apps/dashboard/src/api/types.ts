// Response DTOs for apps/platform's HTTP facade (SPEC.md §19.4). These mirror
// the interfaces exported by apps/platform/src/engine/*.ts (InboxRow/
// InboxPage, ActivityItem/ActivityPage, CampaignListItem, EventCounts,
// InfrastructureStatus/MailboxHealthReport, AccountSummary) — NOT imported
// directly because this app's scope is apps/dashboard/** only (it cannot
// reach into apps/platform/src/**, and these DTOs aren't in @coldstart/shared
// today). Keep in sync by hand; moving them into packages/shared so both
// sides import one definition is a good follow-up (outside this build's
// scope — flagged in the M2 report, not silently done here).
import type { DashboardLayout, Provenance } from "@coldstart/shared";

export interface SignupResult {
  tenantId: string;
  token: string;
}

export interface DashboardViewSummary {
  id: string;
  name: string;
  isDefault: boolean;
  rev: number;
  editedBy: Provenance;
  editedByNote: string | null;
  updatedAt: string;
}

export interface DashboardViewDetail extends DashboardViewSummary {
  layout: DashboardLayout;
  createdAt: string;
}

export interface EventCounts {
  sent: number;
  reply: number;
  bounce: number;
  complaint: number;
  unsubscribe: number;
  failed: number;
  soft_bounce: number;
}

export interface InboxRow {
  threadId: string;
  campaignId: string;
  campaignName: string;
  leadEmail: string;
  subject: string | null;
  snippet: string | null;
  mailboxEmail: string | null;
  mailboxDelivStatus: string | null;
  label: string | null;
  labelSource: string | null;
  lastEventType: string;
  lastEventTs: number;
  markStatus: string;
}

export interface InboxPage {
  threads: InboxRow[];
  nextCursor: string | null;
}

// Mirrors apps/platform/src/engine/threads.ts's ThreadMessage/ThreadDetail
// (GET /threads/:id). `metadata` is the raw per-event JSON (fromEmail/toEmail/
// subject/body today — sandbox is text-only per SPEC.md §19.1 "email message
// HTML (activation-era; sandbox is text)"). An optional `html` string is NOT
// emitted by the backend yet; MessageBody.tsx feature-detects it so this type
// and the render path are ready the day a real IMAP adapter starts forwarding
// HTML bodies, without a follow-up type change.
export interface ThreadMessage {
  type: string;
  ts: number;
  messageId: string | null;
  metadata: Record<string, unknown> & { fromEmail?: string; toEmail?: string; subject?: string; body?: string; html?: string };
}

export interface ThreadDetail {
  threadId: string;
  campaignId: string;
  leadId: string;
  leadEmail: string;
  // Backend gaps brief item 2 / M4 — now surfaced by GET /threads/:id itself
  // (apps/platform/src/engine/threads.ts getThread()), so a deep-linked
  // thread (?thread=<id>) no longer depends on the inbox LIST row already
  // being loaded for the composer's "Replying from X" line.
  mailboxEmail: string | null;
  messages: ThreadMessage[];
}

export interface ReplyResult {
  messageId: string;
}

export interface ActivityItem {
  id: string;
  kind: "event" | "deliverability";
  label: string;
  ts: number;
  target: string | null;
  detail: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

export interface CampaignListItem {
  campaignId: string;
  name: string;
  status: string;
  counts: EventCounts;
}

export interface MailboxHealthReport {
  email: string;
  domain: string;
  status: string;
  warmupDay: number;
  dailyCap: number;
  sentToday: number;
  sendReady: boolean;
  delivStatus: string;
  sends: number;
  complaintRate: number;
  bounceRate: number;
  softBounceRate: number;
  // Gate (d) — VENDOR-REPORTED approximations (not first-party measurements);
  // the `vendor*` prefix mirrors provisioning.ts's MailboxHealthReport so a
  // reader never mistakes them for measured signals. Not rendered in the
  // mailbox table today; kept typed for parity with the API shape.
  vendorReputationScore: number;
  vendorPlacementRate: number;
  // Surfaced by apps/platform/src/engine/provisioning.ts's
  // getInfrastructureStatus() (SPEC.md §19.2/[F7] — "backs the per-mailbox
  // last-sync UI claim"); null before that mailbox's first poll, a real epoch
  // ms afterward (engine/reply-processor.ts's runPollInbox). Never absent —
  // MailboxHealth.tsx/SettingsPage.tsx's `!= null` checks handle the
  // pre-first-poll null, not a missing field.
  lastPolledAt: number | null;
}

export interface InfrastructureStatus {
  domains: number;
  mailboxes: number;
  mailboxHealth: MailboxHealthReport[];
  sendReady: boolean;
}

export interface DeliverabilityAudit {
  action: string;
  target: string;
  ts: number;
  detail: Record<string, unknown>;
}

export interface DeliverabilitySummary {
  pausedMailboxes: number;
  throttledMailboxes: number;
  burningDomains: number;
  domainsReplaced: number;
  recentActions: DeliverabilityAudit[];
}

// G3 (ga-gates-design-2026-07-22.md §G3) — mirrors the platform's
// ActivationSurfaceState. The HONEST send state; the ActivationBanner reads it.
export type ActivationSurfaceState =
  | "sandbox"
  | "suspended"
  | "canceled"
  | "screening_hold"
  | "capacity_pending"
  | "pending_provisioning"
  | "active";

export interface AccountSummary {
  tenantId: string;
  brand: string;
  plan: string;
  status: string;
  billingState: string;
  // G3 — the honest activation state; NEVER claims 'active' while really on the
  // sandbox port. Drives the app-wide ActivationBanner.
  activationState: ActivationSurfaceState;
  domains: number;
  mailboxes: number;
  campaigns: number;
  leads: number;
  sends: number;
  usageCents: number;
  quota: { domains: number; mailboxes: number };
  deliverability: DeliverabilitySummary;
  teardown: unknown | null;
}

// §19.4 structured 409 body (RevConflictError) — thrown on a stale-rev PUT.
export interface RevConflictBody {
  error: string;
  currentRev: number;
  currentLayout: DashboardLayout;
}
