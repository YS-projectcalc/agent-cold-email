-- G0 (GA gates, ga-gates-design-2026-07-22.md §0) — the cross-tenant vendor
-- spend accounting the G2 ceiling + G4 slot-capacity gates both stand on.
--
-- WHY D1 (not per-tenant DO SQLite): real vendor spend happens INSIDE a
-- TenantDO (provisioning.ts), but the ceiling + the InboxKit plan-slot count
-- are properties of the WHOLE InboxKit account, spanning every tenant. A
-- per-tenant DO cannot see other tenants (ARCHITECTURE.md #3), so the
-- account-level ledger lives here in D1 — the same control-plane store the
-- admin surface already uses cross-tenant. TenantContext carries `env.DB`, so
-- the DO spend path (engine/spend-ceiling.ts's withSpendCeiling) atomically
-- reads/writes it. (This DELIBERATELY extends the prior "the DO never writes
-- D1" scoping, which was specific to the admin/enforcement tables — design §0
-- sanctions the spend-ledger DO->D1 write path.)

-- One row per billing PERIOD (period_key = 'YYYY-MM', per-calendar-month, the
-- founder Q1 ruling). reserved_cents + committed_cents is the running spend the
-- atomic conditional reserve gates against ceiling_cents. Spend RESETS each
-- calendar month (a fresh period row), which is correct for a monthly $ budget.
CREATE TABLE IF NOT EXISTS vendor_spend_ledger (
  period_key      TEXT PRIMARY KEY,
  reserved_cents  INTEGER NOT NULL DEFAULT 0,
  committed_cents INTEGER NOT NULL DEFAULT 0,
  ceiling_cents   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The G4 InboxKit plan-slot counter. DELIBERATELY NOT in vendor_spend_ledger
-- (deviation from the design's "one row per period" — flagged): plan-slot
-- OCCUPANCY persists across months (a mailbox provisioned in January still
-- holds its slot in February), so a per-calendar-month counter would reset to 0
-- each month and let a tenant re-provision the full plan capacity again — silent
-- over-provisioning. This single account-wide row (id=1) is the current live
-- count of real plan-slot mailboxes: incremented on a real mailbox provision,
-- decremented on release/reap/teardown. The plan capacity itself
-- (INBOXKIT_PLAN_SLOTS) is env-configured, not stored here.
CREATE TABLE IF NOT EXISTS vendor_slot_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  slots_used INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO vendor_slot_state (id, slots_used, updated_at) VALUES (1, 0, 0);

-- Append-only audit + the stale-reserve reaper's anchor: one row per money-out
-- reserve. status goes 'reserved' -> 'committed' (vendor call succeeded) or
-- 'released' (vendor call failed, or the scheduled() reaper reclaimed a
-- reservation orphaned by a crash between reserve and commit — design NB-2).
CREATE TABLE IF NOT EXISTS vendor_spend_entries (
  id          TEXT PRIMARY KEY,
  period_key  TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  est_cents   INTEGER NOT NULL,
  actual_cents INTEGER,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Drives the reaper's scan for reservations still 'reserved' past the TTL.
CREATE INDEX IF NOT EXISTS idx_vendor_spend_entries_reserved
  ON vendor_spend_entries(status, created_at);
