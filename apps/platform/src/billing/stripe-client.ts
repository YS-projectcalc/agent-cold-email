// Outbound Stripe REST calls (api.stripe.com) — checkout session creation +
// metered-usage reporting. Only ever invoked when `env.STRIPE_SECRET_KEY` is
// set (checked by the caller, src/engine/billing.ts), which is never true in
// this build (CLAUDE.md rule g: no real vendor secret in the repo; wiring a
// real Stripe TEST key is an ACTIVATION.md step). Coded fully against
// Stripe's documented REST shape so the swap is a provable no-op at
// activation (ARCHITECTURE.md #1), same spirit as src/vendors/real/*.

const STRIPE_API_BASE = "https://api.stripe.com/v1";
// Pinned explicitly so a future Stripe API change can't silently alter this
// request's shape; bump deliberately (with a re-read of the relevant docs).
const STRIPE_API_VERSION = "2024-06-20";

function stripeHeaders(secretKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_API_VERSION,
  };
}

export interface CreateCheckoutSessionParams {
  tenantId: string;
  plan: string;
  priceCents: number;
  label: string;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutSessionResult {
  id: string;
  url: string;
}

// I2 (self-serve activation design §2.5) — promo-eligible plan. Restricted to
// `launch` in CODE (F2, adversarial 2026-07-21, BLOCKING): the founder's
// 100%-off pilot coupon is for the flat-$99 launch tier only, so
// `allow_promotion_codes`/`payment_method_collection` are only set on a
// launch-plan session — a growth/scale checkout keeps requiring a card, same
// as before this change, regardless of what coupon someone might try to
// apply. This is defense-in-depth on OUR side; the actual redemption cap
// lives at Stripe (see the REQUIRED COUPON CONSTRAINTS note below).
const PROMO_ELIGIBLE_PLAN = "launch";

/**
 * Creates a real Stripe TEST-mode Checkout Session (subscription mode, one
 * inline price per SPEC.md §18 — no pre-created Stripe Price object needed,
 * so this works the moment a test secret key is wired without any extra
 * Stripe-dashboard setup step). `client_reference_id` + metadata carry the
 * tenantId so the webhook handler can route back to the right TenantDO
 * without a separate customer->tenant index; `subscription_data.metadata`
 * copies the same onto the subscription so later subscription-level events
 * (customer.subscription.updated/deleted) carry it too.
 *
 * REQUIRED COUPON CONSTRAINTS (founder-created in the Stripe dashboard —
 * F2, adversarial 2026-07-21, BLOCKING; cite this comment in the arming
 * runbook): the pilot's 100%-off promotion code MUST be minted with
 * `max_redemptions: 1` (or restricted to the pilot customer), MUST be
 * restricted to the `launch` price (this session only enables promo entry
 * for `launch` — see `PROMO_ELIGIBLE_PLAN` above), and MUST be `duration:
 * "forever"` (or a `repeating` duration covering the whole pilot term) — a
 * duration-limited coupon that later expires leaves the renewal invoice
 * charging a subscription with NO payment method on file (this is expected;
 * see engine/billing.ts's `invoice.payment_failed` handling, which is what
 * catches it and drives billing_state -> 'past_due' -> the I1 activation
 * gate off). Without `max_redemptions`/plan restriction, ANY self-serve
 * signup that discovers the code could activate real vendor spend for $0
 * (adversarial finding F2) — this is a Stripe-dashboard-only control; no
 * code here can enforce it, hence this comment.
 */
export async function createStripeCheckoutSession(
  secretKey: string,
  params: CreateCheckoutSessionParams,
): Promise<StripeCheckoutSessionResult> {
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("client_reference_id", params.tenantId);
  body.set("success_url", params.successUrl);
  body.set("cancel_url", params.cancelUrl);
  body.set("metadata[tenantId]", params.tenantId);
  body.set("metadata[plan]", params.plan);
  body.set("subscription_data[metadata][tenantId]", params.tenantId);
  body.set("subscription_data[metadata][plan]", params.plan);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", "usd");
  body.set("line_items[0][price_data][unit_amount]", String(params.priceCents));
  body.set("line_items[0][price_data][recurring][interval]", "month");
  // The customer-visible brand is Coldrig (2026-07-22 founder ORDER,
  // ROADMAP.md; the prior internal working name is retired and must never
  // render here again — see the brand-copy guard test in
  // stripe-client-checkout.test.ts, which scans this file's raw source for
  // that retired name so this comment deliberately does not spell it out).
  // The "(test mode)" suffix is DERIVED from the secret key already threaded
  // into this function — never hardcoded — so a real sk_live_ key
  // (post-activation) never shows a test-mode label to a paying customer.
  const isTestModeKey = secretKey.startsWith("sk_test_");
  const productName = isTestModeKey ? `Coldrig ${params.label} (test mode)` : `Coldrig ${params.label}`;
  body.set("line_items[0][price_data][product_data][name]", productName);
  if (params.plan === PROMO_ELIGIBLE_PLAN) {
    // §2.5: enables the code-entry box + lets a 100%-off code complete with
    // NO card (payment_method_collection "if_required" only asks for a
    // payment method when the invoice total is actually > 0).
    body.set("allow_promotion_codes", "true");
    body.set("payment_method_collection", "if_required");
  }

  const res = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: stripeHeaders(secretKey),
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`stripe checkout session create failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { id: string; url: string | null };
  if (!json.url) throw new Error("stripe checkout session created without a url");
  return { id: json.id, url: json.url };
}

/**
 * Reports one metered-usage increment. NOTE: Stripe's usage-records endpoint
 * is keyed by SUBSCRIPTION ITEM id, not subscription id — resolving the
 * correct line-item id from a subscription (a GET /v1/subscriptions/{id}
 * round trip) is an activation-time detail (ACTIVATION.md), since it's
 * unreachable without a real key regardless. Callers pass whatever
 * identifier they have; this function's job is only the documented call
 * shape, not the lookup.
 *
 * B5 (CLASS B): `idempotencyKey` is sent as Stripe's `Idempotency-Key` header,
 * derived from the source send/provision id by the caller. Stripe dedupes on
 * it for 24h, so a redelivered/retried report (an at-least-once tick re-run,
 * a network retry) can't double-increment metered usage even though `action:
 * increment` is otherwise additive.
 */
export async function reportUsageRecord(
  secretKey: string,
  subscriptionItemId: string,
  quantity: number,
  timestampMs: number,
  idempotencyKey: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("quantity", String(quantity));
  body.set("timestamp", String(Math.floor(timestampMs / 1000)));
  body.set("action", "increment");

  const res = await fetch(`${STRIPE_API_BASE}/subscription_items/${subscriptionItemId}/usage_records`, {
    method: "POST",
    headers: { ...stripeHeaders(secretKey), "Idempotency-Key": idempotencyKey },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`stripe usage record report failed: ${res.status} ${text}`);
  }
}
