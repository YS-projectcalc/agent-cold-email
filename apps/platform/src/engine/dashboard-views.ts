import type { DashboardLayout, Provenance } from "@coldstart/shared";
import { NotFoundError, RevConflictError, ValidationError, starterDashboardLayout } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";

// SPEC.md §19.2/§19.4 — agent-controlled dashboard layouts (saved views).
// Every mutation here is reachable via BOTH the dashboard HTTP routes
// (routes/dashboard.ts) and the MCP `configure_dashboard` tool (mcp/tools.ts)
// — parity law (§19.0): the dashboard has no state an agent can't also read
// or write.

export interface DashboardViewSummary {
  id: string;
  name: string;
  isDefault: boolean;
  rev: number;
  editedBy: string;
  editedByNote: string | null;
  updatedAt: string;
}

export interface DashboardViewDetail extends DashboardViewSummary {
  layout: DashboardLayout;
  createdAt: string;
}

interface ViewRow {
  id: string;
  name: string;
  is_default: number;
  rev: number;
  layout_json: string;
  edited_by: string;
  edited_by_note: string | null;
  updated_at: string;
  created_at: string;
  [column: string]: SqlStorageValue;
}

function toSummary(row: ViewRow): DashboardViewSummary {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default === 1,
    rev: row.rev,
    editedBy: row.edited_by,
    editedByNote: row.edited_by_note,
    updatedAt: row.updated_at,
  };
}

function toDetail(row: ViewRow): DashboardViewDetail {
  return { ...toSummary(row), layout: JSON.parse(row.layout_json) as DashboardLayout, createdAt: row.created_at };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base.slice(0, 80) : "view";
}

/**
 * Default-view lifecycle (§19.2/[F6]) — a fresh tenant always renders. Called
 * at the top of every view operation (not just the "first GET" the spec calls
 * out) so the "at least one default view exists" invariant holds regardless
 * of which endpoint an agent happens to call first. Idempotent: a no-op once
 * any row exists.
 */
export function ensureDefaultViewSeeded(ctx: TenantContext): void {
  const count = ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM dashboard_views`).one().n;
  if (count > 0) return;

  const now = new Date(ctx.clock.now()).toISOString();
  ctx.sql.exec(
    `INSERT INTO dashboard_views (id, name, is_default, rev, layout_json, layout_schema_version, edited_by, edited_by_note, updated_at, created_at)
     VALUES ('default', 'Default', 1, 1, ?, 1, 'system', NULL, ?, ?)`,
    JSON.stringify(starterDashboardLayout()),
    now,
    now,
  );
}

export function listDashboardViews(ctx: TenantContext): DashboardViewSummary[] {
  ensureDefaultViewSeeded(ctx);
  return ctx.sql
    .exec<ViewRow>(`SELECT * FROM dashboard_views ORDER BY is_default DESC, created_at ASC`)
    .toArray()
    .map(toSummary);
}

function getRow(ctx: TenantContext, id: string): ViewRow {
  const row = ctx.sql.exec<ViewRow>(`SELECT * FROM dashboard_views WHERE id = ?`, id).toArray()[0];
  if (!row) throw new NotFoundError(`dashboard view ${id} not found`);
  return row;
}

export function getDashboardView(ctx: TenantContext, id: string): DashboardViewDetail {
  ensureDefaultViewSeeded(ctx);
  return toDetail(getRow(ctx, id));
}

export function createDashboardView(
  ctx: TenantContext,
  input: { name: string; layout: DashboardLayout; note?: string },
  source: Provenance,
): DashboardViewDetail {
  ensureDefaultViewSeeded(ctx);

  const baseSlug = slugify(input.name);
  let id = baseSlug;
  let suffix = 2;
  while (ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM dashboard_views WHERE id = ?`, id).one().n > 0) {
    id = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const now = new Date(ctx.clock.now()).toISOString();
  // §19.2 create lifecycle: non-default unless it's the only view — but
  // ensureDefaultViewSeeded above guarantees a default already exists before
  // any create runs, so a fresh create is never "the only view" in practice.
  ctx.sql.exec(
    `INSERT INTO dashboard_views (id, name, is_default, rev, layout_json, layout_schema_version, edited_by, edited_by_note, updated_at, created_at)
     VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    JSON.stringify(input.layout),
    input.layout.schemaVersion,
    source,
    input.note ?? null,
    now,
    now,
  );
  return toDetail(getRow(ctx, id));
}

export function updateDashboardView(
  ctx: TenantContext,
  id: string,
  input: { rev: number; layout: DashboardLayout; name?: string; note?: string },
  source: Provenance,
): DashboardViewDetail {
  ensureDefaultViewSeeded(ctx);
  const existing = getRow(ctx, id);
  if (existing.rev !== input.rev) {
    throw new RevConflictError(
      `dashboard view ${id} was edited since rev ${input.rev} (current rev ${existing.rev}) — refetch and rebase your change`,
      existing.rev,
      JSON.parse(existing.layout_json),
    );
  }

  const now = new Date(ctx.clock.now()).toISOString();
  const nextRev = existing.rev + 1;
  // Rename: an optional field on the SAME full-layout-upsert update, same
  // rev-CAS semantics — not a separate endpoint/method. COALESCE keeps the
  // existing name when `name` is omitted (the id/slug is never touched).
  ctx.sql.exec(
    `UPDATE dashboard_views
     SET layout_json = ?, layout_schema_version = ?, name = COALESCE(?, name), rev = ?, edited_by = ?, edited_by_note = ?, updated_at = ?
     WHERE id = ?`,
    JSON.stringify(input.layout),
    input.layout.schemaVersion,
    input.name ?? null,
    nextRev,
    source,
    input.note ?? null,
    now,
    id,
  );
  return toDetail(getRow(ctx, id));
}

/** POST /dashboard/views/:id/default — atomically promotes `id` and demotes
 * whatever was previously the default (§19.2: "exactly one default enforced
 * transactionally"). Both UPDATEs run synchronously with no `await` between
 * them, so the DO's input gate can't interleave a concurrent call between
 * the demote and the promote. */
export function promoteDashboardViewDefault(ctx: TenantContext, id: string, source: Provenance): DashboardViewSummary[] {
  ensureDefaultViewSeeded(ctx);
  getRow(ctx, id); // 404s if missing

  const now = new Date(ctx.clock.now()).toISOString();
  ctx.sql.exec(`UPDATE dashboard_views SET is_default = 0 WHERE is_default = 1`);
  ctx.sql.exec(
    `UPDATE dashboard_views SET is_default = 1, edited_by = ?, updated_at = ? WHERE id = ?`,
    source,
    now,
    id,
  );
  return listDashboardViews(ctx);
}

export function deleteDashboardView(ctx: TenantContext, id: string): { deleted: true } {
  ensureDefaultViewSeeded(ctx);
  const row = getRow(ctx, id);
  if (row.is_default === 1) {
    throw new ValidationError(`cannot delete the default view (${id}) — promote another view to default first`);
  }
  const total = ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM dashboard_views`).one().n;
  if (total <= 1) {
    throw new ValidationError(`cannot delete the last remaining dashboard view (${id})`);
  }
  ctx.sql.exec(`DELETE FROM dashboard_views WHERE id = ?`, id);
  return { deleted: true };
}
