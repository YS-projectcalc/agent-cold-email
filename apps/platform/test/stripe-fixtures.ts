// REAL-SHAPED Stripe webhook payloads — the single place fixtures for the
// six subscribed event types are built.
//
// WHY this file exists (docs/adversarial/audit-stripe-webhook-2026-08-06.md
// finding 1): every fixture in this suite used to hand-place
// `metadata.tenantId` on the Invoice or Dispute object. Stripe NEVER emits
// that shape — an Invoice carries its own (empty) metadata and surfaces the
// subscription's under `subscription_details.metadata`; a Dispute is minted by
// Stripe FROM a charge with `metadata: {}` and no `customer` field at all. The
// dunning and chargeback lanes therefore passed every test while resolving
// NOTHING in production, answering `200 {"applied":false}` on every real
// delivery for weeks. Fixtures that flatter the code are worse than no
// fixtures: they retire the very attack that would have found the bug.
//
// Shapes below follow Stripe's documented objects for the 2024-06-20 API
// version this repo pins (src/billing/stripe-client.ts). Keep them honest: if
// a field is not on the real object, it does not belong here, even when adding
// it would make a test easier to write.

/** The Stripe customer id a fixture tenant "owns". Distinct per tenant, because
 *  the D1 customer index (migrations/0016) is keyed on it — a shared literal
 *  would map every tenant onto whichever one checked out last. */
export function stripeCustomerIdFor(tenantId: string): string {
  return `cus_test_${tenantId}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function eventEnvelope(type: string, object: Record<string, unknown>, created?: number) {
  return {
    id: `evt_${crypto.randomUUID()}`,
    object: "event",
    api_version: "2024-06-20",
    created: created ?? nowSeconds(),
    livemode: false,
    type,
    data: { object },
  };
}

/**
 * `checkout.session.completed`. This is the ONE object we decorate ourselves
 * (createStripeCheckoutSession sets `client_reference_id` + `metadata`), so
 * metadata here is REAL, not a convenience.
 */
export function checkoutSessionCompleted(params: {
  tenantId: string;
  plan?: string;
  created?: number;
  subscriptionId?: string;
  amountSubtotal?: number;
  amountDiscount?: number;
  billingName?: string | null;
}) {
  const plan = params.plan ?? "managed";
  return eventEnvelope(
    "checkout.session.completed",
    {
      id: `cs_test_${crypto.randomUUID()}`,
      object: "checkout.session",
      amount_subtotal: params.amountSubtotal ?? 9900,
      amount_total: (params.amountSubtotal ?? 9900) - (params.amountDiscount ?? 0),
      client_reference_id: params.tenantId,
      currency: "usd",
      customer: stripeCustomerIdFor(params.tenantId),
      customer_details: { email: "buyer@example.com", name: params.billingName ?? null },
      metadata: { tenantId: params.tenantId, plan },
      mode: "subscription",
      payment_status: "paid",
      status: "complete",
      subscription: params.subscriptionId ?? `sub_test_${params.tenantId}`,
      total_details: { amount_discount: params.amountDiscount ?? 0 },
    },
    params.created,
  );
}

/**
 * `invoice.payment_failed`. The invoice's OWN metadata is `{}`; the tenant
 * reference lives under `subscription_details.metadata`, which is where Stripe
 * surfaces the subscription's metadata on invoices raised from it. Pass
 * `tenantId: null` to model an invoice with no metadata anywhere — the case
 * that can ONLY be routed through the customer index.
 *
 * Deliberately carries no decline code: on a real, unexpanded
 * `invoice.payment_failed` payload `charge` and `payment_intent` are bare id
 * STRINGS, so there is nowhere on the object for one to be. Faking one here
 * would re-commit exactly the sin this file exists to prevent.
 */
export function invoicePaymentFailed(params: { tenantId: string | null; customerId: string; created?: number; attemptCount?: number }) {
  return eventEnvelope(
    "invoice.payment_failed",
    {
      id: `in_test_${crypto.randomUUID()}`,
      object: "invoice",
      attempt_count: params.attemptCount ?? 1,
      billing_reason: "subscription_cycle",
      charge: `ch_test_${crypto.randomUUID()}`,
      collection_method: "charge_automatically",
      currency: "usd",
      customer: params.customerId,
      metadata: {},
      payment_intent: `pi_test_${crypto.randomUUID()}`,
      status: "open",
      subscription: "sub_test_fixture",
      subscription_details: params.tenantId ? { metadata: { tenantId: params.tenantId, plan: "managed" } } : { metadata: null },
      total: 9900,
    },
    params.created,
  );
}

/** `customer.subscription.updated` — the Subscription DOES carry our metadata
 *  (subscription_data[metadata] at checkout creation). */
export function subscriptionUpdated(params: { tenantId: string; status: string; created?: number }) {
  return eventEnvelope(
    "customer.subscription.updated",
    {
      id: `sub_test_${params.tenantId}`,
      object: "subscription",
      customer: stripeCustomerIdFor(params.tenantId),
      metadata: { tenantId: params.tenantId, plan: "managed" },
      status: params.status,
    },
    params.created,
  );
}

/** `customer.subscription.deleted` — same object as above, terminal status. */
export function subscriptionDeleted(params: { tenantId: string; created?: number }) {
  return eventEnvelope(
    "customer.subscription.deleted",
    {
      id: `sub_test_${params.tenantId}`,
      object: "subscription",
      canceled_at: nowSeconds(),
      customer: stripeCustomerIdFor(params.tenantId),
      metadata: { tenantId: params.tenantId, plan: "managed" },
      status: "canceled",
    },
    params.created,
  );
}

/**
 * `charge.dispute.created`. NOTE what is NOT here: no `metadata.tenantId`, no
 * `customer`, no `client_reference_id`. A Dispute's only route back to an
 * account is its `charge`, which is why deliveries of this event have to go
 * through `postDisputeWebhook` (helpers.ts) rather than plain `postWebhook`.
 */
export function disputeCreated(params: { chargeId: string; disputeId?: string; amountCents?: number; reason?: string; created?: number }) {
  const created = params.created ?? nowSeconds();
  return eventEnvelope(
    "charge.dispute.created",
    {
      id: params.disputeId ?? `dp_test_${crypto.randomUUID()}`,
      object: "dispute",
      amount: params.amountCents ?? 9900,
      balance_transactions: [],
      charge: params.chargeId,
      created,
      currency: "usd",
      is_charge_refundable: true,
      metadata: {},
      payment_intent: `pi_test_${crypto.randomUUID()}`,
      reason: params.reason ?? "fraudulent",
      status: "needs_response",
    },
    created,
  );
}

/** `charge.dispute.closed` — same Dispute object, resolved status. */
export function disputeClosed(params: { chargeId: string; disputeId: string; status: string; amountCents?: number; created?: number }) {
  const created = params.created ?? nowSeconds();
  return eventEnvelope(
    "charge.dispute.closed",
    {
      id: params.disputeId,
      object: "dispute",
      amount: params.amountCents ?? 9900,
      balance_transactions: [],
      charge: params.chargeId,
      created,
      currency: "usd",
      is_charge_refundable: false,
      metadata: {},
      payment_intent: `pi_test_${crypto.randomUUID()}`,
      reason: "fraudulent",
      status: params.status,
    },
    created,
  );
}
