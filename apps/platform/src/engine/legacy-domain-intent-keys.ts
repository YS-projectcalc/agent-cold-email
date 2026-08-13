// ONE-SHOT, DATED 2026-08-13 — reconciliation of the `domain_intents` rows
// stranded when the domain buy-intent key changed derivation (ticket
// sup_3ca260e4; ROADMAP.md `## Open`, the 2026-08-13 P0 entry).
//
// WHAT HAPPENED. `85f48af` moved the key from the inline
// `${setupKey ?? `tenant:${tenantId}`}#${ordinal}` to `domainIntentKey`'s
// `tenant:${tenantId}#${ordinal}` and shipped no backfill. The UNKEYED old form
// is byte-identical to the new one, so only calls that supplied an
// `Idempotency-Key` orphaned — and the live customer's did. His committed
// intent sits at `apd-setup-a-2mbx#0` (pinned verbatim in
// docs/adversarial/incident-hotfix-gate-2026-08-05.md), which the new
// derivation never reads, so `planProvisioning` sees ordinal 0 as unsatisfied
// and mints a fresh lookalike. `findAdoptableDomain` cannot rescue the paid
// domain either: it excludes anything with a live `domains` row. The domain is
// simultaneously too owned to adopt and not committed enough to resume, and
// every retry buys another one.
//
// WHY A REBIND AND NOT A FALLBACK READ. A permanent "also try the old shape"
// branch in the read path is a patch on a patch (CLAUDE.md rule f) and it never
// terminates: every future derivation adds another branch, and the read path is
// on the money route. Rebinding the row moves the state to where the CURRENT
// code already looks, once, and then this file is deletable.
//
// WHY NO MARKER COLUMN. The clock migration next door stamps `clock_mode`
// because applying its delta twice CORRUPTS (a shift compounds). This
// operation is a fixed point, not a shift: once a row is rebound it matches the
// current derivation and is skipped by the classifier below, so "already done"
// is directly observable in the data. A marker would be a second source of
// truth about that, free to disagree with it.

import {
  domainIntentKey,
  domainIntentOrdinal,
  replacementDomainIntentKeyPrefix,
} from "./provision-intents.js";

/** One rebound row — ids and domain names only, safe to log. */
export interface LegacyDomainIntentRebind {
  from: string;
  to: string;
  domain: string;
  /** The ordinal the old key named, kept for the operator log when it differs from `to`'s. */
  originalOrdinal: number;
  ordinal: number;
}

/** The trailing `#<ordinal>` every old-derivation key carries — and the ordinal it named. */
const ORDINAL_SUFFIX = /#(0|[1-9][0-9]*)$/;

interface IntentRow {
  key: string;
  candidate_domain: string;
  status: string;
  [column: string]: SqlStorageValue;
}

/**
 * Rebinds this tenant's legacy-key domain intents onto the current derivation.
 * Call ONCE per DO construction, from TenantDO only; returns the rebinds it
 * made (empty on the overwhelmingly common no-op path).
 *
 * SPEND-NEUTRAL IN THE ONLY DIRECTION THAT MATTERS. A rebind can turn an
 * ordinal that would have been BOUGHT into one that RESUMES; it can never do
 * the reverse, because it only ever writes a key at an ordinal that held no
 * intent at all, and only for a domain the tenant demonstrably already owns.
 *
 * @param nowMs the tenant's own clock — `updated_at` on these rows is stamped
 *   by `ctx.clock` everywhere else (provision-intents.ts's markIntent), and a
 *   frozen-clock tenant's rows must not acquire one real timestamp among
 *   virtual ones.
 */
export function reconcileLegacyDomainIntentKeys(
  storage: DurableObjectStorage,
  tenantId: string,
  nowMs: number,
): LegacyDomainIntentRebind[] {
  const sql = storage.sql;
  const rows = sql
    .exec<IntentRow>(`SELECT key, candidate_domain, status FROM domain_intents WHERE tenant_id = ?`, tenantId)
    .toArray();

  // Ordinals already spoken for, and the domains a current-derivation COMMITTED
  // intent already resolves. Both are exclusion sets for the rebinds below: an
  // ordinal may hold at most one intent (it is the PRIMARY KEY), and a live
  // domain may back at most one ordinal — two ordinals resolving to one domain
  // would have `planProvisioning` count one resource as satisfying two slots.
  const occupied = new Set<number>();
  const claimedDomains = new Set<string>();
  const replacePrefix = replacementDomainIntentKeyPrefix(tenantId);
  const legacy: { key: string; domain: string; originalOrdinal: number }[] = [];

  for (const row of rows) {
    const ordinal = domainIntentOrdinal(tenantId, row.key);
    if (ordinal !== undefined) {
      occupied.add(ordinal);
      if (row.status === "committed") claimedDomains.add(row.candidate_domain);
      continue;
    }
    // NOT the current derivation — which is NOT the same as orphaned. The
    // burn-replacement path (engine/deliverability-actions.ts) is a live second
    // writer of this table under its own derivation; rebinding one of its rows
    // would orphan a working key and re-create this very defect on the
    // deliverability route.
    if (row.key.startsWith(replacePrefix)) continue;
    // Only a COMMITTED row is evidence of a resource. An 'intent'/'dangling'
    // legacy row says a buy MAY have happened, and there is no ordinal at which
    // that claim becomes safely resumable — resolving it means asking the
    // vendor, which is the adopt path's job, not a migration's.
    if (row.status !== "committed") continue;
    const match = ORDINAL_SUFFIX.exec(row.key);
    if (!match) continue; // every old-derivation key ended in `#<ordinal>`; this one is from neither shape
    legacy.push({ key: row.key, domain: row.candidate_domain, originalOrdinal: Number(match[1]) });
  }

  if (legacy.length === 0) return [];

  // Stable order: two orphans must land on the same ordinals on a retry after a
  // rolled-back attempt, so the assignment below can never depend on row order.
  legacy.sort((a, b) => a.originalOrdinal - b.originalOrdinal || (a.key < b.key ? -1 : 1));

  const rebinds: LegacyDomainIntentRebind[] = [];
  for (const row of legacy) {
    // The PROOF the orphan names a real resource: a live `domains` row. The
    // predicate is `liveDomainForIntent`'s (engine/provisioning.ts) verbatim,
    // deliberately — a rebind exists to make THAT reader resolve the row, so a
    // looser one here would rebind rows it still cannot resolve, and a tighter
    // one would leave resumable resources stranded.
    const live = sql
      .exec<{ id: string }>(
        `SELECT id FROM domains WHERE tenant_id = ? AND domain = ? AND status != 'released' LIMIT 1`,
        tenantId,
        row.domain,
      )
      .toArray()[0];
    if (!live) continue;
    if (claimedDomains.has(row.domain)) continue;

    // COLLISION (the live customer's exact shape): his ordinal 0 already holds
    // the 2026-08-12 intent written at the CURRENT key, so the orphan cannot go
    // home. Overwriting would discard a committed intent for one domain to
    // record another — losing a paid resource to recover a paid resource. It
    // goes to the first free ordinal at or above the highest one in use
    // instead, which makes it additional CAPACITY: a call asking for more
    // domains resumes it, and no call ever buys it twice. Ordinals below the
    // max are left alone — a gap there is a slot an in-flight call may be
    // about to fill.
    const ordinal = occupied.has(row.originalOrdinal) ? firstFreeAtOrAboveMax(occupied) : row.originalOrdinal;
    occupied.add(ordinal);
    claimedDomains.add(row.domain);
    rebinds.push({
      from: row.key,
      to: domainIntentKey(tenantId, ordinal),
      domain: row.domain,
      originalOrdinal: row.originalOrdinal,
      ordinal,
    });
  }

  if (rebinds.length === 0) return [];

  // All or nothing. A half-applied set would leave the tenant with some
  // ordinals rebound against an `occupied` set computed from the other half, so
  // a retry would assign from a different starting state.
  //
  // The reads above are not re-taken inside: this whole function runs in the
  // DO's constructor, one synchronous input-gate turn with no await anywhere,
  // so no concurrent RPC can write `domain_intents` between the scan and this
  // transaction — the same guarantee `withRequestIdempotency`'s
  // claim-before-the-first-await relies on (engine/idempotency.ts).
  storage.transactionSync(() => {
    for (const rebind of rebinds) {
      sql.exec(
        `UPDATE domain_intents SET key = ?, updated_at = ? WHERE key = ? AND tenant_id = ?`,
        rebind.to,
        nowMs,
        rebind.from,
        tenantId,
      );
    }
  });

  return rebinds;
}

/** The lowest ordinal at or above the highest one in use that nothing holds. */
function firstFreeAtOrAboveMax(occupied: Set<number>): number {
  let ordinal = Math.max(...occupied);
  while (occupied.has(ordinal)) ordinal++;
  return ordinal;
}
