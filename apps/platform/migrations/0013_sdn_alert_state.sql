-- SDN list alert-throttle state (class fix 2026-07-24: founder reported 160
-- identical emails — maybeRefreshSdnList alerted on EVERY failed 5-min cron
-- tick, unthrottled). Mirrors watchtower_state's shape (migrations/0008) but
-- simplified to a SINGLE logical check ("is the SDN list loading
-- successfully?" — shared by both the direct-fetch refresh and the
-- droplet-relay ingest, src/ofac/sdn-alert.ts), so it is a pinned singleton
-- row like sdn_list_meta/demo_run_state rather than a per-check_name table.

CREATE TABLE IF NOT EXISTS sdn_alert_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Consecutive failed load attempts since the last success. 0 means the
  -- last attempt (if any) succeeded — the "healthy" baseline.
  failure_streak INTEGER NOT NULL DEFAULT 0,
  -- Last time an alert was actually SENT while in a failure streak — the 6h
  -- cooldown anchor (src/ofac/sdn-alert.ts's SDN_ALERT_COOLDOWN_MS). NULL
  -- once the streak resets (a fresh failure has no prior alert to cool down
  -- from).
  last_alert_ts INTEGER,
  -- The most recent failure/success detail, for direct D1 inspection without
  -- waiting for the next email.
  last_detail TEXT,
  updated_at INTEGER NOT NULL
);
