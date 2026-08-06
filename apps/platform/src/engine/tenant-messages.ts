// System->agent message channel, increment 1 (founder-approved 2026-08-05).
// A DO-local mailbox our OWN system writes and the customer's agent reads via
// infrastructure_status's `messages` field — so a system notice (a retryable
// setup step, a credential going live) reaches the customer's agent without a
// human relay. Sibling of deliverability-actions.ts's `logAction`: same
// tenant-scoped SqlStorage write, same newId-prefixed row. DO-local, not D1
// (ARCHITECTURE.md decision #3 + CLAUDE.md rule h).
//
// Increment 1: emit + read + a bounded prune. Increment 2 (this file, below)
// adds the operator route's write path (emitOperatorMessage); increment 3
// adds the full paginated read surface + the one place that ever sets
// `read_at` (listMessagesPage, ackMessage).

import { NotFoundError } from "@coldstart/shared";
import { newId } from "../schema.js";
import type { TenantContext } from "../tenant-context.js";
import { assertNotLifecycleFrozen } from "./billing-state.js";

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
  /** 'system' (default — every increment-1 call site) | 'operator' (increment
   * 2's admin route, routes/admin-messages.ts). */
  source?: "system" | "operator";
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    newId("tmsg"),
    ctx.tenantId,
    input.kind,
    input.severity,
    input.body,
    actionHintJson,
    input.source ?? "system",
    input.dedupKey ?? null,
    now,
    expiresAt,
  );
}

export interface EmitOperatorMessageInput {
  kind: string;
  severity: TenantMessageSeverity;
  body: string;
}

// Kinds allowed to reach a LIFECYCLE-FROZEN tenant (status='suspended' or a
// frozen billing_state — billing-state.ts's isLifecycleFrozen) despite the
// gate below. Empty today: the one enumerated operator kind (admin/schemas.ts's
// AdminOperatorMessageInput — 'operator_notice') is a generic notice, not a
// message that itself explains or follows from the freeze, so it does not
// warrant the carve-out. Extend THIS set (never bypass the gate itself) if a
// future kind genuinely must reach a frozen tenant (e.g. a cancellation
// confirmation) — CLAUDE.md rule i, no speculative carve-out ahead of a real one.
const LIFECYCLE_EXEMPT_OPERATOR_KINDS = new Set<string>([]);

/**
 * Increment 2 — the operator route's write path (routes/admin-messages.ts).
 * Same INSERT as emitTenantMessage (source='operator' instead of 'system'),
 * gated by the SAME assertNotLifecycleFrozen predicate Inc1's gate's F2 fix
 * applies to wire B (mailbox-credential-push.ts's reconcileMailboxCredentialPushes):
 * a canceled/terminated (or disputed/suspended/canceling) tenant's agent must
 * not be handed a fresh operator message while the account itself is frozen.
 * Throws the SAME ValidationError assertNotLifecycleFrozen throws elsewhere
 * (mapped to HTTP 400 by error-response.ts) — reused, not reimplemented
 * (CLAUDE.md rule c).
 */
export function emitOperatorMessage(ctx: TenantContext, input: EmitOperatorMessageInput): void {
  if (!LIFECYCLE_EXEMPT_OPERATOR_KINDS.has(input.kind)) {
    assertNotLifecycleFrozen(ctx, `operator message (${input.kind})`);
  }
  emitTenantMessage(ctx, { kind: input.kind, severity: input.severity, body: input.body, source: "operator" });
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
 * must never mutate tenant_messages; increment 3's ackMessage below is the
 * ONLY writer of `read_at` in this codebase). Unread rows sort first, newest
 * first within each group, expired rows filtered out, capped at
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

export interface MessageListPage {
  messages: TenantMessage[];
  nextCursor: string | null;
}

interface MessageQueryRow extends TenantMessageRow {
  rowid: number;
}

/**
 * Opaque composite cursor `(unacked, createdAt, rowid)` — the same
 * "keyset over the ORDER BY columns" shape list-leads.ts/inbox.ts use for
 * their own 2-column cursors, extended one column to carry the unread/read
 * partition boundary: a plain `(createdAt, rowid)` cursor can't express
 * "every unread row sorts before every read row regardless of age" — an old
 * UNREAD row and a new READ row would otherwise decode to the wrong side of
 * a page boundary.
 */
function encodeMessageCursor(unacked: boolean, createdAt: number, rowid: number): string {
  return `${unacked ? 1 : 0}:${createdAt}:${rowid}`;
}

function decodeMessageCursor(cursor: string): { unacked: number; createdAt: number; rowid: number } | null {
  const match = /^([01]):(-?\d+):(-?\d+)$/.exec(cursor);
  if (!match) return null;
  return { unacked: Number(match[1]), createdAt: Number(match[2]), rowid: Number(match[3]) };
}

/**
 * list_messages (increment 3) — the full paginated read surface, unlike
 * listSurfacedTenantMessages's fixed cap-5 preview. SAME unread-first,
 * newest-first ordering as that surface. A stable keyset cursor (never
 * OFFSET) so a message emitted mid-pagination can't shift an already-issued
 * page — list-leads.ts/inbox.ts use the identical rationale for their own
 * cursors. PURE SELECT, exactly like listSurfacedTenantMessages: never sets
 * `read_at` (ackMessage below is the only writer of that column).
 */
export function listMessagesPage(ctx: TenantContext, query: { cursor?: string; limit: number }): MessageListPage {
  const now = ctx.clock.now();
  const conditions: string[] = [`tenant_id = ?`, `(expires_at IS NULL OR expires_at > ?)`];
  const binds: SqlStorageValue[] = [ctx.tenantId, now];

  const cursor = query.cursor ? decodeMessageCursor(query.cursor) : null;
  if (cursor) {
    conditions.push(`((read_at IS NULL) < ? OR ((read_at IS NULL) = ? AND (created_at < ? OR (created_at = ? AND rowid < ?))))`);
    binds.push(cursor.unacked, cursor.unacked, cursor.createdAt, cursor.createdAt, cursor.rowid);
  }

  // Fetch one extra row to know whether a next page exists without a second
  // COUNT query (mirrors list-leads.ts/inbox.ts/activity.ts).
  binds.push(query.limit + 1);

  const rows = ctx.sql
    .exec<MessageQueryRow>(
      `SELECT id, kind, severity, body, action_hint, source, created_at, read_at, rowid as rowid
       FROM tenant_messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY (read_at IS NULL) DESC, created_at DESC, rowid DESC
       LIMIT ?`,
      ...binds,
    )
    .toArray();

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  return {
    messages: page.map(toTenantMessage),
    nextCursor: hasMore && last ? encodeMessageCursor(last.read_at === null, last.created_at, last.rowid) : null,
  };
}

export interface AckMessageResult {
  acked: true;
  /** true when the message was ALREADY read before this call — a no-op
   * success, not an error (see ackMessage's doc). */
  alreadyAcked: boolean;
}

/**
 * ack_message (increment 3) — the ONLY writer of `read_at` in this codebase.
 * Tenant-scoped by `id + tenant_id` in BOTH the existence check and the
 * UPDATE (CLAUDE.md rule h): a cross-tenant id 404s exactly like an unknown
 * one — a tenant can never learn another tenant's message even exists.
 * IDEMPOTENT: acking an already-read row returns `alreadyAcked: true`
 * without writing again — an agent retrying a dropped call, or two agent
 * instances racing to ack the same message, must never see a second write or
 * an error for doing the safe thing twice.
 */
export function ackMessage(ctx: TenantContext, id: string): AckMessageResult {
  const existing = ctx.sql
    .exec<{ read_at: number | null }>(`SELECT read_at FROM tenant_messages WHERE id = ? AND tenant_id = ?`, id, ctx.tenantId)
    .toArray()[0];
  if (!existing) throw new NotFoundError(`message ${id} not found`);
  if (existing.read_at !== null) return { acked: true, alreadyAcked: true };

  ctx.sql.exec(`UPDATE tenant_messages SET read_at = ? WHERE id = ? AND tenant_id = ?`, ctx.clock.now(), id, ctx.tenantId);
  return { acked: true, alreadyAcked: false };
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
