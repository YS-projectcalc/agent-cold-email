-- Scale audit S1 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — the
-- cron sweep's rotation cursor.
--
-- The sweep used to fan every per-tenant leg out over the WHOLE tenants_index
-- on every 5-minute tick: a measured ~8 DO RPCs per tenant with no cap, so
-- above roughly 122 tenants the invocation's subrequest budget ran out
-- mid-sweep and every remaining leg — including the dead-man heartbeat that is
-- deliberately LAST because it means "this tick ran to completion" — threw and
-- was swallowed. The platform then paged the founder that the scheduler was
-- dead while what had actually stopped was automatic sending.
--
-- This row is where the bounded slice resumes (src/admin/tenant-slice.ts):
-- keyset paging over `id`, so the read itself is bounded and no tenant is
-- skipped or double-swept when tenants are inserted mid-rotation. NULL means
-- "start the next rotation from the beginning". id is pinned to 1 like
-- watchtower_cursor and demo_run_state.
CREATE TABLE IF NOT EXISTS sweep_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- The last tenant id EVERY fan-out leg finished this tick. NULL = restart.
  last_tenant_id TEXT,
  updated_at INTEGER NOT NULL
);
