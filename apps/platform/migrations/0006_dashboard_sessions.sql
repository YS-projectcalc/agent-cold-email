-- SPEC.md §19.1 (M1) — dashboard cookie-session store. `session_hash` is
-- SHA-256(+pepper) of a random 256-bit id (see src/auth.ts
-- generateDashboardSessionId / hashApiToken) — the opaque id itself lives
-- ONLY in the httpOnly cookie, never here in plaintext, mirroring how
-- tenants_index never stores a plaintext bearer token either. `expires_at` is
-- a real wall-clock TTL (30d, src/routes/dashboard-session.ts) — dashboard
-- sessions are a control-plane concept, unrelated to any tenant's sandboxed
-- virtual clock.
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  session_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_tenant ON dashboard_sessions(tenant_id);
