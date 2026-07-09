# site/

The public marketing + docs site for `agent-cold-email`: static HTML/CSS/JS, no build step, no external CDN/fonts/scripts. Deploys to Cloudflare Pages.

## What's here

- `index.html` — landing page: hero, how-it-works, tool list, pricing summary, FAQ, waitlist. JSON-LD (`SoftwareApplication` + `FAQPage`) in `<head>`.
- `docs.html` — quickstart, MCP setup, CLI usage, full tool reference, the free demo, auth model.
- `pricing.html` — the pricing tiers (mirrors `SPEC.md` §18).
- `compare.html` — honest DIY-vs-platform comparison; no fabricated benchmarks, no named-competitor claims; stamped `As of 2026-07-09`.
- `privacy.html`, `terms.html`, `aup.html` — legal pages, **DRAFT, pending attorney review** (see the stamp at the top of each). Covers customer-is-sender, no-deliverability-warranty, prohibited-use, monitoring consent, and data-handling clauses.
- `llms.txt` — convenience discovery index (per `ROADMAP.md` C-shell notes, this is a *convenience*, not the load-bearing asset — `AGENTS.md` + `openapi.yaml` + JSON-LD are).
- `openapi.yaml` — the ~12 facade intents as an OpenAPI 3.1 REST spec, matching `apps/platform/src/routes/*` and `packages/shared/src/intents.ts` exactly.
- `.well-known/mcp/server-card.json` — MCP server card for registry scans (Smithery/mcp.so/PulseMCP) and MCP-aware agents.
- `sitemap.xml`, `robots.txt` — standard crawl assets.
- `_headers` — Cloudflare Pages response headers (security headers + CORS for the machine-readable assets).
- `_redirects` — Cloudflare Pages redirects.
- `assets/style.css` — the entire shared stylesheet (system fonts, theme-aware via `prefers-color-scheme`, responsive).
- `assets/brand.js` — **the single swappable brand constant** (`BRAND_NAME`). Populates every `[data-brand]` element and replaces the `{{BRAND}}` token in `<title>`. This is the one place to edit when the final display brand (coldrig/coldpipe/coldloop, per `SPEC.md` §0.3) is chosen at activation — nothing else in `site/` needs to change.
- `assets/waitlist.js` — waitlist form submission logic; posts to `__API_BASE__/api/waitlist`.

## The `__API_BASE__` placeholder

Every reference to the deployed API host — the waitlist POST target, MCP config URLs, OpenAPI `servers:`, the sitemap/robots/CSP entries, the JSON-LD `url` fields — uses the literal token `__API_BASE__`. Substitute it repo-wide (a single find-and-replace across `site/` and the repo root `README.md`/`AGENTS.md`) once the platform has a real deployed URL. There is intentionally only this one placeholder token; do not introduce a second one for the site's own origin.

## How to deploy

```bash
# from the repo root, after substituting __API_BASE__:
npx wrangler pages deploy site --project-name=agent-cold-email
```

Requires a Cloudflare account authenticated via `wrangler login` (or `CLOUDFLARE_API_TOKEN`). No build step — `site/` is deployed as-is.

## Local preview

```bash
npx serve site
# or simply open site/index.html directly in a browser — everything is
# relative-path and self-contained, no server required for a quick look.
```

## Depends on

Nothing outside this directory at runtime (self-contained CSS/JS, no external requests except the eventual `__API_BASE__` waitlist POST). Content here should stay in sync with `packages/shared/src/intents.ts` and `apps/platform/src/routes/*` (the tool reference and OpenAPI spec) and with `SPEC.md` §18 (pricing) — if either changes, update this directory in the same change.
