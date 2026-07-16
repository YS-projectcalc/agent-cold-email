import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { enqueueEventWebhooks } from "../src/engine/webhook-enqueue.js";
import { api, signup, tenantStub } from "./helpers.js";

// Outbound webhook subscriptions — CRUD + tenant isolation + MCP parity +
// enqueue fan-out. Delivery/retry/auto-disable behavior is
// webhook-delivery.test.ts. SSRF/signature units are
// webhook-subscriptions-security.test.ts.

interface WebhookSummary {
  id: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  status: string;
  secret?: string;
}

async function createSub(token: string, body: Record<string, unknown>) {
  return api<WebhookSummary & { secret: string }>("/webhook-subscriptions", {
    method: "POST",
    token,
    body: JSON.stringify(body),
  });
}

async function mcp<T = unknown>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await api<{ result: { content: { text: string }[]; isError?: boolean } }>("/mcp", {
    method: "POST",
    token,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

const GOOD_URL = "https://hooks.example.com/coldrig";

describe("webhook subscription CRUD (HTTP)", () => {
  it("create returns 201 with a signing secret exposed exactly once; reads never re-expose it", async () => {
    const { token } = await signup("Hooks Co", "founder@hooksco.com");
    const created = await createSub(token, { url: GOOD_URL, eventTypes: ["reply", "bounce"] });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^whk_/);
    expect(created.body.url).toBe(GOOD_URL);
    expect(created.body.eventTypes.sort()).toEqual(["bounce", "reply"]);
    expect(created.body.active).toBe(true);
    expect(created.body.status).toBe("active");
    expect(typeof created.body.secret).toBe("string");
    expect(created.body.secret.length).toBeGreaterThanOrEqual(16);

    // List never carries the secret.
    const list = await api<WebhookSummary[]>("/webhook-subscriptions", { token });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("secret");

    // Detail carries the delivery/attempt log, still no secret.
    const detail = await api<{ subscription: WebhookSummary; recentDeliveries: unknown[]; recentAttempts: unknown[] }>(
      `/webhook-subscriptions/${created.body.id}`,
      { token },
    );
    expect(detail.status).toBe(200);
    expect(detail.body.subscription).not.toHaveProperty("secret");
    expect(detail.body.recentDeliveries).toEqual([]);
    expect(detail.body.recentAttempts).toEqual([]);
  });

  it("update patches the event filter + pauses; delete removes it (404 after)", async () => {
    const { token } = await signup("Patch Co", "founder@patchco.com");
    const created = await createSub(token, { url: GOOD_URL, eventTypes: ["reply"] });
    const id = created.body.id;

    const updated = await api<WebhookSummary>(`/webhook-subscriptions/${id}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ eventTypes: ["reply", "complaint"], active: false }),
    });
    expect(updated.status).toBe(200);
    expect(updated.body.eventTypes.sort()).toEqual(["complaint", "reply"]);
    expect(updated.body.active).toBe(false);

    const del = await api<{ deleted: boolean }>(`/webhook-subscriptions/${id}`, { method: "DELETE", token });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const gone = await api(`/webhook-subscriptions/${id}`, { token });
    expect(gone.status).toBe(404);
  });

  it("rejects an unsafe URL at the boundary with 400 (http scheme and private IP)", async () => {
    const { token } = await signup("SSRF Co", "founder@ssrfco.com");
    const httpRes = await createSub(token, { url: "http://example.com/hook", eventTypes: ["reply"] });
    expect(httpRes.status).toBe(400);
    const privRes = await createSub(token, { url: "https://169.254.169.254/", eventTypes: ["reply"] });
    expect(privRes.status).toBe(400);
    // None of the rejected creates persisted a subscription.
    const list = await api<WebhookSummary[]>("/webhook-subscriptions", { token });
    expect(list.body).toEqual([]);
  });
});

describe("webhook subscription tenant isolation", () => {
  it("tenant B cannot see, fetch, or delete tenant A's subscription", async () => {
    const a = await signup("Tenant A", "a@webhook-iso.example");
    const b = await signup("Tenant B", "b@webhook-iso.example");
    const created = await createSub(a.token, { url: GOOD_URL, eventTypes: ["reply"] });
    const aId = created.body.id;

    // B's own list is empty.
    const bList = await api<WebhookSummary[]>("/webhook-subscriptions", { token: b.token });
    expect(bList.body).toEqual([]);

    // B using A's id 404s (a different DO entirely).
    expect((await api(`/webhook-subscriptions/${aId}`, { token: b.token })).status).toBe(404);
    expect((await api(`/webhook-subscriptions/${aId}`, { method: "DELETE", token: b.token })).status).toBe(404);

    // A still has it — proves the 404s above weren't a broken read.
    expect((await api<WebhookSummary[]>("/webhook-subscriptions", { token: a.token })).body).toHaveLength(1);
  });
});

describe("webhook subscription CRUD (MCP parity)", () => {
  it("configure_webhook create/get/delete drive the SAME facade as HTTP", async () => {
    const { token } = await signup("Mcp Hooks Co", "founder@mcphooksco.com");

    const created = await mcp<WebhookSummary & { secret: string }>(token, "configure_webhook", {
      action: "create",
      url: GOOD_URL,
      eventTypes: ["reply"],
    });
    expect(created.id).toMatch(/^whk_/);
    expect(typeof created.secret).toBe("string");

    const list = await mcp<WebhookSummary[]>(token, "get_webhooks", {});
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);

    const detail = await mcp<{ subscription: WebhookSummary }>(token, "get_webhooks", { id: created.id });
    expect(detail.subscription.id).toBe(created.id);

    const del = await mcp<{ deleted: boolean }>(token, "configure_webhook", { action: "delete", id: created.id });
    expect(del.deleted).toBe(true);
    expect(await mcp<WebhookSummary[]>(token, "get_webhooks", {})).toEqual([]);
  });
});

describe("event enqueue fan-out", () => {
  const T0 = 1_800_000_000_000;

  function syntheticEvent(id: string, type: string) {
    return { id, type, ts: T0, campaignId: "camp_1", leadId: "lead_1", threadId: "thr_1", messageId: `${id}@m`, metadata: { toEmail: "x@y.com" } };
  }

  function deliveryCount(tenantId: string): Promise<number> {
    return runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM webhook_deliveries`).one().n,
    );
  }

  it("enqueues one delivery per matching active subscription, respects the type filter, and is idempotent per event", async () => {
    const { tenantId, token } = await signup("Enqueue Co", "founder@enqueueco.com");
    // Two subs: one wants reply only, one wants bounce only.
    await createSub(token, { url: "https://a.example.com/hook", eventTypes: ["reply"] });
    await createSub(token, { url: "https://b.example.com/hook", eventTypes: ["bounce"] });

    const enq = await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      const store = { sql: state.storage.sql, tenantId };
      const first = enqueueEventWebhooks(store, syntheticEvent("evt_a", "reply"), T0); // matches sub 1 only
      const filtered = enqueueEventWebhooks(store, syntheticEvent("evt_b", "soft_bounce"), T0); // matches neither
      const dup = enqueueEventWebhooks(store, syntheticEvent("evt_a", "reply"), T0); // idempotent replay
      return { first, filtered, dup };
    });

    expect(enq.first).toBe(1);
    expect(enq.filtered).toBe(0);
    expect(enq.dup).toBe(0);
    expect(await deliveryCount(tenantId)).toBe(1);
  });

  it("a paused/inactive subscription receives no enqueue", async () => {
    const { tenantId, token } = await signup("Paused Co", "founder@pausedco.com");
    const created = await createSub(token, { url: GOOD_URL, eventTypes: ["reply"] });
    await api(`/webhook-subscriptions/${created.body.id}`, {
      method: "PUT",
      token,
      body: JSON.stringify({ active: false }),
    });

    const enq = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      enqueueEventWebhooks({ sql: state.storage.sql, tenantId }, syntheticEvent("evt_c", "reply"), T0),
    );
    expect(enq).toBe(0);
    expect(await deliveryCount(tenantId)).toBe(0);
  });
});
