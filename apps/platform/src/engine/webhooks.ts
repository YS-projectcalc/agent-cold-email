// Per-tenant outbound webhook subscriptions — CRUD facade + the enqueue choke
// point. Every function is tenant-scoped (CLAUDE.md rule h): a subscription and
// its deliveries live in the tenant's OWN DO SQLite, so no query here can reach
// another tenant's rows. The delivery state machine (retries/backoff/auto-
// disable) is engine/webhook-delivery.ts; URL/HMAC security is
// engine/webhook-security.ts. Shared with both transports (HTTP routes + MCP
// tools) via the TenantDO facade, per the parity law.

import type { WebhookCreateInput, WebhookEventType, WebhookUpdateInput } from "@coldstart/shared";
import { NotFoundError } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { assertSafeWebhookUrl } from "./webhook-security.js";

export interface WebhookSummary {
  id: string;
  url: string;
  eventTypes: WebhookEventType[];
  active: boolean;
  status: "active" | "disabled";
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: number;
  createdAt: number;
  lastAttemptAt: number | null;
  deliveredAt: number | null;
}

export interface WebhookAttemptView {
  deliveryId: string;
  attemptNo: number;
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  ts: number;
}

export interface WebhookDetail {
  subscription: WebhookSummary;
  recentDeliveries: WebhookDeliveryView[];
  recentAttempts: WebhookAttemptView[];
}

// The `ctx` slice these functions actually need — just tenant-scoped SQL + the
// tenant id. Kept minimal so the delivery pump + tests can supply a bare
// { sql, tenantId } without constructing a full TenantContext.
export type WebhookStore = Pick<TenantContext, "sql" | "tenantId">;

// A `type` (not `interface`) so it satisfies sql.exec<T>'s
// `Record<string, SqlStorageValue>` constraint (an interface gets no implicit
// index signature).
type SubscriptionRow = {
  id: string;
  url: string;
  secret: string;
  event_types_json: string;
  active: number;
  status: string;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
};

function rowToSummary(r: SubscriptionRow): WebhookSummary {
  return {
    id: r.id,
    url: r.url,
    eventTypes: JSON.parse(r.event_types_json) as WebhookEventType[],
    active: r.active === 1,
    status: r.status as "active" | "disabled",
    disabledReason: r.disabled_reason,
    consecutiveFailures: r.consecutive_failures,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** A server-minted signing secret (used when the caller supplies none). */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "whsec_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function listWebhooks(ctx: WebhookStore): WebhookSummary[] {
  return ctx.sql
    .exec<SubscriptionRow>(
      `SELECT * FROM webhook_subscriptions WHERE tenant_id = ? ORDER BY created_at DESC`,
      ctx.tenantId,
    )
    .toArray()
    .map(rowToSummary);
}

function requireSubscription(ctx: WebhookStore, id: string): SubscriptionRow {
  const row = ctx.sql
    .exec<SubscriptionRow>(`SELECT * FROM webhook_subscriptions WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId)
    .toArray()[0];
  if (!row) throw new NotFoundError(`webhook subscription '${id}' not found`);
  return row;
}

export function getWebhook(ctx: WebhookStore, id: string): WebhookDetail {
  const row = requireSubscription(ctx, id);
  const recentDeliveries = ctx.sql
    .exec<{
      id: string;
      event_id: string;
      event_type: string;
      status: string;
      attempts: number;
      last_status_code: number | null;
      last_error: string | null;
      next_attempt_at: number;
      created_at: number;
      last_attempt_at: number | null;
      delivered_at: number | null;
    }>(
      `SELECT id, event_id, event_type, status, attempts, last_status_code, last_error, next_attempt_at, created_at, last_attempt_at, delivered_at
         FROM webhook_deliveries WHERE subscription_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 20`,
      id,
      ctx.tenantId,
    )
    .toArray()
    .map((d) => ({
      id: d.id,
      eventId: d.event_id,
      eventType: d.event_type,
      status: d.status,
      attempts: d.attempts,
      lastStatusCode: d.last_status_code,
      lastError: d.last_error,
      nextAttemptAt: d.next_attempt_at,
      createdAt: d.created_at,
      lastAttemptAt: d.last_attempt_at,
      deliveredAt: d.delivered_at,
    }));
  const recentAttempts = ctx.sql
    .exec<{ delivery_id: string; attempt_no: number; ok: number; status_code: number | null; error: string | null; ts: number }>(
      `SELECT delivery_id, attempt_no, ok, status_code, error, ts
         FROM webhook_delivery_attempts WHERE subscription_id = ? AND tenant_id = ? ORDER BY ts DESC LIMIT 20`,
      id,
      ctx.tenantId,
    )
    .toArray()
    .map((a) => ({
      deliveryId: a.delivery_id,
      attemptNo: a.attempt_no,
      ok: a.ok === 1,
      statusCode: a.status_code,
      error: a.error,
      ts: a.ts,
    }));
  return { subscription: rowToSummary(row), recentDeliveries, recentAttempts };
}

/** Create a subscription. Returns the summary PLUS the signing secret — the one
 *  and only time the secret is exposed on a read path (rotate via update). */
export function createWebhook(
  ctx: WebhookStore,
  input: WebhookCreateInput,
  nowMs: number,
): WebhookSummary & { secret: string } {
  // Boundary validation for BOTH transports (CLAUDE.md rule h) — throws
  // ValidationError (-> 400) on a non-https / private-IP / credentialed URL.
  assertSafeWebhookUrl(input.url);
  const secret = input.secret ?? generateSecret();
  const id = newId("whk");
  const eventTypes = dedupe(input.eventTypes);
  ctx.sql.exec(
    `INSERT INTO webhook_subscriptions (id, tenant_id, url, secret, event_types_json, active, status, consecutive_failures, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    id,
    ctx.tenantId,
    input.url,
    secret,
    JSON.stringify(eventTypes),
    input.active ? 1 : 0,
    nowMs,
    nowMs,
  );
  const summary = rowToSummary(requireSubscription(ctx, id));
  return { ...summary, secret };
}

/** Patch a subscription. Setting `active: true` also RE-ENABLES an auto-disabled
 *  one (resets consecutive_failures + status). Returns the summary, plus the new
 *  `secret` only when this call rotated it. */
export function updateWebhook(
  ctx: WebhookStore,
  id: string,
  input: WebhookUpdateInput,
  nowMs: number,
): WebhookSummary & { secret?: string } {
  const existing = requireSubscription(ctx, id);
  if (input.url !== undefined) assertSafeWebhookUrl(input.url);

  const url = input.url ?? existing.url;
  const secret = input.secret ?? undefined; // only rotate when provided
  const eventTypes = input.eventTypes !== undefined ? dedupe(input.eventTypes) : (JSON.parse(existing.event_types_json) as WebhookEventType[]);
  // A re-enable clears any auto-disable; an explicit active:false just pauses.
  const active = input.active !== undefined ? input.active : existing.active === 1;
  const reEnabling = input.active === true;
  const status = reEnabling ? "active" : existing.status;
  const disabledReason = reEnabling ? null : existing.disabled_reason;
  const consecutiveFailures = reEnabling ? 0 : existing.consecutive_failures;

  ctx.sql.exec(
    `UPDATE webhook_subscriptions
        SET url = ?, secret = ?, event_types_json = ?, active = ?, status = ?, disabled_reason = ?, consecutive_failures = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    url,
    secret ?? existing.secret,
    JSON.stringify(eventTypes),
    active ? 1 : 0,
    status,
    disabledReason,
    consecutiveFailures,
    nowMs,
    id,
    ctx.tenantId,
  );
  const summary = rowToSummary(requireSubscription(ctx, id));
  return secret ? { ...summary, secret } : summary;
}

/** Delete a subscription and every delivery/attempt it owns (bounded cleanup). */
export function deleteWebhook(ctx: WebhookStore, id: string): { deleted: true } {
  requireSubscription(ctx, id);
  ctx.sql.exec(`DELETE FROM webhook_delivery_attempts WHERE subscription_id = ? AND tenant_id = ?`, id, ctx.tenantId);
  ctx.sql.exec(`DELETE FROM webhook_deliveries WHERE subscription_id = ? AND tenant_id = ?`, id, ctx.tenantId);
  ctx.sql.exec(`DELETE FROM webhook_subscriptions WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId);
  return { deleted: true };
}
