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
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO support_tickets (id, from_email, subject, body, tenant_id, category, draft, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();
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
