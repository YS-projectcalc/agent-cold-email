# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE (test mode):** site https://coldrig.dev · API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email@0.2.0` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` (v0.2.0, hosted remote + npm package) · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming coldrig with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold before acting.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything CHANGED, surface exactly what and ask. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · npm publish · real vendor spend · external send · DO support ticket) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-16)

Everything on the findability/quality/discoverability side is SHIPPED and LIVE; **real sending is the one thing NOT live, and it's walled by a genuine infrastructure blocker (outbound SMTP egress) that needs a founder decision — see `## Resume`.**

- **Shipped + live this session** (all founder-authorized, all adversary-gated, pushed through `51aded0`; origin in sync): directory-shopfront refresh (`ebd1a12` — README/`server.json`/server-card/cli-README now carry $99 pricing + "free sandbox now, no waitlist" + 17 tools, killing the stale-listing content that lost buyer runs #2/#3; repo-root `glama.json` added, schema-validated) · all 17 MCP tool descriptions rewritten for completeness (`15344ef`, deployed Worker `8a622434`, live `tools/list` verified — lifts the Glama tool-def grade, was 3.7/5) · `OPS_ALERT_EMAIL` repointed to `yaakovscher@gmail.com` (an already-verified CF Email Routing destination — watchtower founder-alerts armed, NO click needed). Earlier in the session: full design + $99 pricing + legal-final (Worker `4836515a`), watchtower/ops-email monitoring lane + 5-min cron armed + waitlist-CORS fix (`2795a64`, Worker `b21ca47d`), 3 flagship guides (`0a87f7c`), 5 competitor comparison pages (`6849c80`) — all live-verified 200 on coldrig.dev.
- **npm + MCP Registry PUBLISHED** (founder 2FA/OAuth): `agent-cold-email@0.2.0` live on npm (dist-tag `latest`) + registry entry v0.2.0 `isLatest` with both hosted remote AND npm package block (verified via registry API). **Smithery PUBLISHED** (scan SUCCESS via the X-API-Key gateway header). **cursor.directory SUBMITTED** (auto-scanned from repo `.mcp.json`, pending their security scan). **Glama listing CLAIMED** by founder.
- **CF Email Sending + Routing ENABLED on coldrig.dev** (`wrangler login` with email scopes done this session): DKIM/DMARC live in DNS, `support@coldrig.dev`→Worker routing rule created. The watchtower email legs are now armable.
- **Buyer-CHOICE panel cycle 1 COMPLETE** (`tools/buyer-panel/`, CHOICE-TREND 3 rows, 3 frozen run records): canonical NOT-SURFACED; starter + agency both **organically SURFACED + SHORTLISTED** via the Glama auto-index ("closest match to your entire brief") — **all three killed on the same row: real sending not live.** That kill is the SMTP wall below.
- **Engine droplet PROVISIONED, live DARK:** `coldstart-engine` 142.93.12.85 ($6/mo, nyc1), `/health` ok, unauth `/v1/send` → 401. Gmail creds for `yaakovscher@gmail.com` written to its `/root/mailboxes.json`.
- Local `main` = `51aded0`, **in sync with origin** (all session work pushed).

## In flight / next

- **No agents running.** All lanes reported and closed this session.
- **THE headline blocker (founder decision — see `## Resume`):** real sending is blocked by an **outbound-SMTP-egress wall**. The engine cannot reach any mail server: DigitalOcean blocks 465/587 account-wide (443 works; proven to Gmail AND Outlook) and the Mac's network blocks them too. Full detail + the 4 candidate paths: `ROADMAP.md ## Open` 2026-07-15 [ORDER] "SMTP EGRESS BLOCKED".
- **Non-destructive build lanes the resuming chat CAN start WITHOUT the founder decision** (all test-mode, no spend): (1) **webhooks** core-platform lane (ruled build — per-tenant reply/bounce push subscriptions; the one buyer-checklist row we fail); (2) **BYO intake build** (§20, spec adversary-ratified — unblocks Mordy migration); (3) **warm-lead lifecycle deep dive** (Yaakov ruling 07-15); (4) **send-framing copy pass + annual-billing toggle** — folds into the pending Stripe quantity-billing migration. The **Gmail-API/MS-Graph send path** (SMTP-wall path (c)) is ALSO a non-destructive build lane and is the recommended durable fix — see Resume.
- **Open decisions / blockers (founder-owned):** the SMTP send-path decision (Resume) · Stripe live keys + quantity-billing migration (carries annual billing + agency-bundle pricing) · agency-bundle pricing ruling · BYO-mailbox pricing (same $10 or cheaper?) · review-site listings (G2/Trustpilot/Capterra — Mordy post-pilot) · dogfood-calls scope · `mcp-publisher publish` re-publish (registry description; his hands) · Glama listing sync-click.

## Landmines / gotchas

- **⚠️ SMTP egress is blocked on both available networks** (DO droplet + Mac) — do NOT assume the engine can send until the send-path decision lands and a smoke passes. `apps/engine/` code is correct; the HOST/network is the blocker.
- **`site/` deploys whatever is on disk**, not what's committed — `wrangler pages deploy site --branch main` uploads the local dir as-is (no git-based Pages integration). Tree is clean now, but re-check `git status` before any future site redeploy (bit twice before).
- **support-kb.ts:35-36 still quotes dead $299/$799 tiers** — contradicts the ratified $99 pricing; fix with the billing migration (`ROADMAP.md ## Open`).
- **`SPEC.md:102` header still reads "~8–12 tools"** — stale (actual 17); same staleness class the Glama shopper hit; fix at next SPEC touch (`ROADMAP.md ## Open` shopfront residual i).
- `apps/platform/vitest.config.ts fileParallelism:false` is REQUIRED; fresh-worktree verification needs `apps/platform/.dev.vars` + local D1 migrations or the suite shows phantom failures.
- **Gmail app password for yaakovscher@gmail.com sits on the droplet** `/root/mailboxes.json` (bearer-gated, world-reachable :8080 but can't even send) — rotate anytime and re-paste; nothing depends on it staying.
- Stale worktrees were pruned this handoff (deploy-wt, engine-wt, the merged design integrator). The designer's own worktree `~/Documents/Codex/2026-07-14/.../coldrig-design` is the user's, unrelated to main — leave it.

## Key files

- `SPEC.md` (§0 locks · §12/§12.1 economics · §18 pricing · §19 dashboard · §20 BYO) · `ROADMAP.md` (`## Now`/`## Open` ledger — source of truth for all open items) · `ACTIVATION.md` (owner-hands gates; Gate-2 engine host = the SMTP-wall context) · `CLAUDE.md` (project law).
- `apps/engine/` — the Node SMTP/IMAP daemon (committed `eb8ee42`). `apps/engine/dist/` — built; runnable from any SMTP-capable network for a local smoke (SMTP-wall path (b)).
- `tools/buyer-panel/` — the blind-shopper CHOICE harness; `runs/2026-07-15-claude-{canonical,starter,agency}.md` — the frozen evidence that we surface but get killed on "not live".
- `docs/adversarial/*-2026-07-15.md` — frozen SHIP verdicts (shopfront, tool-descriptions, guide-pages, compare-pages, watchtower-ops-email).
- `archive/2026-07-16-handoff-smtp-wall/prior-HANDOFF.md` — the resume state this replaced.

## Resume — KIND B: the next step is a founder decision (real-sending send path), with non-blocked build lanes available meanwhile

**First verify state still holds:** `git -C ~/dev/coldstart status -sb` (expect clean, in sync with origin at `51aded0` or later) and re-read `ROADMAP.md ## Open` 2026-07-15 [ORDER] "SMTP EGRESS BLOCKED". If real sending is somehow now live (a send path was resolved out-of-session), skip to the reframe item; else:

**The decision (present to Yaakov, ask him to pick — do NOT act unilaterally; (a) and (d) spend/are-irreversible):** real sending is blocked because outbound SMTP (465/587) is blocked on the DO droplet AND the Mac. Four paths:
- **(a) DO support ticket** to unblock SMTP — his identity, hours-to-days, DO may deny cold-email use.
- **(b) Prove-it-now test** — he tethers the Mac to a phone hotspot (carriers usually allow 465); then run the built engine locally (`node apps/engine/dist/index.js` with `MAILBOX_CREDENTIALS` for yaakovscher@gmail.com + `ENGINE_AUTH_SECRET` from `apps/platform/.dev.vars`), `curl` a self-send + poll → proves the engine end-to-end. Not production.
- **(c) [RECOMMENDED] Build a Gmail-API + MS-Graph HTTPS/443 send path** alongside the nodemailer SMTP adapter — 443 is never blocked on any host, most BYO customers (and Mordy) are on Google/MS Workspace, so this retires the whole SMTP-blocking class and is arguably the correct BYO architecture. Non-destructive build lane; needs OAuth (vs the current app-password model). Does NOT need his decision to START (only real-tenant arming does).
- **(d) Move the engine to an SMTP-egress-friendly host** — whack-a-mole; most cheap hosts block it too.

**Meanwhile, a resuming chat may START (non-destructive, no founder input, test-mode):** the Gmail-API send path (c), or the webhooks / BYO-intake / warm-lead build lanes (`## In flight / next`). Dispatch a builder against the chosen lane; git READ-ONLY for subagents in the live worktree; adversary-gate before any commit; commit + deploy only with Yaakov's confirm (deploy/push/spend are founder-gated).

**Then, only with Yaakov's explicit confirmation** (each founder-owned): his quick clicks (PulseMCP, GSC/Bing + CF Web Analytics, Cline test, Glama sync-click, `mcp-publisher publish`) · Stripe live keys + quantity-billing migration ruling · agency-bundle + BYO-mailbox pricing rulings · review-site listings · once a smoke passes → the early-access→fully-live reframe (`ROADMAP.md ## Open` 2026-07-15 [ASK]).

Do NOT deploy, push, publish, spend, file a support ticket, or send without confirming with Yaakov first.
