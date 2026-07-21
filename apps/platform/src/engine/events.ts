import { RealClock } from "../clock.js";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { enqueueEventWebhooks } from "./webhook-enqueue.js";

/**
 * The single once-per-new-event choke point (B1, CLASS B) — extracted out of
 * engine/reply-processor.ts (where it originated) so engine/suppression.ts
 * can route its own tenant-wide unsubscribe event writes through the SAME
 * fan-out path (SPEC.md §22: "closing [the unsubscribe webhook gap] needs
 * BOTH changes together or the fix is inert — add it to WEBHOOK_EVENT_TYPES
 * AND route the direct INSERT ... through the recordEventIfNew choke point
 * ... the enqueue fan-out fires only inside that choke, so the enum addition
 * alone changes nothing"). Splitting this into its own module (rather than
 * having suppression.ts import reply-processor.ts) avoids a circular import:
 * reply-processor.ts already imports `unsubscribeEmail` FROM suppression.ts.
 *
 * The events unique index on (tenant_id, type, message_id) + INSERT OR
 * IGNORE means an at-least-once re-poll/re-processing of the SAME message
 * writes no second row; returns true only when a NEW row was recorded, so
 * the caller applies side effects (webhook enqueue included) exactly once.
 */
export function recordEventIfNew(
  ctx: TenantContext,
  ev: {
    campaignId: string;
    leadId: string;
    type: string;
    step: number;
    // `null` is used by callers with no real inbound Message-ID (e.g. the
    // per-lead tenant-wide unsubscribe walk, engine/suppression.ts's
    // unsubscribeEmail) — NULLs are distinct in the underlying unique index,
    // so each such call still records its own row per lead instead of
    // colliding on a shared NULL key (see tenant-do.ts's ensureDedupeIndex
    // doc, "events without a source Message-ID").
    messageId: string | null;
    threadId: string;
    ts: number;
    metadata: Record<string, unknown>;
  },
): boolean {
  const eventId = newId("evt");
  const res = ctx.sql.exec(
    `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    eventId,
    ctx.tenantId,
    ev.campaignId,
    ev.leadId,
    ev.type,
    ev.step,
    ev.messageId,
    ev.threadId,
    ev.ts,
    JSON.stringify(ev.metadata),
  );
  if (res.rowsWritten === 0) return false;

  // This is the single once-per-new-event choke point, so it is also where a
  // new event fans out to any active outbound webhook subscriptions — a
  // re-polled/re-processed duplicate returned above without re-enqueuing.
  // Best-effort: a webhook-layer failure must NEVER break event recording
  // (the event is already durably committed). `next_attempt_at` uses REAL
  // wall-clock — webhook retry timing is real-time, not the tenant's
  // accelerated VirtualClock.
  try {
    enqueueEventWebhooks(
      ctx,
      {
        id: eventId,
        type: ev.type,
        ts: ev.ts,
        campaignId: ev.campaignId,
        leadId: ev.leadId,
        threadId: ev.threadId,
        messageId: ev.messageId,
        metadata: ev.metadata,
      },
      new RealClock().now(),
    );
  } catch (err) {
    console.error("webhook enqueue failed (event already recorded)", err);
  }
  return true;
}
