import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  pumpWebhookDeliveries,
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_DISABLE_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETENTION_MS,
} from "../src/engine/webhook-delivery.js";
import { enqueueEventWebhooks } from "../src/engine/webhook-enqueue.js";
import type { WebhookDeliverer } from "../src/engine/webhook-security.js";
import { api, signup, tenantStub } from "./helpers.js";

// The delivery state machine driven directly with a FAKE deliverer (no live
// network) + a test-controlled nowMs — the SAME pumpWebhookDeliveries the DO's
// runWebhookDeliveries / the cron sweep call in production.

const T0 = 1_800_000_000_000;
const BIG = 30_000_000; // > the largest backoff step, so the next pass is always "due"

const okDeliverer: WebhookDeliverer = async () => ({ ok: true, statusCode: 200, snippet: "ok" });
const failDeliverer: WebhookDeliverer = async () => ({ ok: false, statusCode: 500, snippet: "boom", error: "http_500" });

function event(id: string, type = "reply") {
  return { id, type, ts: T0, campaignId: "camp_1", leadId: "lead_1", threadId: "thr_1", messageId: `${id}@m`, metadata: { toEmail: "x@y.com" } };
}

// `type` (not `interface`) to satisfy sql.exec<T>'s Record constraint.
type DeliveryRow = {
  status: string;
  attempts: number;
  next_attempt_at: number;
  delivered_at: number | null;
};
type SubRow = {
  active: number;
  status: string;
  consecutive_failures: number;
  disabled_reason: string | null;
};

async function createSub(token: string, eventTypes: string[]) {
  const res = await api<{ id: string }>("/webhook-subscriptions", {
    method: "POST",
    token,
    body: JSON.stringify({ url: "https://hooks.example.com/coldrig", eventTypes }),
  });
  return res.body.id;
}

describe("webhook delivery — success path", () => {
  it("delivers, records the attempt, marks delivered, and resets the failure counter", async () => {
    const { tenantId, token } = await signup("Deliver Co", "founder@deliverco.com");
    const subId = await createSub(token, ["reply"]);

    const result = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      enqueueEventWebhooks(store, event("evt_ok"), T0);
      const summary = await pumpWebhookDeliveries(store, okDeliverer, T0);
      const delivery = state.storage.sql.exec<DeliveryRow>(`SELECT status, attempts, next_attempt_at, delivered_at FROM webhook_deliveries`).one();
      const sub = state.storage.sql.exec<SubRow>(`SELECT active, status, consecutive_failures, disabled_reason FROM webhook_subscriptions WHERE id = ?`, subId).one();
      const attempts = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM webhook_delivery_attempts WHERE ok = 1`).one().n;
      return { summary, delivery, sub, attempts };
    });

    expect(result.summary.delivered).toBe(1);
    expect(result.delivery.status).toBe("delivered");
    expect(result.delivery.attempts).toBe(1);
    expect(result.delivery.delivered_at).toBe(T0);
    expect(result.sub.consecutive_failures).toBe(0);
    expect(result.attempts).toBe(1);
  });
});

describe("webhook delivery — retry with exponential backoff", () => {
  it("reschedules on failure per the backoff ladder, skips a not-yet-due row, and fails terminally after MAX_ATTEMPTS", async () => {
    const { tenantId, token } = await signup("Retry Co", "founder@retryco.com");
    await createSub(token, ["reply"]);

    const result = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      enqueueEventWebhooks(store, event("evt_retry"), T0);

      const pass1 = await pumpWebhookDeliveries(store, failDeliverer, T0);
      const afterPass1 = state.storage.sql.exec<DeliveryRow>(`SELECT status, attempts, next_attempt_at, delivered_at FROM webhook_deliveries`).one();

      // Same nowMs — the row is scheduled into the future, so nothing is due.
      const notDue = await pumpWebhookDeliveries(store, failDeliverer, T0);

      // Drive attempts 2..MAX to exhaustion, each pass far enough ahead to be due.
      for (let k = 1; k < WEBHOOK_MAX_ATTEMPTS; k++) {
        await pumpWebhookDeliveries(store, failDeliverer, T0 + k * BIG);
      }
      const final = state.storage.sql.exec<DeliveryRow>(`SELECT status, attempts, next_attempt_at, delivered_at FROM webhook_deliveries`).one();
      const sub = state.storage.sql.exec<SubRow>(`SELECT active, status, consecutive_failures, disabled_reason FROM webhook_subscriptions`).one();
      return { pass1, afterPass1, notDue, final, sub };
    });

    expect(result.pass1.rescheduled).toBe(1);
    expect(result.afterPass1.attempts).toBe(1);
    expect(result.afterPass1.status).toBe("pending");
    expect(result.afterPass1.next_attempt_at).toBe(T0 + WEBHOOK_BACKOFF_MS[0]!);
    expect(result.notDue.attempted).toBe(0);

    expect(result.final.status).toBe("failed");
    expect(result.final.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    // One terminal delivery failure => one consecutive failure on the subscription.
    expect(result.sub.consecutive_failures).toBe(1);
  });
});

describe("webhook delivery — auto-disable after consecutive terminal failures", () => {
  it("disables the subscription (tenant-visible reason) once the threshold is reached and stops enqueuing", async () => {
    const { tenantId, token } = await signup("Disable Co", "founder@disableco.com");
    await createSub(token, ["reply"]);

    const result = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      for (let i = 0; i < WEBHOOK_DISABLE_THRESHOLD; i++) enqueueEventWebhooks(store, event(`evt_d${i}`), T0);

      let lastSummary;
      for (let k = 0; k < WEBHOOK_MAX_ATTEMPTS; k++) {
        lastSummary = await pumpWebhookDeliveries(store, failDeliverer, T0 + k * BIG);
      }
      const sub = state.storage.sql.exec<SubRow>(`SELECT active, status, consecutive_failures, disabled_reason FROM webhook_subscriptions`).one();
      // A new event for the now-disabled subscription enqueues nothing.
      const enqAfterDisable = enqueueEventWebhooks(store, event("evt_after"), T0);
      return { lastSummary, sub, enqAfterDisable };
    });

    expect(result.sub.active).toBe(0);
    expect(result.sub.status).toBe("disabled");
    expect(result.sub.consecutive_failures).toBeGreaterThanOrEqual(WEBHOOK_DISABLE_THRESHOLD);
    expect(result.sub.disabled_reason).toBeTruthy();
    expect(result.lastSummary!.disabledSubscriptions).toBeGreaterThanOrEqual(1);
    expect(result.enqAfterDisable).toBe(0);
  });

  it("re-enabling via update clears the disabled state and failure counter", async () => {
    const { tenantId, token } = await signup("Reenable Co", "founder@reenableco.com");
    const subId = await createSub(token, ["reply"]);

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      for (let i = 0; i < WEBHOOK_DISABLE_THRESHOLD; i++) enqueueEventWebhooks(store, event(`evt_r${i}`), T0);
      for (let k = 0; k < WEBHOOK_MAX_ATTEMPTS; k++) await pumpWebhookDeliveries(store, failDeliverer, T0 + k * BIG);
    });

    const reenabled = await api<{ active: boolean; status: string; consecutiveFailures: number; disabledReason: string | null }>(
      `/webhook-subscriptions/${subId}`,
      { method: "PUT", token, body: JSON.stringify({ active: true }) },
    );
    expect(reenabled.status).toBe(200);
    expect(reenabled.body.active).toBe(true);
    expect(reenabled.body.status).toBe("active");
    expect(reenabled.body.consecutiveFailures).toBe(0);
    expect(reenabled.body.disabledReason).toBeNull();
  });
});

describe("webhook delivery — queue hygiene", () => {
  it("cancels a pending delivery whose subscription was paused before it fired", async () => {
    const { tenantId, token } = await signup("Cancel Co", "founder@cancelco.com");
    const subId = await createSub(token, ["reply"]);

    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      enqueueEventWebhooks({ sql: state.storage.sql, tenantId }, event("evt_cancel"), T0);
    });
    await api(`/webhook-subscriptions/${subId}`, { method: "PUT", token, body: JSON.stringify({ active: false }) });

    const result = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      const summary = await pumpWebhookDeliveries(store, failDeliverer, T0 + BIG);
      const delivery = state.storage.sql.exec<DeliveryRow>(`SELECT status, attempts, next_attempt_at, delivered_at FROM webhook_deliveries`).one();
      return { summary, delivery };
    });
    expect(result.summary.attempted).toBe(0);
    expect(result.summary.canceled).toBeGreaterThanOrEqual(1);
    expect(result.delivery.status).toBe("canceled");
  });

  it("prunes terminal deliveries + attempts older than the retention window", async () => {
    const { tenantId, token } = await signup("Prune Co", "founder@pruneco.com");
    await createSub(token, ["reply"]);

    const counts = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      enqueueEventWebhooks(store, event("evt_prune"), T0);
      await pumpWebhookDeliveries(store, okDeliverer, T0); // delivered at T0
      // A later pump beyond the retention window prunes the delivered row.
      await pumpWebhookDeliveries(store, okDeliverer, T0 + WEBHOOK_RETENTION_MS + BIG);
      const deliveries = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM webhook_deliveries`).one().n;
      const attempts = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM webhook_delivery_attempts`).one().n;
      return { deliveries, attempts };
    });
    expect(counts.deliveries).toBe(0);
    expect(counts.attempts).toBe(0);
  });
});
