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
- `db.ts` — D1 helpers for the two new control-plane tables
  (`migrations/0002_admin_ops.sql`): `support_tickets`, `dunning_events`,
  plus `listAllTenantIds` (the D1 tenants_index id list that drives every
  cross-tenant sweep/digest).
- `ops-sweep.ts` — the actual cross-tenant iteration + aggregation logic
  (`runDunningSweep`, `runDeliverabilitySweepAllTenants`, `buildOpsDigest`),
  shared by `../routes/admin-ops.ts` (on-demand) AND `../scheduled.ts`
  (cron) so the two can never drift (CLAUDE.md rule c).

Routes live in `../routes/admin-support.ts` / `../routes/admin-ops.ts` (see
`../routes/README.md`) — kept with the other route files so "one file per
intent cluster" stays a single convention, not two.

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

## What's armed at activation (not built as a real integration here)

- **D1 real inbound email**: Cloudflare Email Routing -> `POST
  /admin/support/triage`. The triage LOGIC is complete and callable now with
  any `{from, subject, body}` payload; only the mailbox-forwarding wiring is
  an owner-hands step.
- **D2 real dunning emails**: the sweep computes and idempotently records
  the correct retry/escalate/suspend action now (and `suspend` really does
  flip the tenant's status), but no outbound email is sent — there is no
  email-sending channel wired in this build.
- **D2/D6 cron schedule**: `scheduled()` (`../scheduled.ts`) is implemented
  and callable directly; the `[triggers]` block that makes Cloudflare
  actually invoke it on a schedule is commented-out in `wrangler.toml`.

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/admin-*.test.ts`
and `apps/platform/test/status.test.ts`.
