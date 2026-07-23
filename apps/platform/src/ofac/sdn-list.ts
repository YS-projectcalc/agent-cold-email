// D1 storage for the SDN list — shadow-swap build (write a complete NEW
// version, verify it, THEN flip the active pointer) so a corrupt/partial fetch
// never degrades the currently-active list (design ga-gates-design-2026-07-22.md
// §G1a, F5 fail-loud convention). Read side (getActiveSdnEntries) is what
// screening.ts's matcher queries at checkout/brand-change time.

import type { Env } from "../env.js";
import type { ParsedSdnEntry } from "./sdn-parse.js";

// Rows per multi-row INSERT. CORRECTED 2026-07-24 (droplet-relay build,
// first code path to ever exercise this at realistic ~5k+ entry scale): the
// original comment assumed vanilla SQLite's ~999 bind-param ceiling, but
// Cloudflare D1's REAL per-statement limit is 100 bound parameters —
// empirically confirmed (101 params throws `D1_ERROR: too many SQL variables`,
// 100 succeeds). 6 columns * 100 rows = 600 params silently could never have
// worked at any real scale; it just never got exercised (every existing test
// fixture is 4-5 rows, and the real ~17k Treasury feed has never successfully
// reached swapInSdnList — Workers fetch to Treasury 525s, see sdn-refresh.ts).
// floor(100 / 6 columns) = 16 rows/statement is the max that stays under the
// real ceiling. To preserve the ORIGINAL design intent (design line 47:
// "batched to stay inside the cron CPU budget" — i.e. few network round
// trips, not many small statements), every 16-row chunk's INSERT is queued
// into ONE `env.DB.batch()` call below rather than awaited one at a time —
// batch() sends every statement in a single round trip while each statement
// independently still respects the 100-param ceiling.
const INSERT_BATCH_SIZE = 16;

export interface SdnListMeta {
  activeVersion: string | null;
  publishedDate: string | null;
  fetchedAt: number | null;
  entryCount: number;
}

export interface SdnEntryRow {
  uid: string;
  nameNormalized: string;
  tokens: string[];
  entityType: string | null;
  program: string | null;
}

interface SdnListMetaD1Row {
  active_version: string | null;
  published_date: string | null;
  fetched_at: number | null;
  entry_count: number;
}

export async function getSdnListMeta(env: Env): Promise<SdnListMeta | null> {
  const row = await env.DB.prepare(
    `SELECT active_version, published_date, fetched_at, entry_count FROM sdn_list_meta WHERE id = 1`,
  ).first<SdnListMetaD1Row>();
  if (!row) return null;
  return {
    activeVersion: row.active_version,
    publishedDate: row.published_date,
    fetchedAt: row.fetched_at,
    entryCount: row.entry_count,
  };
}

/** Convenience read for the matcher (screening.ts) — `null` means no list has
 * ever been successfully built yet (fresh env / pre-first-refresh). */
export async function getActiveSdnListVersion(env: Env): Promise<string | null> {
  const meta = await getSdnListMeta(env);
  return meta?.activeVersion ?? null;
}

interface SdnEntryD1Row {
  uid: string;
  name_normalized: string;
  tokens_json: string;
  entity_type: string | null;
  program: string | null;
}

/** Every entry under one list version — read by the matcher at screen time
 * (design's per-tenant screen is infrequent — checkout/brand-change, not a
 * hot send-path query — so an unindexed full-version scan is acceptable at
 * pilot scale; see the arming-time note in the honesty statement for the
 * scale caveat). */
export async function getActiveSdnEntries(env: Env, listVersion: string): Promise<SdnEntryRow[]> {
  const result = await env.DB.prepare(
    `SELECT uid, name_normalized, tokens_json, entity_type, program FROM sdn_entries WHERE list_version = ?`,
  )
    .bind(listVersion)
    .all<SdnEntryD1Row>();
  return result.results.map((r) => ({
    uid: r.uid,
    nameNormalized: r.name_normalized,
    tokens: JSON.parse(r.tokens_json) as string[],
    entityType: r.entity_type,
    program: r.program,
  }));
}

/**
 * Builds a COMPLETE new list version's rows, then atomically flips
 * `sdn_list_meta.active_version` to it — the shadow-swap. If ANY step here
 * throws (a D1 write failure mid-batch), the partial rows under `listVersion`
 * are best-effort deleted and the error is rethrown WITHOUT ever touching the
 * active pointer — the caller (sdn-refresh.ts) keeps the prior good list and
 * alerts. Old-version cleanup (deleting rows for every version that is no
 * longer active) runs AFTER the pointer flip succeeds, so a cleanup failure
 * can never affect correctness (the matcher only ever reads the active
 * version).
 */
export async function swapInSdnList(
  env: Env,
  params: { listVersion: string; entries: ParsedSdnEntry[]; publishedDate: string; fetchedAt: number },
): Promise<void> {
  try {
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < params.entries.length; i += INSERT_BATCH_SIZE) {
      const chunk = params.entries.slice(i, i + INSERT_BATCH_SIZE);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const values: unknown[] = [];
      for (const entry of chunk) {
        values.push(params.listVersion, entry.uid, entry.nameNormalized, JSON.stringify(entry.tokens), entry.entityType, entry.program);
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO sdn_entries (list_version, uid, name_normalized, tokens_json, entity_type, program) VALUES ${placeholders}`,
        ).bind(...values),
      );
    }
    // One network round trip for every chunked INSERT (D1's `.batch()`) —
    // preserves the ORIGINAL design intent (stay inside the cron CPU budget)
    // even though each individual statement is now capped at 16 rows (see
    // INSERT_BATCH_SIZE's comment above). Empirically verified working up to
    // 1100+ statements in one batch() call, comfortably above the ~1063 a
    // real ~17k-entry list needs at 16 rows/statement.
    if (statements.length > 0) await env.DB.batch(statements);
  } catch (err) {
    // Best-effort cleanup of the orphaned partial version — never touches the
    // active pointer, so correctness does not depend on this succeeding.
    await env.DB.prepare(`DELETE FROM sdn_entries WHERE list_version = ?`).bind(params.listVersion).run().catch(() => {});
    throw err;
  }

  // Atomic flip — single UPDATE/UPSERT, the shadow-swap moment.
  await env.DB.prepare(
    `INSERT INTO sdn_list_meta (id, active_version, published_date, fetched_at, entry_count)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       active_version = excluded.active_version,
       published_date = excluded.published_date,
       fetched_at = excluded.fetched_at,
       entry_count = excluded.entry_count`,
  )
    .bind(params.listVersion, params.publishedDate, params.fetchedAt, params.entries.length)
    .run();

  // Cleanup old versions AFTER the swap — non-load-bearing (see doc comment).
  await env.DB.prepare(`DELETE FROM sdn_entries WHERE list_version != ?`).bind(params.listVersion).run().catch(() => {});
}

/** Just the refresh cursor (used by the once-daily guard, sdn-refresh.ts) —
 * separate from getSdnListMeta so the guard's staleness check reads cheaply
 * without needing the full meta shape every 5-minute sweep tick. */
export async function getSdnListFetchedAt(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT fetched_at FROM sdn_list_meta WHERE id = 1`).first<{ fetched_at: number | null }>();
  return row?.fetched_at ?? null;
}
