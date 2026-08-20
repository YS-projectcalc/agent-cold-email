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
  /** Adversary finding 2 (docs/adversarial/sdn-relay-review-2026-07-24.md) —
   * a content hash of the raw feed text, written ONLY by the droplet-relay
   * ingest (sdn-ingest.ts's monotonicity guard). The direct-fetch refresh
   * (sdn-refresh.ts) leaves this `null` (no attacker-controlled-replay threat
   * model on that path). */
  contentHash: string | null;
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
  content_hash: string | null;
}

export async function getSdnListMeta(env: Env): Promise<SdnListMeta | null> {
  const row = await env.DB.prepare(
    `SELECT active_version, published_date, fetched_at, entry_count, content_hash FROM sdn_list_meta WHERE id = 1`,
  ).first<SdnListMetaD1Row>();
  if (!row) return null;
  return {
    activeVersion: row.active_version,
    publishedDate: row.published_date,
    fetchedAt: row.fetched_at,
    entryCount: row.entry_count,
    contentHash: row.content_hash,
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

/**
 * Every entry under one list version. Kept as the FULL-SCAN reference read (the
 * oracle S9's narrowing is tested against, and the ingest-side verification
 * read); the screening path uses `getSdnEntriesForLookup` below.
 */
export async function getActiveSdnEntries(env: Env, listVersion: string): Promise<SdnEntryRow[]> {
  const result = await env.DB.prepare(
    `SELECT uid, name_normalized, tokens_json, entity_type, program FROM sdn_entries WHERE list_version = ?`,
  )
    .bind(listVersion)
    .all<SdnEntryD1Row>();
  return result.results.map(toSdnEntryRow);
}

function toSdnEntryRow(r: SdnEntryD1Row): SdnEntryRow {
  return {
    uid: r.uid,
    nameNormalized: r.name_normalized,
    tokens: JSON.parse(r.tokens_json) as string[],
    entityType: r.entity_type,
    program: r.program,
  };
}

const SELECT_ENTRY_COLUMNS = `SELECT uid, name_normalized, tokens_json, entity_type, program FROM sdn_entries`;

// D1's REAL per-statement bound-parameter ceiling is 100, not SQLite's ~999
// (empirically confirmed — see INSERT_BATCH_SIZE above). A first-token range
// costs TWO params, plus one for list_version, so 40 tokens/statement (81
// params) stays comfortably inside it.
const LOOKUP_TOKENS_PER_STATEMENT = 40;

/**
 * The rows that could match these candidates — S9's index-assisted narrowing
 * (docs/adversarial/scale-readiness-audit-2026-08-17.md). Replaces pulling all
 * ~17k rows (and JSON.parse-ing all ~17k `tokens_json` blobs) into Worker CPU on
 * every signup.
 *
 * The keys come from `sdnLookupKeys`, which derives them FROM the match rules —
 * see that function for why the derivation lives there and why it is deliberately
 * a superset. `matchAgainstSdn` still decides; this only decides what to read.
 *
 * The first-token selection is expressed as an index RANGE rather than a `LIKE`
 * prefix: names are normalized to `[a-z0-9 ]` only, so every multi-token name
 * beginning with token `t` sorts inside [`t `, `t!`) — ' ' (0x20) is below every
 * character a token can contain, and '!' (0x21) is the next code point up. That
 * reads straight off idx_sdn_entries_version_name, and it cannot be turned into
 * a pattern by a candidate carrying `%` or `_` (a live concern: the candidate is
 * tenant-supplied brand/billing text).
 */
export async function getSdnEntriesForLookup(
  env: Env,
  listVersion: string,
  keys: { exactNames: string[]; firstTokens: string[] },
): Promise<SdnEntryRow[]> {
  const statements: D1PreparedStatement[] = [];

  if (keys.exactNames.length > 0) {
    const placeholders = keys.exactNames.map(() => "?").join(", ");
    statements.push(
      env.DB.prepare(`${SELECT_ENTRY_COLUMNS} WHERE list_version = ? AND name_normalized IN (${placeholders})`).bind(
        listVersion,
        ...keys.exactNames,
      ),
    );
  }

  for (let i = 0; i < keys.firstTokens.length; i += LOOKUP_TOKENS_PER_STATEMENT) {
    const chunk = keys.firstTokens.slice(i, i + LOOKUP_TOKENS_PER_STATEMENT);
    const ranges = chunk.map(() => "(name_normalized >= ? AND name_normalized < ?)").join(" OR ");
    const bounds: string[] = [];
    for (const token of chunk) bounds.push(`${token} `, `${token}!`);
    statements.push(env.DB.prepare(`${SELECT_ENTRY_COLUMNS} WHERE list_version = ? AND (${ranges})`).bind(listVersion, ...bounds));
  }

  if (statements.length === 0) return [];

  // One round trip for every chunk, same as the ingest side.
  const batched = await env.DB.batch<SdnEntryD1Row>(statements);
  // The exact and range reads legitimately overlap (a single-token candidate
  // that is also some name's first token), so dedupe on the list's own key.
  const byUid = new Map<string, SdnEntryRow>();
  for (const result of batched) {
    for (const row of result.results) if (!byUid.has(row.uid)) byUid.set(row.uid, toSdnEntryRow(row));
  }
  return [...byUid.values()];
}

/**
 * Does this list version still have ANY rows?
 *
 * Its own question, because the narrowed read above made "zero rows" ambiguous.
 * `screenTenant`'s TOCTOU guard fails CLOSED on an empty result — a concurrent
 * `swapInSdnList` can delete the version this screen already read the pointer
 * for, and clearing a tenant off a list that vanished mid-screen is the wrong
 * direction for a sanctions gate. Under the full scan, empty could only mean
 * that. Under a narrowed read, empty is the NORMAL clean-tenant answer, so the
 * guard has to ask about the list rather than infer from its own filter.
 */
export async function sdnVersionHasEntries(env: Env, listVersion: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 as present FROM sdn_entries WHERE list_version = ? LIMIT 1`)
    .bind(listVersion)
    .first<{ present: number }>();
  return row !== null;
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
  params: { listVersion: string; entries: ParsedSdnEntry[]; publishedDate: string; fetchedAt: number; contentHash?: string },
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
    `INSERT INTO sdn_list_meta (id, active_version, published_date, fetched_at, entry_count, content_hash)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       active_version = excluded.active_version,
       published_date = excluded.published_date,
       fetched_at = excluded.fetched_at,
       entry_count = excluded.entry_count,
       content_hash = excluded.content_hash`,
  )
    .bind(params.listVersion, params.publishedDate, params.fetchedAt, params.entries.length, params.contentHash ?? null)
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

/**
 * Advances ONLY `fetched_at` — never `active_version`/`content_hash`/
 * `entry_count`/`published_date`, and never touches `sdn_entries`. This is
 * NOT a shadow-swap (no new version, no rows written), so it is deliberately
 * a separate narrow updater rather than a `swapInSdnList` call.
 *
 * Used by the droplet-relay ingest's "unchanged" outcome (sdn-ingest.ts,
 * fix A, docs/adversarial/sdn-unchanged-fix-review-2026-07-27.md): a
 * byte-identical relay push means the droplet genuinely reached Treasury and
 * confirmed the active list IS current, which satisfies exactly the "did we
 * last reach Treasury recently" freshness `maybeRefreshSdnList`'s once-daily
 * guard keys on (sdn-refresh.ts) — advancing `fetched_at` here quiets that
 * guard's 5-min direct-fetch retry loop for another 24h. No-op if no active
 * list exists yet (nothing to touch).
 */
export async function touchSdnListFreshness(env: Env, nowMs: number): Promise<void> {
  await env.DB.prepare(`UPDATE sdn_list_meta SET fetched_at = ? WHERE id = 1`).bind(nowMs).run();
}
