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

// B1 money path — plan literals kept in sync with PLAN_QUOTAS' keys in
// pricing.ts by convention (only 3 tiers; a zod-level derivation would add
// more indirection than it saves here).
export const CheckoutInput = z.object({
  plan: z.enum(["launch", "growth", "scale"]),
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

// Query params for the unauthenticated GET /checkout/simulate landing route
// (test-mode-only simulated Stripe Checkout return). The session id is
// itself the credential (unguessable, single-use, re-validated tenant-scoped
// inside the target TenantDO) — see apps/platform/src/routes/checkout.ts.
export const CheckoutSimulateQuery = z.object({
  tenant: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
});
export type CheckoutSimulateQuery = z.infer<typeof CheckoutSimulateQuery>;

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

// D5 lifecycle — abuse offboarding (POST /admin/tenants/:id/terminate,
// ADMIN_TOKEN-authed). The terminal rung of the AUP consequence ladder
// (site/aup.html §7). `reason` + `evidence` are recorded to enforcement_actions
// (migrations/0003) as the audit trail behind the termination.
export const TerminateInput = z.object({
  reason: z.string().min(1).max(2000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});
export type TerminateInput = z.infer<typeof TerminateInput>;
