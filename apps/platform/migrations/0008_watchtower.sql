-- Watchtower alert-state machine (D2 monitoring brief). The dedupe state that
-- makes a 5-minute cron cadence safe: the sweep alerts the founder on a health
-- CHANGE (healthy->unhealthy) with specifics, re-alerts on PERSISTENCE only
-- after a cooldown, sends a recovery email on unhealthy->healthy, and NEVER
-- storms. Without this table a 5-min cron would re-email every tick an outage
-- persisted. Cross-tenant/admin-owned, so it lives in D1 like tenants_index,
-- never inside a single TenantDO (see src/admin/watchtower.ts).

-- One row per named health check (d1 | do_storage | engine | failure_signals).
CREATE TABLE IF NOT EXISTS watchtower_state (
  check_name TEXT PRIMARY KEY,
  -- 'healthy' | 'unhealthy' — the last observed status for this check.
  status TEXT NOT NULL,
  -- When the check ENTERED its current status (drives "unhealthy for N hours"
  -- and the recovery email's duration line). Wall-clock ms.
  since_ts INTEGER NOT NULL,
  -- Last time an alert was actually SENT for this check while unhealthy — the
  -- 6h cooldown anchor. NULL while healthy (a fresh unhealthy transition has
  -- no prior alert to cool down from).
  last_alert_ts INTEGER,
  -- The observation detail from the last sweep (surfaced in the alert body so
  -- the founder gets specifics, not just a check name).
  last_detail TEXT,
  updated_at INTEGER NOT NULL
);

-- Single-row sweep cursor: the timestamp of the previous watchtower sweep, so
-- the failure-signal scan counts only NEW terminal-'failed' sends + complaint
-- events (per-tenant `events`.ts >= last_sweep_ts) rather than all-time totals.
-- On the very first sweep (no row) the window is empty (baseline established,
-- no spurious alert). id is pinned to 1 like demo_run_state.
CREATE TABLE IF NOT EXISTS watchtower_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_sweep_ts INTEGER NOT NULL
);
