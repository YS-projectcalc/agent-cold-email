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
// (../scheduled.ts) — cheap no-op (one D1 read, no fan-out) whenever no list
// is loaded yet or no tenant is currently stuck on the sentinel.
import { listPendingScreeningReviews, resolveScreeningReview } from "../admin/db.js";
import type { Env } from "../env.js";
import { LIST_UNAVAILABLE_VERSION } from "./screening.js";
import { getActiveSdnListVersion } from "./sdn-list.js";

export interface SdnListUnavailableRecoverySummary {
  /** How many tenants were still stuck on the sentinel this tick. */
  attempted: number;
  /** How many of those were re-screened (0 whenever no list is loaded yet). */
  rescreened: number;
  errors: number;
}

export async function rescreenListUnavailableReviews(env: Env): Promise<SdnListUnavailableRecoverySummary> {
  const listVersion = await getActiveSdnListVersion(env);
  if (!listVersion) return { attempted: 0, rescreened: 0, errors: 0 }; // still no list — nothing recoverable yet

  const pending = await listPendingScreeningReviews(env);
  const stuck = pending.filter((r) => r.listVersion === LIST_UNAVAILABLE_VERSION);

  let rescreened = 0;
  let errors = 0;
  for (const review of stuck) {
    try {
      // `env.TENANT` is already typed `DurableObjectNamespace<TenantDO>`
      // (env.ts) — the stub carries TenantDO's real RPC surface, including
      // `rescreenIfListUnavailable` (tenant-do.ts), no cast needed.
      const stub = env.TENANT.get(env.TENANT.idFromName(review.tenantId));
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
        await resolveScreeningReview(env, review.tenantId, "cleared", "system-recovery", Date.now());
      }
    } catch (err) {
      errors++;
      console.error(`SDN list-unavailable recovery failed for tenant ${review.tenantId}`, err);
    }
  }
  return { attempted: stuck.length, rescreened, errors };
}
