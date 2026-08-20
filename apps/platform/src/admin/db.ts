// D1 control-plane helpers for the admin surface (D1/D2/D6 — src/admin/README.md).
// Mirrors the shape of ../db.ts (the tenant-index helpers) but for the
// cross-tenant tables added in migrations/0002_admin_ops.sql. Never touches
// a TenantDO's own SQLite storage — that's reached only via its RPC stub
// (see engine/ops-summary.ts + tenant-do.ts), keeping tenant isolation
// belt-and-suspenders (CLAUDE.md rule h) even on the admin surface.

import type { TenantIndexRow } from "../db.js";
import type { Env } from "../env.js";
import { clampListLimit } from "../validate.js";
import type { SupportCategory } from "./support-kb.js";

// S8 — the default page and the hard cap every cross-tenant operator list read
// shares. 200 mirrors the per-tenant messages twin (engine/tenant-messages.ts),
// which is the convention this codebase already settled on; the max exists so an
// explicit `?limit=` cannot re-open the unbounded read.
//
// EXPORTED so the last member of this class — `readCheckRows` in
// admin/watchtower.ts, which lives in that file because it reads
// `watchtower_state` and nothing else here does — bounds itself with the SAME
// two numbers rather than a second pair that can drift (CLAUDE.md rule c).
export const DEFAULT_ADMIN_LIST_LIMIT = 200;
export const MAX_ADMIN_LIST_LIMIT = 1000;

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
  // msgchannel Inc5 (migrations/0017) — 'email' (triaged inbound support mail)
  // vs 'agent' (a tenant's coding agent calling contact_operator). The whole
  // reason 0017 added the column is that the operator has to be able to tell
  // them apart, and an agent ticket's `fromEmail` is the tenant's REAL contact
  // address on a body the customer never wrote, so the digest must say so
  // rather than leave it inferable from a subject prefix.
  source: "email" | "agent";
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
 * msgchannel Inc5 — stamps `email_sent_at` on every ticket an ops email
 * actually carried, AFTER the send lands (never before — engine/
 * contact-operator.ts inserts every ticket with `email_sent_at: null` first,
 * so a send that throws leaves the rows honestly un-emailed and their text
 * rolls into the NEXT successful send, mirroring support-inbound.ts's own
 * "the ticket is already persisted, which is the durable record" posture for
 * its best-effort forward leg). Takes a LIST because one email carries the
 * new ticket plus every message the throttle had held back.
 *
 * This is a RECORD write, never a decision input: the guard's own state lives
 * in DO storage (engine/contact-operator-guard.ts) precisely because reading
 * D1 to decide cannot be atomic. Scoped by `tenantId` as well as id — the ids
 * are DO-local UUIDs so a collision is not a practical risk, but this is a
 * cross-tenant table and CLAUDE.md rule (h) wants the scope on every query
 * (its DO-side twins stampEmailed/releaseEmailClaim both carry it).
 */
// Ids per markSupportTicketsEmailed statement. Class sweep (docs/adversarial/
// inc5-reconcile-sweep-gate-2026-08-11.md, gate NON-BLOCKING-2's shape found
// again during the fix round's sweep): D1's real per-statement ceiling is
// 100 bound parameters (ofac/sdn-list.ts:13-19). This statement binds TWO
// fixed params (sentAt, tenantId) ahead of the ids, so the safe chunk is 98
// ids (2 + 98 = 100), not the 99 a single-fixed-param statement allows —
// confirmed by a chunk-boundary test at exactly 99 that reds without this.
const MARK_EMAILED_CHUNK_SIZE = 98;

export async function markSupportTicketsEmailed(env: Env, tenantId: string, ids: string[], sentAt: number): Promise<void> {
  if (ids.length === 0) return;
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += MARK_EMAILED_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + MARK_EMAILED_CHUNK_SIZE);
    statements.push(
      env.DB.prepare(
        `UPDATE support_tickets SET email_sent_at = ? WHERE tenant_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(sentAt, tenantId, ...chunk),
    );
  }
  if (statements.length === 1) {
    await statements[0]!.run();
  } else {
    await env.DB.batch(statements);
  }
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
  source: "email" | "agent";
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
    source: row.source,
  };
}

/**
 * GET /admin/support/digest — the tickets still needing the owner's attention
 * (brief: "open/escalated tickets"), NEWEST FIRST and BOUNDED (S8,
 * docs/adversarial/scale-readiness-audit-2026-08-17.md).
 *
 * `support_tickets` is lifetime-cumulative — nothing deletes a ticket — and this
 * projection carries the full `body` of every row, so the unbounded version grew
 * a single operator response without limit. The truncation is safe to leave
 * silent HERE only because the route pairs this with
 * `countSupportTicketsByStatus`, whose counts are computed over the whole table:
 * the digest can be a page, but it must never be able to imply the queue is
 * empty behind it.
 */
export async function listOpenAndEscalatedSupportTickets(env: Env, limit?: number): Promise<SupportTicketRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, from_email, subject, body, tenant_id, category, draft, status, created_at, source
     FROM support_tickets WHERE status IN ('open', 'escalated') ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(clampListLimit(limit, DEFAULT_ADMIN_LIST_LIMIT, MAX_ADMIN_LIST_LIMIT))
    .all<SupportTicketD1Row>();
  return result.results.map(fromD1Row);
}

/**
 * The digest's ticket counts, WITH THE DENOMINATOR THEY WERE DRAWN FROM
 * (docs/adversarial/class-sweep-watch-completeness-2026-08-17.md, platform IN
 * member 2 — "the amplifier").
 *
 * This used to return `open` and `escalated` and nothing else: two hardcoded
 * `SUM(CASE ...)` columns over an unfiltered table, hardcoding the SAME two
 * statuses as `listOpenAndEscalatedSupportTickets`' `WHERE status IN (...)`. A
 * consumer cross-checking the digest's counts against its ticket array
 * therefore got perfect agreement while BOTH were blind, which is precisely why
 * the digest could not detect its own narrowing. Complete only by accident
 * today: `'closed'` exists in the TS union and has zero writers anywhere in
 * src, so the first close/snooze/reopen feature blinds the list and its counts
 * in the same commit.
 *
 * `total` is a plain `COUNT(*)`. `open + escalated + closed === total` is now an
 * arithmetic identity a caller can check, and a status nobody accounted for
 * breaks it LOUDLY instead of vanishing.
 */
export async function countSupportTicketsByStatus(env: Env): Promise<{
  open: number;
  escalated: number;
  closed: number;
  total: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
       SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) as escalated_count,
       SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
       COUNT(*) as total_count
     FROM support_tickets`,
  ).first<{ open_count: number | null; escalated_count: number | null; closed_count: number | null; total_count: number | null }>();
  return {
    open: row?.open_count ?? 0,
    escalated: row?.escalated_count ?? 0,
    closed: row?.closed_count ?? 0,
    total: row?.total_count ?? 0,
  };
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
  if ((result.meta.changes ?? 0) > 0) return true;

  // THE KEY ALREADY HELD A ROW — record the later reason instead of discarding
  // it (IN-15, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md).
  // `UNIQUE(tenant_id, action)` means a tenant terminated, reinstated, then
  // re-terminated for a DIFFERENT AUP reason kept only the FIRST reason and
  // evidence — the abuse that actually got them terminated the second time left
  // no trace anywhere, in the platform's abuse audit trail.
  //
  // Accumulated INTO the existing row rather than fixing the key. Dropping a
  // SQLite constraint needs a full table rebuild, which none of this repo's 18
  // migrations has ever done, and `countTerminatedTenants` reads
  // one-row-per-terminated-tenant off exactly this constraint. So the row count,
  // the constraint and `enforcementLogged`'s meaning ("a NEW row was created",
  // which admin-terminate.test.ts pins as false on a repeat) are all unchanged —
  // only the silent loss goes.
  //
  // BOUNDED BY CONSECUTIVE-DISTINCT REASONS, not by distinct reasons (NB3,
  // docs/adversarial/wave-a-trains-3-4-gate-2026-08-20.md — the original comment
  // here claimed the stronger bound and was wrong). The comparison below looks
  // at the LAST recorded reason only, so an admin double-clicking terminate with
  // the same reason appends nothing, but reasons alternating A, B, A, B… append
  // on every call.
  //
  // Left as-is deliberately rather than half-fixed. A true distinct-reason bound
  // needs a per-episode ANNOUNCED SET rather than a two-state comparison, which
  // is the identical shape as — and is being designed alongside — the deferred
  // IN-17 alert-state work in the Wave B increment. Reachability here is one
  // human behind ADMIN_TOKEN appending to a D1 TEXT column, so the honest
  // comment is the fix for now and the mechanism moves with its sibling.
  const existing = await env.DB.prepare(
    `SELECT reason, evidence_json FROM enforcement_actions WHERE tenant_id = ? AND action = ?`,
  )
    .bind(params.tenantId, params.action)
    .first<{ reason: string; evidence_json: string }>();
  if (!existing) return false;

  const evidence = JSON.parse(existing.evidence_json) as {
    subsequentActions?: { reason: string; evidence: Record<string, unknown>; ts: number }[];
  };
  const subsequent = evidence.subsequentActions ?? [];
  const latestReason = subsequent.length > 0 ? subsequent[subsequent.length - 1]!.reason : existing.reason;
  if (latestReason === params.reason) return false;

  subsequent.push({ reason: params.reason, evidence: params.evidence, ts: params.ts });
  await env.DB.prepare(`UPDATE enforcement_actions SET evidence_json = ? WHERE tenant_id = ? AND action = ?`)
    .bind(JSON.stringify({ ...evidence, subsequentActions: subsequent }), params.tenantId, params.action)
    .run();
  return false;
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
/**
 * Pending screening reviews, oldest first and BOUNDED (S8).
 *
 * TWO CONSUMERS WITH DIFFERENT NEEDS, which is why the narrowing is a parameter
 * rather than a bound baked into the query:
 *
 *  - `routes/admin-screening.ts` renders an operator PAGE, and a page is allowed
 *    to be a page (it reports `total` beside it).
 *  - `ofac/screening-recovery.ts` is a 5-minute cron that must REACH every tenant
 *    held on the `list-unavailable` sentinel. It used to load the whole queue and
 *    filter in JS, so a limit added for the operator's benefit would have
 *    silently stopped a sanctions recovery from ever seeing a tenant sitting past
 *    the cap — a truncation with no error and no operator anywhere. It now asks
 *    for its own rows via `listVersion`, which narrows in SQL, so its batch is
 *    spent on the population it actually processes.
 */
export async function listPendingScreeningReviews(
  env: Env,
  opts: { limit?: number; listVersion?: string } = {},
): Promise<ScreeningReviewRow[]> {
  const limit = clampListLimit(opts.limit, DEFAULT_ADMIN_LIST_LIMIT, MAX_ADMIN_LIST_LIMIT);
  const result = opts.listVersion
    ? await env.DB.prepare(
        `SELECT tenant_id, matched_terms, screened_fields, list_version, status, created_at, resolved_at, resolved_by
         FROM screening_reviews WHERE status = 'pending' AND list_version = ? ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(opts.listVersion, limit)
        .all<ScreeningReviewD1Row>()
    : await env.DB.prepare(
        `SELECT tenant_id, matched_terms, screened_fields, list_version, status, created_at, resolved_at, resolved_by
         FROM screening_reviews WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(limit)
        .all<ScreeningReviewD1Row>();
  return result.results.map(fromScreeningReviewD1Row);
}

/** How deep the pending queue actually is — the `total` beside a bounded page. */
export async function countPendingScreeningReviews(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM screening_reviews WHERE status = 'pending'`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
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
