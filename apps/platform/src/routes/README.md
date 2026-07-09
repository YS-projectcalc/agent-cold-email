# src/routes

Thin Hono route groups — one file per facade-intent cluster from SPEC.md §6.
Every handler: validates its body via `../validate.ts` against a zod schema
from `@coldstart/shared`, then calls exactly one method on the authed
tenant's `TenantDO` stub (`c.get("tenantStub")`) and returns its result.
No business logic lives here — that's `../engine/*.ts`, reached only
through the DO.

- `signup.ts` — `POST /signup` (unauthenticated; mints the tenant + token).
- `infrastructure.ts` — `POST /setup-infrastructure`, `GET /infrastructure-status`.
- `campaigns.ts` — `POST /campaigns` (launch), `GET /campaigns/:id/results`,
  `POST /campaigns/:id/pause`, `POST /campaigns/pause-all`, `GET /metrics`.
- `inbox.ts` — `GET /inbox`, `GET /threads/:id`, `POST /threads/:id/reply`,
  `POST /threads/:id/mark`.
- `account.ts` — `GET /account`.
- `demo.ts` — `POST /demo/run` (B5): authed, sandbox-only accelerated
  pipeline run for demo/free tenants. The plan guard lives in
  `TenantDO.demoRun()`, not here (structural, not an HTTP-layer policy).
- `mcp.ts` — `GET|POST /mcp`, the hosted MCP endpoint (JSON-RPC 2.0 over
  streamable HTTP). NOT mounted behind `requireAuth` — see `../mcp/README.md`
  for why auth is per-JSON-RPC-method instead of per-HTTP-request.
- `waitlist.ts` — `POST|OPTIONS /api/waitlist`, the public marketing-site
  waitlist form (KV-backed, unauthenticated, CORS for the Pages origin).

All routes except `signup.ts`, `mcp.ts`, and `waitlist.ts` are mounted
behind `../require-auth.ts` (`requireAuth` middleware), which resolves the
bearer token to exactly one tenant and hands the handler that tenant's DO
stub — there is no code path in this directory that can reach a DO stub for
any tenant other than the one the token authenticated as.

## How to run

Part of `apps/platform`; exercised end-to-end by `apps/platform/test/*.test.ts`.
