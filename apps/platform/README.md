# apps/platform

The Cloudflare Worker: the Plane C facade (Hono, ~12 intents from
SPEC.md §6), `TenantDO` (per-tenant SQLite state + money ledger), the
sandbox `VendorPort` implementations, and the native sandbox sequencing +
reply engine. This is the B0 walking skeleton — see `ROADMAP.md` at the
repo root for what's in/out of scope at this phase.

## Layout

- `src/index.ts` — the Hono app; mounts routes, exports `TenantDO`.
- `src/tenant-do.ts` — the Durable Object class. No business logic; builds a
  `TenantContext` per call and dispatches into `src/engine/*.ts`.
- `src/clock.ts` — `RealClock` + `VirtualClock` (see `src/clock.ts` for the
  full rationale). Nothing outside this file reads `Date.now()`.
- `src/auth.ts` / `src/require-auth.ts` — bearer token minting/hashing +
  the Hono auth middleware that resolves a token to one tenant's DO stub.
- `src/db.ts` — D1 control-plane index (token -> tenant lookup only).
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
  dunning sweep, business-health digest) — a SEPARATE `ADMIN_TOKEN`-gated
  facade from the tenant one. See its README.
- `src/scheduled.ts` — the Cron Trigger entry point (D2), exported from
  `src/index.ts`'s `scheduled()` handler.
- `migrations/0001_init.sql` — the D1 schema (tenant index).
  `migrations/0002_admin_ops.sql` — D1 admin-surface tables (support
  tickets, dunning events).
- `test/` — the walking-skeleton E2E suite, the tenant-isolation/demo-guard
  tests, the B5 MCP/demo-run/waitlist tests, and the D1/D2/D6 admin-surface
  tests (`test/admin-*.test.ts`, `test/scheduled.test.ts`, `test/status.test.ts`).

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
  create WAITLIST`, B5) backing `POST /api/waitlist`.
- `.dev.vars.example` — copy to `.dev.vars` (gitignored) for local dev/test;
  `TOKEN_HASH_PEPPER` + `ADMIN_TOKEN` (D1/D2/D6 admin surface — see
  `src/admin/README.md`). No real vendor secrets exist anywhere in this app
  (CLAUDE.md rule g) — sandbox adapters need none, and `real/` adapters are
  unreachable stubs (see `src/vendors/README.md`).
- The D2 ops-sweep Cron Trigger is commented-out in `wrangler.toml`
  (`[triggers]` / `crons`) — armed at activation (`ACTIVATION.md`); the
  `scheduled()` handler it will call is fully built and independently
  callable now (`src/scheduled.ts`).

## Depends on

`@coldstart/shared` (workspace package: domain types, `VendorPort`
interfaces, the `Clock` interface, zod intent schemas).
