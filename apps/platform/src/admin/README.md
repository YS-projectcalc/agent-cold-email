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
  (`migrations/0002_admin_ops.sql`): `support_tickets`, `dunning_events`,
  plus `listAllTenantIds` (the D1 tenants_index id list that drives every
  cross-tenant sweep/digest). Also owns the G1 `screening_reviews` queue
  (`migrations/0012_sdn_screening.sql`) — `upsertScreeningReview`/
  `listPendingScreeningReviews`/`getScreeningReview`/`resolveScreeningReview`.
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
- `watchtower.ts` — **D2 monitoring**: health probes (D1, DO storage, engine
  `/health` when configured, a cross-tenant failure-signal scan) + the
  founder-alert STATE MACHINE (`reconcileAlerts`) — alerts on a health CHANGE,
  re-alerts on persistence after a 6h cooldown, recovers on heal, never
  storms. Dedupe state in D1 (`migrations/0008_watchtower.sql`). Runs on the
  ops-sweep cron.
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

1. Reads the tenant **id list** from D1 (`listAllTenantIds`) — the one thing
   D1 is trusted for.
2. For each id, calls that tenant's own DO stub's `opsSummary()` RPC
   (`../engine/ops-summary.ts`) to get the AUTHORITATIVE plan/billing/usage/
   deliverability state — never reads another tenant's SqlStorage directly.

This is a per-request RPC fan-out over every tenant — **acceptable at
test-mode scale** (ROADMAP.md), not the long-term design: ARCHITECTURE.md #3
already names the scale path as a D1/Analytics read-model fed by Queues
(cross-tenant reporting + the abuse-aggregation loop), which is where this
moves once tenant count makes a full fan-out slow.

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
  (an in-CF watchtower can't report CF being down).
- **D2/D6 cron schedule**: the `[triggers]` cron in `wrangler.toml` is now
  ARMED (every 5 min). It goes live on the next deploy; the email legs stay
  log-only until the sending domain is onboarded.

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/admin-*.test.ts`
and `apps/platform/test/status.test.ts`.
