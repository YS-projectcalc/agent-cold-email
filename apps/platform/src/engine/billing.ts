// B1 money path — checkout (demo/free -> paid) + Stripe webhook business
// logic. Two checkout paths (SPEC-brief B1 signature):
//   - env.STRIPE_SECRET_KEY set -> a real Stripe TEST-mode Checkout Session.
//   - unset (current default state) -> a simulated session recorded in this
//     tenant's own ledger/session table, completed by hitting our own
//     `GET /checkout/simulate` landing route. Fully exercisable now.
// Stripe is the source of truth once activated (ARCHITECTURE.md #3); these
// functions mirror that state onto tenant_profile.

import {
  billableMailboxes,
  isPaidPlan,
  MINIMUM_BILLABLE_MAILBOXES,
  monthlyRevenueCents,
  NotFoundError,
  ValidationError,
  type CheckoutInput,
  type RemoveMailboxesInput,
  type TenantPlan,
} from "@coldstart/shared";
import {
  createStripeCheckoutSession,
  ensureStripePrices,
  getSubscription,
  setSubscriptionItemQuantity,
  STRIPE_PRICES,
  stripeMode,
  type StripePriceMap,
} from "../billing/stripe-client.js";
import { HANDLED_STRIPE_EVENT_TYPES, type StripeEventInput } from "../billing/stripe-webhook.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { screenTenant } from "../ofac/screening.js";
import type { TenantContext } from "../tenant-context.js";
import { assertNotLifecycleFrozen, readLifecycleState } from "./billing-state.js";
import { billableMailboxCount, clearTeardownRecord, releaseMailboxes } from "./lifecycle.js";
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
    Boolean(env.INBOXKIT_API_KEY && env.INBOXKIT_WORKSPACE_ID) ||
    // G5 gate (a) — registrar arming is its OWN leg, independent of the
    // INBOXKIT_* leg above (adversary B1 2026-07-23): the whole point of
    // decoupling is that arming one vendor must never be read as arming the
    // other.
    Boolean(env.REGISTRAR_PROVIDER && env.CLOUDFLARE_REGISTRAR_API_TOKEN)
  );
}

export interface CheckoutResult {
  mode: "stripe" | "simulated";
  url: string;
  sessionId: string;
}

// The single paid plan every checkout subscribes to (design §4 — the tiers
// collapsed to one `managed` plan billed on the per-mailbox curve).
const MANAGED_PLAN: TenantPlan = "managed";

/**
 * The mailbox quantity to send at checkout = max(5, provisioned-at-checkout)
 * (design §3). A brand-new tenant has 0 provisioned → floors at 5 (= the $99
 * minimum); the count then TRACKS real provisioning as setup runs (§2). The
 * customer's requested `input.mailboxes` bounds the intended size at the
 * boundary (5..60 self-serve; 61+ is a custom quote) and seeds the quote, but
 * the billed quantity mirrors provisioning, never an unprovisioned commitment.
 * The underlying count is `billableMailboxCount` (engine/lifecycle.ts) — the
 * SAME function `getAccount` (engine/reporting.ts) reads for the dashboard's
 * Go-live quote, single-sourced so the two can never diverge again (adversary
 * golive-ux-review-2026-07-27.md round-2 finding).
 */
function checkoutMailboxQuantity(ctx: TenantContext): number {
  return Math.max(MINIMUM_BILLABLE_MAILBOXES, billableMailboxCount(ctx));
}

/**
 * Resolves the two durable Price ids for a billing interval, reading the D1
 * `stripe_prices` cache first and only calling `ensureStripePrices` (a Stripe
 * round trip) on a cache miss — then caching all four ids for the mode (design
 * §3). The arm-time bootstrap pre-warms this cache so the common checkout path
 * never races; the lazy miss here is the backstop, race-safe via
 * ensureStripePrices' duplicate-lookup_key re-fetch.
 */
async function resolveCheckoutPriceIds(
  ctx: TenantContext,
  secretKey: string,
  interval: "month" | "year",
): Promise<{ platformPriceId: string; mailboxPriceId: string }> {
  const mode = stripeMode(secretKey);
  const platformKey = interval === "year" ? STRIPE_PRICES.platform_yearly.lookupKey : STRIPE_PRICES.platform_monthly.lookupKey;
  const mailboxKey = interval === "year" ? STRIPE_PRICES.mailbox_yearly.lookupKey : STRIPE_PRICES.mailbox_monthly.lookupKey;

  const cached = await ctx.env.DB.prepare(
    `SELECT lookup_key, price_id FROM stripe_prices WHERE mode = ? AND lookup_key IN (?, ?)`,
  )
    .bind(mode, platformKey, mailboxKey)
    .all<{ lookup_key: string; price_id: string }>();
  const byKey = new Map(cached.results.map((r) => [r.lookup_key, r.price_id]));
  if (byKey.has(platformKey) && byKey.has(mailboxKey)) {
    return { platformPriceId: byKey.get(platformKey)!, mailboxPriceId: byKey.get(mailboxKey)! };
  }

  const map = await ensureStripePrices(secretKey);
  await cacheStripePrices(ctx, mode, map);
  return {
    platformPriceId: interval === "year" ? map.platform_yearly : map.platform_monthly,
    mailboxPriceId: interval === "year" ? map.mailbox_yearly : map.mailbox_monthly,
  };
}

/** Persists the resolved `lookup_key -> price_id` map for a mode into the D1 cache (idempotent upsert). */
async function cacheStripePrices(ctx: TenantContext, mode: string, map: StripePriceMap): Promise<void> {
  const now = ctx.clock.now();
  const stmt = ctx.env.DB.prepare(
    `INSERT INTO stripe_prices (lookup_key, mode, price_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (lookup_key, mode) DO UPDATE SET price_id = excluded.price_id`,
  );
  const slugs = Object.keys(STRIPE_PRICES) as (keyof StripePriceMap)[];
  await ctx.env.DB.batch(slugs.map((slug) => stmt.bind(STRIPE_PRICES[slug].lookupKey, mode, map[slug], now)));
}

/**
 * Adversary NB#3 (golive-ux-review-2026-07-27.md finding 3) — an
 * already-active tenant hitting POST /checkout a second time (e.g. clicking
 * a UI "Go live" control meant for sandbox/canceled/suspended tenants) would
 * start a SECOND Stripe Checkout Session/subscription while the DO tracks
 * only ONE `stripe_subscription_id` (tenant-do.ts) — the webhook then
 * overwrites the tracked id and the first subscription orphans while still
 * billing. `billing_state === 'active'` is the ONE state that means "already
 * paying, nothing to reactivate" — every ActivationSurfaceState that reads as
 * 'active'/'pending_provisioning'/'capacity_pending' to the UI shares this
 * SAME underlying billing_state (see engine/activation.ts's
 * deriveActivationState — all three branch off `billingState === 'active'`),
 * so this one check covers all three at once. Reactivation from 'canceled'/
 * 'past_due'/'none' stays allowed (design §2/§9 — that's the intended path
 * back to paying).
 */
export async function startCheckout(ctx: TenantContext, input: CheckoutInput, origin: string): Promise<CheckoutResult> {
  const { billingState } = readLifecycleState(ctx);
  if (billingState === "active") {
    throw new ValidationError(
      "checkout rejected: this tenant's billing is already active. Use POST /remove-mailboxes to change mailbox count, or POST /cancel first to reactivate on a new checkout.",
    );
  }

  const stripeKey = ctx.env.STRIPE_SECRET_KEY;

  if (stripeKey) {
    const { platformPriceId, mailboxPriceId } = await resolveCheckoutPriceIds(ctx, stripeKey, input.interval);
    const session = await createStripeCheckoutSession(stripeKey, {
      tenantId: ctx.tenantId,
      platformPriceId,
      mailboxPriceId,
      mailboxQuantity: checkoutMailboxQuantity(ctx),
      successUrl: `${origin}/checkout/success?tenant=${ctx.tenantId}`,
      cancelUrl: `${origin}/checkout/cancel?tenant=${ctx.tenantId}`,
    });
    return { mode: "stripe", url: session.url, sessionId: session.id };
  }

  // Reuse an existing PENDING session instead of inserting a new row on every
  // call — otherwise a tenant looping POST /checkout grows its own DO SQLite
  // storage unboundedly (adversarial panel-03 finding #10). Bounds pending
  // sessions to at most one per tenant (there is now one paid plan, `managed`).
  const existing = ctx.sql
    .exec<{ id: string }>(
      `SELECT id FROM checkout_sessions WHERE tenant_id = ? AND plan = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
      ctx.tenantId,
      MANAGED_PLAN,
    )
    .toArray()[0];
  const sessionId = existing?.id ?? newId("cs");
  if (!existing) {
    const now = ctx.clock.now();
    ctx.sql.exec(
      `INSERT INTO checkout_sessions (id, tenant_id, plan, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      sessionId,
      ctx.tenantId,
      MANAGED_PLAN,
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
export async function completeSimulatedCheckout(ctx: TenantContext, sessionId: string): Promise<CompleteCheckoutResult> {
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
  recordDunningCycleBasis(ctx, now);
  ctx.sql.exec(
    `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts) VALUES (?, ?, 'credit', 0, ?, ?)`,
    newId("ledg"),
    ctx.tenantId,
    `plan upgraded to ${session.plan} (simulated test-mode checkout)`,
    now,
  );
  // G1 (ga-gates-design-2026-07-22.md §G1) — screen at the activation
  // transition. Test-mode simulated checkout carries no Stripe billing name
  // (there's no real Stripe session), so brand + contact email are the only
  // screenable fields here.
  await screenTenant(ctx, { trigger: "checkout" });
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
  /** Refused as OUT OF ORDER: Stripe emitted this event before one already
   *  applied, so applying it would regress billing state (finding 3). */
  stale?: boolean;
  /** This delivery FINISHED a previous attempt that died mid-handler, rather
   *  than no-op'ing as an ordinary duplicate (finding 2). */
  completed?: boolean;
}

function readStripeMetadataPlan(obj: Record<string, unknown>): TenantPlan | null {
  const metadata = obj.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const plan = (metadata as Record<string, unknown>).plan;
  return typeof plan === "string" && isPaidPlan(plan) ? plan : null;
}

/**
 * G1 (design line 45) — best-effort Stripe billing name off a completed
 * checkout session's `customer_details.name`. ⚠️ Under the pilot's 100%-off +
 * `payment_method_collection:"if_required"` posture (self-serve design §2.5)
 * this is typically ABSENT — never assumed present, only screened when the
 * webhook object actually carries it (screening.ts records `screened_fields`
 * either way, so a review honestly shows what was/wasn't checked).
 */
function readStripeBillingName(obj: Record<string, unknown>): string | null {
  const customerDetails = obj.customer_details;
  if (!customerDetails || typeof customerDetails !== "object") return null;
  const name = (customerDetails as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0 ? name : null;
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
 * Which independent Stripe state machine an event belongs to. The six subscribed
 * types are NOT one sequence: a Dispute, a Subscription and an Invoice are
 * separate objects with no causal ordering between them, and Stripe guarantees
 * no cross-object delivery order.
 *
 *   'billing' — checkout.session.completed, customer.subscription.*,
 *     invoice.payment_failed. These all report on the SAME subscription's
 *     payment/status lifecycle, so a later one genuinely supersedes an earlier
 *     one (a subscription that is 'active' now supersedes the invoice that
 *     failed before it).
 *   'dispute' — charge.dispute.*. A chargeback on a charge is orthogonal to the
 *     subscription's status: a renewal succeeding says NOTHING about whether a
 *     cardholder disputed an earlier charge, so it must never silence one.
 */
function stripeEventLane(type: string): "billing" | "dispute" | null {
  if (type === "charge.dispute.created" || type === "charge.dispute.closed") return "dispute";
  return HANDLED_STRIPE_EVENT_TYPES.has(type) ? "billing" : null;
}

/**
 * The `billing_state` this event WANTS to write, or null when it writes none.
 * The staleness rule compares this against the state already on the row — see
 * isStaleBillingEvent's condition (2).
 */
function intendedBillingState(event: StripeEventInput): string | null {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return "active";
    case "customer.subscription.updated":
      return mapStripeSubscriptionStatus(obj.status);
    case "customer.subscription.deleted":
      return "canceled";
    case "invoice.payment_failed":
      return "past_due";
    case "charge.dispute.created":
      return "disputed";
    case "charge.dispute.closed":
      // Only a WON dispute writes state (it lifts the freeze); lost/other just
      // record the outcome on the disputes row.
      return obj.status === "won" ? "active" : null;
    default:
      return null;
  }
}

/**
 * True when this event must be REFUSED as out of order
 * (audit-stripe-webhook-2026-08-06.md finding 3, rescoped by
 * wave2-integration-gate-2026-08-06.md BLOCKING 2).
 *
 * The original defect: a stale `invoice.payment_failed` landing on a RECOVERED
 * payer wrote 'past_due', which flipped `isTenantActivated` false — swapping
 * real vendor adapters for sandbox ones mid-campaign — and then let the dunning
 * sweep suspend a paying customer off that poisoned state. A conditional write
 * is only as good as the freshness of what it conditions on.
 *
 * The first fix over-reached: ONE global watermark across all six types, so once
 * any event at time T applied, every event emitted before T was refused forever
 * IN EVERY LANE. That silently dropped the D5 chargeback freeze (a routine
 * renewal at T+300 made a real dispute emitted at T+120 a no-op, with no alert
 * and no self-heal) and could drop a paid checkout with `screened_at` NULL,
 * reopening the very compliance fail-open the guard-before-effect fix closed.
 * Refusal is right for SAME-LANE supersession and wrong for cross-lane, where
 * the older event carries information the newer one does not replace.
 *
 * THE RULE — refuse only when BOTH hold:
 *   (1) the event is OLDER than the newest applied event IN ITS OWN LANE.
 *       Strictly older; EQUAL applies, because Stripe's `created` has
 *       one-second granularity and two genuinely distinct events can share a
 *       second. A genuinely NEW failure after a recovery is therefore not
 *       stale (its `created` is later) — the guard must not turn a recovered
 *       tenant into one that can never go past_due again.
 *   (2) applying it would actually CHANGE the billing_state a newer event has
 *       already established. If the older event agrees with where the tenant
 *       already is, there is nothing to regress — so let it through and let its
 *       OTHER effects land. This is what saves a late checkout: it writes the
 *       'active' the renewal already set, but it is also the only carrier of
 *       the OFAC screen, the ledger credit and the subscription-item capture.
 *       It is also what still refuses a stale checkout after a cancellation
 *       (it would write 'active' over 'canceled'), and a stale dispute.closed
 *       (won) that would lift a NEWER freeze.
 *
 * An event with NO `created` is UNORDERED: it applies, and never advances a
 * watermark. Every real Stripe event carries `created`; only synthetic fixtures
 * lack one, and an unordered event must not poison the ordering of real ones.
 *
 * Failure direction: a wrong APPLY here can only be an event whose state write
 * agrees with the current state — i.e. it changes no state at all, and only its
 * idempotent side effects run. A wrong REFUSE silently drops a control. The
 * rule is deliberately biased toward applying.
 */
function isStaleBillingEvent(ctx: TenantContext, event: StripeEventInput): boolean {
  if (event.created === undefined) return false;
  const lane = stripeEventLane(event.type);
  if (!lane) return false;

  const row = ctx.sql
    .exec<{ last_event_created: number }>(`SELECT last_event_created FROM billing_event_order WHERE lane = ?`, lane)
    .toArray()[0];
  if (row === undefined || event.created >= row.last_event_created) return false; // (1)

  const intended = intendedBillingState(event);
  if (intended === null) return false; // writes no state — nothing to regress
  const current = ctx.sql
    .exec<{ billing_state: string }>(`SELECT billing_state FROM tenant_profile WHERE id = ?`, ctx.tenantId)
    .one().billing_state;
  return intended !== current; // (2)
}

/**
 * Closes the current dunning cycle at a billing RECOVERY transition
 * (audit-stripe-webhook-2026-08-06.md finding 6). `billingFailureCount`
 * (engine/ops-summary.ts) counts `invoice.payment_failed` rows in
 * `webhook_events` and had no window at all, so the "cycle" was a LIFETIME
 * count: three failures a year ago plus one today read as cycle 4 and
 * suspended the tenant on that single new failure, skipping the whole
 * four-strike grace period.
 *
 * Recorded as a webhook_events ROWID rather than a timestamp — insertion order
 * cannot tie, so it needs no clock and is unaffected by the tenant's virtual
 * one. Called at EVERY recovery transition regardless of whether the tenant was
 * actually dunning-suspended: a tenant sitting at cycle 3 (failing, not yet
 * suspended) who then pays must start their next cycle at 1 too. Monotonic by
 * construction, since rowids only increase.
 */
function recordDunningCycleBasis(ctx: TenantContext, now: number): void {
  ctx.sql.exec(
    `INSERT INTO dunning_cycle_basis (id, basis_rowid, updated_at)
     VALUES (1, (SELECT COALESCE(MAX(rowid), 0) FROM webhook_events), ?)
     ON CONFLICT (id) DO UPDATE SET basis_rowid = excluded.basis_rowid, updated_at = excluded.updated_at`,
    now,
  );
}

/** Advances the watermark FOR THIS EVENT'S LANE ONLY, monotonically — the
 *  conditional upsert means an out-of-order write can never pull it backwards,
 *  and one lane can never move another lane's mark. */
function recordBillingEventOrder(ctx: TenantContext, event: StripeEventInput, now: number): void {
  if (event.created === undefined) return;
  const lane = stripeEventLane(event.type);
  if (!lane) return;
  ctx.sql.exec(
    `INSERT INTO billing_event_order (lane, last_event_created, last_event_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (lane) DO UPDATE SET
       last_event_created = excluded.last_event_created,
       last_event_id = excluded.last_event_id,
       updated_at = excluded.updated_at
     WHERE excluded.last_event_created >= billing_event_order.last_event_created`,
    lane,
    event.created,
    event.id,
    now,
  );
}

/**
 * Applies one Stripe webhook event to this tenant. Idempotent by event id
 * (ARCHITECTURE.md #3): a redelivered event's second `INSERT OR IGNORE`
 * writes zero rows and this returns `{ applied: false, duplicate: true }`
 * WITHOUT re-running the mutation — UNLESS the previous attempt died partway
 * through (finding 2), which the in-flight marker records and this finishes.
 *
 * ORDER OF OPERATIONS, and why:
 *   1. claim the event id. This is the concurrency guard — DO single-threading
 *      serializes the INSERT OR IGNORE, so of two simultaneous deliveries
 *      exactly one wins the claim. It has to stay FIRST for that to hold.
 *   2. refuse an out-of-order event (isStaleBillingEvent) before any effect.
 *   3. advance the watermark, synchronously, BEFORE the effects — so a handler
 *      that dies mid-flight still can't be undercut by an older redelivery.
 *   4. mark in flight, run effects, unmark. The effects themselves are ordered
 *      so every awaited VENDOR call comes last: the compliance screen and the
 *      ledger write can no longer be skipped by a Stripe hiccup.
 */
export async function applyStripeWebhookEvent(ctx: TenantContext, event: StripeEventInput): Promise<WebhookApplyResult> {
  const now = ctx.clock.now();
  const claim = ctx.sql.exec(
    `INSERT OR IGNORE INTO webhook_events (event_id, type, ts) VALUES (?, ?, ?)`,
    event.id,
    event.type,
    now,
  );
  if (claim.rowsWritten === 0) {
    const halfApplied = ctx.sql
      .exec<{ event_id: string }>(`SELECT event_id FROM webhook_event_inflight WHERE event_id = ?`, event.id)
      .toArray()[0];
    if (!halfApplied) return { applied: false, duplicate: true };
    // The completion pass obeys the SAME ordering rule as a first delivery.
    // Without this, finding 2's fix would reopen finding 3 one door down: a
    // checkout that crashed mid-handler at T1, followed by a
    // customer.subscription.deleted at T2, would have its half-applied work
    // "finished" when Stripe redelivered it — re-writing plan='managed',
    // billing_state='active' and resurrecting a canceled tenant. Superseded
    // work is not worth finishing; drop the marker and stop.
    if (isStaleBillingEvent(ctx, event)) {
      ctx.sql.exec(`DELETE FROM webhook_event_inflight WHERE event_id = ?`, event.id);
      return { applied: false, duplicate: true, stale: true };
    }
    // A previous attempt claimed this event and then died before finishing
    // (finding 2's exact repro: an awaited Stripe call threw with the claim
    // already durable). Finish the job instead of no-op'ing it — the effects
    // are idempotent, which is what makes this safe to run against work that
    // may have partially landed, and safe to run CONCURRENTLY with the original
    // attempt that is still in flight.
    await applyStripeEventEffects(ctx, event, now);
    ctx.sql.exec(`DELETE FROM webhook_event_inflight WHERE event_id = ?`, event.id);
    return { applied: false, duplicate: true, completed: true };
  }

  if (isStaleBillingEvent(ctx, event)) {
    return { applied: false, duplicate: false, stale: true };
  }
  recordBillingEventOrder(ctx, event, now);

  ctx.sql.exec(`INSERT OR REPLACE INTO webhook_event_inflight (event_id, started_at) VALUES (?, ?)`, event.id, now);
  const result = await applyStripeEventEffects(ctx, event, now);
  ctx.sql.exec(`DELETE FROM webhook_event_inflight WHERE event_id = ?`, event.id);
  return result;
}

/**
 * The per-type effects. EVERY branch must be idempotent — the in-flight
 * completion path above re-runs this against state a crashed attempt may have
 * partially written, so a branch that appends rather than sets (the checkout
 * ledger entry) has to be keyed on something stable, not a fresh random id.
 */
async function applyStripeEventEffects(ctx: TenantContext, event: StripeEventInput, now: number): Promise<WebhookApplyResult> {
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
      // Quantity-billing (design §9): store the captured discount % (from the
      // session totals) + resolve/store the subscription-item ids + confirmed
      // mailbox quantity so syncMailboxQuantity can set-to-N without re-resolving.
      // The item-id capture needs a real Stripe subscription (a getSubscription
      // round trip), so it is gated on the key — a simulated tenant has none.
      ctx.sql.exec(`UPDATE tenant_profile SET checkout_discount_pct = ? WHERE id = ?`, readCheckoutDiscountPct(obj), ctx.tenantId);
      // Re-subscribe bookkeeping (findings #4 + #6).
      clearTeardownRecord(ctx);
      reactivateFromDunning(ctx);
      recordDunningCycleBasis(ctx, now);
      // Keyed on the EVENT id, not a fresh newId: the in-flight completion path
      // re-runs this branch after a crash, and an appending INSERT would then
      // write a second upgrade-credit row for one checkout.
      ctx.sql.exec(
        `INSERT OR IGNORE INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts) VALUES (?, ?, 'credit', 0, ?, ?)`,
        `ledg_${event.id}`,
        ctx.tenantId,
        `plan upgraded to ${plan} (stripe checkout.session.completed)`,
        now,
      );
      // G1 — screen at the activation transition, including the Stripe
      // billing name when the completed session actually carried one.
      //
      // ORDERING (audit 2026-08-06 finding 2): the sanctions screen and the
      // ledger write run BEFORE the Stripe round trip below, never after. When
      // `captureSubscriptionState` sat first, an ordinary 429/500 on
      // `GET /v1/subscriptions/{id}` threw with the dedup claim and
      // `billing_state='active'` already committed, so the retry short-circuited
      // as a duplicate and the tenant ended up permanently activated with
      // `screening_status` still at its 'clear' DEFAULT and `screened_at` NULL —
      // a crashed checkout was MORE activated than a clean one, breaking the
      // `isPaidPlanTier => screened-at-least-once` invariant.
      await screenTenant(ctx, { trigger: "checkout", billingName: readStripeBillingName(obj) });
      // The one vendor round trip, LAST, so nothing durable depends on it
      // completing. If it throws, the in-flight marker survives and the next
      // delivery of this event finishes exactly this step.
      if (ctx.env.STRIPE_SECRET_KEY && subscriptionId) {
        await captureSubscriptionState(ctx, ctx.env.STRIPE_SECRET_KEY, subscriptionId);
      }
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
      // Recovery-to-active also un-suspends a dunning-frozen tenant (finding #6)
      // and closes the dunning cycle, so the NEXT failure starts at 1.
      if (billingState === "active" && res.rowsWritten > 0) {
        reactivateFromDunning(ctx);
        recordDunningCycleBasis(ctx, now);
      }
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
        // dunning-frozen tenant (finding #6) and close the dunning cycle.
        if (res.rowsWritten > 0) {
          reactivateFromDunning(ctx);
          recordDunningCycleBasis(ctx, now);
        }
        return { applied: true, duplicate: false, unfrozen: res.rowsWritten > 0 };
      }
      return { applied: true, duplicate: false };
    }

    default:
      return { applied: false, duplicate: false };
  }
}

/**
 * The live PROVISIONED mailbox count — the billing meter (design §2, founder
 * ruling 1). `released_at IS NULL` (the exact query quota.ts/lifecycle.ts run).
 */
function provisionedMailboxCount(ctx: TenantContext): number {
  return ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) as n FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL`, ctx.tenantId)
    .one().n;
}

export interface SyncQuantityResult {
  /** True iff a set-to-N request was actually sent to Stripe on this call. */
  pushed: boolean;
  /** The desired mailbox quantity = max(5, provisioned) at this call. */
  quantity: number;
  /** The proration behavior sent (null if nothing was pushed). */
  proration: "create_prorations" | "none" | null;
}

/**
 * Mirrors the Stripe mailbox-item quantity to the live provisioned count
 * (design §2/§8). Billing FOLLOWS provisioning: `desired = max(5, provisioned)`
 * and the item quantity is SET to it (absolute, never increment — a
 * missed/duplicated push self-heals on the next sync). ACTIVE-ONLY (§7): a
 * frozen/dunning/canceled tenant is a no-op, so a teardown-driven release can
 * never push qty into a canceling subscription. NO-OP when there is no drift,
 * or when the tenant has no real Stripe subscription (a simulated /
 * unarmed-key tenant — the mechanic only applies to a real Stripe subscription).
 * Increases prorate (`create_prorations`); decreases do NOT credit
 * (`proration_behavior: "none"` — founder ruling 2). NEVER throws: a Stripe
 * hiccup leaves `mailbox_qty_synced` stale and the reconcile sweep retries, so
 * a push failure can never fail the provision/release that called it.
 */
export async function syncMailboxQuantity(ctx: TenantContext): Promise<SyncQuantityResult> {
  const row = ctx.sql
    .exec<{ billing_state: string; mailbox_qty_synced: number; stripe_subscription_id: string | null; stripe_mailbox_item_id: string | null }>(
      `SELECT billing_state, mailbox_qty_synced, stripe_subscription_id, stripe_mailbox_item_id FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();
  const desired = billableMailboxes(provisionedMailboxCount(ctx));

  // Active-only (§7) — a teardown/freeze release never reaches Stripe.
  if (row.billing_state !== "active") return { pushed: false, quantity: desired, proration: null };
  // No drift — the common case, no round trip.
  if (row.mailbox_qty_synced === desired) return { pushed: false, quantity: desired, proration: null };
  // No real Stripe subscription (simulated / unarmed) — nothing to mirror; do
  // NOT advance `synced` (there is no Stripe state to be in sync with).
  const key = ctx.env.STRIPE_SECRET_KEY;
  if (!key || !row.stripe_subscription_id || !row.stripe_mailbox_item_id) {
    return { pushed: false, quantity: desired, proration: null };
  }

  const proration: "create_prorations" | "none" = desired > row.mailbox_qty_synced ? "create_prorations" : "none";
  try {
    // Per-attempt-unique idempotency key: the set is ABSOLUTE (self-idempotent),
    // so the key must NOT dedupe a later distinct transition to the same target
    // within Stripe's 24h window (which would silently drop it) — it only guards
    // a within-call network retry. The reconcile sweep is the real safety net.
    await setSubscriptionItemQuantity(
      key,
      row.stripe_mailbox_item_id,
      desired,
      proration,
      `mbxqty:${ctx.tenantId}:${desired}:${ctx.clock.now()}`,
    );
    ctx.sql.exec(`UPDATE tenant_profile SET mailbox_qty_synced = ? WHERE id = ?`, desired, ctx.tenantId);
    return { pushed: true, quantity: desired, proration };
  } catch (err) {
    console.error("stripe mailbox quantity sync failed (non-fatal — the reconcile sweep will retry)", err);
    return { pushed: false, quantity: desired, proration };
  }
}

/**
 * Percent-off discount captured from a `checkout.session.completed` event
 * (design §9/N5), derived from the session totals (`amount_discount /
 * amount_subtotal`) so mrrCents/quote apply it without a Stripe round trip.
 * 0 when there is no coupon or the subtotal is 0.
 */
function readCheckoutDiscountPct(obj: Record<string, unknown>): number {
  const subtotal = typeof obj.amount_subtotal === "number" ? obj.amount_subtotal : 0;
  const totalDetails = obj.total_details;
  const discount =
    totalDetails && typeof totalDetails === "object" && typeof (totalDetails as Record<string, unknown>).amount_discount === "number"
      ? ((totalDetails as Record<string, unknown>).amount_discount as number)
      : 0;
  if (subtotal <= 0 || discount <= 0) return 0;
  return Math.round((discount / subtotal) * 100);
}

/**
 * Resolves + stores the platform/mailbox subscription-item ids, the confirmed
 * mailbox quantity (-> `mailbox_qty_synced`), and the interval at checkout
 * completion (design §9). One `getSubscription` round trip, gated on
 * `STRIPE_SECRET_KEY` by the caller — a simulated / test-mode-unarmed checkout
 * has no real Stripe subscription, so the ids stay NULL and the quantity
 * mechanic no-ops for that tenant.
 */
async function captureSubscriptionState(ctx: TenantContext, secretKey: string, subscriptionId: string): Promise<void> {
  const items = await getSubscription(secretKey, subscriptionId);
  const platform = items.find((i) => i.lookupKey === STRIPE_PRICES.platform_monthly.lookupKey || i.lookupKey === STRIPE_PRICES.platform_yearly.lookupKey);
  const mailbox = items.find((i) => i.lookupKey === STRIPE_PRICES.mailbox_monthly.lookupKey || i.lookupKey === STRIPE_PRICES.mailbox_yearly.lookupKey);
  if (!mailbox) return; // not our subscription shape — leave state unset
  const interval = mailbox.lookupKey === STRIPE_PRICES.mailbox_yearly.lookupKey ? "year" : "month";
  ctx.sql.exec(
    `UPDATE tenant_profile
       SET stripe_platform_item_id = ?, stripe_mailbox_item_id = ?, mailbox_qty_synced = ?, billing_interval = ?
     WHERE id = ?`,
    platform?.id ?? null,
    mailbox.id,
    mailbox.quantity,
    interval,
    ctx.tenantId,
  );
}

export interface MailboxBilling {
  /**
   * The mailbox count this projection is for — REALITY, not the ask (SPEC §18
   * "the proposed new count"). On an actual add/remove it is the live provisioned
   * count AFTER the operation (so a capacity_pending partial reflects only what
   * landed); on a quoteOnly preview it is the projected count (current + delta).
   */
  provisionedAfter: number;
  /** Projected monthly price for that count on the curve, folding any stored
   *  checkout discount, integer cents. Floors at the 5-mailbox / $99 minimum. */
  projectedMonthlyCents: number;
  /** Human-readable pricing formula (SPEC §18) so no add is a silent bill surprise. */
  formula: string;
}

/**
 * The billing projection returned on EVERY mailbox add/remove response (SPEC
 * §18 "no silent capacity addition" — the response must carry the proposed new
 * count + projected monthly price). `provisionedAfter` is passed by the caller:
 * the REAL post-operation count on an actual add/remove, or the projected count
 * on a quoteOnly preview. The monthly folds the discount captured at checkout
 * and floors at 5. Read-only.
 */
export function buildMailboxBilling(ctx: TenantContext, provisionedAfter: number): MailboxBilling {
  const discountPct = ctx.sql
    .exec<{ d: number }>(`SELECT checkout_discount_pct as d FROM tenant_profile WHERE id = ?`, ctx.tenantId)
    .one().d;
  return {
    provisionedAfter,
    projectedMonthlyCents: monthlyRevenueCents(provisionedAfter, discountPct),
    formula: "$49 platform + $10/mailbox, 5 minimum",
  };
}

export interface RemoveMailboxesResult {
  releasedCount: number;
  /** The projected bill after the release (the lower count, floored at $99). */
  billing: MailboxBilling;
}

/**
 * Customer-initiated downgrade (design §2 — the symmetrical deprovision path,
 * distinct from teardown). Releases the N newest live mailboxes NOW (effective
 * immediately for provisioning) and mirrors the LOWER Stripe quantity with
 * proration_behavior 'none' — no mid-cycle credit (founder ruling 2), effective
 * next renewal for billing. Guards against a frozen tenant (must re-subscribe
 * first). Reuses the shared releaseMailboxes path (revoke-before-mark + G4
 * slot decrement). The quoted consent is enforced at the boundary
 * (RemoveMailboxesInput.acknowledged must be an explicit `true`).
 */
export async function removeMailboxes(ctx: TenantContext, input: RemoveMailboxesInput): Promise<RemoveMailboxesResult> {
  assertNotLifecycleFrozen(ctx, "remove_mailboxes");
  const { releasedCount } = await releaseMailboxes(ctx, { limit: input.count });
  // Decrease: syncMailboxQuantity picks proration_behavior 'none' (desired < synced).
  await syncMailboxQuantity(ctx);
  return { releasedCount, billing: buildMailboxBilling(ctx, provisionedMailboxCount(ctx)) };
}
