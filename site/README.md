# site/

The public marketing + docs site for `agent-cold-email`: static HTML/CSS/JS, no build step, no external CDN/fonts/scripts. Deploys to Cloudflare Pages.

## What's here

- `index.html` — light product landing page: category-explicit hero, product model, simulated control-room UI, verified sandbox path, and activation list. JSON-LD graph (`WebSite` + `Organization` + `SoftwareApplication`) in `<head>`.
- `signup.html` — human conversion path into the real same-origin dashboard signup at the Worker (`/app/signup`), with sandbox and credential boundaries stated before the click.
- `connect.html` — current remote-MCP setup for Codex, Claude Code, Cursor, and Cline, including copyable configuration and a safe evaluation prompt.
- `replies.html`, `byo-domain.html` — product explainers for the reply lifecycle and customer-owned domain risk/consent model.
- `security.html`, `status.html`, `support.html` — public trust and support surfaces. Status is a release-boundary board with a live health link, not an automated uptime-history product.
- `unsubscribe.html`, `why-email.html` — noindex recipient-experience previews. They deliberately do not claim a real suppression record while production sending is inactive.
- `404.html` — branded not-found route with recovery paths.
- `docs.html` — quickstart, MCP setup, CLI usage, full tool reference, the free demo, auth model.
- `pricing.html` — quantity-price calculator: $49 platform + $10/provisioned mailbox, five-mailbox/$99 minimum (backend quantity billing is still activation-gated).
- `compare.html` — honest DIY-vs-Coldrig comparison with explicit sandbox/production boundary.
- `for-agents.html` + `agent-evaluation.md` — indexable and Markdown versions of the evidence-led agent decision brief: fit rule, seven-point checklist, claim ledger, price math, runnable test, and disqualifiers.
- `compare-vs-salesforge.html` — sourced comparison with the strongest current agent-operated alternative, including where Salesforge/Forge Stack is the honest production choice today.
- `compare-vs-smartlead-instantly.html` — sourced comparison against named incumbents (Smartlead, Instantly) for AI-operated outreach; every competitor figure attributed to the third-party source that reported it, no disparagement.
- `guide-mcp-tool-count.html` — compares smaller intent-level and larger granular MCP surfaces; maps Coldrig's 19 tools to its documented lifecycle and states the control/webhook tradeoffs.
- `guide-infrastructure-vs-sending-platform.html` — answers the literal query "do I need a separate email infrastructure provider and sending platform?" (no, not with this platform).
- `guide-domains-inboxes-warmup-compliance.html` — client-side domains/inboxes-per-volume calculator (`assets/domain-calculator.js`), warmup timeline before first send, and CAN-SPAM/GDPR compliance disclosure.
- `privacy.html`, `terms.html`, `aup.html` — legal pages, **DRAFT, pending attorney review** (see the stamp at the top of each). Covers customer-is-sender, no-deliverability-warranty, prohibited-use, monitoring consent, and data-handling clauses.
- `llms.txt` — convenience discovery index (per `ROADMAP.md` C-shell notes, this is a *convenience*, not the load-bearing asset — `AGENTS.md` + `openapi.yaml` + JSON-LD are).
- `openapi.yaml` — the 19 facade intents (core pipeline + the optional dashboard session/views surface, plus outbound webhook subscriptions) as an OpenAPI 3.1 REST spec, matching the platform's committed route and schema definitions exactly.
- `.well-known/mcp/server-card.json` — MCP server card for registry scans (Smithery/mcp.so/PulseMCP) and MCP-aware agents.
- `sitemap.xml`, `robots.txt` — standard crawl assets.
- `_headers` — Cloudflare Pages response headers (security headers + CORS for the machine-readable assets).
- `_redirects` — Cloudflare Pages redirects.
- `assets/style.css` — the entire responsive light visual system for the landing page and editorial/product pages.
- `assets/logo.svg`, `assets/logo-mark.svg`, `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `assets/og-image.png` — the shared Coldrig identity and crawler/social assets.
- `assets/brand.js` — the canonical Coldrig display-name constant used by `[data-brand]` elements. The permanent repository, npm, and MCP handle remains `agent-cold-email`.
- `assets/waitlist.js` — waitlist form submission logic; posts to `https://agent-cold-email-api.yaakovscher.workers.dev/api/waitlist`.
- `assets/human-pages.js` — progressive enhancement for client tabs, copy buttons, safe query-string labels on recipient previews, and explicitly simulated recipient form confirmation.
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

Nothing outside this directory at runtime (self-contained CSS/JS, no external requests except the activation-request POST and deliberate links to the same-origin Worker dashboard/health endpoint). Content here should stay in sync with the platform's committed route and schema definitions (the tool reference and OpenAPI spec) and the platform pricing config — if any changes, update this directory in the same change.
