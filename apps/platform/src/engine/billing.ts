// B1 money path — checkout (demo/free -> paid) + Stripe webhook business
// logic. Two checkout paths (SPEC-brief B1 signature):
//   - env.STRIPE_SECRET_KEY set -> a real Stripe TEST-mode Checkout Session.
//   - unset (current default state) -> a simulated session recorded in this
//     tenant's own ledger/session table, completed by hitting our own
//     `GET /checkout/simulate` landing route. Fully exercisable now.
// Stripe is the source of truth once activated (ARCHITECTURE.md #3); these
// functions mirror that state onto tenant_profile.

import { isPaidPlanTier, NotFoundError, PLAN_QUOTAS, ValidationError, type CheckoutInput, type TenantPlan } from "@coldstart/shared";
import { createStripeCheckoutSession, reportUsageRecord } from "../billing/stripe-client.js";
import type { StripeEventInput } from "../billing/stripe-webhook.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { clearTeardownRecord } from "./lifecycle.js";
import { reactivateFromDunning } from "./ops-summary.js";

/**
 * F1 residual fix (adversarial re-attack round-2, 2026-07-21 —
 * docs/adversarial/selfserve-i1i2-build-review-2026-07-21.md finding 1): a
 * `STRIPE_SECRET_KEY`-only guard is INERT during the original arming-order
 * window the design review named — infra (engine) armed BEFORE Stripe keys —
 * because that window's DEFINING condition is `STRIPE_SECRET_KEY` unset. The
 * actual threat is REAL VENDOR SPEND being reachable, not payment being live,
 * so the guard must key off every signal that makes spend reachable:
 *   - `STRIPE_SECRET_KEY` (payment-arming; the case already closed)
 *   - `ENGINE_BASE_URL` + `ENGINE_AUTH_SECRET` (spend-arming: the real
 *     EmailPort's own gate, factory.ts) — the actual hole this closes.
 * InboxKit (`inboxKitConfig`, the real mailbox/domain vendor) landed its env
 * binding in I3 (`INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`, env.ts) — so this
 * function now ORs them in too (R3-1). A failing-by-construction coverage guard
 * (spend-armed-env-coverage.test.ts) enforces that EVERY env field tagged
 * `// spend-arming` in env.ts is referenced here, so the NEXT vendor binding
 * trips RED at test time instead of silently reopening this class on a new
 * vendor. A doc comment is not a systemic guard — the test is.
 */
export function isRealSpendArmed(env: Env): boolean {
  return (
    Boolean(env.STRIPE_SECRET_KEY) ||
    Boolean(env.ENGINE_BASE_URL && env.ENGINE_AUTH_SECRET) ||
    Boolean(env.INBOXKIT_API_KEY && env.INBOXKIT_WORKSPACE_ID)
  );
}

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

  // Reuse an existing PENDING session for the same plan instead of inserting a
  // new row on every call — otherwise a tenant looping POST /checkout grows its
  // own DO SQLite storage unboundedly (adversarial panel-03 finding #10, same
  // self-amplifier class /demo/run was hardened against). Bounds pending
  // sessions to at most one per (tenant, plan).
  const existing = ctx.sql
    .exec<{ id: string }>(
      `SELECT id FROM checkout_sessions WHERE tenant_id = ? AND plan = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      ctx.tenantId,
      input.plan,
    )
    .toArray()[0];
  const sessionId = existing?.id ?? newId("cs");
  if (!existing) {
    const now = ctx.clock.now();
    ctx.sql.exec(
      `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      sessionId,
      ctx.tenantId,
      input.plan,
      now,
    );
  }
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
  // F1 (adversarial 2026-07-21, BLOCKING — round-2 residual fix): defense in
  // depth — even if the route guard (routes/checkout.ts) were ever
  // bypassed/removed, this function itself must refuse to grant
  // activation-relevant billing state once REAL VENDOR SPEND is reachable
  // (Stripe live keys AND/OR the sending engine armed — see
  // isRealSpendArmed's doc comment for why a Stripe-key-only check is
  // inert during the engine-armed-before-Stripe window).
  if (isRealSpendArmed(ctx.env)) {
    throw new ValidationError("simulated checkout is disabled once real vendor spend is armed (Stripe keys and/or the sending engine)");
  }

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
  // STICKY against a chargeback freeze: a checkout can reactivate a
  // canceled/canceling tenant (a legitimate re-subscribe) but must NEVER lift a
  // 'disputed' freeze — only a won dispute may (adversarial panel-03 finding
  // #2). If the tenant is disputed the UPDATE writes 0 rows and we do not
  // upgrade (the disputed tenant's own /checkout/simulate is a no-op).
  const applied = ctx.sql.exec(
    `UPDATE tenant_profile SET plan = ?, billing_state = 'active' WHERE id = ? AND billing_state != 'disputed'`,
    session.plan,
    ctx.tenantId,
  );
  if (applied.rowsWritten === 0) {
    return { upgraded: false, plan: ctx.plan };
  }
  // Re-subscribe bookkeeping: drop any prior teardown tombstone (so a later
  // cancel re-runs teardown on the NEW infra — finding #4) and clear a dunning
  // suspension (a now-paying customer — finding #6).
  clearTeardownRecord(ctx);
  reactivateFromDunning(ctx);
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
  /** D5 chargeback lane: the event froze the tenant (billing_state -> 'disputed', sends paused). */
  frozen?: boolean;
  /** D5 chargeback lane: a won dispute lifted the freeze (billing_state -> 'active'). */
  unfrozen?: boolean;
}

function readStripeMetadataPlan(obj: Record<string, unknown>): TenantPlan | null {
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const plan = (metadata as Record<string, unknown>).plan;
  return typeof plan === "string" && isPaidPlanTier(plan) ? plan : null;
}

/**
 * Reads the charge decline/failure code from an `invoice.payment_failed` event
 * object (A5). Stripe exposes it in a few shapes depending on expansion; we
 * check the documented locations and fall back to null (unknown -> transient,
 * the safe default). The exact real-Stripe path is verified at activation.
 */
function readDeclineCode(obj: Record<string, unknown>): string | null {
  const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const nested = (v: unknown, key: string): unknown =>
    v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;

  return (
    asString(obj.decline_code) ??
    asString(obj.failure_code) ??
    asString(nested(obj.last_payment_error, "decline_code")) ??
    asString(nested(obj.charge, "failure_code")) ??
    asString(nested(nested(obj.payment_intent, "last_payment_error"), "decline_code")) ??
    null
  );
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
      // STICKY against a chargeback freeze (finding #2): checkout reactivates a
      // canceled/canceling tenant (re-subscribe) but must NOT lift 'disputed'.
      const res = ctx.sql.exec(
        `UPDATE tenant_profile
           SET plan = ?, billing_state = 'active',
               stripe_customer_id = COALESCE(?, stripe_customer_id),
               stripe_subscription_id = COALESCE(?, stripe_subscription_id)
         WHERE id = ? AND billing_state != 'disputed'`,
        plan,
        customerId,
        subscriptionId,
        ctx.tenantId,
      );
      if (res.rowsWritten === 0) {
        // Frozen by an open dispute — checkout did not apply (plan unchanged).
        return { applied: false, duplicate: false };
      }
      // Re-subscribe bookkeeping (findings #4 + #6).
      clearTeardownRecord(ctx);
      reactivateFromDunning(ctx);
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
      // STICKY: a routine subscription event (renewal, plan/metadata change)
      // must NEVER silently overwrite a frozen state — a subscription stays
      // 'active' at Stripe throughout an open dispute, so an unguarded write
      // here re-activated a disputed/canceled tenant and resumed sends
      // (adversarial panel-03 finding #2). Only a won dispute / explicit
      // checkout may exit a frozen state.
      const res = ctx.sql.exec(
        `UPDATE tenant_profile SET billing_state = ?
         WHERE id = ? AND billing_state NOT IN ('disputed', 'canceling', 'canceled')`,
        billingState,
        ctx.tenantId,
      );
      // Recovery-to-active also un-suspends a dunning-frozen tenant (finding #6).
      if (billingState === "active" && res.rowsWritten > 0) reactivateFromDunning(ctx);
      return { applied: true, duplicate: false };
    }

    case "customer.subscription.deleted": {
      // Guard against overwriting a chargeback freeze — the dispute is stickier
      // and stays until it's resolved (both states freeze sends regardless).
      const res = ctx.sql.exec(
        `UPDATE tenant_profile SET billing_state = 'canceled', plan = 'free' WHERE id = ? AND billing_state != 'disputed'`,
        ctx.tenantId,
      );
      // Only report plan='free' when it actually applied, so the DO's in-memory
      // plan mirror never drifts from the row (it stays disputed -> old plan).
      return res.rowsWritten > 0
        ? { applied: true, duplicate: false, plan: "free" }
        : { applied: false, duplicate: false };
    }

    case "invoice.payment_failed": {
      // A5 (CLASS A): record the charge decline code so the dunning sweep can
      // grade it (permanent -> suspend immediately; transient -> count-based
      // grace). Stored even when the freeze guard below no-ops the state
      // change, so the LATEST code always reflects the most recent failure.
      const declineCode = readDeclineCode(obj);
      ctx.sql.exec(`UPDATE tenant_profile SET last_decline_code = ? WHERE id = ?`, declineCode, ctx.tenantId);
      // STICKY: a failed invoice must not overwrite a dispute/cancel freeze.
      ctx.sql.exec(
        `UPDATE tenant_profile SET billing_state = 'past_due'
         WHERE id = ? AND billing_state NOT IN ('disputed', 'canceling', 'canceled')`,
        ctx.tenantId,
      );
      return { applied: true, duplicate: false };
    }

    // D5 chargeback / dispute lane. Cold email is a high-chargeback category
    // (SPEC.md §12) — a dispute WAVE could get our whole master Stripe account
    // frozen, so we freeze the disputing tenant FAST: billing_state='disputed'
    // makes the tick's freeze guard stop every send (engine/tick.ts). Recorded
    // to the per-DO `disputes` table (keyed on the Stripe dispute id) so
    // dispute.created + dispute.closed collapse to one row. Idempotency by
    // EVENT id is already handled by the webhook_events dedupe above; the
    // INSERT OR IGNORE here is a second guard for two DISTINCT events that
    // reference the same dispute.
    case "charge.dispute.created": {
      const disputeId = typeof obj.id === "string" ? obj.id : newId("dp");
      const chargeId = typeof obj.charge === "string" ? obj.charge : null;
      const amountCents = typeof obj.amount === "number" ? obj.amount : 0;
      const reason = typeof obj.reason === "string" ? obj.reason : null;
      ctx.sql.exec(
        `INSERT OR IGNORE INTO disputes (dispute_id, charge_id, amount_cents, reason, status, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
        disputeId,
        chargeId,
        amountCents,
        reason,
        now,
      );
      ctx.sql.exec(`UPDATE tenant_profile SET billing_state = 'disputed' WHERE id = ?`, ctx.tenantId);
      return { applied: true, duplicate: false, frozen: true };
    }

    case "charge.dispute.closed": {
      const disputeId = typeof obj.id === "string" ? obj.id : null;
      const rawStatus = typeof obj.status === "string" ? obj.status : "";
      const outcome = rawStatus === "won" ? "won" : rawStatus === "lost" ? "lost" : "closed";
      if (disputeId) {
        ctx.sql.exec(
          `UPDATE disputes SET status = ?, closed_at = ? WHERE dispute_id = ?`,
          outcome,
          now,
          disputeId,
        );
      }
      // Won -> lift the freeze WE set (only when still 'disputed', so we never
      // resurrect a tenant that was canceled/suspended in the meantime). A lost
      // dispute keeps the freeze — the owner decides via terminate.
      if (outcome === "won") {
        const res = ctx.sql.exec(
          `UPDATE tenant_profile SET billing_state = 'active' WHERE id = ? AND billing_state = 'disputed'`,
          ctx.tenantId,
        );
        // A won dispute is a billing-recovery transition — also un-suspend a
        // dunning-frozen tenant (finding #6).
        if (res.rowsWritten > 0) reactivateFromDunning(ctx);
        return { applied: true, duplicate: false, unfrozen: res.rowsWritten > 0 };
      }
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
 * `idempotencyKey` is the source send/provision id — see reportUsageRecord (B5).
 */
export async function reportUsageToStripeIfConfigured(
  ctx: TenantContext,
  quantity: number,
  idempotencyKey: string,
): Promise<void> {
  const key = ctx.env.STRIPE_SECRET_KEY;
  if (!key) return;
  const row = ctx.sql
    .exec<{ subId: string | null }>(`SELECT stripe_subscription_id as subId FROM tenant_profile WHERE id = ?`, ctx.tenantId)
    .one();
  if (!row.subId) return;
  try {
    // B5: dedupe key derived from the source send/provision id so a redelivered
    // report can't double-increment Stripe metered usage.
    await reportUsageRecord(key, row.subId, quantity, ctx.clock.now(), `usage-report:${idempotencyKey}`);
  } catch (err) {
    console.error("stripe usage report failed (non-fatal — the local ledger entry already committed)", err);
  }
}
