# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE (test mode):** site https://coldrig.dev · API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming coldrig with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything CHANGED, surface exactly what and ask. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · npm publish · real vendor spend · external send) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-15 — "day 2", design + go-live-readiness)

- **Design fully integrated + merged to main** (`db80c00`, ff'd): the external designer's whole human journey (signup/connect/security/status/support/replies/byo-domain/unsubscribe-preview/404/for-agents/agent-evaluation) + dashboard Billing/Setup/Signup/Recovery (bundles rebuilt) + compare-vs-salesforge. Adversary 2 rounds → SHIP (`docs/adversarial/design-integration-review-2026-07-15.md`).
- **Pricing RATIFIED by Yaakov in-session:** public pitch = **"starts at $99/month for 5 mailboxes, then $10 per additional mailbox"** ($49+$10 decomposition only as explanation, never the headline); **send volume is NOT capped** — capacity is presented as ideal/recommended deliverability guidance, never contractual. Applied to every surface. Backend billing still legacy tiers (see Open decisions).
- **CLI 0.2.0 = a real installable MCP server** (`324a15c`): new `agent-cold-email mcp` stdio↔hosted bridge per the registry quickstart; `server.json` now advertises both the hosted remote AND the npm stdio package. Adversary 2 rounds → SHIP. **NOT published to npm yet** (owner step below).
- **Legal FINALIZED per founder ruling** (`45a8d13`): attorney-review draft banners removed from terms/privacy/aup/dpa + FAQ; governing law set to New Jersey (law + venue). Yaakov ruled attorney review is not a launch gate.
- **Directory/discoverability batch executed** (founder-authorized): llmstxt.site ✓, directory.llmstxt.cloud ✓, mcp.so ✓ (free tier, in review queue), awesome-mcp-servers PR #10106 — Glama badge added + bot answered (maintainer's merge pending), Glama already auto-indexed. Blocked/carried items in Open.
- **Business-readiness critique done** (drafter+skeptic, in `ROADMAP.md ## Open`): the one genuinely unplanned gap = **monitoring/alerting** — now being built (see In flight).
- Local `main` is **ahead of origin by ~22** commits; **push + all deploys remain founder-gated.**

## In flight / next

- **Still running: `watchtower-builder`** (hard-builder subagent) — building the ops-email + monitoring lane: OpsMailer VendorPort over the Cloudflare `send_email` binding, a re-armed watchtower cron with a healthy→unhealthy alert state machine (emails the founder on issues, dedupes/cooldowns to never storm), dunning notices on suspend, inbound `support@` `email()` handler feeding the existing triage, ACTIVATION.md ops-email/monitoring arming block + fix of the stale `:67` CAN-SPAM-placeholder line, an `X-API-Key` auth alternative (unblocks Smithery), and a repo-root `.mcp.json` (unblocks cursor.directory). **UNVERIFIED until it reports.** Builds DARK (degrades gracefully until the email binding is onboarded). Its diff must pass a fresh adversary before commit.
- **Next action:** when watchtower-builder reports → adversary on its diff → commit on clean pass → deploy batch is then complete. See `## Resume`.
- **In progress (not finished):** ROADMAP done-drain — 8 `- [x]` lines are checked but not yet moved to `archive/ROADMAP-done.md` (deferred this handoff; purely mechanical, do at next).
- **Open decisions / blockers (all founder-owned):** deploy-go + push · the two CLI publish commands · **Stripe live keys + quantity-billing backend migration** (dashboard billing UI is built but deliberately inert until per-mailbox quantity billing + spend-ceiling persistence + plan-enum migration land — the last core-code gap) · mailbox provider (Inboxkit vs Google Workspace) + ~$10 test domain + ~$6/mo droplet · Glama claim (his GitHub OAuth click) · PulseMCP (bot-walled — his browser or email) · GSC/Bing + CF Web Analytics (his clicks) · Cline (needs one real Cline-setup test to attest honestly) · dogfood 3 calls (competitors? Jack Clark? "roast it" CTA) · external uptime prober (UptimeRobot/BetterStack — CF can't watch itself).

## Landmines / gotchas

- **watchtower-builder diff is UNCOMMITTED + UNVERIFIED** when you resume (if it finished): do NOT commit it without a fresh adversary pass; do NOT `git checkout`/`reset` its paths.
- **Deploy batch is staged but NOT deployed** — the live site still shows OLD pricing ($99/$299/$799) and pre-design pages until deploy. Directory listings point at the live site, so deploy soon after they approve. Ordering: **Worker first** (`npm run deploy` in `apps/platform/`, applies D1 migrations), **then site** (`--branch main` or it lands as preview). Never bare `wrangler deploy`.
- **Stale leftover worktree** `.claude/worktrees/agent-affd823ae7fd92292` (branch `integrate/design-2026-07-15`) — the design-integrator's; already merged to main, safe to `git worktree remove` when convenient. The designer's own worktree is `~/Documents/Codex/2026-07-14/.../coldrig-design` (branch `coldrig-human-interface`), now unrelated to main's history.
- **support-kb.ts:35-36 still quotes dead $299/$799 tiers** — the AI support agent's KB contradicts the ratified pricing; fix with the billing migration or right after deploy (`ROADMAP.md ## Open`).
- `apps/platform/vitest.config.ts fileParallelism:false` is REQUIRED. Fresh-worktree verification needs `apps/platform/.dev.vars` (from `.dev.vars.example`) + local D1 migrations or the suite shows phantom failures.
- npm + MCP-Registry + all founder OAuth = Yaakov's hands. `mcp-publisher` cached token is EXPIRED (re-login needed).

## Key files

- `SPEC.md` (§0 locks · §12/§12.1 economics · §18 pricing · §19 dashboard · §20 BYO) · `ROADMAP.md` (`## Now`/`## Open` ledger — source of truth for all open items) · `ACTIVATION.md` (owner-hands gates; Gate 2 engine = CLEARED) · `CLAUDE.md` (project law).
- `docs/adversarial/{design-integration,cli-mcp-bridge,b4-optout,engine-host,engine-tenants-allowlist}-review-2026-07-1{4,5}.md` — frozen verdicts.
- `docs/research/{agent-buyer-research-forensics,dogfood-targets}-2026-07-14.md` — the buyer-agent playbook + dogfood list.
- `packages/cli/src/commands/mcp.ts` — the new stdio MCP bridge. `apps/engine/` — dark Node SMTP/IMAP daemon (committed, flag-dark).
- `archive/2026-07-15-day2-design-email/prior-HANDOFF.md` — the resume state this replaced.

## Resume — KIND B: the next step is a fresh-context review + founder-gated actions

**First, check the watchtower lane:** `git -C ~/dev/coldstart status --short` and read the `watchtower-builder` task output.
- **If its diff is present but uncommitted:** the next code step is **decided and non-destructive** — dispatch a fresh-context `adversary` on the ops-email/monitoring diff (attack: the alert state-machine for storm/flap correctness, the dark-degradation when the email binding is absent, token hygiene on the X-API-Key path, the inbound `email()` single-use `message.raw` buffering, the `.mcp.json` format). Commit ONLY on a clean pass, then update `ROADMAP.md` + this HANDOFF.
- **If it didn't finish / died:** re-dispatch with the same brief (in this session's transcript / the `ROADMAP.md ## Open` monitoring entry).

**Then, and only with Yaakov's explicit confirmation** (each is founder-owned, irreversible, or spends money — STOP and confirm before each):
1. **Deploy the batch** — Worker first (`cd apps/platform && npm run deploy`), verify live `tools/list`==17, then site (`wrangler pages deploy site --project-name agent-cold-email --branch main`). Ships design + $99 pricing + legal-final + real `/unsubscribe` + (if committed) the email lane.
2. **`git push`** (origin ~22 behind; also flips cursor.directory live via the new `.mcp.json`).
3. **Publish the CLI:** `cd packages/cli && npm publish` (2FA), then from repo root `mcp-publisher login github && mcp-publisher publish` (cached token expired).
4. His quick clicks: `wrangler login` (email scopes for the watchtower), Glama claim, PulseMCP, GSC/Bing, CF Web Analytics, the Cline setup test.
5. Pilot chain: rule mailbox provider + buy test domain + provision droplet → Gate-1 smoke → arm Mordy pilot.

Do NOT deploy, push, publish, or spend without confirming with Yaakov first.
