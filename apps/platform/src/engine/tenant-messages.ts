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

/**
 * What an agent may branch on (F11, docs/adversarial/
 * agent-channel-product-audit-2026-08-17.md). A bare `string` was
 * undefined-by-convention: the type promised nothing, the comment that stood
 * here claimed "both real emit points use 'action_required'" while
 * provisioning.ts's SUCCESS-PENDING emit already used 'info', and four public
 * tool descriptions tell agents to read this field.
 *
 * FOUR RUNGS, and each of the last two is load-bearing (docs/adversarial/
 * class-sweep-signal-inversion-2026-08-17.md guard A2, then
 * class-sweep-vendor-truth-2026-08-18.md class A):
 *
 * - 'info' — the condition resolves on its own; nothing is required.
 * - 'action_required' — the account will not progress until someone acts, and
 *   acting works. The actor is YOU, the agent reading this.
 * - 'operator_pending' — the platform has stopped AND the agent cannot restart
 *   it, but this is not the end of the road: an OPERATOR clears the blocker
 *   (funds a provider account, rotates a credential, ships a fix) and then the
 *   agent's SAME retry completes, unchanged. Without this rung that outcome had
 *   to borrow one of its neighbours, and both lied — 'action_required' tells an
 *   agent to act when no action of its own can work, and 'terminal' tells it to
 *   stop forever over something a top-up clears in a minute. The latter is what
 *   actually happened: an empty provider wallet was reported as permanent, and
 *   the customer's agent correctly obeyed and gave up.
 * - 'terminal' — the platform has STOPPED. Retrying will never help; the only
 *   way forward is a human. Emitting the terminal give-up (F3) without this
 *   rung re-opened the same defect one layer up: the message existed, and an
 *   agent branching on `severity` read a dead paid domain identically to a
 *   transient vendor hiccup, so it retried forever exactly as before.
 *
 * The 'operator_pending' / 'terminal' distinction is exactly "will the SAME
 * retry work later" — the question `VendorError.operatorActionable` answers,
 * and these two rungs are its message-channel projection.
 *
 * NOT DB-enforced — the `tenant_messages` CHECK would have to be added by table
 * rebuild inside every live DO, and the writes all funnel through this module's
 * two emit helpers, so the type is the enforcement point. Adding this rung
 * therefore needed NO migration (verified against schema.ts: `severity` is a
 * bare `TEXT NOT NULL`).
 */
/**
 * Runtime array, so the doc-coverage guard (design §2.6/I9, G1) can see a
 * rung the moment it is added — a fifth rung reddens the guard before it can
 * ship undocumented, the way the vendor-truth wave's `operator_pending` had
 * to be hand-added to four descriptions with nothing to catch a miss.
 */
export const TENANT_MESSAGE_SEVERITIES = ["info", "action_required", "operator_pending", "terminal"] as const;
export type TenantMessageSeverity = (typeof TENANT_MESSAGE_SEVERITIES)[number];

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
  // msgchannel Inc5 — optional back-reference (e.g. a contact_operator
  // ticket id) surfaced verbatim on the emitted message's actionHint.regarding
  // (admin/schemas.ts's AdminOperatorMessageInput doc has the full rationale).
  regarding?: string;
}

/**
 * Increment 2 — the operator route's write path (routes/admin-messages.ts).
 * Same INSERT as emitTenantMessage (source='operator' instead of 'system').
 *
 * DELIBERATELY NOT lifecycle-gated (gate fix, msgchannel-inc23-gate-2026-08-06
 * F2 — an earlier version reused wire B's assertNotLifecycleFrozen here and
 * that generalization was wrong in kind). Wire A/B's gate exists because a
 * SYSTEM-templated body asserts something the freeze makes FALSE ("sending is
 * now enabled" to a suspended tenant is a lie) — assertNotLifecycleFrozen
 * stays on those wires untouched. An operator message has no such claim
 * baked in: it is human-authored prose under ADMIN_TOKEN, and the channel's
 * ratified purpose (ROADMAP.md's msgchannel entry: "activation/next-step
 * instructions, retry-with-same-key prompts, the OAuth-mint-ready signal,
 * incident notices") is precisely to reach a tenant IN a trouble state —
 * "your card failed, update it at <link>" to a dunning-suspended tenant is
 * the canonical use case this channel exists to carry, not a case to block.
 * Delivers in every lifecycle state; there is no kind-based exemption list to
 * maintain because there is no default-deny to exempt from.
 */
export function emitOperatorMessage(ctx: TenantContext, input: EmitOperatorMessageInput): void {
  emitTenantMessage(ctx, {
    kind: input.kind,
    severity: input.severity,
    body: input.body,
    source: "operator",
    actionHint: input.regarding ? { regarding: input.regarding } : undefined,
  });
}

interface TenantMessageRow {
  id: string;
  kind: string;
  /** Widened deliberately: this is what SQLite hands back, not what we accept.
   * A row written before the union was the contract must still read out. */
  severity: string;
  body: string;
  action_hint: string | null;
  source: "system" | "operator";
  created_at: number;
  read_at: number | null;
  [column: string]: SqlStorageValue;
}

/**
 * Reads a stored severity back into the union. Anything unrecognised resolves
 * to 'action_required' rather than 'info': the emit helpers can only ever write
 * a union member, so this is reachable only by a hand-written row or by a row
 * written before a rung existed, and an over-reported action item costs an
 * agent one look while an under-reported one is precisely the silent-stall
 * class this channel exists to prevent.
 *
 * Note the unknown case does NOT resolve to 'terminal' either: claiming the
 * platform has permanently stopped, on the strength of a value we do not
 * recognise, would be its own false terminal. Nor to 'operator_pending', which
 * makes the equal-and-opposite claim that a human elsewhere is the blocker.
 */
function toSeverity(raw: string): TenantMessageSeverity {
  if (raw === "info") return "info";
  if (raw === "terminal") return "terminal";
  if (raw === "operator_pending") return "operator_pending";
  return "action_required";
}

function toTenantMessage(row: TenantMessageRow): TenantMessage {
  return {
    id: row.id,
    kind: row.kind,
    severity: toSeverity(row.severity),
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
 * ONLY writer of `read_at` in this codebase). UNACKED ONLY (gate fix,
 * msgchannel-inc23-gate-2026-08-06 F1 — increment 3 shipped the ack writer
 * without this filter, so an acked message kept resurfacing here, and four
 * public tool/API descriptions claimed the opposite as fact). Expired rows
 * filtered out, capped at MAX_SURFACED_MESSAGES.
 *
 * OPERATOR FIRST, then newest first (F9, docs/adversarial/
 * agent-channel-product-audit-2026-08-17.md). A plain newest-first cap of 5 is
 * displaceable by our own system churn: `emitTenantMessage`'s dedup branch
 * RE-STAMPS `created_at` on every re-trigger, so a tenant with five or more
 * domains each refreshing a per-domain `retry_setup` pushes a human operator's
 * reply out of the preview entirely — while infrastructure_status's tool
 * description tells the agent to "poll this alongside the mailbox fields so you
 * never miss one". A system message is machine-regenerated on the next call; an
 * operator's reply is written once by a human and is the only thing here that
 * cannot be reconstructed, so it outranks. list_messages (below) is the surface
 * for acked history — this preview never shows it.
 */
export function listSurfacedTenantMessages(ctx: TenantContext): TenantMessage[] {
  const now = ctx.clock.now();
  const rows = ctx.sql
    .exec<TenantMessageRow>(
      `SELECT id, kind, severity, body, action_hint, source, created_at, read_at
       FROM tenant_messages
       WHERE tenant_id = ? AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY (source = 'operator') DESC, created_at DESC, rowid DESC
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

// `actionHint` is `object | null` here, NOT `Record<string, unknown> | null`
// like TenantMessage's own field (assignable at runtime — same JSON.parse
// result, no behavior change): a SECOND RPC-returned type on TenantDO
// carrying a `Record<string, unknown>` collapses `Rpc.Provider`'s
// `Serializable<T>` check to `never` (silent — no tsc diagnostic points at
// the cause), confirmed by bisection against listMessages'
// MessageListPage/TenantMessage (the first, working occurrence). A generic
// index-signature type reachable from a SECOND RPC method is the trigger,
// not this field's data shape.
// Item 6 (founder-ordered, docs/adversarial/class-sweep-vendor-truth-2026-08-18.md
// addendum) — `readAt` (TenantMessage's own field, shared with the two
// AGENT-facing surfaces above and NEVER renamed there) is replaced here with
// `ackedAt`, ONLY on this operator-facing type. `tenant_messages.read_at`'s
// ONLY writer is the tenant agent's explicit `ackMessage` tool
// (ackMessage below) — a null does NOT mean the agent never saw the message,
// only that it has not acked it; this endpoint lists every message
// REGARDLESS of ack state. The old `readAt` name told the operator "the
// agent read this" when the true claim was narrower and misled the operator
// for a full day during a live incident.
export type OperatorTenantMessage = Omit<TenantMessage, "actionHint" | "readAt"> & {
  actionHint: object | null;
  expiresAt: number | null;
  ackedAt: number | null;
};

export type OperatorMessageListResult = {
  messages: OperatorTenantMessage[];
  total: number;
};

export interface ListMessagesForOperatorOptions {
  limit?: number;
  unreadOnly?: boolean;
}

const DEFAULT_OPERATOR_MESSAGE_LIMIT = 50;
const MAX_OPERATOR_MESSAGE_LIMIT = 200;

function clampOperatorMessageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_OPERATOR_MESSAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_OPERATOR_MESSAGE_LIMIT);
}

/**
 * The operator/admin read surface (routes/admin-messages.ts's GET route) —
 * an AUDIT view, unlike the two agent-facing surfaces above:
 * listSurfacedTenantMessages caps at 5 and hides read/expired rows;
 * listMessagesPage partitions unread-first for an agent's inbox triage.
 * Here the operator is asking "has the customer's agent ACKED this?" — NOT
 * "has it been seen" (Item 6, docs/adversarial/class-sweep-vendor-truth-
 * 2026-08-18.md addendum): this call itself LISTS every message regardless of
 * ack state, so a message can be read by this very response without ever
 * being acked. `ackedAt` (OperatorTenantMessage, above) is set ONLY by the
 * tenant's explicit `ackMessage` call; null means "not acked", never "not
 * seen". Every row is in scope regardless of ack/expired state, newest-first
 * only (no unread partition), and `expiresAt` is returned (the agent-facing
 * shapes omit it — an agent never needs its own expiry). `total` counts the
 * SAME filter the returned page used (tenant_id, plus read_at IS NULL when
 * `unreadOnly`), so it always tells the caller whether `limit` truncated the
 * result. PURE SELECT, same as the two surfaces above: never writes
 * `read_at` (ackMessage remains the only writer).
 */
export function listMessagesForOperator(
  ctx: TenantContext,
  options: ListMessagesForOperatorOptions = {},
): OperatorMessageListResult {
  const limit = clampOperatorMessageLimit(options.limit);
  const conditions = [`tenant_id = ?`];
  const binds: SqlStorageValue[] = [ctx.tenantId];
  if (options.unreadOnly) conditions.push(`read_at IS NULL`);
  const where = conditions.join(" AND ");

  const rows = ctx.sql
    .exec<TenantMessageRow & { expires_at: number | null }>(
      `SELECT id, kind, severity, body, action_hint, source, created_at, read_at, expires_at
       FROM tenant_messages
       WHERE ${where}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
      ...binds,
      limit,
    )
    .toArray();

  const total = ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM tenant_messages WHERE ${where}`, ...binds).one().n;

  return {
    // Item 6 — `readAt` -> `ackedAt`: same underlying column (`read_at`,
    // ackMessage's ONLY writer), renamed on THIS surface only so the field
    // name states its true semantics rather than implying "the agent saw
    // this", which this endpoint cannot know.
    messages: rows.map((row) => {
      const { readAt, ...message } = toTenantMessage(row);
      return { ...message, expiresAt: row.expires_at, ackedAt: readAt };
    }),
    total,
  };
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
