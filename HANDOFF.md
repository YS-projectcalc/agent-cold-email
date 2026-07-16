# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE (test mode):** site https://coldrig.dev · API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email@0.2.0` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` (v0.2.0, hosted remote + npm package) · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming coldrig with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold before acting.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything CHANGED, surface exactly what and ask. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · npm publish · real vendor spend · external send · DO support ticket) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-16)

Local `main` is still `249d065` (1 ahead of origin, unpushed — same commit as the prior handoff). Since then the working tree has grown **two adversary-gated-SHIP lanes, both uncommitted, awaiting founder commit confirm**:

1. **Gmail-API + MS-Graph HTTPS/443 send transports** (SMTP-wall path c — see `ROADMAP.md ## Open` 2026-07-16 [ORDER] "SMTP wall"). Files: `apps/engine/src/{config,engine,index,smtp}.ts` (modified) + new `api-send.ts`/`gmail.ts`/`graph.ts`/`http.ts`/`message.ts`/`oauth.ts`/`scripts/mint-gmail-token.mjs` + their tests, `apps/engine/README.md`. Adversary SHIP, zero blockers (`docs/adversarial/engine-443-transports-2026-07-16.md`); bookkeeper-verified: engine typecheck exit 0, 62 tests passed / 3 skipped (docker-gated GreenMail).
2. **MCP Connectors-Directory readiness bundle** (see `ROADMAP.md ## Open` 2026-07-16 [ORDER] "Become THE recommended pick"). Files: `apps/platform/src/mcp/{tools,handler}.ts`, `apps/platform/src/engine/{mailbox-state,provisioning,dashboard-views}.ts` + their tests, `packages/cli/{README.md,src/index.ts,src/commands/signup.ts,src/claude-code-hint.ts}` (new), `.claude-plugin/plugin.json` (new). Adversary cycle r1 NO-SHIP → fix rounds → reattack caught 1 new blocking regression → round-3 fix → ADDENDUM SHIP (`docs/adversarial/directory-readiness-2026-07-16.md` + `-reattack-2026-07-16.md`); that doc records platform `npm test` 362/362, typecheck exit 0.

Both lanes also carry edits to `README.md` and `ROADMAP.md` (already showing modified in `git status`). Real sending is now unblocked **in code** via lane 1 above, but arming still needs founder OAuth cred minting + a live per-transport smoke (the one thing the adversary review flagged UNVERIFIABLE without real creds).

Findability work also moved: AI-crawler/Google probes done (`ROADMAP.md` 2026-07-16 [ORDER] "AI-crawler wall" — `site:coldrig.dev` = 0 results, CF bot-management unreadable with current token scopes) and Connectors-Directory research complete (same file, "Become THE recommended pick" entry) — both still gated on founder clicks, see `## Resume`.

## In flight / next

- **Multiple lanes are active this session** (see the live agent roster if resuming mid-session) — the two lanes above are BUILD + ADVERSARY COMPLETE and just need a founder commit confirm; do not assume all lanes are done just because these two are.
- **Founder decision queue (new, this checkpoint):** (a) approve reading the droplet credential file for the local prove-it smoke — Mac network TODAY allows 465 to smtp.gmail.com (bookkeeper-verified), so this is runnable the moment approval lands; (b) name the mcp.so + Cline public-listing targets — the permission classifier blocks agent-initiated public submissions without his naming them; (c) CF dashboard Security→Bots allow-AI-crawlers toggle (or mint a scoped API token: Zone Settings:Edit + Bot Management:Edit) + GSC domain property/sitemap submit + Bing import; (d) confirm claude.ai org tier (Team/Enterprise needed for Connectors Directory) and run `npx agent-cold-email demo` once to produce the demo-tenant bearer token the submission needs.
- **Still the headline blocker until (a) above resolves:** real sending — outbound SMTP egress (465/587) is blocked on both DigitalOcean and the Mac's network; full detail in `ROADMAP.md ## Open` 2026-07-16 [ORDER] "SMTP wall".
- **Non-destructive build lanes unaffected by the founder queue** (all test-mode, no spend, carried from the prior handoff — status unchanged this pass, verify directly in `ROADMAP.md ## Open` before resuming): webhooks core-platform lane, BYO intake build (§20), warm-lead lifecycle deep dive, send-framing copy pass + annual-billing toggle.
- **Other open decisions (unchanged from prior handoff):** Stripe live keys + quantity-billing migration · agency-bundle pricing ruling · BYO-mailbox pricing · review-site listings · dogfood-calls scope · `mcp-publisher publish` re-publish · Glama listing sync-click.

## Landmines / gotchas

- **⚠️ SMTP egress is blocked on both available networks** (DO droplet + Mac) — do NOT assume the engine can send until the send-path decision lands and a smoke passes. `apps/engine/` code is correct; the HOST/network is the blocker.
- **`site/` deploys whatever is on disk**, not what's committed — `wrangler pages deploy site --branch main` uploads the local dir as-is (no git-based Pages integration). Tree is clean now, but re-check `git status` before any future site redeploy (bit twice before).
- **support-kb.ts:35-36 still quotes dead $299/$799 tiers** — contradicts the ratified $99 pricing; fix with the billing migration (`ROADMAP.md ## Open`).
- **`SPEC.md:102` header still reads "~8–12 tools"** — stale (actual 17); same staleness class the Glama shopper hit; fix at next SPEC touch (`ROADMAP.md ## Open` shopfront residual i).
- `apps/platform/vitest.config.ts fileParallelism:false` is REQUIRED; fresh-worktree verification needs `apps/platform/.dev.vars` + local D1 migrations or the suite shows phantom failures.
- **Gmail app password for yaakovscher@gmail.com sits on the droplet** `/root/mailboxes.json` (bearer-gated, world-reachable :8080 but can't even send) — rotate anytime and re-paste; nothing depends on it staying.
- Stale worktrees were pruned this handoff (deploy-wt, engine-wt, the merged design integrator). The designer's own worktree `~/Documents/Codex/2026-07-14/.../coldrig-design` is the user's, unrelated to main — leave it.
- **This is a shared/live worktree with multiple parallel-agent lanes in it right now** (2026-07-16 checkpoint): the working tree holds at least two unrelated gated-SHIP lanes (engine-443 transports, directory-readiness bundle) plus their shared edits to `README.md`/`ROADMAP.md`. A commit must include ALL gated files together, or the two lanes must be split deliberately (e.g. by disjoint pathspec) — do not `git add -A` or commit one lane's files without checking `git status` for what else is dirty first.

## Key files

- `SPEC.md` (§0 locks · §12/§12.1 economics · §18 pricing · §19 dashboard · §20 BYO) · `ROADMAP.md` (`## Now`/`## Open` ledger — source of truth for all open items) · `ACTIVATION.md` (owner-hands gates; Gate-2 engine host = the SMTP-wall context) · `CLAUDE.md` (project law).
- `apps/engine/` — the Node SMTP/IMAP daemon (committed `eb8ee42`). `apps/engine/dist/` — built; runnable from any SMTP-capable network for a local smoke (SMTP-wall path (b)).
- `tools/buyer-panel/` — the blind-shopper CHOICE harness; `runs/2026-07-15-claude-{canonical,starter,agency}.md` — the frozen evidence that we surface but get killed on "not live".
- `docs/adversarial/*-2026-07-15.md` — frozen SHIP verdicts (shopfront, tool-descriptions, guide-pages, compare-pages, watchtower-ops-email).
- `archive/2026-07-16-handoff-smtp-wall/prior-HANDOFF.md` — the resume state this replaced.

## Resume — KIND B: founder commit-confirm + a decision queue, with non-blocked build lanes available meanwhile

**First verify state still holds:** `git -C ~/dev/coldstart status -sb` (expect HEAD `249d065`, ahead 1 of origin, with the two gated lanes above still dirty in the working tree) and re-read `ROADMAP.md ## Open` for the three 2026-07-16 [ORDER] entries (SMTP wall / Become THE recommended pick / AI-crawler wall). If the working tree is clean or on a different HEAD, a commit already happened out-of-session — re-derive state from `git log` before proceeding.

**Step 1 — commit confirm (present to Yaakov, do NOT commit unilaterally):** both lanes are adversary-gated SHIP and ready to commit. Decide together whether they land as one commit or two (they touch disjoint file sets but share `README.md`/`ROADMAP.md` edits) — see the Landmines note below before staging.

**Step 2 — the founder decision queue** (present all four, do NOT act unilaterally; (a) touches credentials, (c)/(d) are his outward-facing accounts):
- **(a) Engine smoke:** approve reading the droplet credential file (`/root/mailboxes.json`) so a resuming chat can run the local prove-it smoke — Mac network today allows 465 to smtp.gmail.com, so this is otherwise ready to go.
- **(b) Directory naming:** state the mcp.so + Cline public-listing targets directly — the classifier will not relay agent-initiated public submissions without it.
- **(c) Findability clicks:** CF dashboard Security→Bots allow-AI-crawlers toggle (or mint a scoped API token) + GSC domain property/sitemap submit + Bing import.
- **(d) Connectors Directory:** confirm claude.ai org tier (Team/Enterprise required) and run `npx agent-cold-email demo` once for the bearer token the submission needs.

**Meanwhile, a resuming chat may START (non-destructive, no founder input, test-mode):** the webhooks / BYO-intake / warm-lead build lanes (`## In flight / next`) — status unchanged from the prior handoff, not touched this checkpoint. Dispatch a builder against the chosen lane; git READ-ONLY for subagents in the live worktree; adversary-gate before any commit; commit + deploy only with Yaakov's confirm.

**Then, only with Yaakov's explicit confirmation** (each founder-owned): the decision queue above · Stripe live keys + quantity-billing migration ruling · agency-bundle + BYO-mailbox pricing rulings · review-site listings · once a real-sending smoke passes → the early-access→fully-live reframe (`ROADMAP.md ## Open` 2026-07-15 [ASK]).

Do NOT deploy, push, publish, spend, file a support ticket, or send without confirming with Yaakov first.
