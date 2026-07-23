// D1 storage for the SDN list — shadow-swap build (write a complete NEW
// version, verify it, THEN flip the active pointer) so a corrupt/partial fetch
// never degrades the currently-active list (design ga-gates-design-2026-07-22.md
// §G1a, F5 fail-loud convention). Read side (getActiveSdnEntries) is what
// screening.ts's matcher queries at checkout/brand-change time.

import type { Env } from "../env.js";
import type { ParsedSdnEntry } from "./sdn-parse.js";

// Rows per multi-row INSERT — bounded well under SQLite's ~999 bind-param
// ceiling (6 columns * 100 rows = 600 params) while still batching (design
// line 47's "parse+upsert must be batched to stay inside the cron CPU
// budget" — this is the batching; see sdn-refresh.ts for the CPU-budget note).
const INSERT_BATCH_SIZE = 100;

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
    for (let i = 0; i < params.entries.length; i += INSERT_BATCH_SIZE) {
      const chunk = params.entries.slice(i, i + INSERT_BATCH_SIZE);
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      const values: unknown[] = [];
      for (const entry of chunk) {
        values.push(params.listVersion, entry.uid, entry.nameNormalized, JSON.stringify(entry.tokens), entry.entityType, entry.program);
      }
      await env.DB.prepare(
        `INSERT INTO sdn_entries (list_version, uid, name_normalized, tokens_json, entity_type, program) VALUES ${placeholders}`,
      )
        .bind(...values)
        .run();
    }
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
