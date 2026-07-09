import { Hono } from "hono";
import type { Env } from "../env.js";
import { extractStripeTenantId, StripeEventInput, verifyStripeSignature } from "../billing/stripe-webhook.js";

// POST /webhooks/stripe — UNAUTHENTICATED (Stripe calls this, no bearer
// token to present); authenticity comes from the `Stripe-Signature` header
// IF `env.STRIPE_WEBHOOK_SECRET` is set, else accepted as-is in test-sim
// mode (B1 brief). Idempotent per event id inside the target TenantDO
// (ARCHITECTURE.md #3) — see engine/billing.ts.
export const webhooksRoute = new Hono<{ Bindings: Env }>().post("/webhooks/stripe", async (c) => {
  // Signature verification needs the RAW body bytes — read text() before any
  // JSON parsing (a re-serialized body would not match the signature).
  const raw = await c.req.text();

  const webhookSecret = c.env.STRIPE_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signatureHeader = c.req.header("stripe-signature");
    if (!signatureHeader || !(await verifyStripeSignature(raw, signatureHeader, webhookSecret))) {
      return c.json({ error: "invalid stripe-signature" }, 400);
    }
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
