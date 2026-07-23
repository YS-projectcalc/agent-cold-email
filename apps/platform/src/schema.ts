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

-- SPEC.md §20 — BYO domains & mailboxes. Every new column below defaults to
-- the value an EXISTING provisioned (lookalike) domain already has, so every
-- pre-existing row — and every existing test/tenant — is byte-identical
-- (flag-dark: source='provisioned', is_primary=0, byo_status='active',
-- reputation/breaker fields NULL/'standard'). Only a row explicitly inserted
-- through the new BYO intake path (engine/byo-intake.ts) ever sets these to
-- anything else.
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  purchased_at INTEGER NOT NULL,
  -- 'provisioned' (the existing lookalike-domain flow, unchanged) | 'byo'
  -- (SPEC.md §20 — the customer brought this domain).
  source TEXT NOT NULL DEFAULT 'provisioned',
  -- The tenant's declared primary/flagship business domain (SPEC.md §20.2/
  -- §20.4/§20.5's primary-axis-first gate). At most one LIVE row per tenant
  -- may have this set — enforced in engine/byo-intake.ts's
  -- assertNoExistingActiveByoPrimary (registerByoDomain's boundary check), not
  -- a DB constraint (mirrors dashboard_views.is_default's own documented
  -- app-level-only enforcement). "Live" excludes a terminal-failed intake
  -- (byo_status='rejected'/'abandoned') and a hard-paused primary
  -- (status='paused_primary') — none of those block registering a new one.
  is_primary INTEGER NOT NULL DEFAULT 0,
  -- 'we_manage_zone' | 'records_to_apply' | NULL (provisioned domains never
  -- set this — the lookalike flow's setDns() is a different code path).
  dns_mode TEXT,
  -- BYO intake lifecycle: 'pending_scan' | 'pending_dns' | 'pending_consent'
  -- | 'pending_kyc' | 'active' | 'rejected' | 'abandoned'. Provisioned
  -- domains are always 'active' (there is no intake pipeline for them).
  byo_status TEXT NOT NULL DEFAULT 'active',
  -- SPEC.md §20.1's pre-flight live-infra scan result snapshot (JSON — see
  -- byo-preflight.ts's PreflightScanFindings/PreflightInterpretation), frozen
  -- at the moment it was taken so a later re-scan can't silently rewrite what
  -- was actually disclosed to the customer (byo-consent.ts's ConsentRecord
  -- also carries its OWN copy at ack time, for the same reason).
  scan_json TEXT,
  -- SPEC.md §20.3's abuse-gate verdict (JSON — byo-abuse-gate.ts's ByoAbuseAssessment).
  abuse_gate_json TEXT,
  -- SPEC.md §20.4's primary-domain consent record (JSON — byo-consent.ts's
  -- ConsentRecord). NULL until a primary-domain intake has been acknowledged.
  consent_json TEXT,
  -- SPEC.md §20.5's reputation branch: 'primary_standard' | 'established_good'
  -- | 'unknown_fresh' | 'blocklisted_reject' | NULL (provisioned domains have
  -- no reputation-ladder branch at all — mailbox-state.ts's rampTierFor
  -- treats NULL as 'standard', byte-identical to today).
  reputation_branch TEXT,
  -- SPEC.md §20.1's elevated-breaker note: a subdomain-of-primary domain is
  -- NOT is_primary itself but still inherits §20.2's operationalized breaker
  -- (deliverability.ts's evaluate() branches on this, not on is_primary,
  -- when deciding which breaker a domain routes through). 'primary' |
  -- 'elevated' | 'standard'.
  breaker_tier TEXT NOT NULL DEFAULT 'standard',
  -- Poll-verify bookkeeping for records-to-apply / we-manage-zone DNS
  -- confirmation (SPEC.md §20.1's "no mode silently blocks forever" —
  -- byo-intake.ts's pollByoDomainDns uses these for the 7-day idle timeout).
  dns_check_count INTEGER NOT NULL DEFAULT 0,
  dns_first_checked_at INTEGER,
  -- SPEC.md §20.2's mandatory DMARC p=none observation window before first
  -- send (14 days, or 7 if the pre-flight scan already found enforcement
  -- mode). NULL = no gate (provisioned domains, and BYO domains before this is
  -- computed) — tick.ts's capacity picker excludes a mailbox whose domain's
  -- first_send_eligible_at is in the future; NULL never gates anything.
  first_send_eligible_at INTEGER
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
  created_at INTEGER NOT NULL,
  -- SPEC.md §20.6 — mailbox composition. 'provisioned' (the existing vendor-
  -- provisioned flow, unchanged — includes a managed mailbox provisioned ON a
  -- BYO domain, shape (a): we still own/manage the mailbox itself) | 'byo_connected'
  -- (SPEC.md §20.6's Mordy-pilot seam — the customer's own existing OAuth/
  -- SMTP+IMAP mailbox, bypassing provisioning entirely).
  source TEXT NOT NULL DEFAULT 'provisioned',
  -- Maps directly onto the engine's per-mailbox SEND transport discriminator
  -- (apps/engine/src/config.ts's sendTransportSchema) — 'smtp' | 'gmail_api' |
  -- 'ms_graph'. Every existing mailbox is 'smtp' by default, matching
  -- config.ts's own documented default (an omitted 'send' field means smtp).
  transport_kind TEXT NOT NULL DEFAULT 'smtp',
  -- Connection metadata for a 'byo_connected' mailbox (JSON — kind-specific
  -- fields mirroring config.ts's gmailTransportSchema/graphTransportSchema;
  -- for 'smtp' this holds host/port/user, NEVER the raw password — see
  -- engine/byo-intake.ts's connectByoMailbox doc comment on the secret-
  -- handling posture, modeled on webhook_subscriptions.secret's "shown once,
  -- never re-exposed on read" convention). NULL for 'provisioned' mailboxes
  -- (their credentials are injected into the engine out-of-band, via the
  -- existing droplet/env runbook -- unchanged by this lane).
  transport_json TEXT
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
  ts INTEGER NOT NULL,
  -- SPEC.md §20.2's dual-alert requirement for a HARD_PAUSE_PRIMARY_DOMAIN
  -- action (customer dashboard banner + account-contact email, owner §D6
  -- digest) — set the moment the best-effort notice is dispatched
  -- (deliverability-actions.ts), so a re-sweep of an already-paused primary
  -- domain never re-sends the same alert. NULL for every other action type.
  alerted_at INTEGER
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

-- Per-tenant OUTBOUND webhook subscriptions (ROADMAP.md WIN-THE-COMPARISON (d)
-- / forensics §5 (c) — buyer checklists hard-gate on reply/bounce PUSH). One
-- row per registered endpoint, scoped inside the tenant's own DO exactly like
-- every other table here (one tenant per DO instance — a subscription can
-- physically reference no other tenant's events). 'secret' is the HMAC-SHA256
-- signing key (server-minted if the caller omits one); NEVER logged. The
-- delivery pump (engine/webhook-delivery.ts) auto-disables a subscription after
-- WEBHOOK_DISABLE_THRESHOLD consecutive TERMINAL delivery failures — 'status'
-- flips to 'disabled' with a tenant-visible 'disabled_reason', and 'active'
-- reflects both the caller's pause flag AND that auto-disable (a re-enable via
-- updateWebhook resets consecutive_failures + status). 'event_types_json' is a
-- JSON array of the WEBHOOK_EVENT_TYPES this endpoint wants.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_types_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  disabled_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The at-least-once delivery queue. One row per (event, subscription) the
-- enqueue path fans out (engine/webhooks.ts, called from the SAME once-per-new-
-- event choke point that records the event — engine/reply-processor.ts's
-- recordEventIfNew — so a re-polled duplicate event enqueues nothing twice).
-- 'payload_json' is the exact raw body signed + POSTed, frozen at enqueue so a
-- retry re-sends identical bytes with a stable signature. 'event_id' is the
-- source events.id, surfaced in the payload as the CONSUMER dedup key; the
-- UNIQUE(subscription_id, event_id) index (created in ensureColumnMigrations)
-- makes enqueue idempotent. 'next_attempt_at' is REAL wall-clock ms (webhook
-- retries are real-time infra, NOT the tenant's accelerated VirtualClock): the
-- pump processes rows due at/<= its injected nowMs, and on a retryable failure
-- reschedules next_attempt_at = nowMs + exponential backoff until MAX_ATTEMPTS.
-- Terminal states: 'delivered' | 'failed' (retries exhausted) | 'canceled'
-- (subscription deleted/inactive before delivery). Bounded by retention pruning
-- of terminal rows.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  delivered_at INTEGER
);

-- Per-attempt delivery log (the "delivery-attempt log queryable per
-- subscription" the brief requires). One row per HTTP attempt: outcome, the
-- endpoint's status code, a bounded error tag, and a TRUNCATED response snippet
-- (WEBHOOK_SNIPPET_MAX chars — a consumer response body is never stored in
-- full). Pruned alongside its terminal delivery.
CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT,
  snippet TEXT,
  ts INTEGER NOT NULL
);

-- SPEC.md §22 (D1 of the warm-lead thin layer) — contact-level disposition,
-- keyed (tenant_id, email) — decoupled from the campaign-scoped 'leads'
-- table (one row per CAMPAIGN per email, schema.ts above) because disposition
-- belongs to the CONTACT, not the campaign-lead: "interested on campaign A" is
-- visible the instant campaign B lists the same address (founder-ratified Q1,
-- docs/research/warm-lead-q1-q6-recommendations-2026-07-21.md). interest_status
-- is a server-enforced enum (Q2 — see packages/shared's LEAD_INTEREST_STATUSES),
-- never validated here (SQLite has no CHECK-enum shorthand; the zod boundary
-- schema is the single enforcement point, matching every other enum-shaped
-- column in this codebase). tags_json is the free-form escape hatch the
-- hybrid design keeps alongside the enum. source is server-derived from
-- transport exactly like thread_labels.source/dashboard_views.edited_by
-- (never a client-supplied actor claim) — 'mcp' | 'api' | 'dashboard'.
CREATE TABLE IF NOT EXISTS lead_dispositions (
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  interest_status TEXT NOT NULL DEFAULT 'none',
  notes TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'mcp',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email)
);

-- SPEC.md §22 (D2) — one-off scheduled follow-up sends. SCHEMA ONLY in this
-- build: the schedule_followup tool + tick-drain send mechanism are
-- EXPLICITLY OUT OF SCOPE here (increment #4 — the adversary amendment
-- requires a new shared guarded single-send primitive — daily cap + warmup
-- ramp + deliv_status='paused' exclusion + suppression re-check — that
-- neither replyToThread nor the tick's inline loop exposes as a callable
-- unit today; docs/adversarial/warm-lead-thin-layer-design-2026-07-16.md
-- R1/R2). Rejected reusing 'scheduled_sends': those rows carry SEQUENCE
-- semantics (a step index rendered from campaigns.sequence_json at tick
-- time) and no body column — a one-off custom-body send would force a
-- synthetic step + a body side-channel + a tick render-path branch
-- (patch-on-patch, CLAUDE.md rule f). idempotency_key mirrors
-- request_idempotency's caller-retry-safety shape (a future tool would key on
-- it the same way launch_campaign/setup_infrastructure do).
CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);

-- Enqueue idempotency: a given source event is delivered at most once per
-- subscription (enqueue uses INSERT OR IGNORE against this key). These tables
-- are always new (no DO predates them), so the unique/lookup indexes live
-- inline here rather than in the collapse-then-index migration path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_dedupe
  ON webhook_deliveries(subscription_id, event_id);
-- The pump's hot query: due pending rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at);
-- Per-subscription delivery + attempt log reads.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_sub
  ON webhook_deliveries(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_attempts_delivery
  ON webhook_delivery_attempts(delivery_id, attempt_no);

-- Self-serve activation I3 (F6 partial-failure ordering) — the durable record
-- of a provisioned (BILLED) mailbox whose credentials must reach the engine.
-- Written 'pending' BEFORE the credential push (engine/mailbox-credential-push.ts),
-- so a push that fails (or a DO crash mid-push) never silently loses a billed
-- mailbox: reconcileMailboxCredentialPushes retries every 'pending' row and
-- flips it 'pushed' only after the engine confirms the write. email is the PK
-- (one push record per mailbox). Inert until arming (rows only ever written by
-- the config-gated push flow). Always a new table (no DO predates it), so the
-- reconcile index lives inline.
CREATE TABLE IF NOT EXISTS mailbox_cred_pushes (
  email TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mailbox_cred_pushes_pending
  ON mailbox_cred_pushes(tenant_id, status, created_at);
`;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
