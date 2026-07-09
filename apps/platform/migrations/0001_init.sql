-- D1 control-plane index (ARCHITECTURE.md: "D1 = control-plane index + a
-- Queues-fed read-model for cross-tenant reporting"). Per-tenant runtime
-- data (domains, mailboxes, campaigns, leads, events...) lives in each
-- TenantDO's own SQLite storage — this table exists so the Worker can look
-- up which tenant a bearer token belongs to and route to the right DO.

CREATE TABLE IF NOT EXISTS tenants_index (
  id TEXT PRIMARY KEY,
  api_token_hash TEXT NOT NULL UNIQUE,
  brand TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'demo',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_index_token ON tenants_index(api_token_hash);
