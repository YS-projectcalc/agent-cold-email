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

// Quantity-billing migration (design §3) — the durable Prices checkout
// references by id. Two products (platform + mailbox), each with a monthly and
// a yearly Price, keyed by a stable, versioned `lookup_key`. The `_v1` suffix
// lets a future unit-amount change mint `_v2` without mutating the Price
// historical subscriptions already reference. unit_amount is integer cents.
export const STRIPE_PRICES = {
  platform_monthly: { lookupKey: "coldrig_platform_monthly_v1", product: "Coldrig Platform", interval: "month", unitAmount: 4900 },
  mailbox_monthly: { lookupKey: "coldrig_mailbox_monthly_v1", product: "Coldrig Mailbox", interval: "month", unitAmount: 1000 },
  platform_yearly: { lookupKey: "coldrig_platform_yearly_v1", product: "Coldrig Platform", interval: "year", unitAmount: 49000 },
  mailbox_yearly: { lookupKey: "coldrig_mailbox_yearly_v1", product: "Coldrig Mailbox", interval: "year", unitAmount: 10000 },
} as const;

export type StripePriceSlug = keyof typeof STRIPE_PRICES;
/** Resolved `slug -> Stripe Price id` map for one Stripe mode (test or live). */
export type StripePriceMap = Record<StripePriceSlug, string>;

/** 'test' | 'live' derived from the secret key prefix — decides which Stripe mode
 *  (and thus which cached Price ids) a call operates in. */
export function stripeMode(secretKey: string): "test" | "live" {
  return secretKey.startsWith("sk_test_") ? "test" : "live";
}

function stripeHeaders(secretKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_API_VERSION,
  };
}

export interface CreateCheckoutSessionParams {
  tenantId: string;
  /** Durable Price id for the flat $49 platform item (qty 1). */
  platformPriceId: string;
  /** Durable Price id for the $10 mailbox item. */
  mailboxPriceId: string;
  /** Initial mailbox quantity = max(5, provisioned-at-checkout) — floors at the $99 minimum. */
  mailboxQuantity: number;
  successUrl: string;
  cancelUrl: string;
}

export interface StripeCheckoutSessionResult {
  id: string;
  url: string;
}

/**
 * Creates a real Stripe TEST-mode Checkout Session (subscription mode) on the
 * per-mailbox curve (design §2/§3): two DURABLE Price line items — a flat
 * platform item (qty 1) + a mailbox item (qty = max(5, provisioned)). The
 * durable Prices (created by `ensureStripePrices`) carry their own Product name
 * ("Coldrig Platform"/"Coldrig Mailbox"), so checkout no longer emits inline
 * `price_data` — a subscription-level coupon rides every line + every future
 * quantity bump, and the Price is reusable/auditable. `client_reference_id` +
 * metadata carry the tenantId so the webhook routes back to the right TenantDO;
 * `subscription_data.metadata` copies it onto the subscription for later
 * subscription-level events.
 *
 * REQUIRED COUPON CONSTRAINTS (founder-created in the Stripe dashboard — F2,
 * adversarial 2026-07-21; cite this comment in the arming runbook): the pilot
 * promotion code (MORDYPILOT, design §0) MUST be minted with `max_redemptions:
 * 1` (or restricted to the pilot customer) and `duration: "forever"` (or a
 * `repeating` duration covering the whole pilot term) — a duration-limited
 * coupon that later expires leaves the renewal invoice charging a subscription
 * whose card was never collected at a $0-after-discount checkout (see
 * engine/billing.ts's `invoice.payment_failed` -> 'past_due'). There is now ONE
 * paid plan (`managed`), so `allow_promotion_codes` is enabled for every
 * checkout; the actual redemption cap lives at Stripe. `payment_method_collection:
 * "if_required"` still collects a card whenever the discounted invoice is > $0
 * (e.g. a 60%-off checkout — design §10 scenario 5), so a real renewal has a
 * card on file; only a 100%-off ($0) checkout completes without one.
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
  body.set("metadata[plan]", "managed");
  body.set("subscription_data[metadata][tenantId]", params.tenantId);
  body.set("subscription_data[metadata][plan]", "managed");
  body.set("line_items[0][price]", params.platformPriceId);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[1][price]", params.mailboxPriceId);
  body.set("line_items[1][quantity]", String(params.mailboxQuantity));
  body.set("allow_promotion_codes", "true");
  body.set("payment_method_collection", "if_required");

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

interface StripePriceListItem {
  id: string;
  lookup_key: string | null;
}

/** GET the active Price for a `lookup_key`, or null if none exists yet. */
async function fetchPriceByLookupKey(secretKey: string, lookupKey: string): Promise<string | null> {
  const url = `${STRIPE_API_BASE}/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`;
  const res = await fetch(url, { method: "GET", headers: stripeHeaders(secretKey) });
  if (!res.ok) throw new Error(`stripe price lookup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: StripePriceListItem[] };
  const match = json.data.find((p) => p.lookup_key === lookupKey);
  return match?.id ?? null;
}

/**
 * Find-or-create the Product for a Price by a deterministic metadata tag
 * (`coldrig_product` = the product name), so two concurrent bootstraps never
 * create duplicate Products. Stripe has no unique constraint on product name,
 * so we search by metadata first and only create on a genuine miss.
 */
async function findOrCreateProduct(secretKey: string, name: string): Promise<string> {
  const tag = name;
  const searchUrl = `${STRIPE_API_BASE}/products/search?query=${encodeURIComponent(`metadata['coldrig_product']:'${tag}'`)}&limit=1`;
  const searchRes = await fetch(searchUrl, { method: "GET", headers: stripeHeaders(secretKey) });
  if (searchRes.ok) {
    const json = (await searchRes.json()) as { data: { id: string }[] };
    if (json.data[0]) return json.data[0].id;
  }
  const body = new URLSearchParams();
  body.set("name", name);
  body.set("metadata[coldrig_product]", tag);
  const res = await fetch(`${STRIPE_API_BASE}/products`, {
    method: "POST",
    headers: stripeHeaders(secretKey),
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`stripe product create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Create a recurring Price for a lookup_key; returns the new Price id. */
async function createPrice(secretKey: string, slug: StripePriceSlug, productId: string): Promise<string> {
  const spec = STRIPE_PRICES[slug];
  const body = new URLSearchParams();
  body.set("currency", "usd");
  body.set("unit_amount", String(spec.unitAmount));
  body.set("recurring[interval]", spec.interval);
  body.set("product", productId);
  body.set("lookup_key", spec.lookupKey);
  const res = await fetch(`${STRIPE_API_BASE}/prices`, {
    method: "POST",
    headers: stripeHeaders(secretKey),
    body: body.toString(),
  });
  return handlePriceCreate(res, secretKey, spec.lookupKey);
}

// Split out so the happy path stays a single expression above; on a
// duplicate-lookup_key race (adversary N3) Stripe rejects the second create —
// re-fetch by lookup_key and use the existing Price rather than surfacing the
// error, so two concurrent bootstraps converge on ONE Price per lookup_key.
async function handlePriceCreate(res: Response, secretKey: string, lookupKey: string): Promise<string> {
  if (res.ok) return ((await res.json()) as { id: string }).id;
  const text = await res.text();
  if (/lookup_key/i.test(text)) {
    const existing = await fetchPriceByLookupKey(secretKey, lookupKey);
    if (existing) return existing;
  }
  throw new Error(`stripe price create failed: ${res.status} ${text}`);
}

/**
 * Idempotent durable-Price bootstrap (design §3). Resolves every `lookup_key`
 * to a Price id, creating any that are missing (find-or-create the Product,
 * then the Price). RACE-SAFE on the lazy path: a duplicate-`lookup_key` create
 * error re-fetches the existing Price (N3), so two concurrent first-checkouts
 * converge on one Price per key. Pure Stripe REST (no D1) — the same code path
 * runs at the arm-time admin bootstrap, in the build-time test-mode gate, and
 * lazily at first checkout; the D1 cache is layered above this in
 * engine/billing.ts. `secretKey`'s prefix decides test vs live mode.
 */
export async function ensureStripePrices(secretKey: string): Promise<StripePriceMap> {
  const slugs = Object.keys(STRIPE_PRICES) as StripePriceSlug[];
  const entries = await Promise.all(
    slugs.map(async (slug): Promise<[StripePriceSlug, string]> => {
      const existing = await fetchPriceByLookupKey(secretKey, STRIPE_PRICES[slug].lookupKey);
      if (existing) return [slug, existing];
      const productId = await findOrCreateProduct(secretKey, STRIPE_PRICES[slug].product);
      const priceId = await createPrice(secretKey, slug, productId);
      return [slug, priceId];
    }),
  );
  return Object.fromEntries(entries) as StripePriceMap;
}

export interface StripeSubscriptionItem {
  id: string;
  lookupKey: string | null;
  priceId: string;
  quantity: number;
}

/**
 * GET a subscription's line items (id + resolved lookup_key + quantity), used
 * to resolve the platform/mailbox subscription-item ids at
 * `checkout.session.completed` and to assert quantities in the test-mode gate.
 */
export async function getSubscription(secretKey: string, subscriptionId: string): Promise<StripeSubscriptionItem[]> {
  const res = await fetch(`${STRIPE_API_BASE}/subscriptions/${subscriptionId}`, {
    method: "GET",
    headers: stripeHeaders(secretKey),
  });
  if (!res.ok) throw new Error(`stripe subscription fetch failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    items: { data: { id: string; quantity?: number; price: { id: string; lookup_key: string | null } }[] };
  };
  return json.items.data.map((item) => ({
    id: item.id,
    lookupKey: item.price.lookup_key ?? null,
    priceId: item.price.id,
    quantity: item.quantity ?? 0,
  }));
}

/**
 * The customer id behind a charge — the ONLY route from a Dispute back to an
 * account (audit-stripe-webhook-2026-08-06.md finding 1). A Dispute is minted by
 * Stripe FROM a charge: it carries `metadata: {}`, no `client_reference_id`, and
 * no `customer` field of its own, so `charge.dispute.*` cannot be routed from
 * its payload alone. Its `charge` id can be, with this one read.
 *
 * The error grading is the point. This runs on the unauthenticated webhook path,
 * where the two failure modes need OPPOSITE handling:
 *   - transient (429 / 5xx / network) -> THROW, so the route 500s and Stripe
 *     redelivers. Losing a chargeback freeze to a momentary blip is not
 *     acceptable; the D5 lane exists because a dispute WAVE can get the master
 *     account frozen (SPEC.md §12).
 *   - permanent (any other non-2xx — charge not found, wrong mode, revoked key)
 *     -> `null`, i.e. "unroutable". A THROW here would 500 every redelivery for
 *     the ~3 days Stripe retries and count the whole way toward endpoint
 *     auto-disable, which would take down billing for EVERY tenant over one
 *     poison event (finding 8). The caller turns null into a 200 + a founder alert.
 */
export async function getChargeCustomerId(secretKey: string, chargeId: string): Promise<string | null> {
  const res = await fetch(`${STRIPE_API_BASE}/charges/${encodeURIComponent(chargeId)}`, {
    method: "GET",
    headers: stripeHeaders(secretKey),
  });
  if (!res.ok) {
    const detail = `${res.status} ${await res.text()}`;
    if (res.status === 429 || res.status >= 500) throw new Error(`stripe charge fetch failed (transient): ${detail}`);
    console.error(`stripe charge fetch failed permanently for ${chargeId} — event is unroutable: ${detail}`);
    return null;
  }
  const json = (await res.json()) as { customer?: unknown };
  if (typeof json.customer === "string" && json.customer.length > 0) return json.customer;
  // Expanded shape (`?expand[]=customer`, or a future default) — accept both.
  if (json.customer && typeof json.customer === "object") {
    const id = (json.customer as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * How long the decline-code lookup below may take. It runs INSIDE the webhook's
 * own response, so it is bounded far below Stripe's delivery timeout: a slow
 * Stripe must cost us an unknown decline code (which grades transient), never a
 * webhook that times out and gets redelivered for three days.
 */
export const STRIPE_DECLINE_LOOKUP_TIMEOUT_MS = 5_000;

/** One bounded GET, or `null` on ANY failure — see getDeclineCode's grading. */
async function readStripeObject(secretKey: string, path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${STRIPE_API_BASE}/${path}`, {
      method: "GET",
      headers: stripeHeaders(secretKey),
      signal: AbortSignal.timeout(STRIPE_DECLINE_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`stripe decline-code lookup failed for ${path}: ${res.status} ${await res.text()}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(`stripe decline-code lookup errored for ${path} — the decline grades transient`, err);
    return null;
  }
}

function readNestedString(container: unknown, key: string): string | null {
  if (!container || typeof container !== "object") return null;
  const value = (container as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The charge decline code behind a failed invoice (A5) — the second read the
 * permanent-decline fast path needs. On a real `invoice.payment_failed` the
 * invoice's `charge` and `payment_intent` are bare id STRINGS, so the payload
 * itself carries no failure detail at all; without this call every real decline
 * graded transient and `lost_card`/`stolen_card`/`fraudulent` never suspended.
 *
 * ONE round trip: the Charge when the invoice has one (`outcome.reason` is where
 * Stripe puts the issuer's decline code, `failure_code` the generic card error),
 * otherwise the PaymentIntent (`last_payment_error.decline_code`, the canonical
 * field, then its `code`). An invoice that failed before any Charge existed has
 * `charge: null` and only the intent.
 *
 * The error grading is the OPPOSITE of getChargeCustomerId's above, deliberately.
 * There, losing the read loses the routing, so a transient failure must throw and
 * be redelivered. Here the read only REFINES a decision that already has a safe
 * default: unknown means transient, which keeps the four-strike grace cycle. So
 * this never throws and never blocks the failure from applying — suspending a
 * paying customer because Stripe 503'd would be strictly worse than the bug this
 * closes.
 */
export async function getDeclineCode(
  secretKey: string,
  chargeId: string | null,
  paymentIntentId: string | null,
): Promise<string | null> {
  if (chargeId) {
    const charge = await readStripeObject(secretKey, `charges/${encodeURIComponent(chargeId)}`);
    return readNestedString(charge?.outcome, "reason") ?? (charge ? readNestedString(charge, "failure_code") : null);
  }
  if (paymentIntentId) {
    const intent = await readStripeObject(secretKey, `payment_intents/${encodeURIComponent(paymentIntentId)}`);
    return (
      readNestedString(intent?.last_payment_error, "decline_code") ??
      readNestedString(intent?.last_payment_error, "code")
    );
  }
  return null;
}

/**
 * Sets a licensed subscription item's quantity to an ABSOLUTE value (design
 * §8.2 — set-to-N, never increment, so a missed/duplicated push self-heals on
 * the next sync). `prorationBehavior` is the founder-ruled direction: increases
 * `create_prorations` (bill the partial-period cost of added mailboxes),
 * decreases `none` (no mid-cycle credit — founder ruling 2). `idempotencyKey`
 * makes a redelivered set safe at Stripe.
 */
export async function setSubscriptionItemQuantity(
  secretKey: string,
  subscriptionItemId: string,
  quantity: number,
  prorationBehavior: "create_prorations" | "none",
  idempotencyKey: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("quantity", String(quantity));
  body.set("proration_behavior", prorationBehavior);
  const res = await fetch(`${STRIPE_API_BASE}/subscription_items/${subscriptionItemId}`, {
    method: "POST",
    headers: { ...stripeHeaders(secretKey), "Idempotency-Key": idempotencyKey },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`stripe set subscription item quantity failed: ${res.status} ${await res.text()}`);
}
