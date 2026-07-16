// Webhook delivery pump — the at-least-once retry/backoff/auto-disable state
// machine over the webhook_deliveries queue. Pure w.r.t. time and transport:
// `nowMs` is injected (REAL wall-clock in production, test-controlled in specs)
// and the `WebhookDeliverer` is injected (real fetch in production, a fake in
// tests — no live network). Driven in production by the cron sweep
// (admin/ops-sweep.ts -> TenantDO.runWebhookDeliveries); the pump is the ONE
// code path both cron and tests exercise, so they can't diverge.

import { newId } from "../schema.js";
import type { WebhookStore } from "./webhooks.js";
import { WEBHOOK_SNIPPET_MAX, type DeliveryOutcome, type WebhookDeliverer } from "./webhook-security.js";

// A delivery gets MAX_ATTEMPTS total tries; BACKOFF_MS[i] is the real-ms wait
// after the (i+1)-th failure (so 5 backoff steps span attempts 1..5, and a 6th
// failure is terminal). Real-time offsets — a webhook retry of "1 minute" is 60
// real seconds, NOT accelerated by the tenant's demo VirtualClock.
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]; // 1m, 5m, 30m, 2h, 6h
// Consecutive TERMINAL delivery failures (retries exhausted) before a
// subscription auto-disables; a single success resets the counter.
export const WEBHOOK_DISABLE_THRESHOLD = 5;
// Terminal deliveries + attempt rows older than this are pruned each pump so
// the per-tenant queue stays bounded.
export const WEBHOOK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PUMP_BATCH = 50;

export interface PumpSummary {
  attempted: number;
  delivered: number;
  rescheduled: number;
  failed: number;
  canceled: number;
  disabledSubscriptions: number;
}

// `type` (not `interface`) so these satisfy sql.exec<T>'s
// `Record<string, SqlStorageValue>` constraint.
type DeliveryRow = {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  attempts: number;
};

type SubRow = {
  id: string;
  url: string;
  secret: string;
  active: number;
  status: string;
  consecutive_failures: number;
};

export async function pumpWebhookDeliveries(
  store: WebhookStore,
  deliver: WebhookDeliverer,
  nowMs: number,
): Promise<PumpSummary> {
  const summary: PumpSummary = { attempted: 0, delivered: 0, rescheduled: 0, failed: 0, canceled: 0, disabledSubscriptions: 0 };

  // Pending deliveries whose subscription was paused/deleted since enqueue never
  // fire — cancel them so they don't linger (a resumed subscription should not
  // replay stale events). A deleted subscription's deliveries are already gone
  // (deleteWebhook cascades), so this targets the paused/disabled case.
  const canceled = store.sql.exec(
    `UPDATE webhook_deliveries SET status = 'canceled', last_error = 'subscription_inactive', last_attempt_at = ?
       WHERE tenant_id = ? AND status = 'pending'
         AND subscription_id NOT IN (SELECT id FROM webhook_subscriptions WHERE tenant_id = ? AND active = 1 AND status = 'active')`,
    nowMs,
    store.tenantId,
    store.tenantId,
  );
  summary.canceled += canceled.rowsWritten;

  const due = store.sql
    .exec<{ id: string }>(
      `SELECT d.id FROM webhook_deliveries d
         JOIN webhook_subscriptions s ON s.id = d.subscription_id AND s.tenant_id = d.tenant_id
        WHERE d.tenant_id = ? AND d.status = 'pending' AND d.next_attempt_at <= ?
          AND s.active = 1 AND s.status = 'active'
        ORDER BY d.next_attempt_at ASC LIMIT ?`,
      store.tenantId,
      nowMs,
      PUMP_BATCH,
    )
    .toArray();

  for (const { id: deliveryId } of due) {
    // Re-read fresh: an earlier iteration in THIS batch may have disabled the
    // subscription (so a later delivery for it must not fire), and the delivery
    // row's own state may have moved.
    const d = store.sql
      .exec<DeliveryRow>(
        `SELECT id, subscription_id, event_id, event_type, payload_json, attempts
           FROM webhook_deliveries WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
        deliveryId,
        store.tenantId,
      )
      .toArray()[0];
    if (!d) continue;

    const sub = store.sql
      .exec<SubRow>(
        `SELECT id, url, secret, active, status, consecutive_failures FROM webhook_subscriptions WHERE id = ? AND tenant_id = ?`,
        d.subscription_id,
        store.tenantId,
      )
      .toArray()[0];
    if (!sub || sub.active !== 1 || sub.status !== "active") {
      store.sql.exec(
        `UPDATE webhook_deliveries SET status = 'canceled', last_error = 'subscription_inactive', last_attempt_at = ? WHERE id = ? AND tenant_id = ?`,
        nowMs,
        d.id,
        store.tenantId,
      );
      summary.canceled++;
      continue;
    }

    const attemptNo = d.attempts + 1;
    summary.attempted++;
    const outcome = await deliver(
      { url: sub.url, secret: sub.secret },
      d.payload_json,
      {
        "X-Coldrig-Event": d.event_type,
        "X-Coldrig-Event-Id": d.event_id,
        "X-Coldrig-Delivery": d.id,
        "X-Coldrig-Timestamp": String(nowMs),
      },
    );
    recordAttempt(store, d, sub.id, attemptNo, outcome, nowMs);

    if (outcome.ok) {
      store.sql.exec(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL, last_attempt_at = ?, delivered_at = ?
           WHERE id = ? AND tenant_id = ?`,
        attemptNo,
        outcome.statusCode,
        nowMs,
        nowMs,
        d.id,
        store.tenantId,
      );
      store.sql.exec(
        `UPDATE webhook_subscriptions SET consecutive_failures = 0, updated_at = ? WHERE id = ? AND tenant_id = ?`,
        nowMs,
        sub.id,
        store.tenantId,
      );
      summary.delivered++;
      continue;
    }

    if (attemptNo < WEBHOOK_MAX_ATTEMPTS) {
      const backoff = WEBHOOK_BACKOFF_MS[Math.min(attemptNo - 1, WEBHOOK_BACKOFF_MS.length - 1)]!;
      store.sql.exec(
        `UPDATE webhook_deliveries SET attempts = ?, status = 'pending', next_attempt_at = ?, last_status_code = ?, last_error = ?, last_attempt_at = ?
           WHERE id = ? AND tenant_id = ?`,
        attemptNo,
        nowMs + backoff,
        outcome.statusCode,
        outcome.error ?? null,
        nowMs,
        d.id,
        store.tenantId,
      );
      summary.rescheduled++;
      continue;
    }

    // Retries exhausted — terminal failure for this delivery.
    store.sql.exec(
      `UPDATE webhook_deliveries SET attempts = ?, status = 'failed', last_status_code = ?, last_error = ?, last_attempt_at = ?
         WHERE id = ? AND tenant_id = ?`,
      attemptNo,
      outcome.statusCode,
      outcome.error ?? null,
      nowMs,
      d.id,
      store.tenantId,
    );
    summary.failed++;

    // Increment-then-read so multiple terminal failures for the SAME
    // subscription within one batch each count toward the disable threshold.
    store.sql.exec(
      `UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      nowMs,
      sub.id,
      store.tenantId,
    );
    const failures = store.sql
      .exec<{ consecutive_failures: number }>(
        `SELECT consecutive_failures FROM webhook_subscriptions WHERE id = ? AND tenant_id = ?`,
        sub.id,
        store.tenantId,
      )
      .one().consecutive_failures;
    if (failures >= WEBHOOK_DISABLE_THRESHOLD) {
      store.sql.exec(
        `UPDATE webhook_subscriptions SET active = 0, status = 'disabled', disabled_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
        `auto-disabled after ${failures} consecutive failed deliveries`,
        nowMs,
        sub.id,
        store.tenantId,
      );
      summary.disabledSubscriptions++;
    }
  }

  pruneOldTerminalDeliveries(store, nowMs);
  return summary;
}

function recordAttempt(
  store: WebhookStore,
  d: DeliveryRow,
  subscriptionId: string,
  attemptNo: number,
  outcome: DeliveryOutcome,
  nowMs: number,
): void {
  store.sql.exec(
    `INSERT INTO webhook_delivery_attempts (id, tenant_id, subscription_id, delivery_id, attempt_no, ok, status_code, error, snippet, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("wha"),
    store.tenantId,
    subscriptionId,
    d.id,
    attemptNo,
    outcome.ok ? 1 : 0,
    outcome.statusCode,
    outcome.error ?? null,
    outcome.snippet ? outcome.snippet.slice(0, WEBHOOK_SNIPPET_MAX) : null,
    nowMs,
  );
}

function pruneOldTerminalDeliveries(store: WebhookStore, nowMs: number): void {
  const cutoff = nowMs - WEBHOOK_RETENTION_MS;
  store.sql.exec(`DELETE FROM webhook_delivery_attempts WHERE tenant_id = ? AND ts < ?`, store.tenantId, cutoff);
  store.sql.exec(
    `DELETE FROM webhook_deliveries WHERE tenant_id = ? AND status IN ('delivered', 'failed', 'canceled') AND created_at < ?`,
    store.tenantId,
    cutoff,
  );
}
