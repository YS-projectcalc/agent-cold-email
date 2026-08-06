// System->agent message channel, increment 1 (founder-approved 2026-08-05).
// A DO-local mailbox our OWN system writes and the customer's agent reads via
// infrastructure_status's `messages` field — so a system notice (a retryable
// setup step, a credential going live) reaches the customer's agent without a
// human relay. Sibling of deliverability-actions.ts's `logAction`: same
// tenant-scoped SqlStorage write, same newId-prefixed row. DO-local, not D1
// (ARCHITECTURE.md decision #3 + CLAUDE.md rule h).
//
// Increment 1 scope only: emit + read + a bounded prune. The operator route
// and the list_messages/ack_message tools (increment 2) are NOT built here —
// nothing in this file ever sets `read_at`.

import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";

/** Convention so far (not DB-enforced — see the schema.ts table comment):
 * 'info' | 'action_required'. Both real emit points use 'action_required'. */
export type TenantMessageSeverity = string;

export interface TenantMessage {
  id: string;
  kind: string;
  severity: TenantMessageSeverity;
  body: string;
  actionHint: Record<string, unknown> | null;
  source: "system" | "operator";
  createdAt: number;
  readAt: number | null;
}

export interface EmitTenantMessageInput {
  kind: string;
  severity: TenantMessageSeverity;
  /** Customer-safe prose ONLY — never a raw vendor error string, stack trace,
   * refresh token, internal hostname/IP, or ACTIVATION.md/env-var text (the
   * incident N2 leak class). Every call site must pass a literal/templated
   * string it composed itself, never `err.message` or a vendor payload. */
  body: string;
  actionHint?: Record<string, unknown>;
  /** Opt-in no-spam key, scoped to (tenant_id, kind, dedup_key) — see GUARDRAIL A below. */
  dedupKey?: string;
  expiresAt?: number;
}

// How long a READ row is kept around before the prune sweep reclaims it.
// Nothing in increment 1 sets `read_at` (no ack tool yet), so this only
// starts mattering once increment 2's ack_message tool ships — forward
// compatible, not dead code (the prune already needs to be idempotent/no-op
// against a schema no writer has populated yet, exactly like this codebase's
// other schema-ahead-of-writer columns, e.g. followups.idempotency_key).
export const READ_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// The read surface never returns more than this many messages (brief: "capped ≤5").
const MAX_SURFACED_MESSAGES = 5;

/**
 * Writes one system-sourced message row scoped to `ctx`'s own tenant.
 *
 * GUARDRAIL A (no-spam): when `dedupKey` is supplied, an existing UNREAD,
 * UNEXPIRED row for the same (tenant_id, kind, dedup_key) is REFRESHED
 * (body/severity/actionHint/timestamps updated) instead of inserting a
 * duplicate — a re-triggered path (e.g. every provisioning retry hitting the
 * same stuck state) must never grow an unbounded run of rows for one ongoing
 * condition. A row that has since been read or has expired no longer
 * dedup-matches, so a genuinely NEW occurrence still gets its own row.
 */
export function emitTenantMessage(ctx: TenantContext, input: EmitTenantMessageInput): void {
  const now = ctx.clock.now();
  const actionHintJson = input.actionHint ? JSON.stringify(input.actionHint) : null;
  const expiresAt = input.expiresAt ?? null;

  if (input.dedupKey) {
    const existing = ctx.sql
      .exec<{ id: string }>(
        `SELECT id FROM tenant_messages
         WHERE tenant_id = ? AND kind = ? AND dedup_key = ? AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
        ctx.tenantId,
        input.kind,
        input.dedupKey,
        now,
      )
      .toArray()[0];
    if (existing) {
      ctx.sql.exec(
        `UPDATE tenant_messages SET severity = ?, body = ?, action_hint = ?, created_at = ?, expires_at = ? WHERE id = ? AND tenant_id = ?`,
        input.severity,
        input.body,
        actionHintJson,
        now,
        expiresAt,
        existing.id,
        ctx.tenantId,
      );
      return;
    }
  }

  ctx.sql.exec(
    `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, action_hint, source, dedup_key, created_at, read_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'system', ?, ?, NULL, ?)`,
    newId("tmsg"),
    ctx.tenantId,
    input.kind,
    input.severity,
    input.body,
    actionHintJson,
    input.dedupKey ?? null,
    now,
    expiresAt,
  );
}

interface TenantMessageRow {
  id: string;
  kind: string;
  severity: string;
  body: string;
  action_hint: string | null;
  source: "system" | "operator";
  created_at: number;
  read_at: number | null;
  [column: string]: SqlStorageValue;
}

function toTenantMessage(row: TenantMessageRow): TenantMessage {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    body: row.body,
    actionHint: row.action_hint ? (JSON.parse(row.action_hint) as Record<string, unknown>) : null,
    source: row.source,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/**
 * The infrastructure_status read surface. PURE SELECT — never writes (a read
 * must never mutate tenant_messages; increment 2's ack_message tool is the
 * only future writer of `read_at`). Unread rows sort first, newest first
 * within each group, expired rows filtered out, capped at
 * MAX_SURFACED_MESSAGES.
 */
export function listSurfacedTenantMessages(ctx: TenantContext): TenantMessage[] {
  const now = ctx.clock.now();
  const rows = ctx.sql
    .exec<TenantMessageRow>(
      `SELECT id, kind, severity, body, action_hint, source, created_at, read_at
       FROM tenant_messages
       WHERE tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY (read_at IS NULL) DESC, created_at DESC, rowid DESC
       LIMIT ?`,
      ctx.tenantId,
      now,
      MAX_SURFACED_MESSAGES,
    )
    .toArray();
  return rows.map(toTenantMessage);
}

/**
 * Bounded, tenant-scoped cleanup: deletes expired rows and READ rows past
 * READ_RETENTION_MS. Reuses the existing per-tenant deliverability-sweep cron
 * leg (TenantDO.deliverabilitySweep, called by runDeliverabilitySweepAllTenants
 * in scheduled.ts) rather than a new cron.
 */
export function pruneTenantMessages(ctx: TenantContext): { deleted: number } {
  const now = ctx.clock.now();
  const result = ctx.sql.exec(
    `DELETE FROM tenant_messages
     WHERE tenant_id = ?
       AND ((expires_at IS NOT NULL AND expires_at <= ?) OR (read_at IS NOT NULL AND read_at <= ?))`,
    ctx.tenantId,
    now,
    now - READ_RETENTION_MS,
  );
  return { deleted: result.rowsWritten };
}
