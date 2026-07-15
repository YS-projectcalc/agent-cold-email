# apps/platform

The Cloudflare Worker: the Plane C facade (Hono, ~12 intents from
SPEC.md §6), `TenantDO` (per-tenant SQLite state + money ledger), the
sandbox `VendorPort` implementations, and the native sandbox sequencing +
reply engine. This is the B0 walking skeleton — see `ROADMAP.md` at the
repo root for what's in/out of scope at this phase.

## Layout

- `src/index.ts` — the Hono app; mounts routes, exports `TenantDO`, the
  `scheduled()` cron handler, and the `email()` inbound-support handler.
- `src/tenant-do.ts` — the Durable Object class. No business logic; builds a
  `TenantContext` per call and dispatches into `src/engine/*.ts`.
- `src/clock.ts` — `RealClock` + `VirtualClock` (see `src/clock.ts` for the
  full rationale). Nothing outside this file reads `Date.now()`.
- `src/auth.ts` / `src/require-auth.ts` — bearer token minting/hashing +
  the Hono auth middleware that resolves a token OR a dashboard cookie
  session (SPEC.md §19.1) to one tenant's DO stub, exposing which one
  (`authVia`) for provenance stamping.
- `src/csrf-guard.ts` — the GLOBAL CSRF guard (§19.1 [NEW-1]) on the entire
  authed surface: a cookie-authed non-GET/HEAD request needs
  `X-Coldstart-Client: dashboard`, or it's rejected 403.
- `src/db.ts` — D1 control-plane index (token -> tenant lookup) + the
  dashboard cookie-session store (§19.1, `migrations/0006`).
- `src/schema.ts` — the TenantDO SQLite schema (`CREATE TABLE` DDL) + id helper.
- `src/vendors/` — `VendorPort` implementations (`sandbox/` active, `real/`
  coded-but-unactivated stubs) + the adapter factory. See its README.
- `src/engine/` — the sequencing/warmup/reply engine (+ `demo.ts`, the B5
  `POST /demo/run` accelerated sandbox pipeline). See its README.
- `src/routes/` — Hono route handlers, one file per intent cluster, plus
  `demo.ts`, `mcp.ts`, `waitlist.ts` (B5), `status.ts` + `admin-support.ts`/
  `admin-ops.ts` (D1/D2/D6). See its README.
- `src/mcp/` — the hosted MCP JSON-RPC 2.0 handler (B5). See its README.
- `src/admin/` — the D1/D2/D6 owner/ops admin surface (support triage,
  dunning sweep, business-health digest, `watchtower.ts` monitoring, the
  `support-inbound.ts` `email()` handler) — a SEPARATE `ADMIN_TOKEN`-gated
  facade from the tenant one. See its README.
- `src/ops-mail/` — the OpsMailer port (Cloudflare Email Service `send_email`
  binding): founder alerts, dunning notices. Real + sandbox impls + factory,
  ships dark. See its README.
- `src/scheduled.ts` — the Cron Trigger entry point (D2): deliverability +
  dunning sweeps, owner digest, and the watchtower, exported from
  `src/index.ts`'s `scheduled()` handler.
- `migrations/0001_init.sql` — the D1 schema (tenant index).
  `migrations/0002_admin_ops.sql` — D1 admin-surface tables (support
  tickets, dunning events). `migrations/0006_dashboard_sessions.sql` — the
  dashboard cookie-session store (§19.1). `migrations/0007_tenant_contact.sql`
  — `tenants_index.contact_email` (dunning notices).
  `migrations/0008_watchtower.sql` — the watchtower alert dedupe state.
  `dashboard_views`/`thread_labels` (§19.2) need NO D1 migration — they're
  TenantDO SQLite tables, created via the `TENANT_DO_SCHEMA`
  constructor-bootstrap pattern (`src/schema.ts`).
- `public/app/` — the dashboard SPA's served static assets (SPEC.md §19.1):
  M1 ships only a placeholder `index.html` (proves the `/app/*` serving
  spike); the real `apps/dashboard` Vite build lands here in M2. See its
  own README.
- `test/` — the walking-skeleton E2E suite, the tenant-isolation/demo-guard
  tests, the B5 MCP/demo-run/waitlist tests, the D1/D2/D6 admin-surface
  tests (`test/admin-*.test.ts`, `test/scheduled.test.ts`,
  `test/status.test.ts`), and the M1 dashboard+inbox suite
  (`test/dashboard-session.test.ts`, `test/dashboard-views.test.ts`,
  `test/inbox-v2.test.ts`, `test/thread-labels.test.ts`,
  `test/campaigns-activity.test.ts`, `test/mcp-dashboard-tools.test.ts`).

## How to run

```
npm install                 # from repo root (npm workspaces)
npm run typecheck -w apps/platform
npm test -w apps/platform    # vitest via @cloudflare/vitest-pool-workers
npm run dev -w apps/platform # wrangler dev (needs .dev.vars — copy .dev.vars.example)
```

## Config

- `wrangler.toml` — Worker name `agent-cold-email-api`; `TENANT` Durable
  Object binding (new_sqlite_classes migration `v1`); `DB` D1 binding
  (`coldstart-platform-db`, created via `wrangler d1 create`, migration
  applied from `migrations/`); `WAITLIST` KV binding (`wrangler kv namespace
  create WAITLIST`, B5) backing `POST /api/waitlist`; `[assets]` (SPEC.md
  §19.1, M1) — `public/` served with `run_worker_first` excluding `/app/*`
  and bare `/app`, so every existing API path is untouched (same origin, no
  Worker code on the asset-serving path) while `/app/*` gets SPA fallback
  (`not_found_handling = "single-page-application"`). That fallback serves
  the assets directory's OWN root `index.html` for ANY unmatched path under
  it (proven live via `wrangler dev`, not assumed) — hence `public/index.html`
  existing alongside `public/app/index.html` (identical placeholder content
  today; M2's Vite build needs to keep both in sync or generate the root one
  from the `/app/` build, see `public/README.md`).
- `.dev.vars.example` — copy to `.dev.vars` (gitignored) for local dev/test;
  `TOKEN_HASH_PEPPER` + `ADMIN_TOKEN` (D1/D2/D6 admin surface — see
  `src/admin/README.md`). No real vendor secrets exist anywhere in this app
  (CLAUDE.md rule g) — sandbox adapters need none, and `real/` adapters are
  unreachable stubs (see `src/vendors/README.md`).
- The D2 ops-sweep Cron Trigger is now ARMED in `wrangler.toml`
  (`[triggers]` / `crons = ["*/5 * * * *"]`) — it goes live on the next
  deploy. The `send_email` binding (`[[send_email]] name = "OPS_EMAIL"`) +
  `OPS_ALERT_EMAIL` var are declared and dry-run-safe; the email legs stay
  log-only (dark) until the owner onboards the sending domain (`ACTIVATION.md`
  "Ops email + monitoring"). The `email()` handler needs Email Routing +
  a support@ route (same runbook).

## Depends on

`@coldstart/shared` (workspace package: domain types, `VendorPort`
interfaces, the `Clock` interface, zod intent schemas).
