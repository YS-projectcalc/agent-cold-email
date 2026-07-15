---
name: coldstart-waitlist-cors-custom-domain-drift
description: ColdStart waitlist route's CORS allowlist is hardcoded to the Pages.dev origin and was never updated when coldrig.dev went live as the production custom domain — check this on every coldrig deploy-verification pass.
metadata:
  type: project
---

Found 2026-07-15 during post-deploy verification (Worker version
4836515a-4b70-4383-b31f-b95d7ca22467, site deploy to
agent-cold-email.pages.dev serving coldrig.dev): `apps/platform/src/routes/waitlist.ts:19`
has `const ALLOWED_ORIGIN = "https://agent-cold-email.pages.dev";` — a
hardcoded single origin. `apps/platform/src/routes/README.md:45` documents
this as intentional at the time ("CORS for the Pages origin"), but the site
has since gone live on the custom domain `coldrig.dev`.

Verified live: `curl -i -X OPTIONS https://agent-cold-email-api.yaakovscher.workers.dev/api/waitlist -H 'Origin: https://coldrig.dev' -H 'Access-Control-Request-Method: POST'` returns 204 but with `access-control-allow-origin: https://agent-cold-email.pages.dev` — NOT echoing/allowing the coldrig.dev origin that sent the request. A real browser on coldrig.dev will block the waitlist fetch.

**Why:** custom-domain cutover is a common drift point — CORS allowlists,
canonical URLs, and OAuth redirect URIs all tend to get hardcoded to the
platform-default origin during early build and then silently miss the
custom-domain migration.

**How to apply:** on any future coldrig deploy-verification pass, re-check
`ALLOWED_ORIGIN` (or whatever it's renamed to) actually includes
`https://coldrig.dev`, not just the `.pages.dev` origin. This is a report-only
finding — do not fix without an explicit dispatch, since a builder pass may
already be tracking this as a known ROADMAP item.
