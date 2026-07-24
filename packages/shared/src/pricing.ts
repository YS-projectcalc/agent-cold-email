// SPEC.md §18 — canonical pricing curve ("delegated design authority,
// 2026-07-09 — canonical; drives Stripe test-mode products + site pricing
// page"). Single source of truth for: `POST /checkout` price selection,
// `setup_infrastructure` quota enforcement (apps/platform/src/engine/quota.ts),
// and the site pricing page. Free/Demo is intentionally NOT modeled here —
// SPEC §18 lists it at "0 real" (structurally sandbox-only, ARCHITECTURE.md
// #8), not a purchasable plan with a Stripe price.
//
// The legacy 3-tier table (launch/growth/scale = $99/$299/$799) is RETIRED by
// the quantity-billing migration (design §4): §18 replaced the tiers with a
// continuous per-mailbox curve, the site already ships it, and there were zero
// live subscribers — so the tiers collapse to one paid plan, `managed`, billed
// on the curve below. `$299`/`$799` are superseded by $249/$649, never stranded.

// Founder-ratified activation curve (SPEC.md §18, 2026-07-14): monthly price =
// $49 platform + ($10 × provisioned mailboxes), minimum 5 mailboxes / $99.
export const PLATFORM_FEE_CENTS = 4_900;
export const MAILBOX_PRICE_CENTS = 1_000;
export const MINIMUM_BILLABLE_MAILBOXES = 5;
export const MAX_SELF_SERVE_MAILBOXES = 60;
export const PLANNING_SENDS_PER_MAILBOX_DAY = 30;
export const PLANNING_SENDING_DAYS_MONTH = 22;

// The bundled-domain ratio (SPEC.md §18/§20 — "domains bundled", ceil(mailboxes
// / 3)); the flat self-serve mailbox ceiling (60) implies the domain ceiling.
export const MAILBOXES_PER_DOMAIN = 3;

export interface MailboxQuote {
  readonly mailboxes: number;
  readonly monthlyCents: number;
  readonly estimatedDomains: number;
  readonly planningSendsPerMonth: number;
}

export function quoteProvisionedMailboxes(requestedMailboxes: number): MailboxQuote {
  const mailboxes = Math.min(
    MAX_SELF_SERVE_MAILBOXES,
    Math.max(MINIMUM_BILLABLE_MAILBOXES, Math.round(requestedMailboxes)),
  );
  return {
    mailboxes,
    monthlyCents: PLATFORM_FEE_CENTS + (MAILBOX_PRICE_CENTS * mailboxes),
    estimatedDomains: Math.ceil(mailboxes / MAILBOXES_PER_DOMAIN),
    planningSendsPerMonth: mailboxes * PLANNING_SENDS_PER_MAILBOX_DAY * PLANNING_SENDING_DAYS_MONTH,
  };
}

// The billable mailbox count is the LIVE PROVISIONED count floored at 5 (design
// §2, founder ruling 1 — the meter follows provisioning, deprovision lowers it).
export function billableMailboxes(provisionedCount: number): number {
  return Math.max(MINIMUM_BILLABLE_MAILBOXES, provisionedCount);
}

// Monthly recurring revenue for the curve, folding a stored checkout discount
// (design §9 — mrrCents = curve × (1 − discountPct/100)). `discountPct` is the
// integer percent captured at checkout (0 when none).
export function monthlyRevenueCents(provisionedCount: number, discountPct = 0): number {
  const gross = PLATFORM_FEE_CENTS + MAILBOX_PRICE_CENTS * billableMailboxes(provisionedCount);
  return Math.round(gross * (1 - discountPct / 100));
}

// One paid plan after the tier collapse (design §4). `isPaidPlan` replaces the
// retired 3-tier `isPaidPlanTier` at every consumer.
export function isPaidPlan(plan: string): plan is "managed" {
  return plan === "managed";
}
