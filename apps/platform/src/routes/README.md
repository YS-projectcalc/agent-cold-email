# src/routes

Thin Hono route groups — one file per facade-intent cluster from SPEC.md §6.
Every handler: validates its body via `../validate.ts` against a zod schema
from `@coldstart/shared`, then calls exactly one method on the authed
tenant's `TenantDO` stub (`c.get("tenantStub")`) and returns its result.
No business logic lives here — that's `../engine/*.ts`, reached only
through the DO.

- `signup.ts` — `POST /signup` (unauthenticated; mints the tenant + token).
- `infrastructure.ts` — `POST /setup-infrastructure`, `GET /infrastructure-status`.
- `campaigns.ts` — `POST /campaigns` (launch), `GET /campaigns` (§19.4 list —
  id/name/status/counts), `GET /campaigns/:id/results`,
  `POST /campaigns/:id/pause`, `POST /campaigns/pause-all`, `GET /metrics`.
- `inbox.ts` — `GET /inbox` (SPEC.md §19.4 v2: cursor pagination + mailbox/
  campaign/label/read/include_nonreply filters, backward-compatible
  defaults), `GET /threads/:id`, `POST /threads/:id/reply`,
  `POST /threads/:id/mark`, `POST /threads/:id/label` (§19.2/§19.4).
- `account.ts` — `GET /account`.
- `dashboard-session.ts` — `POST /dashboard/session` (§19.1, UNAUTHENTICATED
  — see its own doc comment for why, same reasoning as `checkout.ts`'s
  `GET /checkout/simulate`): exchanges a pasted bearer token for an httpOnly
  cookie session.
- `dashboard.ts` — `POST /dashboard/logout` + the `/dashboard/views*`
  saved-view CRUD lifecycle (§19.2/§19.4). Authed (bearer OR cookie).
- `activity.ts` — `GET /activity` (§19.4): the merged events +
  deliverability_actions feed.
- `webhook-subscriptions.ts` — `GET|POST /webhook-subscriptions`,
  `GET|PUT|DELETE /webhook-subscriptions/:id` (SPEC.md §21): per-tenant
  OUTBOUND webhook subscription CRUD. Authed (bearer OR cookie). Named
  distinctly from `webhooks.ts` on purpose — a `/webhooks/*` auth pattern
  would have swept the unauthenticated inbound `POST /webhooks/stripe` into
  `requireAuth`. Boundary URL security (https-only, SSRF) lives in the DO
  facade (`assertSafeWebhookUrl`), surfaced here as the usual 400.
- `checkout.ts` — `POST /checkout` (B1, authed): demo/free -> paid upgrade.
  Real Stripe TEST-mode Checkout Session if `env.STRIPE_SECRET_KEY` is set,
  else a simulated session. `GET /checkout/simulate` (UNAUTHENTICATED — the
  session id is the credential, mirroring Stripe's own hosted checkout
  return page not being bearer-gated either) completes the simulated
  upgrade.
- `webhooks.ts` — `POST /webhooks/stripe` (B1, UNAUTHENTICATED — Stripe
  can't present our bearer token; authenticated instead by
  `Stripe-Signature` HMAC verification when `env.STRIPE_WEBHOOK_SECRET` is
  set). Idempotent per Stripe event id.
- `demo.ts` — `POST /demo/run` (B5): authed, sandbox-only accelerated
  pipeline run for demo/free tenants. The plan guard lives in
  `TenantDO.demoRun()`, not here (structural, not an HTTP-layer policy).
- `mcp.ts` — `GET|POST /mcp`, the hosted MCP endpoint (JSON-RPC 2.0 over
  streamable HTTP). NOT mounted behind `requireAuth` — see `../mcp/README.md`
  for why auth is per-JSON-RPC-method instead of per-HTTP-request.
- `waitlist.ts` — `POST|OPTIONS /api/waitlist`, the public marketing-site
  waitlist form (KV-backed, unauthenticated, CORS for the Pages origin).
- `status.ts` — `GET /status` (D6, UNAUTHENTICATED, PUBLIC): a minimal
  health check for a status page. Returns no tenant/admin data.
- `admin-support.ts` / `admin-ops.ts` — the D1/D2/D6 admin surface
  (`POST /admin/support/triage`, `GET /admin/support/digest`,
  `POST /admin/ops/dunning-sweep`, `GET /admin/ops/digest`). Gated by
  `../require-admin-auth.ts` (a SEPARATE `ADMIN_TOKEN` secret bearer, never
  a tenant token) — mounted as their own Hono group in `index.ts`, not
  behind `requireAuth`. See `../admin/README.md`.

Most routes are mounted behind `../require-auth.ts` (`requireAuth`
middleware — bearer token OR, since §19.1, a dashboard cookie session), which
resolves the caller to exactly one tenant and hands the handler that tenant's
DO stub. `index.ts` scopes `requireAuth` (+ `../csrf-guard.ts`, the GLOBAL
CSRF guard on cookie-authed mutations) to an EXPLICIT list of literal path
patterns — not a blanket `"*"` — for the same reason the admin scoping below
is `"/admin/*"`: a genuinely unknown path must reach `app.notFound()` (JSON
404), not get swallowed into a 401 first. Adding a new authed route here also
means adding its path to that list in `index.ts`. Exceptions (unauthenticated
by design, each with its own credential/tenant-routing — see index.ts's mount
comment): `signup.ts`, `mcp.ts` (per-method auth), `waitlist.ts`,
`checkout.ts`'s `GET /checkout/simulate` (session id), `dashboard-session.ts`
(the pasted bearer token IS the body, §19.1), `webhooks.ts` (Stripe
signature), `status.ts` (no credential — no tenant data returned). There is no
code path in this directory that can reach a DO stub for any tenant other
than the one the caller's credential authenticated as — EXCEPT the admin
routes, which are allowed to iterate every tenant (that's their whole
purpose) and are gated by a wholly separate credential (`ADMIN_TOKEN`)
instead.

## How to run

Part of `apps/platform`; exercised end-to-end by `apps/platform/test/*.test.ts`.
