-- D5 tenant lifecycle — abuse-offboarding enforcement audit log
-- (ARCHITECTURE.md: "D1 = control-plane index + read-model for cross-tenant
-- reporting"). Like `dunning_events`/`support_tickets`, an enforcement action
-- is an ADMIN/OWNER-owned, cross-tenant record (not one tenant's own state),
-- so it lives in D1 — written by the admin terminate route (routes/admin-ops.ts,
-- the Worker layer that already owns D1), never inside a TenantDO. This is the
-- real, tested record behind the AUP consequence-ladder promise (site/aup.html
-- §7 "Immediate termination" / §8 "not a paper policy").
--
-- The disputes table is DELIBERATELY NOT here: a Stripe dispute is applied
-- inside the target TenantDO's own SQLite (same atomic transaction as the
-- `webhook_events` event-id dedupe + the billing_state freeze — see
-- schema.ts's `disputes` table + the webhook_events comment), never split
-- across the DO/D1 boundary. DOs never write D1 and D1 never touches DO
-- storage in this codebase (engine/ops-summary.ts) — keeping that invariant
-- is what makes the dispute write atomically idempotent.

-- One row per (tenant_id, action). The UNIQUE constraint is the idempotency
-- anchor (mirrors dunning_events' UNIQUE(tenant_id, cycle)): re-terminating an
-- already-terminated tenant is a no-op INSERT, so the terminate flow is
-- idempotent AND crash-safe (a retry after the DO teardown committed but
-- before this row was written still lands exactly one row).
CREATE TABLE IF NOT EXISTS enforcement_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL,
  UNIQUE (tenant_id, action)
);

CREATE INDEX IF NOT EXISTS idx_enforcement_actions_tenant ON enforcement_actions(tenant_id);
