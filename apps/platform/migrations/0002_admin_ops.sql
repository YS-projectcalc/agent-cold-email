-- D6/D1/D2 admin surface — cross-tenant control-plane data (ARCHITECTURE.md:
-- "D1 = control-plane index + a Queues-fed read-model for cross-tenant
-- reporting"). Support tickets and dunning-cycle actions are inherently
-- cross-tenant/admin-owned (not one tenant's own state), so — like
-- `tenants_index` — they live in D1, never inside a single TenantDO.

-- D1 (brief) — AI support triage lane. One row per inbound support message
-- triaged by POST /admin/support/triage. `tenant_id` is nullable: a support
-- message may arrive before we can identify the tenant (or from a
-- prospect/non-tenant). `draft` is the AI-drafted FAQ answer (NULL when the
-- message was escalated, not auto-answered). `status`:
--   'open'      — FAQ-answerable, drafted, awaiting the owner's send (real
--                 outbound email is an ACTIVATION step — see admin/README.md)
--   'escalated' — not FAQ-answerable (abuse-report/other) — flagged for the owner
--   'closed'    — reserved for a future owner/agent action; unused in this build
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  from_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  tenant_id TEXT,
  category TEXT NOT NULL,
  draft TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);

-- D2 (brief) — dunning / failed-payment sweep audit log. One row per
-- (tenant_id, cycle) the sweep has already actioned — the UNIQUE constraint
-- is the idempotency anchor: re-running the sweep while a tenant's failure
-- count (== its current "cycle") hasn't changed is a no-op, matching the
-- ledger_entries/webhook_events idempotency pattern in schema.ts.
-- `action`: 'retry' | 'escalate' | 'suspend' — see src/admin/dunning.ts.
CREATE TABLE IF NOT EXISTS dunning_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL,
  UNIQUE (tenant_id, cycle)
);

CREATE INDEX IF NOT EXISTS idx_dunning_events_tenant ON dunning_events(tenant_id);
