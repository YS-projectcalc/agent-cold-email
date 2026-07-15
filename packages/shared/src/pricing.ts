// SPEC.md §18 — canonical pricing/quota table ("delegated design authority,
// 2026-07-09 — canonical; drives Stripe test-mode products + site pricing
// page"). Single source of truth for: `POST /checkout` price selection,
// `setup_infrastructure` quota enforcement (apps/platform/src/engine/quota.ts),
// and (later) the site pricing page. Free/Demo is intentionally NOT modeled
// here — SPEC §18 lists it at "0 real" (structurally sandbox-only,
// ARCHITECTURE.md #8), not a purchasable tier with a Stripe price.

export type PaidPlanTier = "launch" | "growth" | "scale";

export interface PlanQuota {
  readonly label: string;
  /** Flat monthly subscription price, integer cents (ARCHITECTURE.md #3). */
  readonly priceCents: number;
  readonly mailboxes: number;
  readonly domains: number;
}

export const PLAN_QUOTAS: Record<PaidPlanTier, PlanQuota> = {
  launch: { label: "Launch", priceCents: 9_900, mailboxes: 5, domains: 2 },
  growth: { label: "Growth", priceCents: 29_900, mailboxes: 20, domains: 6 },
  scale: { label: "Scale", priceCents: 79_900, mailboxes: 60, domains: 18 },
};

// Founder-ratified provisional activation curve (SPEC.md §18, 2026-07-14).
// The legacy tier table above remains the current checkout implementation
// until the quantity-billing migration lands; these helpers power every NEW
// quote/preview surface so the human UI does not re-encode pricing arithmetic.
export const PLATFORM_FEE_CENTS = 4_900;
export const MAILBOX_PRICE_CENTS = 1_000;
export const MINIMUM_BILLABLE_MAILBOXES = 5;
export const MAX_SELF_SERVE_MAILBOXES = 60;
export const PLANNING_SENDS_PER_MAILBOX_DAY = 30;
export const PLANNING_SENDING_DAYS_MONTH = 22;

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
    estimatedDomains: Math.ceil(mailboxes / 3),
    planningSendsPerMonth: mailboxes * PLANNING_SENDS_PER_MAILBOX_DAY * PLANNING_SENDING_DAYS_MONTH,
  };
}

export function isPaidPlanTier(plan: string): plan is PaidPlanTier {
  return plan === "launch" || plan === "growth" || plan === "scale";
}
