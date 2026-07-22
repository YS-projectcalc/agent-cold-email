import type { LeadInterestStatus, Provenance, UpdateLeadInput } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// SPEC.md §22 (D1) — the warm-lead persistence core. update_lead upserts the
// contact-level lead_dispositions row (keyed tenant_id+email, DECOUPLED from
// the campaign-scoped `leads` table — schema.ts's comment on the table).
// list_leads (engine/list-leads.ts) reads this same table via a LEFT JOIN.

export interface LeadDispositionView {
  email: string;
  interestStatus: LeadInterestStatus;
  notes: string;
  tags: string[];
  source: string;
  updatedAt: number;
}

interface DispositionRow {
  interest_status: LeadInterestStatus;
  notes: string;
  tags_json: string;
  source: string;
  updated_at: number;
  [column: string]: SqlStorageValue;
}

function rowToView(email: string, row: DispositionRow): LeadDispositionView {
  return {
    email,
    interestStatus: row.interest_status,
    notes: row.notes,
    tags: JSON.parse(row.tags_json) as string[],
    source: row.source,
    updatedAt: row.updated_at,
  };
}

/**
 * update_lead — SPEC.md §22 tool 21. A PARTIAL patch: only the fields present
 * on `input` are changed; an omitted field keeps its current stored value (or
 * the schema default on first write for this email). `source` is
 * server-derived from transport (never a client-supplied claim), matching
 * `thread_labels.source`/`dashboard_views.edited_by`. No existence check
 * against `leads` — disposition is intentionally decoupled from any
 * particular campaign-lead row (SPEC.md §22's data-model rationale), so an
 * agent may record disposition for an email before/without a launched
 * campaign lead row for it.
 */
export function upsertLeadDisposition(
  ctx: TenantContext,
  input: UpdateLeadInput,
  source: Provenance,
  nowMs: number,
): LeadDispositionView {
  const existing = ctx.sql
    .exec<DispositionRow>(
      `SELECT interest_status, notes, tags_json, source, updated_at FROM lead_dispositions WHERE tenant_id = ? AND email = ?`,
      ctx.tenantId,
      input.email,
    )
    .toArray()[0];

  const interestStatus = input.interestStatus ?? existing?.interest_status ?? "none";
  const notes = input.notes ?? existing?.notes ?? "";
  const tagsJson = input.tags !== undefined ? JSON.stringify(input.tags) : (existing?.tags_json ?? "[]");

  ctx.sql.exec(
    `INSERT INTO lead_dispositions (tenant_id, email, interest_status, notes, tags_json, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       interest_status = excluded.interest_status,
       notes = excluded.notes,
       tags_json = excluded.tags_json,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    ctx.tenantId,
    input.email,
    interestStatus,
    notes,
    tagsJson,
    source,
    nowMs,
  );

  return rowToView(input.email, {
    interest_status: interestStatus,
    notes,
    tags_json: tagsJson,
    source,
    updated_at: nowMs,
  });
}
