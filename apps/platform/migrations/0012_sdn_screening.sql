-- G1 (GA-gates design 2026-07-22, §G1a/§G1b) — OFAC SDN screening. Two
-- concerns, both control-plane/cross-tenant so they live in D1 like
-- tenants_index/watchtower_state, never inside a single TenantDO:
--   (1) the SDN list itself (sdn_entries/sdn_list_meta) — a platform-wide
--       reference dataset, not tenant data.
--   (2) the review queue (screening_reviews) — cross-tenant, admin-owned,
--       mirrors dunning_events/enforcement_actions (migrations/0002/0003).
-- Per-tenant VERDICT (screening_status/screening_list_version/screened_at)
-- lives on tenant_profile instead (TenantDO SQLite, schema.ts) — that part is
-- tenant-owned, not cross-tenant.

-- SHADOW-SWAP list storage (design line 47: "a partial/failed fetch never
-- leaves a half-populated list"). Every row is tagged with the list_version it
-- was built under; the matcher only ever reads rows for `sdn_list_meta.
-- active_version` (sdn-list.ts's getActiveSdnEntries). A refresh builds a
-- COMPLETE new version's rows first, verifies the count, and only THEN flips
-- active_version in one atomic UPDATE (sdn-refresh.ts) — so a corrupt/partial
-- fetch simply leaves an orphaned unreferenced version, never a half-swapped
-- active list. `id` is a surrogate key (OFAC's ent_num is not globally unique
-- across list versions in our storage since the same entry re-appears under
-- every new version tag).
CREATE TABLE IF NOT EXISTS sdn_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_version TEXT NOT NULL,
  uid TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  entity_type TEXT,
  program TEXT
);

CREATE INDEX IF NOT EXISTS idx_sdn_entries_version ON sdn_entries(list_version);

-- Single-row pointer + refresh cursor (mirrors watchtower_cursor/demo_run_state's
-- id=1 pinned-singleton pattern). `active_version` is the ONLY version the
-- matcher reads; `fetched_at` is the once-daily refresh guard's cursor
-- (sdn-refresh.ts: refresh only when now - fetched_at > 24h).
CREATE TABLE IF NOT EXISTS sdn_list_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_version TEXT,
  published_date TEXT,
  fetched_at INTEGER,
  entry_count INTEGER NOT NULL DEFAULT 0
);

-- Cross-tenant review queue (design line 63) — one row per tenant CURRENTLY OR
-- PREVIOUSLY in review (tenant_id is the PK: a re-hit on a re-screen, e.g. NB-1's
-- brand-change re-screen, REOPENS this row to 'pending' rather than appending a
-- second one, matching "one row per tenant in review" so a single query lists
-- every pending review). `matched_terms`/`screened_fields` are JSON so a human
-- reviewer sees exactly what matched and what was/wasn't checked (NB-3/NB-4).
-- `status`: 'pending' (awaiting the founder) | 'cleared' | 'rejected' (admin
-- decision, admin-screening route). `resolved_by` is a fixed literal ('admin')
-- since ADMIN_TOKEN is a single shared owner secret, not a per-admin identity
-- (mirrors enforcement_actions' own single-operator posture).
CREATE TABLE IF NOT EXISTS screening_reviews (
  tenant_id TEXT PRIMARY KEY,
  matched_terms TEXT NOT NULL,
  screened_fields TEXT NOT NULL,
  list_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_screening_reviews_status ON screening_reviews(status);
