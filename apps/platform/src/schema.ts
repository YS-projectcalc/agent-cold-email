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
  -- B1 money path: 'none' (never checked out) | 'active' | 'past_due' |
  -- 'canceled'. Set by the simulated-checkout / Stripe-webhook paths in
  -- src/engine/billing.ts — Stripe is the source of truth (ARCHITECTURE.md
  -- #3); these columns mirror it.
  billing_state TEXT NOT NULL DEFAULT 'none',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  -- A5 (CLASS A) — the charge failure/decline code from the most recent
  -- invoice.payment_failed Stripe event (engine/billing.ts). The dunning sweep
  -- (admin/dunning.ts) reads it: a PERMANENT decline (lost_card, stolen_card,
  -- pickup_card, fraudulent, do_not_honor) skips straight to the suspend stage
  -- — retrying a permanently-declined card only burns grace cycles — while a
  -- transient code (insufficient_funds, processing_error, generic) keeps the
  -- count-based grace cycle. NULL = no recorded failure / unknown code (treated
  -- as transient, the safe default).
  last_decline_code TEXT,
  -- D5 — why the tenant is suspended (status='suspended'): 'dunning' (failed
  -- payments — reversible on billing recovery) | 'terminate' (abuse — NEVER
  -- reversed by a billing event). NULL while status='active'. Lets a
  -- billing-recovery webhook un-suspend a now-paying dunning tenant without
  -- resurrecting a terminated one (adversarial panel-03 finding #6).
  suspend_reason TEXT,
  -- The tenant's own stated primary domain (SPEC.md §8), captured at
  -- setup_infrastructure. The deliverability control loop reads it to derive a
  -- replacement lookalike when a domain burns (engine/deliverability.ts).
  primary_domain TEXT NOT NULL DEFAULT '',
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
  -- Deliverability control-loop state (B6), DISTINCT from the warmup status
  -- column above (which mailbox-state.ts recomputes every tick from the warmup
  -- ramp). One of healthy | throttled | paused. Kept in its own column so a
  -- warmup refresh can never resurrect a paused/throttled mailbox. The tick
  -- excludes deliv_status='paused' from send scheduling (engine/tick.ts).
  deliv_status TEXT NOT NULL DEFAULT 'healthy',
  -- When throttled, the reduced daily cap the loop imposed. NULL = no throttle;
  -- the effective cap is MIN(warmup cap, cap_override) so the throttle survives
  -- the per-tick warmup-cap recompute (engine/mailbox-state.ts).
  cap_override INTEGER,
  -- D5 teardown/reclaim marker (engine/lifecycle.ts). NULL = live; a timestamp
  -- means the mailbox was released back to the vendor (MailboxPort.release).
  -- Its own column, NOT the warmup status (recomputed every tick — a
  -- 'released' there would be wiped) and NOT deliv_status (owned by the B6
  -- loop, semantically distinct). Teardown also sets deliv_status='paused' so
  -- the tick's capacity picker stops sending from it immediately.
  released_at INTEGER,
  -- Consumer-owned IMAP poll cursor (high-water UID). The engine is cursor-
  -- stateless; runPollInbox passes this as EmailPort.poll's sinceCursor and,
  -- AFTER transactionally processing the returned events, advances it to the
  -- returned cursor. A lost poll response leaves this un-advanced so the next
  -- poll redelivers (deduped on events.message_id) — no silent event loss.
  -- -1 is the "never polled this mailbox" sentinel (engine.ts's first-contact
  -- branch: initialize at the mailbox's current high-water WITHOUT fetching
  -- history). 0 is NOT a sentinel -- it is a legitimate ordinary incremental
  -- cursor (a genuinely empty mailbox's high-water is 0). This DEFAULT is a
  -- brand-new-tenant-DO bootstrap fallback only; provisioning.ts sets
  -- poll_cursor=-1 explicitly on every new mailbox row it inserts. EXISTING
  -- rows (from before this fix) keep whatever value they already had,
  -- INCLUDING any already at 0 -- under the current engine semantics that is
  -- safely treated as an ordinary incremental start (bounded, capped), not
  -- re-primed as first-contact (adversary poll-bounded-fetch-2026-07-16
  -- finding 1: overloading 0 as both meanings permanently lost the first
  -- inbound on every empty mailbox).
  poll_cursor INTEGER NOT NULL DEFAULT -1,
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
  is_demo INTEGER NOT NULL DEFAULT 0,
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
  sent_at INTEGER,
  -- A4 (CLASS A) — per-send retry counter for a RETRYABLE vendor failure on
  -- the post-send billing step (engine/tick.ts). Each transient failure
  -- reverts the row to 'pending' and increments this; at the cap the row is
  -- marked status='failed' (ops-visible) instead of retried forever. A
  -- non-retryable VendorError skips straight to 'failed'. NULL/0 on a clean send.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When the row was claimed into 'sending' (engine/tick.ts). A DO that dies
  -- between the claim and the terminal update leaves the row stuck 'sending';
  -- a later tick reclaims one whose sending_since is older than SEND_CLAIM_TTL_MS
  -- back to 'pending' (send is idempotent on its key). NULL in every non-'sending'
  -- state.
  sending_since INTEGER
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

-- A2 (CLASS A) — soft-bounce STREAK tally, kept SEPARATE from the permanent
-- 'suppressions' table because a soft bounce LAPSES (it is transient) whereas a
-- suppression is permanent. A soft (4.x.x) bounce increments 'streak' here
-- (tally only — the lead stays active, the sequence continues); at
-- SOFT_BOUNCE_SUPPRESS_THRESHOLD the address is escalated into 'suppressions'
-- (persistently unreachable = treat as hard). The streak is CUMULATIVE-UNTIL-
-- REPLY by design: this architecture has no delivery receipt, so absence-of-
-- bounce is unobservable and a send cannot prove the mailbox is alive — only a
-- REPLY does (engine/reply-processor.ts deletes the row on a reply). So the
-- streak counts soft bounces with zero engagement in between across any time
-- span/campaign; a hard bounce or escalation clears the (now-moot) row. Keyed
-- per (tenant, email) like suppressions.
CREATE TABLE IF NOT EXISTS soft_bounces (
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email)
);

-- B2 (CLASS B) — request-level idempotency for mutating intents
-- (launch_campaign / setup_infrastructure / thread reply). The client (an
-- agent, retrying a dropped response) presents an Idempotency-Key (HTTP
-- header or MCP tool arg); the first call records the serialized response here,
-- and a replay returns it verbatim WITHOUT re-executing — so a retry can't
-- create a second campaign / double-provision / double-bill. Scoped inside the
-- tenant's own DO (one tenant per DO instance), so 'key' alone is the anchor.
-- CLAIM-THEN-EXECUTE (engine/idempotency.ts): the first call inserts a 'pending'
-- row (response_json NULL) BEFORE running fn, then UPDATEs it to 'done' with the
-- response; a concurrent same-key call that finds 'pending' is rejected as
-- retryable, so an intent that awaits vendor I/O can't be run twice. Rows are
-- evicted at write time once older than the TTL (engine/idempotency.ts) so the
-- table can't grow unbounded per tenant.
CREATE TABLE IF NOT EXISTS request_idempotency (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'done',
  response_json TEXT,
  created_at INTEGER NOT NULL
);

-- source_send_id is the idempotency anchor for usage entries: a
-- reprocessed/duplicated send (same scheduled_send id) can never double-count
-- usage (engine/tick.ts uses INSERT OR IGNORE keyed on it). The backing UNIQUE
-- index is created in TenantDO.ensureColumnMigrations() AFTER the column is
-- guaranteed to exist (so already-deployed DOs that predate this column don't
-- fail on the index during construction). NULLs are distinct in SQLite, so
-- non-usage entries (credits/adjustments) with NULL source_send_id never
-- collide. See adversarial panel-02 correctness-engine finding.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source_send_id TEXT
);

CREATE TABLE IF NOT EXISTS thread_marks (
  thread_id TEXT PRIMARY KEY,
  status TEXT NOT NULL
);

-- B3 (CLASS B) — DURABLE manual-reply send dedupe (NB4). A manual reply's vendor
-- idempotency key derives from stable inputs (the caller's request key, else a
-- content hash of the body), but the sandbox vendor's send-cache is IN-MEMORY:
-- across a DO eviction it's gone, so a retried no-request-key reply would mint a
-- NEW messageId and double-send. This persists the stable send-key -> messageId
-- mapping in DO SQLite so the dedupe survives a cold start — engine/threads.ts
-- checks it BEFORE calling send(). (The request-key path is already durable via
-- request_idempotency; this closes the no-key content-hash gap.)
CREATE TABLE IF NOT EXISTS sent_message_keys (
  send_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);

-- B1 money path: simulated (no Stripe key) checkout sessions. A REAL Stripe
-- Checkout Session never touches this table — that state lives at Stripe;
-- this exists purely so the paid-upgrade path is fully exercisable before a
-- real key is wired (ACTIVATION.md). See src/engine/billing.ts.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

-- Stripe webhook idempotency anchor (ARCHITECTURE.md #3: "per-tenant webhook
-- handling is idempotent"). A redelivered event id is a no-op. Scoped inside
-- the target tenant's own DO, not globally — POST /webhooks/stripe already
-- routes the event to exactly one tenant's DO before this table is touched.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL
);

-- Deliverability control-loop audit log (B6). Every action the loop takes
-- (THROTTLE / PAUSE / ROTATE / REPLACE_DOMAIN + the capped/no-op variants) is
-- appended here so account()/infrastructure_status() can surface what the AI
-- ops loop did, and so REPLACE_DOMAIN can enforce a per-window replacement cap
-- (count of prior replacements) to prevent infinite domain-respawn. Deliberately
-- NOT the events table: that row shape is campaign/lead/thread-bound (NOT NULL)
-- and its counts feed metrics(); a system action has none of those.
CREATE TABLE IF NOT EXISTS deliverability_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL
);

-- D5 chargeback / dispute lane (protects the master Stripe account). One row
-- per Stripe dispute, applied by the charge.dispute.* webhook INSIDE this
-- tenant's own DO (engine/billing.ts) — same atomic transaction as the
-- webhook_events event-id dedupe + the billing_state='disputed' freeze, so a
-- redelivered event can never double-apply. Scoped per-DO (one tenant per DO
-- instance) exactly like webhook_events; keyed on the Stripe dispute id so two
-- DIFFERENT events referencing the SAME dispute (created then closed) collapse
-- to one row (INSERT OR IGNORE on create, UPDATE on close).
CREATE TABLE IF NOT EXISTS disputes (
  dispute_id TEXT PRIMARY KEY,
  charge_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  -- 'open' (dispute.created — funds frozen) | 'won' | 'lost' (dispute.closed).
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

-- D5 teardown/reclaim record (engine/lifecycle.ts). At most one row per tenant
-- (its existence is the idempotency anchor for cancel/terminate — a re-cancel
-- reads this row and no-ops). Surfaced by account() so the owner/agent sees the
-- reclaim summary, incl. the annual-domain-liability we eat by releasing
-- annually-registered domains mid-term (SPEC.md §12: .com $11.08/yr).
CREATE TABLE IF NOT EXISTS teardown_records (
  tenant_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  effective TEXT NOT NULL,
  domains_released INTEGER NOT NULL DEFAULT 0,
  mailboxes_released INTEGER NOT NULL DEFAULT 0,
  campaigns_stopped INTEGER NOT NULL DEFAULT 0,
  annual_domain_liability_cents INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

-- Per-tenant demo-run throttle state (single-row). Bounds /demo/run abuse:
-- min-interval + lifetime cap enforced in TenantDO.demoRun using REAL wall
-- time (the virtual clock jumps ~weeks per demo run, so it can't gate a
-- real-rate limit). See adversarial panel-02 abuse-cost-dos finding.
CREATE TABLE IF NOT EXISTS demo_run_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER NOT NULL DEFAULT 0
);

-- SPEC.md §19.2 (M1 dashboard+inbox brief) — agent-controlled dashboard
-- layouts. 'rev' is the row version for optimistic concurrency: a PUT must
-- present the rev it read; a mismatch is a structured 409 (engine/
-- dashboard-views.ts) so a concurrent agent/human edit can never silently
-- clobber the other. 'edited_by' is server-derived from the request
-- transport ('dashboard' | 'mcp' | 'api'), NEVER a client-supplied actor
-- claim (§19.4) — the lazy-seeded starter view is stamped 'system'. Exactly
-- one row per tenant may have is_default = 1 (enforced in application code,
-- transactionally, not a partial UNIQUE index — SQLite has no WHERE-clause
-- unique constraint that a plain CREATE TABLE IF NOT EXISTS can express
-- portably here).
CREATE TABLE IF NOT EXISTS dashboard_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  layout_json TEXT NOT NULL,
  layout_schema_version INTEGER NOT NULL DEFAULT 1,
  edited_by TEXT NOT NULL,
  edited_by_note TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- SPEC.md §19.2 — human/agent thread triage. 'label' is free-form (a
-- recommended canonical set is styled in the UI, not enforced server-side —
-- see packages/shared's CANONICAL_THREAD_LABELS); 'source' is server-derived
-- from transport exactly like dashboard_views.edited_by.
CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
