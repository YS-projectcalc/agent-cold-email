-- C6 marketing-site waitlist (adversarial panel-03 finding #9). The public
-- POST /api/waitlist form previously stored emails in KV with a 90-DAY TTL and
-- nothing ever read them back — the funnel silently emptied before activation
-- (a lost lead is unrecoverable). This durable D1 table persists leads with NO
-- expiry and gives the owner an ordered export (buildOpsDigest's waitlist count
-- + the ADMIN_TOKEN-gated GET /admin/ops/waitlist). Like tenants_index this is
-- control-plane data, so it lives in D1, never inside a TenantDO. Only the
-- durable email store moved here — the per-IP RATE-LIMIT counters stay in KV
-- (short TTL, correctly ephemeral).
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);
