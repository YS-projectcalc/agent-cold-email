# Contributing

Thanks for the interest — this project is early (see `ROADMAP.md` for current phase), so please open an issue before a large PR to avoid duplicate work.

## Project layout

```
packages/shared/   framework-free domain types, VendorPort interfaces, zod intent schemas
apps/platform/      Cloudflare Worker: Hono facade, TenantDO, sandbox vendor adapters, engine
site/                static marketing/docs site (Cloudflare Pages)
docs/                frozen research + adversarial-review records (not living docs)
```

`SPEC.md` is the canonical design document; `ARCHITECTURE.md` is the living architecture record; `ROADMAP.md` is build order/status. Read these before proposing a structural change.

## Local setup

```bash
git clone <repo-url>
cd agent-cold-email
npm install                          # npm workspaces, installs everything
npm run typecheck                    # all workspaces
npm test                             # all workspaces
```

Per-workspace, e.g.:

```bash
npm run typecheck -w apps/platform
npm test -w apps/platform
cp apps/platform/.dev.vars.example apps/platform/.dev.vars   # for local wrangler dev
npm run dev -w apps/platform
```

## Ground rules (from `CLAUDE.md` — this repo's project law)

- **No dead code.** No commented-out blocks, no unused exports — delete it, git remembers it.
- **No god files.** A file that grows past ~300 lines or takes on a second responsibility gets split.
- **No duplicated logic.** Search for an existing implementation before writing a new one.
- **No hallucinated dependencies.** Every import must resolve via `package.json`/the lockfile; run install and build before opening a PR.
- **Tests assert behavior, not existence.** A bugfix PR includes a test that fails on the old code and passes on the fix.
- **No patches-on-patches.** Root-cause fixes only.
- **Secrets never in code or git.** Env/wrangler secrets only.
- **Tenant isolation is mandatory** in every query or Durable Object access that touches tenant data — every new endpoint or engine function scoped by `tenant_id`.
- **Every new directory that holds code or content gets a `README.md`** at creation time: what it is, how to run/test it, what depends on it.
- **No live vendor credentials or Stripe live keys in the repo.** Real sending is live in production for activated tenants (Gmail API, HTTPS/443), but those credentials live outside this codebase as Cloudflare Worker secrets set through `ACTIVATION.md`'s owner-hands step — never something a PR wires in.

## Before opening a PR

1. `npm run typecheck` and `npm test` pass (this is also what CI runs — see `.github/workflows/ci.yml`).
2. Any new directory has a `README.md`.
3. Any bugfix includes a regression test.
4. No secrets, no real vendor credentials, no `.env`/`.dev.vars` files in the diff.

## Compliance-sensitive areas

Changes touching suppression, unsubscribe handling, per-mailbox send caps, sender-identity/footer rendering, or the lookalike-domain generator are compliance-load-bearing (see `SPEC.md` §7 and the `README.md` guardrails section) — please call this out explicitly in the PR description so it gets appropriately careful review.
