---
name: hono-subapp-wildcard-middleware-gotcha
description: Hono composes every registered handler matching a request path into ONE chain across mounted sub-apps — an unscoped .use("*", mw) on one sub-app intercepts sibling sub-apps' routes too, regardless of mount order.
metadata:
  type: feedback
---

In this repo's Hono app (`apps/platform/src/index.ts`), mounting two separate
sub-apps at the same base path (`app.route("/", subA)` then
`app.route("/", subB)`), each with its own `subX.use("*", someAuthMiddleware)`,
does NOT scope that middleware to only that sub-app's own routes. Hono
compiles the WHOLE tree into one router; a `"*"` pattern matches literally
every path regardless of which sub-app registered it. Whichever `"*"`
middleware is registered FIRST in the overall app wins for every request that
reaches that point in the chain — including requests meant for a sibling
sub-app's routes, which then get wrongly 401'd (or worse, silently mis-authed)
by the wrong middleware.

**Why:** discovered live 2026-07-09 building the D1/D2/D6 admin surface
alongside the existing tenant-scoped `authed` sub-app. Mounting a new `admin`
sub-app with `admin.use("*", requireAdminAuth)` BEFORE `authed` made every
tenant-facing route (`GET /account`, etc.) return the ADMIN 401 body instead
of tenant data — full regression across ~30 previously-green tests. Mounting
it AFTER `authed` instead made every `/admin/*` request get intercepted by
`authed`'s tenant-token check first. Neither ordering alone fixes it.

**How to apply:** when adding a new auth-gated sub-app alongside an existing
one mounted at the same base path, scope the middleware pattern to that
sub-app's OWN route prefix (e.g. `admin.use("/admin/*", requireAdminAuth)`)
instead of `"*"`. Never trust "it's a separate Hono instance" as isolation —
verify by hitting BOTH an existing route from every other sub-app AND the new
route with a live `SELF.fetch` test after any multi-sub-app auth change, not
just the new route in isolation (a green test file for the new routes alone
will NOT catch this — the regression shows up in the OTHER sub-app's test
files). [[feedback_brief_git_authorization_vs_hook]]
