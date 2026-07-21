// Per-tenant outbound webhook subscriptions — the zod input schemas shared by
// the HTTP facade (apps/platform/src/routes/webhook-subscriptions.ts) and the
// MCP tools (get_webhooks / configure_webhook). Parity law: both transports
// validate against the SAME schema here (mirrors DashboardView*Input in
// dashboard.ts). Delivery/backoff constants live platform-side
// (apps/platform/src/engine/webhook-delivery.ts) — this file is boundary
// validation only, dependency-free.

import { z } from "zod";

// The event kinds a subscription may push. These are exactly the inbound
// `events.type` values a buyer cares about (engine/reply-processor.ts records
// them): a genuine reply, a HARD bounce, a soft (transient) bounce, a spam
// complaint, and (SPEC.md §22) an unsubscribe/opt-out. A subscription's
// filter selects among these; an event type not in a subscription's list is
// never delivered to it. `unsubscribe` closes the poll-only gap SPEC.md §22
// names — closing it ALSO required routing the opt-out event write through
// the recordEventIfNew choke point (engine/suppression.ts's unsubscribeEmail),
// since the enum addition alone is inert (the enqueue fan-out lives only
// inside that choke point).
export const WEBHOOK_EVENT_TYPES = ["reply", "bounce", "soft_bounce", "complaint", "unsubscribe"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

// A webhook endpoint URL: bounded length + basic shape only. The real security
// gate (https-only, SSRF private/link-local/metadata IP rejection) is
// assertSafeWebhookUrl in engine/webhook-security.ts, applied inside the DO
// facade so BOTH transports and every delivery re-check share one validator.
const urlField = z
  .string()
  .min(1)
  .max(2048)
  .describe("HTTPS endpoint that receives event POSTs. Must be https and resolve to a public host — private/link-local/metadata IPs are rejected.");

// An optional caller-supplied signing secret. Omit it and the server mints one,
// returned ONCE on create so the tenant can configure its signature verifier.
const secretField = z
  .string()
  .min(16)
  .max(200)
  .optional()
  .describe("Optional HMAC signing secret (>=16 chars). Omit to have the server generate one, returned once on create.");

const eventTypesField = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1)
  .max(WEBHOOK_EVENT_TYPES.length)
  .describe("Which event types to receive: reply | bounce (hard) | soft_bounce | complaint. At least one.");

export const WebhookCreateInput = z.object({
  url: urlField,
  eventTypes: eventTypesField,
  secret: secretField,
  active: z.boolean().optional().default(true).describe("Whether the subscription delivers immediately. Defaults to true."),
});
export type WebhookCreateInput = z.infer<typeof WebhookCreateInput>;

// Every field optional: an update patches only what's present (url, event
// filter, active flag, or a rotated secret). At least one field must be given.
export const WebhookUpdateInput = z
  .object({
    url: urlField.optional(),
    eventTypes: eventTypesField.optional(),
    secret: secretField,
    active: z.boolean().optional().describe("Set false to pause delivery without deleting; set true to resume (also re-enables an auto-disabled subscription)."),
  })
  .refine((v) => v.url !== undefined || v.eventTypes !== undefined || v.secret !== undefined || v.active !== undefined, {
    message: "update requires at least one of: url, eventTypes, secret, active",
  });
export type WebhookUpdateInput = z.infer<typeof WebhookUpdateInput>;
