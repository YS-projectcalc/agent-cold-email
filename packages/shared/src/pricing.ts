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

export function isPaidPlanTier(plan: string): plan is PaidPlanTier {
  return plan === "launch" || plan === "growth" || plan === "scale";
}
