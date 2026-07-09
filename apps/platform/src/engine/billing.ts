// B1 money path — checkout (demo/free -> paid) + Stripe webhook business
// logic. Two checkout paths (SPEC-brief B1 signature):
//   - env.STRIPE_SECRET_KEY set -> a real Stripe TEST-mode Checkout Session.
//   - unset (current default state) -> a simulated session recorded in this
//     tenant's own ledger/session table, completed by hitting our own
//     `GET /checkout/simulate` landing route. Fully exercisable now.
// Stripe is the source of truth once activated (ARCHITECTURE.md #3); these
// functions mirror that state onto tenant_profile.

import { isPaidPlanTier, NotFoundError, PLAN_QUOTAS, type CheckoutInput, type TenantPlan } from "@coldstart/shared";
import { createStripeCheckoutSession, reportUsageRecord } from "../billing/stripe-client.js";
import type { StripeEventInput } from "../billing/stripe-webhook.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

export interface CheckoutResult {
  mode: "stripe" | "simulated";
  url: string;
  sessionId: string;
}

export async function startCheckout(ctx: TenantContext, input: CheckoutInput, origin: string): Promise<CheckoutResult> {
  const quota = PLAN_QUOTAS[input.plan];
  const stripeKey = ctx.env.STRIPE_SECRET_KEY;

  if (stripeKey) {
    const session = await createStripeCheckoutSession(stripeKey, {
      tenantId: ctx.tenantId,
      plan: input.plan,
      priceCents: quota.priceCents,
      label: quota.label,
      successUrl: `${origin}/checkout/success?tenant=${ctx.tenantId}`,
      cancelUrl: `${origin}/checkout/cancel?tenant=${ctx.tenantId}`,
    });
    return { mode: "stripe", url: session.url, sessionId: session.id };
  }

  const sessionId = newId("cs");
  const now = ctx.clock.now();
  ctx.sql.exec(
    `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
    sessionId,
    ctx.tenantId,
    input.plan,
    now,
  );
  const url = `${origin}/checkout/simulate?tenant=${ctx.tenantId}&session=${sessionId}`;
  return { mode: "simulated", url, sessionId };
}

export interface CompleteCheckoutResult {
  upgraded: boolean;
  plan: TenantPlan;
}

/**
 * Completes a simulated checkout session — the test-mode stand-in for
 * Stripe's hosted checkout success redirect. Idempotent: hitting an
 * already-completed session's link again is a no-op (`upgraded: false`), not
 * an error — mirrors a real user refreshing the Stripe success page.
 */
export function completeSimulatedCheckout(ctx: TenantContext, sessionId: string): CompleteCheckoutResult {
  const session = ctx.sql
    .exec<{ plan: TenantPlan; status: string }>(
      `SELECT plan, status FROM checkout_sessions WHERE id = ? AND tenant_id = ?`,
      sessionId,
      ctx.tenantId,
    )
    .toArray()[0];
  if (!session) throw new NotFoundError(`checkout session ${sessionId} not found for this tenant`);
  if (session.status === "completed") {
    return { upgraded: false, plan: ctx.plan };
  }

  const now = ctx.clock.now();
  ctx.sql.exec(`UPDATE checkout_sessions SET status = 'completed', completed_at = ? WHERE id = ?`, now, sessionId);
  ctx.sql.exec(`UPDATE tenant_profile SET plan = ?, billing_state = 'active' WHERE id = ?`, session.plan, ctx.tenantId);
  ctx.sql.exec(
    `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts) VALUES (?, ?, 'credit', 0, ?, ?)`,
    newId("ledg"),
    ctx.tenantId,
    `plan upgraded to ${session.plan} (simulated test-mode checkout)`,
    now,
  );
  return { upgraded: true, plan: session.plan };
}

export interface WebhookApplyResult {
  applied: boolean;
  duplicate: boolean;
  plan?: TenantPlan;
}

function readStripeMetadataPlan(obj: Record<string, unknown>): TenantPlan | null {
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const plan = (metadata as Record<string, unknown>).plan;
  return typeof plan === "string" && isPaidPlanTier(plan) ? plan : null;
}

function mapStripeSubscriptionStatus(status: unknown): "active" | "past_due" | "canceled" | null {
  if (typeof status !== "string") return null;
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return null; // other statuses (incomplete, paused, ...) — no billing_state change
}

/**
 * Applies one Stripe webhook event to this tenant. Idempotent by event id
 * (ARCHITECTURE.md #3): a redelivered event's second `INSERT OR IGNORE`
 * writes zero rows, and this returns `{ applied: false, duplicate: true }`
 * WITHOUT re-running any of the mutation below.
 */
export function applyStripeWebhookEvent(ctx: TenantContext, event: StripeEventInput): WebhookApplyResult {
  const now = ctx.clock.now();
  const claim = ctx.sql.exec(
    `INSERT OR IGNORE INTO webhook_events (event_id, type, ts) VALUES (?, ?, ?)`,
    event.id,
    event.type,
    now,
  );
  if (claim.rowsWritten === 0) {
    return { applied: false, duplicate: true };
  }

  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const plan = readStripeMetadataPlan(obj);
      if (!plan) return { applied: false, duplicate: false };
      const customerId = typeof obj.customer === "string" ? obj.customer : null;
      const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
      ctx.sql.exec(
        `UPDATE tenant_profile
           SET plan = ?, billing_state = 'active',
               stripe_customer_id = COALESCE(?, stripe_customer_id),
               stripe_subscription_id = COALESCE(?, stripe_subscription_id)
         WHERE id = ?`,
        plan,
        customerId,
        subscriptionId,
        ctx.tenantId,
      );
      ctx.sql.exec(
        `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts) VALUES (?, ?, 'credit', 0, ?, ?)`,
        newId("ledg"),
        ctx.tenantId,
        `plan upgraded to ${plan} (stripe checkout.session.completed)`,
        now,
      );
      return { applied: true, duplicate: false, plan };
    }

    case "customer.subscription.updated": {
      const billingState = mapStripeSubscriptionStatus(obj.status);
      if (!billingState) return { applied: false, duplicate: false };
      ctx.sql.exec(`UPDATE tenant_profile SET billing_state = ? WHERE id = ?`, billingState, ctx.tenantId);
      return { applied: true, duplicate: false };
    }

    case "customer.subscription.deleted": {
      ctx.sql.exec(`UPDATE tenant_profile SET billing_state = 'canceled', plan = 'free' WHERE id = ?`, ctx.tenantId);
      return { applied: true, duplicate: false, plan: "free" };
    }

    case "invoice.payment_failed": {
      ctx.sql.exec(`UPDATE tenant_profile SET billing_state = 'past_due' WHERE id = ?`, ctx.tenantId);
      return { applied: true, duplicate: false };
    }

    default:
      return { applied: false, duplicate: false };
  }
}

/**
 * Reports one metered-usage increment toward Stripe metered billing.
 * Inert/no-op unless `env.STRIPE_SECRET_KEY` AND a stored
 * `stripe_subscription_id` both exist — i.e. unreachable in this build.
 * Never throws: a Stripe reporting hiccup must not corrupt or block the
 * local ledger write it follows (that write already committed).
 */
export async function reportUsageToStripeIfConfigured(ctx: TenantContext, quantity: number): Promise<void> {
  const key = ctx.env.STRIPE_SECRET_KEY;
  if (!key) return;
  const row = ctx.sql
    .exec<{ subId: string | null }>(`SELECT stripe_subscription_id as subId FROM tenant_profile WHERE id = ?`, ctx.tenantId)
    .one();
  if (!row.subId) return;
  try {
    await reportUsageRecord(key, row.subId, quantity, ctx.clock.now());
  } catch (err) {
    console.error("stripe usage report failed (non-fatal — the local ledger entry already committed)", err);
  }
}
