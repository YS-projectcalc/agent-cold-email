import { Hono } from "hono";
import type { Env } from "../env.js";
import { extractStripeTenantId, StripeEventInput, verifyStripeSignature } from "../billing/stripe-webhook.js";
import { SMALL_BODY_MAX_BYTES } from "../validate.js";

// POST /webhooks/stripe — UNAUTHENTICATED (Stripe calls this, no bearer token
// to present); authenticity comes ENTIRELY from the `Stripe-Signature` header
// verified against `env.STRIPE_WEBHOOK_SECRET`. That check IS the cross-tenant
// guard: it proves the event (and its Stripe-set metadata.tenantId) really came
// from Stripe. So this route FAILS CLOSED when the secret is unset — an
// unsigned event must NEVER mutate billing state off an attacker-controlled
// tenant id (adversarial panel-03 finding #1: an unset secret let anyone
// self-upgrade any plan for free / freeze any tenant). There is no legitimate
// test-mode caller — simulated checkout completes via GET /checkout/simulate,
// and the test suite signs its fixtures against a configured test secret.
// Idempotent per event id inside the target TenantDO (ARCHITECTURE.md #3).
export const webhooksRoute = new Hono<{ Bindings: Env }>().post("/webhooks/stripe", async (c) => {
  // Body-size cap BEFORE materializing the (unauthenticated, unthrottled) body
  // — the exact parse-cost amplifier class panel-02 closed on /signup
  // (adversarial panel-03 finding #8). Cap first, THEN read the raw text the
  // signature is computed over.
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > SMALL_BODY_MAX_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  // FAIL CLOSED: no secret configured -> refuse to mutate state. Do this BEFORE
  // reading/parsing anything so an unsigned event is a pure no-op.
  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.json({ error: "webhook not configured (STRIPE_WEBHOOK_SECRET unset) — event rejected" }, 503);
  }

  // Signature verification needs the RAW body bytes — read text() before any
  // JSON parsing (a re-serialized body would not match the signature).
  const raw = await c.req.text();

  const signatureHeader = c.req.header("stripe-signature");
  if (!signatureHeader || !(await verifyStripeSignature(raw, signatureHeader, webhookSecret))) {
    return c.json({ error: "invalid stripe-signature" }, 400);
  }

  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const parsed = StripeEventInput.safeParse(rawEvent);
  if (!parsed.success) {
    return c.json({ error: "unrecognized stripe event shape", issues: parsed.error.issues }, 400);
  }

  const tenantId = extractStripeTenantId(parsed.data);
  if (!tenantId) {
    // Nothing to route to — accepted (Stripe should not retry), but not applied.
    return c.json({ received: true, applied: false, reason: "no tenant reference on event" }, 200);
  }

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
  const result = await stub.handleStripeWebhook(parsed.data);
  return c.json({ received: true, ...result }, 200);
});
