import type { Provenance } from "@coldstart/shared";
import { NotFoundError } from "@coldstart/shared";
import type { TenantContext } from "../tenant-context.js";
import { lookupThreadRef } from "./threads.js";

export interface ThreadLabelResult {
  threadId: string;
  label: string | null;
  source: Provenance | null;
}

/**
 * POST /threads/:id/label — SPEC.md §19.2/§19.4. `label: null` clears the
 * label (DELETE the row); a non-null label upserts it, stamping `source`
 * server-derived from transport (never a client-supplied actor claim, same
 * discipline as dashboard_views.edited_by). Free-form: the canonical set
 * (`@coldstart/shared` CANONICAL_THREAD_LABELS) is a UI recommendation, not a
 * server-enforced enum — a customer's own agent may use its own taxonomy.
 */
export function setThreadLabel(
  ctx: TenantContext,
  threadId: string,
  label: string | null,
  source: Provenance,
): ThreadLabelResult {
  if (!lookupThreadRef(ctx, threadId)) throw new NotFoundError(`thread ${threadId} not found`);

  if (label === null) {
    ctx.sql.exec(`DELETE FROM thread_labels WHERE thread_id = ?`, threadId);
    return { threadId, label: null, source: null };
  }

  const now = new Date(ctx.clock.now()).toISOString();
  ctx.sql.exec(
    `INSERT INTO thread_labels (thread_id, label, source, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (thread_id) DO UPDATE SET label = excluded.label, source = excluded.source, updated_at = excluded.updated_at`,
    threadId,
    label,
    source,
    now,
  );
  return { threadId, label, source };
}
