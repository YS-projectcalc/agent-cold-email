# Audit — ops-sweep / watchtower alerting completeness (boundary-audit gaps 6+7)

- **Date:** 2026-08-06
- **Auditor:** adversary (fresh context), read-only git
- **Ground ref:** worktree `/Users/yaakovscher/dev/coldstart-worktrees/audit-alerting`, branch `audit-scratch-alerting-2026-08-06`, HEAD **`2e86b68`** (`git rev-parse HEAD`, matches the stated base off main)
- **Question:** when something breaks in production, does anything actually PAGE the founder, or does it fail silent?
- **Method:** fault injection against the real Worker + D1 + DO harness (`@cloudflare/vitest-pool-workers`), asserting that an **ops email was actually produced** (`SandboxOpsMailer.sent`), never that code "looks right". Probe files (scratch, delete with the branch):
  - `apps/platform/test/zz-audit-alerting-probe.test.ts` (D1 outage)
  - `apps/platform/test/zz-audit-alerting-e2e-probe.test.ts` (cred_push_aging, send_starved, provisioning)
  - `apps/platform/test/zz-audit-alerting-probe3.test.ts` (registrar spend, engine down, wedged DO)
  - `apps/platform/test/zz-audit-alerting-probe4.test.ts` (failure_signals flap)

## VERDICT: **FAIL** — 3 BLOCKING

The alerting surface is well-built where it is built: nine distinct alert producers all funnel through two correctly-throttled state machines, and the wave-2 additions genuinely fire end-to-end. The failure is in what the alerting depends on. **Every alert the platform can send requires D1 to be readable and the 5-minute cron to be firing, and neither of those two facts is itself alarmed.** The three blocking findings are all instances of that one root defect: the watchtower cannot report a failure of anything it stands on.

---

## Failure-class inventory

The single human-facing channel is ops email to `OPS_ALERT_EMAIL` (`yaakovscher@gmail.com`) over the `OPS_EMAIL` Cloudflare Email Service binding — armed and DNS-verified 2026-07-20 (`ACTIVATION.md:93`). There is **no other channel**: `wrangler.toml` declares no `[observability]`, no `tail_consumers`, no logpush, so a `console.error` pages nobody regardless of retention. "Alerts?" below means "an email a human receives".

| # | Failure class | Alerts? | Evidence | Verdict |
|---|---|---|---|---|
| 1 | **D1 unreachable** | **NO** | PROBE 1 (executed): all 10 cron legs fail, 0 emails | **BLOCKING-1** |
| 2 | **Cron stops firing / watchtower dies** | **NO** | no reader of `watchtower_cursor.last_sweep_ts` compares it to wall-clock; no heartbeat anywhere | **BLOCKING-2** |
| 3 | **One tenant's DO wedged (storage error)** | **NO** | PROBE 7 (executed): nothing names the tenant; `do_storage` reports **healthy** | **BLOCKING-3** |
| 4 | Any cron leg throws | NO | PROBE 1d: `runLeg` → `console.error` only (`scheduled.ts:45-52`) | subsumed by 1/2 |
| 5 | Leg silently returns wrong (`errors`/`budgetExpiries`/`skippedForLegDeadline` counters) | NO | counters returned → `console.log` (`scheduled.ts:101-104`); no reader | NB-2 |
| 6 | Digest `watchdogAlerts` (past_due, escalated tickets, **gave-up warmup cancels = money leaking**, pending cred pushes) | NO | built at `ops-sweep.ts:524-546`, returned to `scheduled.ts:60`, only logged; readable solely on demand via `GET /admin/ops/digest` | NB-3 |
| 7 | Provisioning vendor failure on a paying tenant (incl. **after registrar spend**) | NO | PROBE 5 / 5b (executed): domain bought, DNS failed, 0 emails | NB-4 |
| 8 | Auto-send failure signals (terminal-failed sends, complaints) | YES — but **flaps** | PROBE 8 (executed): 24 emails in 2 h on an intermittent pattern | NB-1 |
| 9 | Credential-push aging (`cred_push_aging:<email>`) | **YES** | PROBE 2 (executed E2E): real row → cron → `[coldrig] Mailbox credentials …: UNHEALTHY` | OK |
| 10 | Send starvation (`send_starved:<tenantId>`) | **YES** | PROBE 3 (executed E2E) | OK |
| 11 | Engine droplet down/unreachable | **YES** | PROBE 6 (executed): `[coldrig] Engine /health: UNHEALTHY` | OK |
| 12 | Stripe event accepted but unroutable / refused as out-of-order | **YES** | wired at `routes/webhooks.ts:110-121` → `alertUnroutableStripeEvent` | OK |
| 13 | SDN/OFAC list load failing or stale | **YES** | `ofac/sdn-alert.ts` `reconcileSdnAlert`, 6 h cooldown + recovery | OK |
| 14 | OFAC screening hit / list-unavailable hold | **YES** | `ofac/screening-alert.ts`, both variants | OK |
| 15 | Registrar not armed on a purchase attempt | **YES** | `engine/registrar-alert.ts` | OK |
| 16 | Spend-ceiling capacity-pending | **YES** | `engine/spend-ceiling.ts:156-189`, transition-gated | OK |
| 17 | Mailbox purchase stuck / re-buy failed | **YES** | `engine/mailbox-acquisition.ts` via `reportCheck` | OK |
| 18 | Dunning suspend applied | **YES** | founder copy at `ops-sweep.ts:153-167` | OK |

---

## Findings

### BLOCKING-1 · Lens 2 (run it) · A D1 outage is a total, silent alerting blackout — and the `d1` health check that exists for it can never fire

`evaluateHealthChecks` opens with a `SELECT 1` wrapped in try/catch, producing a `{name:"d1", healthy:false}` result and an email template labelled "D1 database" (`admin/watchtower.ts:146-151`, `:58`). That check is unreachable in the case it is named for, because the code that would deliver it reads D1 twice more, unguarded:

- `admin/watchtower.ts:184` — `listAllTenantIds(env)` (D1) throws, aborting `evaluateHealthChecks` before it ever returns the `d1` result.
- `admin/watchtower.ts:191` — `readReportedCheckNames(env)` (D1), same.
- `admin/watchtower.ts:294` — even if handed the unhealthy result directly, `reconcileAlerts` calls `readWatchtowerState(env)` (D1) **before** any `trySend`.

**Failure scenario (executed).** D1 returns `D1_ERROR: Network connection lost.` on every statement. All ten cron legs fail; the sweep does not throw (each leg is caught by `runLeg`); the founder receives **zero** emails; the only record is ten `console.error` lines that go to no configured sink.

```
scheduled ops sweep: "deliverability" leg failed … "digest" … "dunning" … "sdnRecovery"
… "sdnRefresh" … "sendPipeline" … "spendReservations" … "warmupCancel" … "watchtower"
… "webhooks" leg failed — other legs still ran this tick
```

`file:line` — `apps/platform/src/admin/watchtower.ts:184`, `:191`, `:294`; `apps/platform/src/scheduled.ts:45-52`.
**Verification:** ran `apps/platform/test/zz-audit-alerting-probe.test.ts` (4/4 assertions pass, including the inline snapshot of the ten failed legs above).

**Why this is a defect and not an unavoidable limit:** the send path does **not** depend on D1. `RealOpsMailer.send` uses only the `send_email` binding (`ops-mail/real-ops-mailer.ts:24-35`). An alert is deliverable during a full D1 outage; the code simply orders D1 reads ahead of the send.

**Self-refutation performed.** For an *intermittent* D1 error the check does work: `SELECT 1` fails, the subsequent reads succeed, the email goes out. So the check is not dead — it covers a blip and is structurally incapable of covering a sustained outage, which is the case that matters. Graded BLOCKING on that basis, not on "the check never works".

---

### BLOCKING-2 · Lens 4 (arm-time plumbing) / Lens 6 (design) · Nobody watches the watchtower — there is no dead-man signal, and the planned external prober would not provide one

If `scheduled()` stops being invoked — cron trigger disabled, a deploy that drops `[triggers]`, a Cloudflare-side cron incident, or a Worker that fails to start — every alert in the table above stops, and **silence is indistinguishable from health**. I searched for any liveness concept: `watchtower_cursor.last_sweep_ts` is written at `admin/watchtower.ts:485-492` and read at `:480-483` **only by the sweep itself**, to set its own scan window. Nothing anywhere compares it to wall-clock; there is no heartbeat, no `last_sweep` staleness check, no alarm.

The compensating control is `ACTIVATION.md:100` step 7, an out-of-band 5-minute external prober — **still open**, and explicitly named at `ACTIVATION.md:103` as the designed backstop for the known alert-loss residual. Two problems:

1. It is not built. `ACTIVATION.md:20` states the prerequisite plainly: *"Do NOT flip any tenant onto the real EmailPort until the Gate 4 Ops email + monitoring (watchtower) block is armed AND verified: the founder-alert channel + the 5-minute external prober are how you learn a real send path broke."* Wave 2 ships `AUTOSEND_DISABLED` unset (armed) and `ACTIVATION.md:74-79` step 2 is "arm `ENGINE_*`/`INBOXKIT_*` for the paying tenant" — i.e. the prober is a prerequisite for the *next* step on the paying customer's path.
2. **Even when built it would not close this.** Its target is `/status`, which is a bare `SELECT 1` returning `{status:"ok"}` (`routes/status.ts:7-15`). That is green with a perfectly dead cron. The prober detects "Worker or D1 down"; it cannot detect "cron stopped", which is the failure this finding is about.

`file:line` — `apps/platform/src/admin/watchtower.ts:480-492`; `apps/platform/src/routes/status.ts:7-15`; `ACTIVATION.md:20`, `:100`, `:103`.
**Verification:** exhaustive grep for any reader of `last_sweep_ts` / `dead.?man` / `heartbeat` / `cron.?stall` / `sweep.?stale` across `apps/platform/src` — the only four hits are the cursor's own read/write pair. Read `routes/status.ts` in full.

**Self-refutation performed.** I checked whether the founder would notice by other means: the digest is log-only (NB-3), the dashboard reads DO state directly rather than sweep freshness, and support@ inbound is customer-initiated. There is no passive path by which a stopped cron surfaces. I also checked whether this is merely theoretical — it is not: BLOCKING-1 is a *live* mechanism that stops the watchtower for as long as D1 is degraded, with no upper bound and no notification on either edge.

---

### BLOCKING-3 · Lens 5 (fixture realism) · A wedged tenant DO makes that tenant invisible to every check, while `do_storage` reports healthy

`evaluateHealthChecks`'s per-tenant loop catches and counts nothing — it logs and continues (`admin/watchtower.ts:198-200`). For the tenant that throws, this silently drops, in one pass: its failure-signal contribution, its `cred_push_aging:<email>` checks, and its `send_starved:<tenantId>` check. The same tenant is simultaneously skipped by the dunning sweep, the deliverability sweep, the digest and the send pipeline (each has its own `errors++` catch). The tenant is completely unmonitored and completely unswept.

Meanwhile the DO health probe pings `env.SIGNUP_LIMITER` — a **`RateLimiterDO`** canary named `__watchtower_probe__` (`admin/watchtower.ts:29`, `:155`), a different Durable Object class from `TenantDO`, holding no customer state. So the check named "Durable Object storage" reports healthy while the DO that holds all of the paying customer's state is throwing on every read.

**Failure scenario (executed).** A paid, activated tenant whose `opsSummary` throws `no such table: scheduled_sends: SQLITE_ERROR`. `runWatchtower` completes normally; no email names the tenant; `evaluateHealthChecks` returns `{name:"do_storage", healthy:true, detail:"DO storage probe ok"}`.

`file:line` — `apps/platform/src/admin/watchtower.ts:192-201`, `:29`, `:155`.
**Verification:** ran `apps/platform/test/zz-audit-alerting-probe3.test.ts` PROBE 7 — both assertions pass.

**Self-refutation performed.** My injected fault (`DROP TABLE`) is artificial, so I checked reachability against real mechanisms rather than asserting it. Three are documented in this repo's own history: (i) `wave2-integration-gate-2026-08-06.md` records a DO that **500s at construction** with `no such column: lane` after a mid-wave table re-key — every RPC to it throws, which is exactly this shape; (ii) `incident-hotfix-gate-2026-08-05.md` H4 exists because a `UNIQUE`-constraint throw in the constructor "would 500 every intent for the tenant, permanently"; (iii) the `agent-memory` dunning entry records a wedged/overloaded DO as the anticipated cause of `opsSummary` throwing. This is a shape the codebase has already defended against elsewhere — it is not hypothetical, and the monitoring is blind to it.

---

### NB-1 · Lens 6 (attack the design) · `failure_signals` will flap once real sending is armed — the exact cry-wolf class `sdn-alert.ts` was built to fix

`failure_signals` is healthy iff `failed + complaints === 0` for events **since the last sweep** (`admin/watchtower.ts:202-210`, counts from `engine/ops-summary.ts:220-226`: `events.type IN ('failed','complaint')`, where `'failed'` includes CAN-SPAM refusals per `engine/tick.ts:375`). It is global across all tenants and the email names no tenant.

Because each 5-minute window is evaluated independently, an intermittent failure rate produces a genuine `unhealthy → healthy → unhealthy` **state transition** every cycle, and the 6 h cooldown suppresses none of it — the cooldown only throttles `unhealthy → unhealthy`.

**Executed:** 24 sweeps over 2 simulated hours, one failure in alternating windows → **24 emails** (12 `UNHEALTHY`, 12 `RECOVERED`, strictly alternating). Same probe with a *sustained* failure → **1 email**, correctly throttled. So the state machine is right for persistence and wrong for intermittence.

This is the class `ofac/sdn-alert.ts`'s header documents as founder-reported ("160 identical emails in one day", 2026-07-24) and the 2026-07-27 re-attack found again as `RECOVERED`-flapping. It is live in the watchtower's own check.

`file:line` — `apps/platform/src/admin/watchtower.ts:202-210`; `apps/platform/src/engine/ops-summary.ts:220-226`.
**Verification:** ran `apps/platform/test/zz-audit-alerting-probe4.test.ts`, both inline snapshots (`24` and `1`).

**Why NON-BLOCKING:** latent today — `realSendPathLive` requires `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`, which `ACTIVATION.md:74-79` step 2 shows are not yet armed for the paying tenant, so no real sends exist to fail. **It arms with the customer.** Its real cost is compound: a founder trained to ignore `[coldrig] …: UNHEALTHY` is the mechanism by which BLOCKING-1/2/3 become permanent.

### NB-2 · Lens 1 (spec-vs-code) · Every cron leg's error counter is a number nobody reads

`runScheduledOpsSweep` collects ten leg results and `console.log`s them as one JSON line (`scheduled.ts:101-104`). Those results carry `errors` (dunning, deliverability, warmupCancel, webhooks, digest, sendPipeline), plus the send pipeline's `budgetExpiries` and `skippedForLegDeadline` (`ops-sweep.ts:295-309`). A tenant failing every cycle, or a wedged engine causing every tenant to be abandoned at its budget, increments these forever with no threshold, no persistence and no alert. `admin/ops-sweep.ts:29-33`'s own comment frames `errors` as the safety property; nothing consumes it.
**Verification:** grepped every reader of the ten leg return values — the sole consumer is the `console.log`.

### NB-3 · Lens 1 · The digest's `watchdogAlerts` are computed every 5 minutes and thrown away

`buildOpsDigest` composes six threshold-crossing alert strings (`ops-sweep.ts:524-546`) — including `gaveUpWarmupCancels`, whose own comment says "this is money leaking" (InboxKit subscriptions that may still be billing), and `pendingCredentialPushes`. On the cron path the entire digest is assigned at `scheduled.ts:60` and only logged. The founder sees these only by manually calling `GET /admin/ops/digest` with the admin token. A pull-only alert on money leaking is not an alert.
**Verification:** `buildOpsDigest` has exactly two call sites (`scheduled.ts:60`, `routes/admin-ops.ts:39`); neither emails.

### NB-4 · Lens 6 · A provisioning vendor failure on a paying tenant — including one that has already spent registrar money — alerts nobody

Provisioning has four founder alerts (registrar-unarmed, mailbox stuck, re-buy failed, capacity-pending). A plain vendor failure is covered by none.

**Executed, two shapes:**
- The 2026-08-05 incident shape — domain `tryprobeco.com` **bought** (real registrar spend), then `setDns` throws. Result: `bought: ["tryprobeco.com"]`, customer's agent receives *"domain tryprobeco.com is registered and recorded, but its DNS setup has not completed yet. Nothing was lost — retry to finish it."*, `sent: []`. The next `runWatchtower` pass also emits nothing naming the tenant.
- A hard vendor 500 at registration → `threw: "inboxkit domains/register failed: HTTP 500 upstream registrar error"`, `sent: []`.

`file:line` — `apps/platform/src/admin/ops-sweep.ts:553` (`provisioningFailureCount: 0`, literal).
**Verification:** ran `zz-audit-alerting-probe3.test.ts` PROBE 5 / 5b. First fixture attempt was invalid (aborted on a missing `physicalAddress` before reaching the vendor, and injected the port under the wrong bundle key `domains` instead of `domain`); both corrected, and the `bought` array now proves the injected port was genuinely called.

**Why NON-BLOCKING, honestly:** the H2/H3 incident fixes make this self-healing — the domain is recorded before DNS, so the agent's retry adopts it with zero new spend, and the customer *does* see a clear retryable error and can reach support@ (which forwards to `OPS_ALERT_EMAIL`). The founder's only path to learning is the customer complaining. **This is a known, deliberately-deferred item, not a new discovery:** the deep-dive flagged `provisioningFailureCount: 0` and `incident-hotfix-gate-2026-08-05.md:209` and `:354` re-confirm F8 as untouched-on-purpose. Reported here for inventory completeness.

---

## GAP 6 — drift diff-checks

### (a) OFAC / SDN lane — **CLEAN (with a coverage caveat)**

Last frozen OFAC/SDN review: `docs/adversarial/sdn-unchanged-fix-review-2026-07-27.md`, frozen at `3da0041`. Files checked: `apps/platform/src/ofac/**`, `routes/admin-sdn-ingest.ts`, `routes/admin-screening.ts`, `tools/**`.

`git log --oneline 3da0041..HEAD -- <those paths>` returns three commits, all accounted for:

| commit | files | covered by |
|---|---|---|
| `d85bdd4` + merge `f583fe5` | `ofac/sdn-ingest.ts`, `ofac/sdn-list.ts`, `tools/sdn-relay/README.md` | the 07-27 review itself — this is the `touchSdnListFreshness` round-2 fix it graded SHIP |
| `fad3a3e` (2026-08-05) | `ofac/screening.ts` (+14/−1) | `incident-hotfix-gate-2026-08-05.md:209-211` |

**Caveat, not a finding.** `fad3a3e` changes *which brand the OFAC screen evaluates* (adds a `brand` override so `setup_infrastructure`'s re-screen reads the incoming brand rather than the not-yet-written persisted one). That is a compliance control, and its entire adversarial coverage is one sentence in a *provisioning* gate's "Scope integrity" bullet: *"moving `screenTenant` before the profile write (with the new `brand` override) is a strict improvement, not a regression."* Defensible, and I re-read the diff and agree with it — but it is thin coverage for a sanctions-screening change, and no OFAC-lane review has run since.
**Verification:** `git log`/`git show --stat` per path against both `3da0041` and `7fab312`; grepped the hotfix-gate doc for `screen|ofac|sdn` and read the one hit in full context.

### (b) Outbound-webhook lane — **CLEAN**

Last frozen review: `docs/adversarial/webhooks-lane-2026-07-16.md` (base `bf3a927`), frozen at `d0e91ec`. Files checked: `engine/webhook-delivery.ts`, `engine/webhook-enqueue.ts`, `engine/webhook-security.ts`, `engine/webhooks.ts`, `routes/webhook-subscriptions.ts`, `packages/shared/src/webhooks.ts`.

Exactly one commit since: `7ce59dc` (2026-07-21, `webhook-enqueue.ts` +5/−1, `packages/shared/src/webhooks.ts` +13/−4) — and it is explicitly in scope of a later frozen review: `warm-lead-build-review-2026-07-21.md` names it in its target line ("`7ce59dc` webhook-choke extraction"), verdict SHIP. No drift.

---

## Attacks that FAILED (what makes the OK rows mean anything)

- **`cred_push_aging` is a scripted-fixture illusion.** Refuted. The existing suite tests the pure `sendPipelineChecks` against a synthetic `TenantOpsSummary`, which is exactly the shape that hides a broken pipeline — so I drove it end-to-end instead: real `mailbox_cred_pushes` row (`status='pending'`, `updated_at` 45 min old) in a real activated tenant's DO → `runWatchtower(env, mailer, now)` → `[coldrig] Mailbox credentials stuck@agingco-probe.com: UNHEALTHY`. It genuinely fires.
- **`send_starved` likewise.** Real `campaigns` + `scheduled_sends` rows (due, non-demo) on a tenant with zero eligible mailboxes → `[coldrig] Send capacity <tenantId>: UNHEALTHY`. Fires.
- **The engine-down leg is decorative.** Refuted — `ENGINE_BASE_URL` pointed at an unresolvable host produced `[coldrig] Engine /health: UNHEALTHY`. (With `ENGINE_BASE_URL` unset the check is omitted entirely, which is deliberate and documented at `watchtower.ts:161-163`; `ENGINE_BASE_URL` is armed in prod per `ACTIVATION.md:60`.)
- **The wave-2 "refusals now ALERT" claim is unwired.** Refuted — `routes/webhooks.ts:110-121` calls `alertUnroutableStripeEvent` on `result.stale`, and that function emails for `HANDLED_STRIPE_EVENT_TYPES` while staying quiet for inert types.
- **The ops mail channel is still dark, so every alert is swallowed.** Refuted — `ACTIVATION.md:93` records Email Sending enabled on `coldrig.dev` with all four DNS records `dig`-verified, destination `yaakovscher@gmail.com` verified, and an end-to-end delivery confirmed. The channel is live; `wrangler.toml` binds `OPS_EMAIL` and sets `OPS_ALERT_EMAIL`.
- **`OPS_ALERT_EMAIL` unset would silently disable alerts.** Held-ish and not a finding: it is a non-optional `string` in `env.ts:135` and a literal `[vars]` entry in `wrangler.toml`, so the guards (`if (!env.OPS_ALERT_EMAIL) return`) are unreachable in the deployed config.
- **The SDN alert regressed to per-attempt storming.** Refuted — `reconcileSdnAlert` retains the streak/cooldown/recovery state machine over `sdn_alert_state`, unchanged since the 07-27 round-2 SHIP.
- **The dunning suspend applies without telling anyone.** Refuted — `ops-sweep.ts:153-167` sends a founder copy alongside the tenant notice, and flags explicitly when no tenant contact email is on file.
- **A leg throw takes down the whole tick (the pre-`runLeg` class).** Refuted — F1's `runLeg` genuinely isolates all ten legs; PROBE 1d shows nine legs still attempted after the first fails. The isolation is real; the *reporting* is what is missing.

## UNVERIFIABLE

- **Whether Cloudflare Workers Logs retains these `console.error` lines at all** (no `[observability]` block in `wrangler.toml`; the platform default for wrangler-deployed Workers is version-dependent). Immaterial to the verdict — retained-or-not, a log line pages nobody, and the founder is not watching a log console. Resolves with `wrangler tail` / a dashboard check, or by adding `[observability] enabled = true` deliberately.
- **Whether the cron is currently firing in production.** Not checked — this audit never touches live systems. Last positive evidence is `ACTIVATION.md:93` (`wrangler tail`, 2026-07-20) and the wave-2 ledger's "first live cron cycle on 13 tenants, 413ms". Resolves with a `wrangler tail` window.
- **Real-world intermittency rate of `failure_signals` once sending is armed** — NB-1's 24-emails-per-2-hours is a simulated pattern, not a measured one. The mechanism is proven; the frequency is not. Resolves by watching the first week of real sends.

## NEW (out of scope, no verdict weight)

- `admin/watchtower.ts:252` — `sendPipelineChecks` skips clearing a `cred_push_aging` alert unless the email still appears in `summary.mailboxProvenance` (the "another tenant's mailbox" guard). A mailbox that is **deleted** rather than released would therefore keep an `unhealthy` row forever, re-alerting every 6 h with no way to clear it. I did not establish that any writer deletes `mailboxes` rows, so this is unproven and listed as an observation only.
- `watchtower_state` grows one row per mailbox address ever alerted on, with no pruning. `readWatchtowerState` and `readReportedCheckNames` each `SELECT` the whole table on every 5-minute sweep. Fine at current scale; worth a bound before it is not.
