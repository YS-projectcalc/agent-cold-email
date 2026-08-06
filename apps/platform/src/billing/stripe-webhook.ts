// Inbound Stripe webhook transport concerns: the event shape, signature
// verification, and tenant-id resolution. Business logic (what an event
// DOES to a tenant) lives in ../engine/billing.ts — this file only gets the
// event safely off the wire and figures out which TenantDO it belongs to.

import { z } from "zod";
import { timingSafeEqual } from "../timing-safe-equal.js";

// Deliberately loose (Stripe's real event payloads carry far more fields) —
// we only need enough structure to route + dedupe + read metadata. Anything
// else stays as unknown, untouched.
export const StripeEventInput = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  // Unix SECONDS, set by Stripe when it EMITTED the event — the only ordering
  // fact a webhook carries, and what engine/billing.ts's staleness guard reads
  // (audit-stripe-webhook-2026-08-06.md finding 3). Optional so a synthetic
  // fixture without it still parses; such an event is treated as UNORDERED
  // rather than as "newest" (see applyStripeWebhookEvent).
  created: z.number().int().nonnegative().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEventInput = z.infer<typeof StripeEventInput>;

/**
 * The event types `applyStripeWebhookEvent`'s switch actually acts on — i.e.
 * the ones where failing to resolve a tenant is a REAL LOSS worth alerting a
 * human about, and the ones whose ordering matters. Anything else is inert by
 * design (it 200s, changes nothing, and must stay quiet).
 *
 * Kept here rather than in engine/billing.ts because both the Worker route
 * (which alerts on an unroutable one) and the DO (which orders them) need it,
 * and the route must not import DO business logic. `handled-event-types.test.ts`
 * parses engine/billing.ts's source and fails if this set ever drifts from the
 * switch — a doc comment would not survive the next event type.
 */
export const HANDLED_STRIPE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

/**
 * How far a `Stripe-Signature` timestamp may be from our clock. Matches the
 * 300s default Stripe's own `constructEvent` enforces.
 */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies Stripe's `Stripe-Signature` header (`t=<timestamp>,v1=<hmac>[,v1=...]`)
 * against the RAW request body — must run BEFORE any JSON.parse, since the
 * signature is computed over the exact bytes Stripe sent. Timing-safe compare
 * against a forged signature guess.
 *
 * Two things the original implementation got wrong (audit 2026-08-06 findings
 * 4 and 5), both in this one function:
 *
 * 1. It folded `t` into the signed string but never CHECKED it, so a captured
 *    delivery stayed replayable forever against any tenant DO that had not
 *    already recorded that event id. The window is symmetric: a far-FUTURE
 *    timestamp is refused too — it cannot come from Stripe, and accepting it
 *    would let a captured delivery be pre-dated into permanent validity.
 * 2. It built a Map from the header, which keeps only the LAST value of a
 *    repeated key. Stripe's header carries one or MORE `v1` signatures, and
 *    during an endpoint-secret roll it signs with both the old and the new
 *    secret — so acceptance depended on Stripe's ordering within the header,
 *    and a rotation could have 400'd every delivery until the retries
 *    exhausted. Every `v1` is now checked and any match accepts, which is what
 *    Stripe's own libraries do.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const pairs = header
    .split(",")
    .map((kv) => kv.split("="))
    .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== undefined && kv[1] !== undefined)
    .map(([k, v]) => [k.trim(), v.trim()] as [string, string]);

  const timestamp = pairs.find(([k]) => k === "t")?.[1];
  const signatures = pairs.filter(([k, v]) => k === "v1" && v.length > 0).map(([, v]) => v);
  if (!timestamp || signatures.length === 0) return false;

  // `Number("")` is 0 and `Number("12x")` is NaN — require a plain integer so
  // neither shape slips through as a usable time.
  if (!/^\d+$/.test(timestamp)) return false;
  const skewSeconds = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skewSeconds > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // No early break: every candidate is compared, so the work done does not
  // depend on WHICH signature matched.
  let matched = false;
  for (const candidate of signatures) if (timingSafeEqual(expected, candidate)) matched = true;
  return matched;
}

/** Where a resolved tenant id came from — carried into logs/alerts so an
 *  operator can tell an in-payload route from an indexed one. */
export type StripeTenantSource =
  | "metadata"
  | "client_reference_id"
  | "subscription_details"
  | "customer_index"
  | "charge_customer_index";

export interface StripeTenantResolution {
  tenantId: string;
  source: StripeTenantSource;
  /** The Stripe customer id the event carried, when it carried one — the route
   *  persists this pairing so LATER events can resolve without any metadata. */
  customerId: string | null;
}

/**
 * The two lookups resolution needs from outside this module, injected so the
 * transport layer stays free of D1/Stripe wiring (and so resolution is unit
 * testable without either).
 */
export interface StripeTenantResolverDeps {
  /** D1 `stripe_customer_index` (src/db.ts). */
  lookupTenantIdByCustomer(customerId: string): Promise<string | null>;
  /**
   * `GET /v1/charges/{id}` -> customer id. MUST throw on a TRANSIENT failure
   * (so the route 500s and Stripe redelivers) and resolve `null` on a permanent
   * one — see billing/stripe-client.ts's getChargeCustomerId. `null` when no
   * Stripe key is armed at all.
   */
  lookupChargeCustomerId(chargeId: string): Promise<string | null>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A Stripe id field is either the bare id or, when expanded, the object. */
function readIdRef(value: unknown): string | null {
  const direct = readString(value);
  if (direct) return direct;
  if (value && typeof value === "object") return readString((value as { id?: unknown }).id);
  return null;
}

function readMetadataTenantId(container: unknown): string | null {
  if (!container || typeof container !== "object") return null;
  const metadata = (container as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return readString((metadata as Record<string, unknown>).tenantId);
}

/**
 * Resolves which tenant an event belongs to. Resolution is a LADDER, cheapest
 * and most authoritative first:
 *
 *   1. `data.object.metadata.tenantId` — set by US at checkout-session creation
 *      (billing/stripe-client.ts) onto the Session and, via
 *      `subscription_data[metadata]`, onto the Subscription. Server-set, no
 *      customer-facing surface can influence it, which is why it stays first
 *      choice: it is the only source that is authoritative on its own.
 *   2. `client_reference_id` — the same value, on the Checkout Session.
 *   3. `subscription_details.metadata.tenantId` — where Stripe surfaces the
 *      SUBSCRIPTION's metadata on an Invoice. The invoice's own `metadata` is
 *      `{}`; assuming otherwise is what made the dunning lane dead in prod
 *      (audit finding 1).
 *   4. `data.object.customer` -> the D1 customer index (migrations/0016),
 *      populated from every event that resolved by 1-3 while carrying a
 *      customer id. This is what makes an invoice with NO metadata anywhere
 *      routable.
 *   5. Disputes only: `data.object.charge` -> Stripe -> that charge's customer
 *      -> the same index. A Dispute is minted by Stripe from a charge and
 *      carries `metadata: {}` and no `customer` field, so this round trip is
 *      the ONLY in-band route from a chargeback back to a tenant. Spent solely
 *      on event types we actually act on.
 *
 * `null` means genuinely unroutable — the caller must accept the delivery
 * (never 500 into Stripe's 3-day retry march) and alert a human.
 */
export async function resolveStripeTenant(
  event: StripeEventInput,
  deps: StripeTenantResolverDeps,
): Promise<StripeTenantResolution | null> {
  const obj = event.data.object;
  const customerId = readIdRef(obj.customer);

  const direct = readMetadataTenantId(obj);
  if (direct) return { tenantId: direct, source: "metadata", customerId };

  const clientRef = readString(obj.client_reference_id);
  if (clientRef) return { tenantId: clientRef, source: "client_reference_id", customerId };

  const fromSubscriptionDetails = readMetadataTenantId(obj.subscription_details);
  if (fromSubscriptionDetails) return { tenantId: fromSubscriptionDetails, source: "subscription_details", customerId };

  if (customerId) {
    const indexed = await deps.lookupTenantIdByCustomer(customerId);
    if (indexed) return { tenantId: indexed, source: "customer_index", customerId };
  }

  const chargeId = readIdRef(obj.charge);
  if (chargeId && HANDLED_STRIPE_EVENT_TYPES.has(event.type)) {
    const chargeCustomerId = await deps.lookupChargeCustomerId(chargeId);
    if (chargeCustomerId) {
      const indexed = await deps.lookupTenantIdByCustomer(chargeCustomerId);
      if (indexed) return { tenantId: indexed, source: "charge_customer_index", customerId: chargeCustomerId };
    }
  }

  return null;
}
