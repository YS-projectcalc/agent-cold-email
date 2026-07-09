// Per-tenant SQLite schema owned by each TenantDO instance (ARCHITECTURE.md:
// "TenantDO SQLite money ledger" + the table list in the B0 brief). D1 only
// holds the control-plane token->tenant index (migrations/0001_init.sql).

export const TENANT_DO_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenant_profile (
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  plan TEXT NOT NULL,
  physical_address TEXT NOT NULL DEFAULT '',
  sender_identity TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  clock_base INTEGER NOT NULL,
  clock_offset INTEGER NOT NULL DEFAULT 0,
  clock_multiplier INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  purchased_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  email TEXT NOT NULL,
  daily_cap INTEGER NOT NULL,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_today_epoch_day INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'warming',
  warmup_started_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  sequence_json TEXT NOT NULL,
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  send_window_json TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  global_status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_sends (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  mailbox_id TEXT,
  step INTEGER NOT NULL,
  variant TEXT NOT NULL DEFAULT 'a',
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  thread_id TEXT NOT NULL,
  message_id TEXT,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  type TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  thread_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS suppressions (
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_marks (
  thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL
);
`;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
