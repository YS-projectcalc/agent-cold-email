---
name: coldstart-two-hosts-site-vs-platform-public
description: coldstart repo has TWO separate static-asset roots on two different hosts — don't assume apps/platform/public/ resolves at coldrig.dev
metadata:
  type: project
---

In `~/dev/coldstart`, `site/` and `apps/platform/public/` are separate deploys to separate hosts, not mirrors of each other:

- `site/` → Cloudflare Pages (`npx wrangler pages deploy site --project-name=agent-cold-email`) → `https://coldrig.dev` (marketing/docs site, JSON-LD, `.well-known/mcp/server-card.json`, `og:image`, etc. all self-reference this host per `site/README.md`'s "The site host" section).
- `apps/platform/public/` → the `[assets]` binding in `apps/platform/wrangler.toml`, part of the `agent-cold-email-api` Worker → `https://api.coldrig.dev` (mostly the `/app/*` dashboard SPA build output; `run_worker_first` scopes the Worker to everything except `/app/*`).

**Why it matters:** any asset (logo, icon, image) that needs to resolve at `coldrig.dev/...` for a directory listing, social card, or MCP server-card field belongs in `site/assets/`, NOT `apps/platform/public/assets/` — putting it in the latter serves it at `api.coldrig.dev` instead, a different origin that public-facing/self-referencing URLs never point at.

**How to apply:** before placing any new site-facing asset in this repo, check `apps/platform/wrangler.toml`'s `routes`/`[assets]` block and `site/README.md`'s host section rather than assuming a single shared `public/`-style directory — this repo doesn't have one.

Also: `site/assets/logo.svg` (238×64 wordmark) and `site/assets/logo-mark.svg` (64×64 square icon, used live in `index.html`) are two different, both-legitimate existing brand assets — don't let a generic "logo.svg" naming request clobber the wordmark when what's wanted is the square icon.
