// D1 control-plane helpers for the admin surface (D1/D2/D6 — src/admin/README.md).
// Mirrors the shape of ../db.ts (the tenant-index helpers) but for the
// cross-tenant tables added in migrations/0002_admin_ops.sql. Never touches
// a TenantDO's own SQLite storage — that's reached only via its RPC stub
// (see engine/ops-summary.ts + tenant-do.ts), keeping tenant isolation
// belt-and-suspenders (CLAUDE.md rule h) even on the admin surface.

import type { TenantIndexRow } from "../db.js";
import type { Env } from "../env.js";
import type { SupportCategory } from "./support-kb.js";

export interface SupportTicketRow {
  id: string;
  fromEmail: string;
  subject: string;
  body: string;
  tenantId: string | null;
  category: SupportCategory;
  draft: string | null;
  status: "open" | "escalated" | "closed";
  createdAt: number;
}

/**
 * Inserts a triaged support ticket. B4 (CLASS B): idempotent on the source
 * RFC 5322 `messageId` (unique index + INSERT OR IGNORE) so a redelivered
 * inbound email can't create two tickets. `messageId` NULL (operator/console
 * tickets) never dedupes — NULLs are distinct in SQLite. Returns `true` only
 * when a NEW row was recorded (mirrors insertDunningEventIfNew).
 *
 * `source`/`emailSentAt` (msgchannel Inc5, migrations/0017) default to
 * 'email'/null — every pre-existing caller (support-inbound.ts,
 * routes/admin-support.ts) omits both and is byte-identical; only
 * engine/contact-operator.ts passes `source: 'agent'`.
 */
export async function insertSupportTicket(
  env: Env,
  params: {
    id: string;
    fromEmail: string;
    subject: string;
    body: string;
    tenantId: string | null;
    category: SupportCategory;
    draft: string | null;
    status: "open" | "escalated";
    createdAt: number;
    messageId?: string | null;
    source?: "email" | "agent";
    emailSentAt?: number | null;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO support_tickets (id, from_email, subject, body, tenant_id, category, draft, status, created_at, message_id, source, email_sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      params.id,
      params.fromEmail,
      params.subject,
      params.body,
      params.tenantId,
      params.category,
      params.draft,
      params.status,
      params.createdAt,
      params.messageId ?? null,
      params.source ?? "email",
      params.emailSentAt ?? null,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * msgchannel Inc5 abuse guards (engine/contact-operator.ts) — everything the
 * storm guard needs about this tenant's agent-sourced tickets in ONE query:
 * dedup (identical-body match within the window) and the rate cap (row
 * count + the oldest row's timestamp, to compute `retryAfter`) share the
 * SAME 1h window, so one read covers both checks. Bounded to 200 rows as a
 * hard safety cap — the rate limit itself keeps real volume far below that.
 */
export async function listRecentAgentSupportTickets(
  env: Env,
  tenantId: string,
  sinceMs: number,
): Promise<Array<{ id: string; body: string; createdAt: number }>> {
  const result = await env.DB.prepare(
    `SELECT id, body, created_at FROM support_tickets
     WHERE tenant_id = ? AND source = 'agent' AND created_at > ?
     ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(tenantId, sinceMs)
    .all<{ id: string; body: string; created_at: number }>();
  return result.results.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at }));
}

/**
 * msgchannel Inc5 ops-email throttle (engine/contact-operator.ts) — the last
 * REAL send time for this tenant's agent-sourced tickets (null = never
 * emailed), and how many since-then tickets were suppressed by the throttle
 * (never individually emailed) — the "and N more messages" count the NEXT
 * send folds in.
 */
export async function agentContactEmailThrottleState(
  env: Env,
  tenantId: string,
): Promise<{ lastEmailAt: number | null; pendingSinceLastEmail: number }> {
  const lastEmailRow = await env.DB.prepare(
    `SELECT MAX(email_sent_at) as last_email FROM support_tickets WHERE tenant_id = ? AND source = 'agent' AND email_sent_at IS NOT NULL`,
  )
    .bind(tenantId)
    .first<{ last_email: number | null }>();
  const lastEmailAt = lastEmailRow?.last_email ?? null;

  const pendingRow = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM support_tickets WHERE tenant_id = ? AND source = 'agent' AND email_sent_at IS NULL AND created_at > ?`,
  )
    .bind(tenantId, lastEmailAt ?? 0)
    .first<{ n: number }>();

  return { lastEmailAt, pendingSinceLastEmail: pendingRow?.n ?? 0 };
}

/**
 * msgchannel Inc5 — stamps `email_sent_at` on ONE ticket AFTER its ops email
 * has actually been sent (never before — engine/contact-operator.ts inserts
 * every ticket with `email_sent_at: null` first, so a send that throws
 * leaves the row honestly un-emailed and its message rolls into the NEXT
 * successful send's "and N more" count, mirroring support-inbound.ts's own
 * "the ticket is already persisted, which is the durable record" posture for
 * its best-effort forward leg).
 */
export async function markSupportTicketEmailed(env: Env, id: string, sentAt: number): Promise<void> {
  await env.DB.prepare(`UPDATE support_tickets SET email_sent_at = ? WHERE id = ?`).bind(sentAt, id).run();
}

interface SupportTicketD1Row {
  id: string;
  from_email: string;
  subject: string;
  body: string;
  tenant_id: string | null;
  category: SupportCategory;
  draft: string | null;
  status: "open" | "escalated" | "closed";
  created_at: number;
}

function fromD1Row(row: SupportTicketD1Row): SupportTicketRow {
  return {
    id: row.id,
    fromEmail: row.from_email,
    subject: row.subject,
    body: row.body,
    tenantId: row.tenant_id,
    category: row.category,
    draft: row.draft,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** GET /admin/support/digest — every ticket still needing the owner's attention (brief: "open/escalated tickets"). */
export async function listOpenAndEscalatedSupportTickets(env: Env): Promise<SupportTicketRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, from_email, subject, body, tenant_id, category, draft, status, created_at
     FROM support_tickets WHERE status IN ('open', 'escalated') ORDER BY created_at DESC`,
  ).all<SupportTicketD1Row>();
  return result.results.map(fromD1Row);
}

export async function countSupportTicketsByStatus(env: Env): Promise<{ open: number; escalated: number }> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
       SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) as escalated_count
     FROM support_tickets`,
  ).first<{ open_count: number | null; escalated_count: number | null }>();
  return { open: row?.open_count ?? 0, escalated: row?.escalated_count ?? 0 };
}

/**
 * Idempotent per (tenantId, cycle) — mirrors ledger_entries/webhook_events'
 * INSERT-and-check-rowcount pattern. Returns `true` only when this call
 * actually recorded a NEW dunning event (the sweep should apply the action's
 * side effect exactly then); `false` means this cycle was already actioned.
 */
export async function insertDunningEventIfNew(
  env: Env,
  params: { id: string; tenantId: string; cycle: number; action: string; detail: Record<string, unknown>; ts: number },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO dunning_events (id, tenant_id, cycle, action, detail_json, ts) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(params.id, params.tenantId, params.cycle, params.action, JSON.stringify(params.detail), params.ts)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Read-only pre-check for (tenantId, cycle) — F2's fix (audit 2026-08-05)
 * moved the suspend EFFECT before `insertDunningEventIfNew`'s guard-row
 * commit (so a crash in between leaves nothing committed and the next tick
 * retries), which means the INSERT alone can no longer gate the suspend
 * branch BEFORE it runs. Without this pre-check, a tenant that's already
 * suspended stays 'past_due' forever (suspending never changes billing_state)
 * and would be re-suspended + re-emailed the notice every single 5-min tick.
 * `insertDunningEventIfNew` still does the actual (race-safe) commit after.
 */
export async function hasDunningEventForCycle(env: Env, tenantId: string, cycle: number): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM dunning_events WHERE tenant_id = ? AND cycle = ? LIMIT 1`)
    .bind(tenantId, cycle)
    .first();
  return row !== null;
}

/** Every tenant id known to the control plane — the D1 read-model driving
 * the cross-tenant sweeps/digest (ARCHITECTURE.md #3). Test-mode scale only:
 * a full D1 read-model (rather than re-fetching every tenant id per sweep)
 * is the scale path, noted in admin/README.md. */
export async function listAllTenantIds(env: Env): Promise<string[]> {
  const result = await env.DB.prepare(`SELECT id FROM tenants_index`).all<{ id: string }>();
  return result.results.map((r) => r.id);
}

/** Resolves a tenant by id from the control-plane index — the admin terminate
 * route uses it to 404 on an unknown :id BEFORE touching a (would-be
 * uninitialized) TenantDO. */
export async function getTenantIndexById(env: Env, id: string): Promise<TenantIndexRow | null> {
  const row = await env.DB.prepare(`SELECT id, brand, plan, status FROM tenants_index WHERE id = ?`)
    .bind(id)
    .first<TenantIndexRow>();
  return row ?? null;
}

/**
 * D5 abuse-offboarding audit row (migrations/0003). Idempotent per
 * (tenantId, action) — mirrors insertDunningEventIfNew: returns `true` only
 * when a NEW enforcement action was recorded, so a retried terminate (after the
 * DO teardown already committed) lands exactly one row. `action` is
 * 'TERMINATE' for the terminal AUP rung.
 */
export async function insertEnforcementActionIfNew(
  env: Env,
  params: { id: string; tenantId: string; action: string; reason: string; evidence: Record<string, unknown>; ts: number },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO enforcement_actions (id, tenant_id, action, reason, evidence_json, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(params.id, params.tenantId, params.action, params.reason, JSON.stringify(params.evidence), params.ts)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** D6 digest — count of terminated tenants (one enforcement_actions row per
 * terminated tenant, given the UNIQUE(tenant_id, action) anchor). */
export async function countTerminatedTenants(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM enforcement_actions WHERE action = 'TERMINATE'`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

// --- G1 OFAC screening review queue (migrations/0012_sdn_screening.sql) ---
// Cross-tenant/admin-owned exactly like dunning_events/enforcement_actions
// above — one row per tenant CURRENTLY OR PREVIOUSLY held for review
// (tenant_id is the PK). See src/ofac/screening.ts (writer) and
// src/routes/admin-screening.ts (reader/resolver).

export interface ScreeningReviewRow {
  tenantId: string;
  matchedTerms: unknown;
  screenedFields: unknown;
  listVersion: string;
  status: "pending" | "cleared" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

interface ScreeningReviewD1Row {
  tenant_id: string;
  matched_terms: string;
  screened_fields: string;
  list_version: string;
  status: "pending" | "cleared" | "rejected";
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

function fromScreeningReviewD1Row(row: ScreeningReviewD1Row): ScreeningReviewRow {
  return {
    tenantId: row.tenant_id,
    matchedTerms: JSON.parse(row.matched_terms),
    screenedFields: JSON.parse(row.screened_fields),
    listVersion: row.list_version,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

/**
 * Records (or REOPENS) a tenant's screening-hold row. `tenant_id` is the PK —
 * a re-hit on a re-screen (NB-1's brand-change re-screen) reopens this SAME
 * row to 'pending' rather than appending a duplicate, so "list every pending
 * review" stays a single query per tenant (design line 63).
 */
export async function upsertScreeningReview(
  env: Env,
  params: { tenantId: string; matchedTerms: unknown; screenedFields: unknown; listVersion: string; createdAt: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO screening_reviews (tenant_id, matched_terms, screened_fields, list_version, status, created_at, resolved_at, resolved_by)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)
     ON CONFLICT(tenant_id) DO UPDATE SET
       matched_terms = excluded.matched_terms,
       screened_fields = excluded.screened_fields,
       list_version = excluded.list_version,
       status = 'pending',
       created_at = excluded.created_at,
       resolved_at = NULL,
       resolved_by = NULL`,
  )
    .bind(params.tenantId, JSON.stringify(params.matchedTerms), JSON.stringify(params.screenedFields), params.listVersion, params.createdAt)
    .run();
}

/** GET /admin/screening/reviews — every review still awaiting the founder. */
export async function listPendingScreeningReviews(env: Env): Promise<ScreeningReviewRow[]> {
  const result = await env.DB.prepare(
    `SELECT tenant_id, matched_terms, screened_fields, list_version, status, created_at, resolved_at, resolved_by
     FROM screening_reviews WHERE status = 'pending' ORDER BY created_at ASC`,
  ).all<ScreeningReviewD1Row>();
  return result.results.map(fromScreeningReviewD1Row);
}

export async function getScreeningReview(env: Env, tenantId: string): Promise<ScreeningReviewRow | null> {
  const row = await env.DB.prepare(
    `SELECT tenant_id, matched_terms, screened_fields, list_version, status, created_at, resolved_at, resolved_by
     FROM screening_reviews WHERE tenant_id = ?`,
  )
    .bind(tenantId)
    .first<ScreeningReviewD1Row>();
  return row ? fromScreeningReviewD1Row(row) : null;
}

/**
 * POST /admin/tenants/:id/screening — resolves a PENDING review. Returns
 * `true` only when a row existed AND was still 'pending' to resolve (a
 * clear/reject on a tenant with no review row on file is still honored on
 * tenant_profile by the caller, but has no queue row to close — see
 * routes/admin-screening.ts).
 *
 * Race-guard (adversary re-attack, 2026-07-23): the atomic conditional
 * `WHERE status = 'pending'` (the house pattern — mirrors the spend-ledger's
 * conditional reserve UPDATE) is what actually prevents the audit-corruption
 * case: the N-OF-1 recovery sweep (ofac/screening-recovery.ts) calls THIS
 * function after re-screening a tenant clean, and without this guard it could
 * overwrite an admin's already-'rejected' (or already-'cleared') row with
 * 'cleared'/'system-recovery' — silently erasing a real admin decision from
 * the audit trail. Now that write simply matches zero rows (a no-op,
 * `false`) whenever the row has already moved on, regardless of which side
 * got there first.
 */
export async function resolveScreeningReview(
  env: Env,
  tenantId: string,
  status: "cleared" | "rejected",
  resolvedBy: string,
  resolvedAt: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE screening_reviews SET status = ?, resolved_at = ?, resolved_by = ? WHERE tenant_id = ? AND status = 'pending'`,
  )
    .bind(status, resolvedAt, resolvedBy, tenantId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
