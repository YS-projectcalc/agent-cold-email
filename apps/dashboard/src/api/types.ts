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

// Magic-link login (design docs/research/human-signup-magic-link-design-
// 2026-07-22.md §1.3/§1.4). POST /login is always this identical shape,
// exists-or-not (enumeration-safe) — the SPA copy is fixed regardless.
export interface LoginRequestResult {
  ok: true;
  message: string;
}

/** POST /login/consume — a single-tenant email auto-completes (mints the
 * session), a multi-tenant email returns the picker list WITHOUT consuming
 * (§1.5). Narrow via `"tenantId" in result`. */
export type LoginConsumeResult = { tenantId: string } | { tenants: { tenantId: string; brand: string }[] };

/** POST /token/rotate — the new bearer token, shown to the caller exactly
 * once (the server never stores it recoverably, only its hash). The old
 * token stops working immediately (atomic swap, see apps/platform's
 * routes/token-rotate.ts). */
export interface RotateTokenResult {
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
  // Collapsed<T> (train 4, packages/shared/src/provenance.ts): true means NO
  // new email was sent — `messageId` is from an earlier send this call
  // matched (same Idempotency-Key at any time, or an identical body within
  // the last 10 minutes when unkeyed); false means this call sent a new
  // email.
  deduplicated: boolean;
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
  // Gate (d) — VENDOR-REPORTED (not first-party measurements); the `vendor*`
  // prefix mirrors infrastructure-status.ts's MailboxHealthReport so a reader
  // never mistakes them for measured signals. NULLABLE since the vendor-truth
  // class sweep (2026-08-18): the provider reports no reputation and no
  // placement signal, so both are null in practice today — a number means one
  // was actually reported. Not rendered in the mailbox table; kept typed for
  // parity with the API shape, so anything that starts rendering them must
  // handle the null rather than print a fabricated 0.
  //
  // `vendorHealth`/`vendorHealthError` (class sweep TRAIN-3 widening, C-M2,
  // docs/adversarial/sweep-completeness-pass-2026-08-17.md) — the
  // DISCRIMINATOR: `vendorHealth:'unknown'` means the two numbers above are
  // BOTH null and meaningless (the lookup failed for this mailbox), not
  // "the vendor reported zero". Previously omitted here despite the file's
  // own comment claiming "parity with the API shape" — a future renderer of
  // the two `vendor*` numbers without this field would have no way to tell
  // a real zero-signal report from a failed lookup.
  vendorHealth: "ok" | "unknown";
  vendorHealthError: string | null;
  vendorReputationScore: number | null;
  vendorPlacementRate: number | null;
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
  // Adversary golive-ux-review-2026-07-27.md round-2 finding — `mailboxes`
  // above counts ALL rows (including soft-released ones: removeMailboxes,
  // deliverability auto-replacement, teardown/cancel). This is the BILLING
  // meter (released_at IS NULL — same count the server actually charges);
  // anything quoting a real charge (BillingPage's Go-live section) must
  // read THIS, never `mailboxes`.
  billableMailboxes: number;
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

// POST /checkout's response (apps/platform/src/engine/billing.ts's
// CheckoutResult) — the dashboard's "Go live" button redirects the browser to
// `url` regardless of `mode` ('stripe' in production, 'simulated' in this
// build's test environment — see routes/checkout.ts).
export interface CheckoutResult {
  mode: "stripe" | "simulated";
  url: string;
  sessionId: string;
}

// W-M5 (docs/adversarial/sweep-completeness-pass-2026-08-17.md) — mirrors
// apps/platform/src/engine/tenant-messages.ts's TenantMessage/
// MessageListPage (GET /messages, the SAME endpoint the MCP list_messages
// tool calls). This is the dashboard's human-fallback render path: before
// this type existed, the dashboard could not render an operator message at
// all, which is the other half of why a founder-sent operator reply once sat
// unread for days — the agent wasn't running, and the human had nowhere to
// look. `readAt` here means "acked by THIS tenant's agent via ack_message",
// not "seen by a human" — matches the agent-facing surface's own semantics
// (never renamed to "ackedAt" the way the admin/operator surface does,
// because this IS the tenant-facing surface, not the operator one).
export interface TenantMessage {
  id: string;
  kind: string;
  severity: "info" | "action_required" | "operator_pending" | "terminal";
  body: string;
  actionHint: Record<string, unknown> | null;
  source: "system" | "operator";
  createdAt: number;
  readAt: number | null;
}

export interface MessageListPage {
  messages: TenantMessage[];
  nextCursor: string | null;
}

export interface AckMessageResult {
  acked: true;
  alreadyAcked: boolean;
}
