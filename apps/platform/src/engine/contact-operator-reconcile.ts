// msgchannel Inc5 fast-follow — isolate-death reconcile sweep (ROADMAP.md
// 2026-08-11 "Inc5 reconcile-sweep for isolate-death"). Closes the window
// contact-operator.ts's in-request compensation cannot reach: the isolate
// dies between the admission commit (contact-operator-guard.ts's
// admitContactOperatorCall, durable in DO storage) and the D1
// support_tickets write it authorizes, so no code is left running to call
// revokeAdmission. Wired as a sibling of pruneTenantMessages inside
// TenantDO.deliverabilitySweep() — same per-tenant DO-scoped bounded
// cleanup shape, same existing cron leg, same error isolation
// (admin/ops-sweep.ts's runDeliverabilitySweepAllTenants already catches a
// per-tenant throw).
//
// Deliberately NOT the concurrent-twin residual (docs/adversarial/
// msgchannel-inc5-gate-2026-08-11.md:563-568, round 3's correction to its
// own ruling): by the time a row is old enough for THIS sweep to touch, the
// in-request compensation has already run for that case and left zero rows
// behind (measured R3-C3/C5). This sweep only ever finds a row an
// in-request compensation never got the chance to touch — an isolate that
// is gone, not a request that is still running.

import type { TenantContext } from "../tenant-context.js";
import { revokeAdmission } from "./contact-operator-guard.js";

/**
 * How old an agent_contact_log admission must be before this sweep will
 * touch it. Sized the same way this codebase's other two "presumed dead"
 * reapers are: engine/idempotency.ts's
 * REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS (10 min, sized against
 * setup_infrastructure's own worst case — up to ~156 sequential real vendor
 * calls) and engine/spend-ceiling.ts's RESERVE_REAP_TTL_MS (15 min,
 * explicitly modeled on the idempotency value with margin). contactOperator's
 * own compensable window (contact-operator.ts:82-110) is far shorter than
 * either precedent's worst case: exactly one D1 read
 * (lookupTenantContactEmail) then one D1 write (insertSupportTicket), no
 * vendor round trips, no loop — normally low milliseconds, pathologically a
 * handful of seconds under D1 contention. Reusing spend-ceiling's own
 * 15-minute value, rather than inventing a third constant for the same
 * class of guarantee, keeps ONE "presumed-dead" cutoff convention across
 * this cron's two reapers, and it carries far more relative headroom here
 * than it does for spend-ceiling's own up-to-156-vendor-call chain.
 */
export const ISOLATE_DEATH_REAP_TTL_MS = 15 * 60 * 1000;

export interface ContactOperatorReconcileResult {
  reaped: number;
}

// Rows per candidate-ticket-lookup statement. Gate BLOCKING-1 (docs/
// adversarial/inc5-reconcile-sweep-gate-2026-08-11.md): the original code
// built ONE `IN (...)` statement with `1 + candidates.length` bound
// parameters — no chunk, no LIMIT — and D1's REAL per-statement ceiling is
// 100 bound parameters (ofac/sdn-list.ts:13-19, empirically confirmed: 101
// throws, 100 succeeds). The guard's own header documents ~120 rows as this
// table's steady-state maximum at 5 admissions/hour × 24h retention — above
// the ceiling, so the sweep died exactly when the log was largest, which is
// exactly the storm state it exists to clean up after, and took the whole
// tenant's deliverabilitySweep() down with it (a false platform-health page
// after 3 consecutive cycles, watchtower-grading.ts's LEG_ALERT_AFTER_SWEEPS).
// 99 ids + 1 for tenant_id stays AT the measured ceiling; chunked statements
// are queued into one env.DB.batch() call (the sdn-list.ts INSERT_BATCH_SIZE
// precedent) so a large backlog still costs one network round trip, not one
// per chunk.
const CANDIDATE_CHUNK_SIZE = 99;

type CandidateRow = { id: string; emailed_at: number | null };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Finds this tenant's agent_contact_log admissions older than
 * ISOLATE_DEATH_REAP_TTL_MS with no matching D1 support_tickets row, and
 * reconciles each with revokeAdmission's own semantics (delete the orphan +
 * release any email claim it made) — so it (a) stops leaking a rate-cap
 * slot and (b) can never answer a later identical (body, urgency) call with
 * a phantom dedup hit.
 *
 * Held-claim reconstruction: an orphan whose own emailed_at is set had
 * claimed the tenant's email slot for itself AND, atomically in the SAME
 * admission call, for every other row admitContactOperatorCall stamped
 * alongside it (contact-operator-guard.ts:150-164) — the identical `now`
 * value. That value is the only correlation this schema persists (no batch
 * id column — adding one is a schema change, out of this sweep's scope),
 * so rows sharing it, excluding the orphan's own id, are exactly its held
 * batch. The match is scoped to the candidate set read in THIS call only.
 */
export async function reconcileOrphanedAdmissions(ctx: TenantContext, nowMs: number): Promise<ContactOperatorReconcileResult> {
  const cutoff = nowMs - ISOLATE_DEATH_REAP_TTL_MS;
  const candidates = ctx.sql
    .exec<CandidateRow>(`SELECT id, emailed_at FROM agent_contact_log WHERE tenant_id = ? AND created_at < ?`, ctx.tenantId, cutoff)
    .toArray();
  if (candidates.length === 0) return { reaped: 0 };

  const statements = chunk(candidates, CANDIDATE_CHUNK_SIZE).map((c) => {
    const placeholders = c.map(() => "?").join(", ");
    return ctx.env.DB.prepare(`SELECT id FROM support_tickets WHERE tenant_id = ? AND id IN (${placeholders})`).bind(
      ctx.tenantId,
      ...c.map((row) => row.id),
    );
  });
  const results = await ctx.env.DB.batch<{ id: string }>(statements);
  const ticketedIds = new Set(results.flatMap((r) => r.results.map((row) => row.id)));

  const orphans = candidates.filter((c) => !ticketedIds.has(c.id));
  for (const orphan of orphans) {
    const heldIds =
      orphan.emailed_at === null ? [] : candidates.filter((c) => c.id !== orphan.id && c.emailed_at === orphan.emailed_at).map((c) => c.id);
    revokeAdmission(ctx, orphan.id, heldIds);
  }
  return { reaped: orphans.length };
}
