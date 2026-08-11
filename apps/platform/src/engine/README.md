# src/engine

The native-sandbox sequencing + reply engine (modeled on cold-cli's shapes
per the B0 brief), split into small single-purpose modules so no file grows
into a god file:

- `warmup.ts` — pure warmup-ramp math (day -> daily cap / status). No I/O.
- `mailbox-state.ts` — persists live warmup day/cap/status + resets daily
  send counters on a virtual-day rollover. Called before anything that
  reads/enforces mailbox capacity.
- `warmup-cancel.ts` — `runWarmupCancellationSweep`: cancels a mailbox's
  InboxKit warmup-pool subscription once its ramp completes (day 29), per the
  founder ruling 2026-08-02 (ROADMAP.md:25) that the recurring add-on bills for
  the ramp month only. Driven by the **cron** (`scheduled.ts` ->
  `runWarmupCancelSweepAllTenants` -> the `warmupCancelSweep` DO method), which
  is its only production driver — adversary A1 caught it wired solely into
  `runTick`, which nothing in production calls (alarm-driven scheduling is still
  B2). Deliberately its own cron lane rather than part of the tick: driving the
  full tick from cron would arm automatic campaign sending. It also cannot live
  inside the synchronous `mailbox-state.ts` refresh, since it makes a vendor
  call and the send path calls that refresh mid-guard-sequence.
  Exactly-once via the `mailboxes.warmup_cancelled_at` marker; a give-up at the
  attempt cap records `warmup_cancel_gave_up_at` INSTEAD, keeping "the vendor
  confirmed" distinguishable from "we stopped trying", and surfaces in the owner
  digest. Skips BYO-connected mailboxes (never had a subscription) and released
  ones. Failure-isolated — it can never delay a send. Cancelling changes nothing
  about send capacity: the ramp is ours.
- `clock-migration.ts` — `migrateTenantClockToReal`: the ONE-SHOT virtual->real
  clock migration a tenant crosses when it starts paying (wave-2 DECISION 2,
  founder ruling 2026-08-05: RealClock for every non-sandbox tenant). Every
  tenant signs up as `demo`, so a paying tenant's frozen virtual clock is
  typically far in the real FUTURE; this rebases every clock-stamped row by
  `realNow - frozenNow` (either sign), retires the demo-era sandbox mailboxes
  AND sandbox-origin `domains` rows (NEW-4, wave-2 design review round 2 —
  never a `source='byo'` row, and only a `source='provisioned'` domain with
  zero currently-live non-sandbox mailboxes attached, so a domain a live real
  mailbox is still on is left alone), terminalizes demo-seed sends, and stamps
  `tenant_profile.clock_mode='real'`.
  Called ONLY by `TenantDO` — at constructor rehydrate (so it self-applies to a
  live tenant on first touch after deploy) and from both checkout paths. All of
  it, marker included, runs inside one `storage.transactionSync`, so a throw
  rolls back everything and the retry re-enters virgin state — a double shift is
  structurally impossible. `clock_mode='real'` is also the interlock the
  auto-send driver's predicate requires, so an unmigrated tenant is never sent
  for. Pure synchronous SQL: no `await` may ever appear inside it.
- `scheduler.ts` — pure send-window + least-loaded-mailbox-with-capacity
  helpers used by `tick.ts` (`isWithinSendWindow` is wired into the tick).
- `brand-guard.ts` — the lookalike third-party-brand hard-reject validator
  (`assertBrandOwnership`), called at the `setup_infrastructure` boundary
  before any domain purchase: a well-known-brand denylist + a
  brand↔primaryDomain ownership-consistency check (SPEC.md §8, panel-02).
- `provisioning.ts` — `setup_infrastructure` (validates brand ownership, then
  picks candidates, adopts-or-buys each domain, drives its DNS, and provisions
  mailboxes onto it). The three legs it orchestrates live in their own modules:
  - `provision-intents.ts` — the durable buy-INTENT records for the two
    non-idempotent vendor purchases (domain registration, mailbox buy). Written
    BEFORE the purchase and never deleted, because the request-idempotency claim
    is deleted on a throw: that is what made a retry re-buy. `markMailboxIntentsReleased`
    is teardown's invalidation hook — a claim about a released mailbox must not
    outlive the mailbox (N4). It also owns the `mailbox_buy_dispatches` claim
    (`claimBuyDispatch` / `readBuyDispatch`), written BEFORE each `/mailboxes/buy`
    on a REAL wall clock: an intent status is written AFTER the vendor answers, so
    only a pre-call claim can tell "nothing was sent" apart from "an accepted buy
    whose status write was lost".
  - `mailbox-acquisition.ts` — the guarded re-buy (founder ruling 2026-08-06).
    Decides whether a mailbox may be bought at all: any dispatch on record means
    ASK the provider, and only a corroborated absence (repeated lookups, plus a
    minimum real age since the dispatch) authorizes the ONE automatic re-buy. A
    failed lookup authorizes nothing. Raises the founder's stuck / re-buy-outcome
    alerts through the watchtower state machine so they inherit its dedup and
    cooldown.
  - `domain-dns.ts` — `setDnsWithRetry`, the only export. Runs the DNS operation
    the domain's `connection_type` calls for (INCIDENT 2026-08-05: the
    connect-an-existing-domain nameserver handshake was being run against
    domains the vendor itself had registered — the wrong operation, permanently
    failing), flips `dns_status` to 'ready' ONLY on real propagation flags, and
    preserves the underlying transient/permanent grade instead of laundering
    everything into "retryable".
  - `mailbox-provisioning.ts` — `provisionMailboxesForDomain`, the per-mailbox
    saga: buy → WAIT for the vendor to finish creating it → warmup → local row →
    metering → credential push. The wait is the L2 gate (a buy is ACCEPTED, not
    completed), and the local row is written only after vendor confirmation, so
    the billing meter can never count a mailbox that does not exist. Reused by
    `byo-mailbox-composition.ts`'s `requestManagedByoMailboxes` (SPEC.md §20.6
    shape (a) — a BYO domain we don't own/buy, but still provision
    platform-owned mailboxes on).
- `infrastructure-status.ts` — `infrastructure_status`, the read-only view
  (per-mailbox warmup/deliverability/vendor-health, degrading per mailbox rather
  than 500ing the endpoint). Split from `provisioning.ts` because reading and
  provisioning are separate responsibilities.
- `campaigns.ts` — `launch_campaign` (schedules every sequence step for
  every non-suppressed lead up front; `is_demo` marks demo-run campaigns) +
  `pause`/`pause_all` + `listCampaigns` (SPEC.md §19.4 `GET /campaigns`: id/
  name/status/counts, two queries total regardless of campaign count). The
  tick is the actual send-time guard, not launch.
- `tick.ts` — the engine tick: runs the deliverability sweep FIRST (so a
  degrading mailbox is throttled/paused before it sends more this tick), then
  sends every due `scheduled_send`, enforcing per-mailbox daily caps AND, at
  send time, lead/campaign status, the `suppressions` table, and the campaign
  send window. The send picker excludes `deliv_status='paused'` mailboxes,
  which is what realizes ROTATE. Claims each row atomically (`pending`→
  `sending`) before the network send so a concurrent/retried tick can't
  double-process it, and records usage before committing `sent`/cap so a row is
  never left sent-but-unbilled. The ledger usage entry is idempotent on
  `source_send_id`.
- `reply-processor.ts` — polls each mailbox's `EmailPort.poll()`, lands
  replies in the inbox (step cancellation is gated on the campaign's
  `stop_on_reply` flag) and bounces AND spam-complaints into `suppressions`
  (both always cancel remaining steps). Complaints carry the original send's
  message id so the deliverability loop can attribute them per-mailbox.
  The typed-unsubscribe-intent reply matcher dispatches to
  `suppression.ts`'s `unsubscribeEmail`.
- `events.ts` — `recordEventIfNew`, the single once-per-new-event choke point
  (extracted out of `reply-processor.ts`, its original home, so
  `suppression.ts` can route its own tenant-wide unsubscribe event writes
  through the SAME choke without a circular import). Every `events` insert
  that should fan out to outbound webhooks goes through here.
- `suppression.ts` — `suppress`/`cancelPendingSteps` (shared primitives) +
  `unsubscribeEmail` (the tenant-wide (tenant,email) opt-out walk, shared by
  the hosted RFC 8058 endpoint and the inbound typed-unsubscribe matcher;
  `reason` is parametrized — `"unsubscribe"` by default, `"manual"` for
  SPEC.md §22's `suppress_lead`) + `suppressLead` (the `suppress_lead`
  MCP tool / REST route).
- `lead-dispositions.ts` — SPEC.md §22's `update_lead`: upserts the
  contact-level `lead_dispositions` row (server-enforced `interest_status`
  enum + free-form notes/tags), keyed `(tenant_id, email)`, decoupled from
  the campaign-scoped `leads` table.
- `list-leads.ts` — SPEC.md §22's `list_leads`: read-only JOIN over
  `leads`/`lead_dispositions`/`suppressions`/a last-event-per-lead CTE
  (mirrors `inbox.ts`'s CTE pattern), cursor-paginated. Doubles as the
  paginated-JSON export surface (Q6 — no separate CSV endpoint).
- `deliverability.ts` — B6 control loop, DECIDE half. A PURE
  `evaluate(mailboxHealth[], domainStats[], thresholds) -> Action[]`
  (unit-testable in isolation) + `gatherMailboxHealth`/`gatherDomainStats`
  which assemble first-party per-mailbox/per-domain bounce+complaint RATES
  (fractions, 0-1) from the event log — same units as reporting.ts and the
  vendor port; the Gmail 0.30% red line is 0.003, NOT 0.30 (the 100x trap).
- `deliverability-actions.ts` — B6 control loop, ACT half. `applyActions`
  mutates DO state (throttle cap via `cap_override`, pause via `deliv_status`,
  retire+replace a burning domain via `provisionDomainWithMailboxes`) and
  audits each to `deliverability_actions`; `runDeliverabilitySweep` is the one
  entry point the tick calls each cycle BEFORE scheduling. Replacements are
  rate-capped per window so a replacement that also burns can't spawn forever.
- `demo.ts` — `demo_run`: the sandbox accelerated pipeline. Resets prior demo
  state each run so DO storage stays bounded; per-tenant throttled in `tenant-do.ts`.
- `guarded-send.ts` — `sendWithGuards`: the shared GUARDED single-send
  primitive every one-off (non-campaign) send goes through, so a manual reply
  is subject to the same governance the tick enforces inline — suppression
  re-check, deliverability-pause refusal, and an atomically-reserved
  per-mailbox daily cap that meters `sent_today`. Refuses with a structured
  `SendBlockedError` (named reason + retryable) rather than dropping silently.
  Warm-lead Q3 (ROADMAP.md:76) / adversary R1-R2 named this as the required
  reuse target; `schedule_followup`'s drain is its next caller when built.
- `threads.ts` — `thread(id)` / `reply(thread, body)` / `mark(thread,
  status)` + `lookupThreadRef` (shared by `reply-processor.ts`,
  `thread-labels.ts`, and `inbox.ts`). `reply` sends via `guarded-send.ts`,
  never the vendor port directly. `listInbox()` (v1) used to live here —
  moved to `inbox.ts` (below) for SPEC.md §19.4's v2 rewrite.
- `inbox.ts` — SPEC.md §19.4 (M1 dashboard+inbox brief) `GET /inbox` v2 /
  the MCP `inbox` tool: a single JOINed+CTE query (kills v1's per-row N+1),
  cursor-paginated (composite `(lastEventTs, rowid)` cursor — same-ts ties
  are routine here, see the file doc), filterable (mailbox/campaign/label/
  read/include_nonreply). Subject/snippet are resolved via `json_extract`
  against `campaigns.sequence_json` / `events.metadata_json`, not columns.
- `thread-labels.ts` — `setThreadLabel` (`POST /threads/:id/label` + the MCP
  `label_thread` tool): free-form label set/clear, source stamped from
  transport (never a client claim).
- `dashboard-views.ts` — SPEC.md §19.2/§19.4/§19.5 agent-controlled saved
  dashboard views: lazy-seeded `default` view (stamped `system`), rev-CAS
  update (`RevConflictError` on a stale write), single-default-view
  invariant (atomic promote/demote), delete guards (can't delete the default
  or the last view). Backs both `routes/dashboard.ts` and the MCP
  `get_dashboard`/`configure_dashboard` tools — parity law, §19.0.
- `activity.ts` — SPEC.md §19.4 `GET /activity`: merges `events` +
  `deliverability_actions` into one chronological, cursor-paginated feed
  (one UNION-ALL query, not two round trips merged in JS).
- `reporting.ts` — `campaign_results()` / `metrics()` / `account()`. Opens
  are never tracked anywhere in the schema (SPEC.md §6: opens OFF by
  default), so there is nothing to leak. Also exports
  `getDeliverabilitySummary` (reused by `ops-summary.ts`) and
  `emptyEventCounts` (reused by `campaigns.ts`'s `listCampaigns`).
- `ops-summary.ts` — D2/D6 admin surface: `getOpsSummary(ctx, sinceMs)`
  returns one tenant's plan/billing/usage/deliverability rollup +
  windowed deliverability-action counts. Dispatched via
  `TenantDO.opsSummary()`, called ONLY from `../admin/*` (never a tenant
  facade route) — see `../admin/README.md`.
- `webhooks.ts` — per-tenant OUTBOUND webhook subscription CRUD (SPEC.md §21 /
  ROADMAP.md WIN-THE-COMPARISON (d)). Backs both
  `routes/webhook-subscriptions.ts` and the MCP
  `get_webhooks`/`configure_webhook` tools (parity law). The signing secret is
  returned once at create/rotate; reads never re-expose it.
- `webhook-enqueue.ts` — `enqueueEventWebhooks`: the event -> delivery-queue
  fan-out. `recordEventIfNew` (events.ts) — the one once-per-new-event
  choke point — calls it, so a re-polled duplicate never enqueues twice.
- `webhook-delivery.ts` — the at-least-once delivery pump: retry with
  exponential backoff, per-attempt logging, auto-disable after N consecutive
  terminal failures, retention pruning. `pumpWebhookDeliveries(store, deliver,
  nowMs)` is time- + transport-injected (REAL wall-clock + real fetch in prod;
  test-controlled `nowMs` + a fake deliverer in specs), so the DO's
  `runWebhookDeliveries` (driven per-tenant by the cron sweep,
  `../admin/ops-sweep.ts`) and the tests exercise ONE code path.
- `webhook-security.ts` — the delivery security boundary: `assertSafeWebhookUrl`
  (https-only + SSRF private/link-local/metadata IP rejection, applied at
  create AND re-applied per delivery), HMAC-SHA256 body signing, and
  `realWebhookDeliverer` (strict timeout, no redirect following, truncated
  response snippet). See SPEC.md §21 for the DNS-resolution platform caveat.
- `byo-preflight.ts` — SPEC.md §20.1's pure pre-flight live-infra scan
  interpretation (`interpretPreflightScan`) + DNS-mode recommendation
  (`recommendDnsMode`: we_manage_zone vs records_to_apply, primary/DNSSEC/
  live-infra hard-refuse rules) + poll-verify criterion (`isDnsVerified`).
- `byo-abuse-gate.ts` — SPEC.md §20.3's BYO abuse gate: extends
  `brand-guard.ts`'s SAME denylist (exported from there) to the BYO domain
  itself + a bounded-Levenshtein/homoglyph lookalike check (the `paypa1.com`
  class). Never a hard reject — routes to `kyc_required`, never auto-admit.
- `byo-reputation.ts` — SPEC.md §20.5's non-primary reputation ladder
  (`computeReputationBranch`: established_good/unknown_fresh/blocklisted_reject),
  primary-axis-first (a primary domain never branches on reputation).
- `byo-ramp.ts` — SPEC.md §20.2/§20.5's domain-tier warmup/cap ramp
  (`rampTierFor`/`effectiveDailyCap`): a primary domain clamps to <=20/mbx/day
  at the standard ramp's own pacing (never compressed); a non-primary
  established-good domain gets a genuinely shortened (7-10 day) ramp. Composes
  `warmup.ts`'s existing pure math rather than duplicating it.
- `byo-breaker.ts` — SPEC.md §20.2's primary-domain complaint-rate circuit
  breaker (`evaluatePrimaryDomainBreaker`): a trailing-7-day windowed 3-condition
  AND (volume floor + absolute-complaint floor + rate), never a bare rate —
  the exact formula the adversarial review fought over 3 rounds (a griefing/
  false-pause vector at low volume otherwise).
- `byo-consent.ts` — SPEC.md §20.4's primary-domain consent mechanics:
  `buildConsentRecord` (domain + timestamp + scan snapshot) +
  `validateConsentAcknowledgment` (rejects anything short of an explicit `true`).
- `byo-intake.ts` — SPEC.md §20.1-§20.5's intake ORCHESTRATION (mirrors
  `provisioning.ts`'s role, but this domain is never bought):
  `registerByoDomain` (scan + abuse gate + reputation ladder -> starting
  byo_status), `pollByoDomainDns` (poll-verify + 7-day idle timeout ->
  abandoned), `acknowledgePrimaryDomainConsent`, `listByoDomains`/`getByoDomain`
  (read-only facade surface). Exports `requireByoDomainRow` for
  `byo-mailbox-composition.ts` to reuse.
- `byo-mailbox-composition.ts` — SPEC.md §20.6's mailbox COMPOSITION on an
  already-active BYO domain: `requestManagedByoMailboxes` (shape (a), the
  founder-ruled PRIMARY build target — platform-provisioned mailboxes, reuses
  `mailbox-provisioning.ts`'s `provisionMailboxesForDomain`) + `connectByoMailbox`
  (the Mordy-pilot BYO-mailbox seam — OAuth/SMTP+IMAP connect, maps onto
  `apps/engine/src/config.ts`'s transport discriminator; SECURITY POSTURE
  documented in its own doc comment — the connection secret is stored
  verbatim, tenant-isolated + encrypted-at-rest but not application-layer
  vaulted, and no read path ever selects it back).

Every function here takes a `TenantContext` (`../tenant-context.ts`): the
DO's own `SqlStorage` handle, tenant id, injected `Clock`, and the tenant's
`VendorAdapterBundle`. `tenant-do.ts` assembles the context once per RPC
call and dispatches into these modules — it holds no business logic itself.

## Why the tick/poll are directly-callable methods, not real alarms (HISTORICAL — see below)

B2 (ROADMAP.md) is where resumable, DO-alarm-driven scheduling lands. B0's
job is to prove the pipe end-to-end with an honest, directly-callable
`tick()`/`pollInbox()` RPC pair that a real alarm would call later — this
keeps the walking-skeleton test deterministic (no real waiting) without
overbuilding a scheduling system this phase doesn't need (CLAUDE.md rule i,
YAGNI).

**HISTORICAL as of wave-2.** The paragraph above described B0's walking
skeleton, where `tick()`/`pollInbox()` had no production driver at all — a
test/demo-only surface. That is no longer the whole picture: wave-2 (SPEC.md
§23) added a **5-minute cron leg** (`admin/ops-sweep.ts`'s
`runSendPipelineAllTenants`) that drives `runScheduledTick()`/
`runScheduledPoll()` — thin wrappers around this file's `tick()`/`pollInbox()`
gated by `engine/activation.ts`'s `readSendDriverGate` — for every tenant on
every cron cycle. The cron leg, not a DO alarm, is now the actual production
driver of automatic sending (design DECISION 1: alarms would add re-arm/
alarm-lost/constructor-re-arm failure classes a loud cron-leg error avoids,
and 5-minute worst-case latency is immaterial at cold-email's day/hour
cadence). `tick()`/`pollInbox()` themselves remain directly-callable and
untouched — the demo path and the existing test surface still drive them with
no activation predicate — but "no production driver" is the part of this
section that is now historical, not the RPC shape itself.

## msgchannel Inc5 — the agent->operator leg

- `contact-operator.ts` — `contact_operator` (MCP) / `POST /messages/contact-operator`:
  files a `source='agent'` support ticket in D1 and pushes ONE ops email
  through the shared `OpsMailer`. Owns the D1 write and the email composition,
  including the untrusted-content fence around every agent-authored body (an
  ops email's server-composed lines must stay unforgeable by the text they
  quote).
- `contact-operator-guard.ts` — that channel's dedup / 5-per-hour cap /
  ops-email throttle, over DO-local `agent_contact_log`. **Contains no
  `await` by design** — the whole decision runs inside one closed DO input
  gate, which is the only reason the cap holds under a concurrent burst. See
  the file header and `docs/adversarial/msgchannel-inc5-gate-2026-08-11.md`
  finding #1 for what happens when the same logic reads and writes D1.

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/*.test.ts`.
