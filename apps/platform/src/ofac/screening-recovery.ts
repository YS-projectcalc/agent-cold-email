// N-OF-1 fix (adversary OFAC build review, 2026-07-23) — recovers a tenant
// that was held fail-CLOSED ONLY because no SDN list had loaded yet at
// screening time (`screening_list_version === LIST_UNAVAILABLE_VERSION`,
// screening.ts). Once a real list is available, re-screening these tenants
// for real either clears them (the common case: they were never actually a
// match, just caught in the post-deploy/pre-first-refresh gap) or upgrades
// the sentinel hold into a genuine, list-versioned verdict — either way it
// replaces "we don't know yet" with a real answer, without requiring a manual
// admin clear for every tenant caught in that window.
//
// Called from the SAME 5-min ops-sweep cron as the list refresh itself
// (../scheduled.ts). It HAS a fan-out — one DO RPC plus, on the common clear
// outcome, one D1 write per sentinel-held tenant — and that fan-out is part of
// the tick's subrequest budget, not free (B1, docs/adversarial/
// wave-b1-scale-monitoring-gate-2026-08-20.md). Its batch size and its cost are
// declared in admin/sweep-budget.ts alongside every other term the tenant slice
// is derived from, and it runs through `sweepTenants` so the tick's shared
// fan-out deadline stops it just like every sibling leg.
import { listPendingScreeningReviews, resolveScreeningReview } from "../admin/db.js";
import { SCREENING_RECOVERY_BATCH } from "../admin/sweep-budget.js";
import { sweepDeadlineOf, sweepTenants, type SweepScope } from "../admin/tenant-slice.js";
import type { Env } from "../env.js";
import { LIST_UNAVAILABLE_VERSION } from "./screening.js";
import { getActiveSdnListVersion } from "./sdn-list.js";

export interface SdnListUnavailableRecoverySummary {
  /** How many tenants were still stuck on the sentinel this tick. */
  attempted: number;
  /** How many of those were re-screened (0 whenever no list is loaded yet). */
  rescreened: number;
  errors: number;
  /** Sentinel-held tenants left for a later tick by the shared fan-out
   * deadline. Capacity, never a failure — the population is self-draining and
   * this leg runs every 5 minutes. */
  deferred: number;
}

export async function rescreenListUnavailableReviews(env: Env, scope: SweepScope = {}): Promise<SdnListUnavailableRecoverySummary> {
  const listVersion = await getActiveSdnListVersion(env);
  if (!listVersion) return { attempted: 0, rescreened: 0, errors: 0, deferred: 0 }; // still no list — nothing recoverable yet

  // NARROWED IN SQL, not in JS (S8, docs/adversarial/scale-readiness-audit-
  // 2026-08-17.md). This read is now bounded, and a bound spent on rows this
  // sweep immediately discards is a bound that silently shortens its REACH: a
  // tenant held on the sentinel behind a queue of real hits would never be
  // re-screened, with no error and nothing to alert on. Asking for the sentinel
  // rows themselves keeps the whole batch usable.
  //
  // SCREENING_RECOVERY_BATCH is a DRAIN RATE, not a working page: the sentinel
  // population is only tenants caught in the pre-first-refresh gap, it is
  // self-draining (a re-screen either clears the row or re-versions it, and
  // either way the row leaves this narrowed query), and this runs every 5
  // minutes — so a backlog drains across ticks at a cost the slice arithmetic
  // has actually subtracted.
  const stuck = await listPendingScreeningReviews(env, {
    listVersion: LIST_UNAVAILABLE_VERSION,
    limit: SCREENING_RECOVERY_BATCH,
  });

  let rescreened = 0;
  // Through the shared primitive, with the tick's DEADLINE but NOT its rotation
  // accumulator: this leg iterates sentinel-held reviews, not the tenant slice,
  // so how many it visited says nothing about how far the tenant rotation got.
  // `sweepDeadlineOf` strips the accumulator by construction.
  const swept = await sweepTenants(
    stuck.map((review) => review.tenantId),
    sweepDeadlineOf(scope.fanout),
    async (tenantId) => {
      // `env.TENANT` is already typed `DurableObjectNamespace<TenantDO>`
      // (env.ts) — the stub carries TenantDO's real RPC surface, including
      // `rescreenIfListUnavailable` (tenant-do.ts), no cast needed.
      const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
      const result = await stub.rescreenIfListUnavailable();
      if (result.rescreened) rescreened++;
      // A genuinely clean re-screen resolves the STALE sentinel review row —
      // screenTenant's own 'clear' branch never touches screening_reviews
      // (only a hit does), so without this the queue would keep showing a
      // 'pending' hold for a tenant whose tenant_profile has already moved to
      // 'clear' and activated. A re-screen that instead finds a REAL match
      // already overwrites this SAME row via screenTenant's normal hit path
      // (upsertScreeningReview's ON CONFLICT), so no separate handling is
      // needed there.
      if (result.status === "clear") {
        await resolveScreeningReview(env, tenantId, "cleared", "system-recovery", Date.now());
      }
    },
    (tenantId, err) => console.error(`SDN list-unavailable recovery failed for tenant ${tenantId}`, err),
  );

  return { attempted: swept.visited, rescreened, errors: swept.errors, deferred: swept.deferred };
}
