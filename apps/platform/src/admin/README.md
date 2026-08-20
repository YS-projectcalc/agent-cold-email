# src/admin

The **owner/ops-facing admin surface** (ROADMAP.md Phase D: D1 support
triage, D2 dunning/ops sweeps, D6 owner business-health digest) — SEPARATE
from the tenant-facing `/mcp` + REST facade in `../routes/*.ts`. SPEC.md
§0.10: *"Support/ops: AI-run by default (built now, armed at activation) —
the business itself must run on agents with a digest to the owner."* This is
that lane: built and testable now, with the owner-hands wiring (real inbound
support email, the cron schedule, real dunning emails) documented as
ACTIVATION.md steps rather than built against real vendors (CLAUDE.md: no
real vendor spend before activation).

## Auth model

Every `/admin/*` route requires `Authorization: Bearer <ADMIN_TOKEN>`,
checked by `../require-admin-auth.ts` with a timing-safe compare against
`env.ADMIN_TOKEN` — a single owner-held secret, **not** a per-tenant token
from `../require-auth.ts`. These routes read and mutate CROSS-tenant data
(every tenant's billing state, every support ticket), so tenant-token auth
would be the wrong isolation boundary entirely. `ADMIN_TOKEN` is unset by
default in this build (like `STRIPE_SECRET_KEY`) — the middleware fails
closed (401 on every call) rather than falling open. Set it via
`wrangler secret put ADMIN_TOKEN` for a deployed environment, or copy
`.dev.vars.example` -> `.dev.vars` locally.

## Layout

- `schemas.ts` — zod input schemas for the admin routes (kept separate from
  `@coldstart/shared`'s tenant-facing intent schemas — this surface is not
  part of the MCP tool contract).
- `support-kb.ts` — **D1**: pure `classifySupportMessage` /
  `triageSupportMessage`. Classifies an inbound message into
  billing / deliverability / how-to / abuse-report / other, and for the
  first three drafts an answer from a small built-in knowledge base grounded
  in the real product (SPEC.md §6 tools, §18 pricing, the `npx
  agent-cold-email demo` no-signup demo, §7/§10 guardrails, honest
  limitations). `abuse-report` and `other` always escalate — never
  auto-answered.
- `dunning.ts` — **D2**: pure `decideDunningAction(failureCount)` — retry /
  escalate / suspend, mirroring `../engine/deliverability.ts`'s
  monitor-decide-act shape.
- `db.ts` — D1 helpers for the control-plane tables
  (`migrations/0002_admin_ops.sql`): `support_tickets`, `dunning_events`.
  Also owns the G1 `screening_reviews` queue
  (`migrations/0012_sdn_screening.sql`) — `upsertScreeningReview`/
  `listPendingScreeningReviews`/`getScreeningReview`/`resolveScreeningReview`.
- `sweep-budget.ts` — the cron tick's BUDGET ARITHMETIC (pure): the
  subrequest ceiling, the derived fan-out wall-clock deadline, and the tenant
  slice both of them size. Every number is derived rather than chosen, so
  raising one constant cannot silently break the invariant another depends on
  (`test/sweep-budget.test.ts`).
- `tenant-slice.ts` — the bounded tenant window that arithmetic produces: the
  keyset cursor read/commit and `sweepTenants`, the one isolated per-tenant
  loop the six fan-out legs share.
- `watchtower-roster.ts` — which always-on checks a completed sweep is
  EXPECTED to have written a row for, given this environment's config. The
  denominator `GET /admin/ops/checks` publishes so a skip-dark check that
  vanished with a lost env var is visible instead of merely absent.
- `terminate.ts` — the shared D5 "suspend + reclaim infra + lock the
  control-plane token + log an enforcement_actions row" sequence, extracted
  from the terminate route so G1b's screening-`reject` path
  (`../routes/admin-screening.ts`) reuses the SAME mechanics instead of a
  second implementation.
- `ops-sweep.ts` — the actual cross-tenant iteration + aggregation logic
  (`runDunningSweep`, `runDeliverabilitySweepAllTenants`, `buildOpsDigest`),
  shared by `../routes/admin-ops.ts` (on-demand) AND `../scheduled.ts`
  (cron) so the two can never drift (CLAUDE.md rule c). `runDunningSweep` now
  emails a suspend notice (tenant + founder copy) via the OpsMailer
  (`../ops-mail/`) on a newly-applied suspend — best-effort, never blocking
  the suspend.
- `watchtower.ts` — **D2 monitoring**: health probes (D1, DO storage across
  BOTH DO classes, engine `/health` when configured, a cross-tenant
  failure-signal scan, a per-tenant "this DO is not answering" check) + the
  D1-backed founder-alert state machine (`reconcileAlerts`) — alerts on a
  CONFIRMED health change, re-alerts on persistence after a backoff, recovers
  on heal, never storms. Dedupe state in D1 (`migrations/0008_watchtower.sql`
  + `0018_watchtower_debounce.sql`). Runs on the ops-sweep cron.
- `watchtower-alerts.ts` — the alert VOCABULARY: what a `CheckResult` is, which
  policy each named check gets (`policyFor`), and how its email renders.
- `watchtower-policy.ts` — the PURE transition rule (`decideAlert`) and the
  policy dials, extracted because two stores back the same machine and the
  anti-storm rules must be identical in both. Founder ruling 2026-08-16: a
  check must be observed unhealthy on **2** observations before its first email
  (a single-sweep flap sends nothing, recovery included), then re-alerts at +6h
  and every 24h after that. `policyFor` is the ONE place that turns the debounce
  off, and it does so for exactly three reasons — the `cron_sweep` dead-man
  (hard exemption: it already embodies `SWEEP_STALE_MS` and is the check of last
  resort), `cron_legs` (already damped over 3 consecutive ticks upstream, so a
  debounce would push it past the 10-15 min paging ceiling), and the one-shot
  event reports raised by `reportCheck` (nothing re-observes them, so a debounce
  would silence them permanently).

  **Not "consecutive" any more** (alert-state increment, `migrations/0021_*`):
  `unhealthy_obs` is zeroed by an episode CLOSE, not by a healthy observation,
  and a `reobserved` clear needs `recoverAfterObservations` observations to
  close (the `holding` action). Before that, a fault alternating bad/good never
  assembled two in a row and stayed silent forever. A `no_longer_applicable`
  clear still closes in ONE observation — it says the entity LEFT the
  population, and a departed entity never produces another observation.
- `watchtower-families.ts` — the per-family table: the CLOSED set of materiality
  keys each check's producer may state, whether the family is per-entity, and
  whether its announcements are budgeted. A key is what lets the machine tell a
  REPEAT from an ESCALATION inside an announced episode; it is never the detail
  string and never a count, both of which move almost every tick.
  `MAX_ANNOUNCED_KEYS_PER_EPISODE` is STRICTLY greater than the widest declared
  space, so the cap can only ever bind on a mis-derived key.
- `watchtower-budget.ts` — the rolling 24h ANNOUNCEMENT budget (a bounded ring
  of send timestamps in WatchtowerDO storage, never a tumbling window). A
  per-episode cap cannot bound a per-DAY inbox count across an unbounded
  instance count. <=20 announcements total, of which <=15 may be per-entity so
  the global and monitor families always have 5 slots. The budget may delay an
  ANNOUNCEMENT; it may never delay an episode CLOSE (recoveries are exempt), and
  it may never suppress the report that it is itself suppressing
  (`alert_budget_exceeded` is exempt, and `saturated` reads EITHER counter).
- `watchtower-grading.ts` — PURE observation damping between "what one probe
  saw this tick" and "what the state machine is told" (trailing window +
  threshold for event counts; N-up/M-down streak for per-tick booleans). A
  `null` grade means HOLD: report nothing, change nothing.
- `watchtower-infra.ts` + `../watchtower-do.ts` — the checks that CANNOT use
  D1, because D1 or the cron is what they are alarming on: the `d1` check is
  throttled in Durable Object storage, and a DO ALARM is the in-platform
  dead-man for the cron itself. `GET /status` serves sweep freshness from here
  so an external prober is a real dead-man too.
- `sweep-signals.ts` — routes the cron sweep's OWN return values (per-leg
  `errors` / `budgetExpiries` / `skippedForLegDeadline`, a leg that threw, and
  the digest's gave-up warmup cancellations) into the same throttled alert
  path. Before this they were counted and then logged to nobody.
- `support-inbound.ts` — **D1**: the inbound support@ handler
  (`handleInboundSupportEmail`) wired to the Worker's `email()` export
  (`../index.ts`). Parses the raw MIME (postal-mime), runs `support-kb.ts`
  triage, persists an ops ticket, and forwards a copy to the founder. Never
  auto-replies (triage drafts stay drafts).

Routes live in `../routes/admin-support.ts` / `../routes/admin-ops.ts` /
`../routes/admin-screening.ts` (see `../routes/README.md`) — kept with the
other route files so "one file per intent cluster" stays a single convention,
not two.

## G1 — OFAC/SDN screening review queue

`GET /admin/screening/reviews` lists every tenant currently held for review;
`POST /admin/tenants/:id/screening` (`{decision:'clear'|'reject', note}`)
resolves one. `clear` un-blocks activation on the tenant's own DO (via a new
`TenantDO.clearScreening()` RPC) and marks the D1 review row `'cleared'`.
`reject` reuses `terminate.ts`'s exact D5 abuse-offboarding sequence (never a
silent "still under review" — a confirmed match is suspended and its infra
reclaimed) and marks the review row `'rejected'`. See `../ofac/README.md` for
the screening pipeline itself (list build + matcher + the `screenTenant`
write path).

## Cross-tenant aggregation — how it stays tenant-isolated

Per-tenant state (billing, deliverability, usage) lives in each tenant's own
`TenantDO` SQLite storage, never in D1 (ARCHITECTURE.md #3). D1 only holds
the control-plane index (`tenants_index` — token->tenant + a plan/status
mirror captured AT SIGNUP, which can go stale after a checkout upgrade or
Stripe webhook — see `../db.ts`). So every sweep/digest here:

1. Reads a **bounded slice** of the tenant id list from D1
   (`tenant-slice.ts`) — the one thing D1 is trusted for.
2. For each id in that slice, calls that tenant's own DO stub's `opsSummary()`
   RPC (`../engine/ops-summary.ts`) to get the AUTHORITATIVE plan/billing/
   usage/deliverability state — never reads another tenant's SqlStorage
   directly.

### Why a slice, and what it costs

The cron used to fan every leg out over the WHOLE index on every tick: a
measured 8.0 DO RPCs per tenant, `subrequests(N) ~= 8N + 29`, crossing 1,000 at
N = 122 (`docs/adversarial/scale-readiness-audit-2026-08-17.md`, S1). Above
that the invocation's subrequest budget ran out mid-sweep and every remaining
leg threw instantly into `runLeg`'s catch — including the dead-man heartbeat,
which is deliberately LAST because it means "this tick ran to completion". The
platform then paged the founder that the scheduler was dead while what had
actually stopped was automatic sending.

`sweep-budget.ts` derives one tenant slice per tick from two independent
ceilings (the invocation's subrequest budget, and the wall clock the 300s cron
period has left after the send pipeline's own bounds). `tenant-slice.ts`
keyset-pages the index against a persisted cursor that advances only as far as
the LEAST-covered leg got, so every leg still reaches every tenant — just
across `ceil(total / slice)` ticks rather than every tick.

That coverage latency is the price, and it is PUBLISHED rather than emergent:
the `sweep_coverage` watchtower check reports the rotation length and alerts
once a full pass takes longer than an hour. When it fires, the answer is the
D1/Analytics read-model ARCHITECTURE.md #3 already names as the scale path —
NOT a bigger slice, which is bounded by the subrequest budget and is what used
to make the heartbeat vanish.

An on-demand caller (`POST /admin/ops/dunning-sweep`, `GET /admin/ops/digest`)
passes no slice and gets a bounded full scan, with `tenants.scanned` beside
`tenants.total` so a capped pass can never read as a complete one.

## What's built now, dark until the owner onboards the domain

The outbound/inbound email channel is now BUILT (Cloudflare Email Service — the
`send_email` binding + Email Routing), not just documented. It ships DARK: the
code degrades to log-only until the owner runs the ACTIVATION.md "Ops email +
monitoring" runbook (`wrangler email sending enable coldrig.dev`, routing +
verified destination, route support@). Nothing breaks pre-arming — an
unsendable email is caught and logged.

- **D1 inbound email**: the Worker's `email()` handler (`../index.ts` ->
  `support-inbound.ts`) parses, triages, persists a ticket, and forwards to
  the founder. Owner-hands step: enable Email Routing + route
  `support@coldrig.dev` to this Worker + verify the forward destination.
- **D2 dunning emails**: `runDunningSweep` sends a real suspend notice
  (tenant + founder copy) via the OpsMailer. Owner-hands step: `wrangler email
  sending enable coldrig.dev` so `OPS_EMAIL.send()` isn't `E_SENDER_NOT_VERIFIED`.
- **D2 watchtower alerts**: `watchtower.ts` emails the founder on a health
  state change. Same sending prerequisite as dunning + a 5-min EXTERNAL prober
  (an in-CF watchtower can't report CF being down). The prober should treat any
  non-2xx from `GET /status` as an incident — that route now reports DEGRADED
  when the ops sweep has gone stale, which is what makes it a dead-man rather
  than a liveness check for the Worker alone.
- **D2/D6 cron schedule**: the `[triggers]` cron in `wrangler.toml` is now
  ARMED (every 5 min). It goes live on the next deploy; the email legs stay
  log-only until the sending domain is onboarded.

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/admin-*.test.ts`
and `apps/platform/test/status.test.ts`.
