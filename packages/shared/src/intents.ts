// The ~12 facade intents (SPEC.md §6) as zod schemas + inferred TS types.
// HTTP routes in apps/platform validate every request body against these at
// the boundary (CLAUDE.md rule h). `signup` bootstraps a tenant + token; the
// rest are bearer-token-authed and tenant-scoped.

import { z } from "zod";

export const SignupInput = z.object({
  brand: z.string().min(1).max(200),
  contactEmail: z.string().email(),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const SetupInfrastructureInput = z.object({
  brand: z.string().min(1).max(200),
  primaryDomain: z.string().min(3).max(253),
  domains: z.number().int().min(1).max(20),
  inboxesEach: z.number().int().min(1).max(10),
  persona: z.string().min(1).max(200),
  physicalAddress: z.string().min(1).max(500),
  senderIdentity: z.string().min(1).max(200),
});
export type SetupInfrastructureInput = z.infer<typeof SetupInfrastructureInput>;

export const SequenceStepInput = z.object({
  step: z.number().int().min(1),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
  delayDays: z.number().int().min(0).max(60),
});

export const LeadInput = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(200),
  company: z.string().min(0).max(200).default(""),
});

export const LaunchCampaignInput = z.object({
  name: z.string().min(1).max(200),
  offer: z.string().min(1).max(2000),
  leads: z.array(LeadInput).min(1).max(5000),
  sequence: z.array(SequenceStepInput).min(1).max(10),
  timezone: z.string().min(1).max(100).default("UTC"),
  sendWindow: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .default({ startHour: 0, endHour: 23 }),
  stopOnReply: z.boolean().default(true),
});
export type LaunchCampaignInput = z.infer<typeof LaunchCampaignInput>;

export const ReplyInput = z.object({
  body: z.string().min(1).max(20_000),
});
export type ReplyInput = z.infer<typeof ReplyInput>;

export const MarkInput = z.object({
  status: z.enum(["read", "unread", "archived"]),
});
export type MarkInput = z.infer<typeof MarkInput>;

// Money path — the quantity-billing migration (design §2/§3) replaces the
// retired plan-tier enum with a mailbox count + billing interval. Checkout
// subscribes the tenant to the single `managed` plan on the per-mailbox curve:
// a $49 platform item (qty 1) + a $10 mailbox item (qty = max(5, mailboxes)).
// `mailboxes` is the initial committed size (5..60 self-serve; 61+ is a custom
// quote, SPEC §18); the billed quantity then TRACKS the live provisioned count.
export const CheckoutInput = z.object({
  mailboxes: z.number().int().min(5).max(60),
  interval: z.enum(["month", "year"]).default("month"),
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

// Customer-initiated downgrade (design §2 — the symmetrical deprovision path,
// distinct from teardown). Releases `count` mailboxes now (effective
// immediately for provisioning) and syncs the lower Stripe quantity with
// proration_behavior 'none' (founder ruling 2 — no mid-cycle credit).
// `acknowledged` must be an explicit `true`: a downgrade forfeits the current
// cycle's paid capacity with no refund, so the consent is quoted + confirmed,
// never defaulted (same posture as AcknowledgeByoConsentInput).
export const RemoveMailboxesInput = z.object({
  count: z.number().int().min(1).max(60),
  acknowledged: z.literal(true),
});
export type RemoveMailboxesInput = z.infer<typeof RemoveMailboxesInput>;

// Query params for the unauthenticated GET /checkout/simulate landing route
// (test-mode-only simulated Stripe Checkout return). The session id is
// itself the credential (unguessable, single-use, re-validated tenant-scoped
// inside the target TenantDO) — see apps/platform/src/routes/checkout.ts.
export const CheckoutSimulateQuery = z.object({
  tenant: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
});
export type CheckoutSimulateQuery = z.infer<typeof CheckoutSimulateQuery>;

// B4 opt-out — query params for the UNAUTHENTICATED GET/POST /unsubscribe
// hosted RFC 8058 one-click endpoint. `sig` is a stateless HMAC over
// `tenant:email` (apps/platform/src/unsubscribe-token.ts) — there is no
// server-side row to look up (opt-outs never expire), so the three params
// together ARE the credential, exactly like CheckoutSimulateQuery's session
// id above. `email` is capped at 320 (RFC 5321 max mailbox length); `sig` at
// 128 covers a hex-encoded SHA-256 HMAC (64 chars) with headroom.
export const UnsubscribeQuery = z.object({
  tenant: z.string().min(1).max(200),
  email: z.string().min(1).max(320),
  sig: z.string().min(1).max(128),
});
export type UnsubscribeQuery = z.infer<typeof UnsubscribeQuery>;

// D5 lifecycle — voluntary cancellation (POST /cancel, tenant-authed).
// `immediate` (default false) cancels the subscription now (billing_state ->
// 'canceled'); the default schedules it for end-of-billing-period
// (billing_state -> 'canceling'; Stripe's later customer.subscription.deleted
// finalizes it to 'canceled'). Infra teardown/reclaim runs now in both cases —
// dedicated cold-email domains/mailboxes have no shared pool to keep warm.
export const CancelInput = z.object({
  immediate: z.boolean().default(false),
});
export type CancelInput = z.infer<typeof CancelInput>;

// Backend gaps brief item 3 — POST /demo/run's optional sandbox-seed-variety
// params. Both default to the platform's ORIGINAL single-campaign, 3-lead
// shape, so an empty/omitted body is byte-for-byte unchanged (engine/
// demo-seed.ts's buildDemoLeads/splitIntoCampaignBatches guarantee this at
// the generation layer). Bounded (<=200 leads, <=3 campaigns) — sandbox-only,
// but still a per-tenant DO SQLite/compute cost or a body someone could hammer.
export const DemoRunInput = z.object({
  leads: z.number().int().min(1).max(200).default(3),
  campaigns: z.number().int().min(1).max(3).default(1),
});
export type DemoRunInput = z.infer<typeof DemoRunInput>;

// D5 lifecycle — abuse offboarding (POST /admin/tenants/:id/terminate,
// ADMIN_TOKEN-authed). The terminal rung of the AUP consequence ladder
// (site/aup.html §7). `reason` + `evidence` are recorded to enforcement_actions
// (migrations/0003) as the audit trail behind the termination.
export const TerminateInput = z.object({
  reason: z.string().min(1).max(2000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type TerminateInput = z.infer<typeof TerminateInput>;

// SPEC.md §20 — BYO domains & mailboxes. The three §20.1 domain-relationship
// shapes the delegation-risk ladder distinguishes (engine/byo-preflight.ts's
// DomainRelationship, re-exported here as the zod boundary validator).
export const DomainRelationshipInput = z.enum(["fresh_standalone", "subdomain_of_primary", "is_primary"]);
export type DomainRelationshipInput = z.infer<typeof DomainRelationshipInput>;

export const RegisterByoDomainInput = z.object({
  domain: z.string().min(3).max(253),
  domainRelationship: DomainRelationshipInput,
});
export type RegisterByoDomainInput = z.infer<typeof RegisterByoDomainInput>;

// §20.4 — primary-domain consent must be an EXPLICIT `true`, never a default
// or an implied acknowledgment (z.literal rejects anything else at the
// boundary, before engine/byo-consent.ts's own runtime check even runs).
export const AcknowledgeByoConsentInput = z.object({
  acknowledged: z.literal(true),
});
export type AcknowledgeByoConsentInput = z.infer<typeof AcknowledgeByoConsentInput>;

// §20.6 shape (a) — the founder-ruled PRIMARY build target: platform-
// provisioned mailboxes on an already-active BYO domain (reuses the existing
// vendor-provisioning path, engine/provisioning.ts's provisionMailboxesForDomain).
export const RequestManagedByoMailboxesInput = z.object({
  count: z.number().int().min(1).max(10),
  personaSlug: z.string().min(1).max(50).optional(),
});
export type RequestManagedByoMailboxesInput = z.infer<typeof RequestManagedByoMailboxesInput>;

// §20.6 — BYO-mailbox connect (the Mordy-pilot seam): maps DIRECTLY onto
// apps/engine/src/config.ts's per-mailbox send-transport discriminated union
// (mailboxCredentialsSchema's `send` field), so the intake data model is
// ready for the engine to consume without translation. This is a "declare an
// existing connection" endpoint (the caller already has the OAuth refresh
// token / SMTP+IMAP app password in hand) -- a real interactive OAuth
// consent-screen redirect flow is dashboard/follow-on work, not this intent.
export const ConnectByoMailboxSmtpInput = z.object({
  kind: z.literal("smtp"),
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string().min(1),
  pass: z.string().min(1),
});
export const ConnectByoMailboxGmailInput = z.object({
  kind: z.literal("gmail_api"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});
export const ConnectByoMailboxGraphInput = z.object({
  kind: z.literal("ms_graph"),
  mode: z.enum(["delegated", "app_only"]),
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
});
// Named separately so the MCP flat-object tool schema (mcp/schemas.ts's
// ConfigureByoDomainInput) can reuse the SAME transport union as an OPTIONAL
// field, matching this required field's validation exactly (CLAUDE.md rule c).
export const ConnectByoMailboxTransportInput = z.discriminatedUnion("kind", [
  ConnectByoMailboxSmtpInput,
  ConnectByoMailboxGmailInput,
  ConnectByoMailboxGraphInput,
]);
export type ConnectByoMailboxTransportInput = z.infer<typeof ConnectByoMailboxTransportInput>;

export const ConnectByoMailboxInput = z.object({
  email: z.string().email(),
  transport: ConnectByoMailboxTransportInput,
});
export type ConnectByoMailboxInput = z.infer<typeof ConnectByoMailboxInput>;
