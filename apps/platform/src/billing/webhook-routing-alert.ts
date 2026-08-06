// Best-effort founder alert for a Stripe event we accepted but could not route
// (audit-stripe-webhook-2026-08-06.md finding 8). Mirrors
// engine/registrar-alert.ts / admin/watchtower.ts exactly: an unsendable alert
// must NEVER fail the request that triggered it.
//
// WHY this exists at all: the route now answers 200 to an unroutable event
// instead of 500ing, because a 500 is retried by Stripe for ~3 days and counts
// toward endpoint AUTO-DISABLE — one poison event could take billing down for
// every tenant. But a silent 200 is exactly the state the audit found the
// chargeback lane in: dead, and indistinguishable from an irrelevant event. So
// the 200 has to come with a human-visible signal, or we have traded a loud
// failure for a quiet one.

import { escapeHtml } from "../html-escape.js";
import type { Env } from "../env.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import { HANDLED_STRIPE_EVENT_TYPES, type StripeEventInput } from "./stripe-webhook.js";

/**
 * Logs every miss, and emails the founder only for the event types we actually
 * ACT on. An unhandled type (`customer.subscription.trial_will_end` and friends)
 * that names no tenant is inert by design — alerting on those would storm the
 * ops inbox and train the founder to ignore the alert that matters.
 *
 * `mailer` is injectable (default a real/dark-per-env OpsMailer) — same pattern
 * as alertRegistrarUnarmed, so a test can assert content with a SandboxOpsMailer
 * without the production call site changing.
 */
export async function alertUnroutableStripeEvent(
  env: Env,
  event: StripeEventInput,
  reason: string,
  mailer: OpsMailer = createOpsMailer(env),
): Promise<void> {
  const handled = HANDLED_STRIPE_EVENT_TYPES.has(event.type);
  console.error(
    `stripe webhook accepted but NOT routed: event ${event.id} type ${event.type} — ${reason}` +
      (handled ? " (HANDLED type: a real billing effect was lost)" : " (unhandled type: inert)"),
  );
  if (!handled || !env.OPS_ALERT_EMAIL) return;

  const text =
    `A signed Stripe event of a type we act on could not be routed to a tenant, so its billing effect did NOT happen.\n\n` +
    `event id: ${event.id}\n` +
    `type: ${event.type}\n` +
    `reason: ${reason}\n\n` +
    `Check the delivery in the Stripe dashboard (Developers -> Webhooks -> recent deliveries) and apply the effect by hand if needed. ` +
    `A dispute event that lands here means the chargeback freeze did not fire.`;
  try {
    await mailer.send({
      to: env.OPS_ALERT_EMAIL,
      subject: `[coldrig] unroutable Stripe webhook — ${event.type}`,
      text,
      html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
    });
  } catch (mailErr) {
    console.error(`unroutable-webhook alert: send to ${env.OPS_ALERT_EMAIL} failed (dark or transient)`, mailErr);
  }
}
