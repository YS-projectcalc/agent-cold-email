# site/

The public marketing + docs site for `agent-cold-email`: static HTML/CSS/JS, no build step, no external CDN/fonts/scripts. Deploys to Cloudflare Pages.

## What's here

- `index.html` — landing page: hero, how-it-works, tool list, pricing summary, FAQ, waitlist. JSON-LD (`SoftwareApplication` + `FAQPage`) in `<head>`.
- `docs.html` — quickstart, MCP setup, CLI usage, full tool reference, the free demo, auth model.
- `pricing.html` — the pricing tiers (mirrors `SPEC.md` §18).
- `compare.html` — honest DIY-vs-platform comparison; no fabricated benchmarks, no named-competitor claims; stamped `As of 2026-07-12`.
- `compare-vs-smartlead-instantly.html` — sourced comparison against named incumbents (Smartlead, Instantly) for AI-operated outreach; every competitor figure attributed to the third-party source that reported it, no disparagement.
- `guide-mcp-tool-count.html` — decomposes the "more MCP tools = more capable" heuristic; maps agent-cold-email's 17 tools to 100% pipeline coverage.
- `guide-infrastructure-vs-sending-platform.html` — answers the literal query "do I need a separate email infrastructure provider and sending platform?" (no, not with this platform).
- `guide-domains-inboxes-warmup-compliance.html` — client-side domains/inboxes-per-volume calculator (`assets/domain-calculator.js`), warmup timeline before first send, and CAN-SPAM/GDPR compliance disclosure.
- `privacy.html`, `terms.html`, `aup.html` — legal pages, **DRAFT, pending attorney review** (see the stamp at the top of each). Covers customer-is-sender, no-deliverability-warranty, prohibited-use, monitoring consent, and data-handling clauses.
- `llms.txt` — convenience discovery index (per `ROADMAP.md` C-shell notes, this is a *convenience*, not the load-bearing asset — `AGENTS.md` + `openapi.yaml` + JSON-LD are).
- `openapi.yaml` — the ~17 facade intents (core pipeline + the optional dashboard session/views surface) as an OpenAPI 3.1 REST spec, matching `apps/platform/src/routes/*` and `packages/shared/src/intents.ts`/`dashboard.ts` exactly.
- `.well-known/mcp/server-card.json` — MCP server card for registry scans (Smithery/mcp.so/PulseMCP) and MCP-aware agents.
- `sitemap.xml`, `robots.txt` — standard crawl assets.
- `_headers` — Cloudflare Pages response headers (security headers + CORS for the machine-readable assets).
- `_redirects` — Cloudflare Pages redirects.
- `assets/style.css` — the entire shared stylesheet (system fonts, theme-aware via `prefers-color-scheme`, responsive).
- `assets/brand.js` — **the single swappable brand constant** (`BRAND_NAME`). Populates every `[data-brand]` element and replaces the `{{BRAND}}` token in `<title>`. This is the one place to edit when the final display brand (coldrig/coldpipe/coldloop, per `SPEC.md` §0.3) is chosen at activation — nothing else in `site/` needs to change.
- `assets/waitlist.js` — waitlist form submission logic; posts to `https://agent-cold-email-api.yaakovscher.workers.dev/api/waitlist`.
- `assets/domain-calculator.js` — pure client-side domains/inboxes-per-volume calculator used by `guide-domains-inboxes-warmup-compliance.html`; no network call, assumptions stated in the file's header comment.

## The site host

Every self-reference to this site — canonical links, `og:url`/`og:image`, the sitemap/robots entries, the JSON-LD `url` fields, and the MCP server card's `homepage`/`documentation`/`openapi` fields — points at `https://coldrig.dev` (host-swapped from the `agent-cold-email.pages.dev` placeholder once the Pages project got the custom domain attached). The API is a separate host, `https://agent-cold-email-api.yaakovscher.workers.dev` (see `assets/waitlist.js`, `openapi.yaml` `servers:`, and the server card's `transport.url`) — do not conflate the two when editing either.

## How to deploy

```bash
# from the repo root:
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

Nothing outside this directory at runtime (self-contained CSS/JS, no external requests except the `https://agent-cold-email-api.yaakovscher.workers.dev` waitlist POST). Content here should stay in sync with `packages/shared/src/intents.ts` and `apps/platform/src/routes/*` (the tool reference and OpenAPI spec) and with `SPEC.md` §18 (pricing) — if either changes, update this directory in the same change.
