// The event -> webhook-delivery-queue fan-out — the producer half of the
// outbound webhook subsystem (CRUD is webhooks.ts; the delivery pump is
// webhook-delivery.ts). Split out so each file carries one responsibility.

import { newId } from "../schema.js";
import type { WebhookStore } from "./webhooks.js";

export interface EnqueueEvent {
  id: string;
  type: string;
  ts: number;
  campaignId: string;
  leadId: string;
  threadId: string;
  messageId: string;
  metadata: Record<string, unknown>;
}

/**
 * Fan a newly-recorded inbound event out to every ACTIVE subscription whose
 * filter includes its type, one pending delivery row each. Called from the
 * SINGLE once-per-new-event choke point (engine/reply-processor.ts's
 * recordEventIfNew), so a re-polled duplicate never enqueues twice; the
 * UNIQUE(subscription_id, event_id) index makes it idempotent even if it did.
 * The payload body is frozen here so retries re-send identical, identically-
 * signed bytes. `nowMs` is REAL wall-clock (webhook timing is real-time infra,
 * not the tenant's accelerated VirtualClock). Returns rows enqueued.
 */
export function enqueueEventWebhooks(ctx: WebhookStore, event: EnqueueEvent, nowMs: number): number {
  const subs = ctx.sql
    .exec<{ id: string; event_types_json: string }>(
      `SELECT id, event_types_json FROM webhook_subscriptions WHERE tenant_id = ? AND active = 1 AND status = 'active'`,
      ctx.tenantId,
    )
    .toArray();
  if (subs.length === 0) return 0;

  let enqueued = 0;
  for (const sub of subs) {
    const types = JSON.parse(sub.event_types_json) as string[];
    if (!types.includes(event.type)) continue;
    const payload = JSON.stringify({
      id: event.id,
      type: event.type,
      timestamp: event.ts,
      tenantId: ctx.tenantId,
      data: {
        campaignId: event.campaignId,
        leadId: event.leadId,
        threadId: event.threadId,
        messageId: event.messageId,
        ...event.metadata,
      },
    });
    const res = ctx.sql.exec(
      `INSERT OR IGNORE INTO webhook_deliveries
         (id, tenant_id, subscription_id, event_id, event_type, payload_json, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      newId("whd"),
      ctx.tenantId,
      sub.id,
      event.id,
      event.type,
      payload,
      nowMs,
      nowMs,
    );
    if (res.rowsWritten > 0) enqueued++;
  }
  return enqueued;
}
