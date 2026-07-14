# ColdStart — Handoff

Agent-operated cold-email platform, BUILT + LIVE in test mode. Live: API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (dashboard at `/app`) · site https://coldrig.dev · repo https://github.com/YS-projectcalc/agent-cold-email · npm `agent-cold-email` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` · Code: `~/dev/coldstart/`

> **You are resuming ColdStart with zero prior context. Re-orient from the `## Resume` step below, then VERIFY its preconditions still hold.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything has CHANGED, surface exactly what and ask before acting. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · real vendor spend · npm publish · external send) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-14)

- **Distribution identity surfaces LIVE — Gate 3 headline closed.** `agent-cold-email@0.1.0` published to npm (Yaakov, 2FA-gated, his hands; verified `npm view agent-cold-email version` → `0.1.0`, `npx agent-cold-email --help` works). Official MCP Registry listing LIVE: `io.github.YS-projectcalc/agent-cold-email` v0.1.0 (GitHub device-flow via `mcp-publisher`, Yaakov authorized; `server.json` committed `aee3679`; verified via the registry API — status `active`, `isLatest: true`). Standing approval GRANTED (Yaakov, verbatim: "standing approval for disclosed registry/directory listings", commit `47cfeb6`) — a cascade agent is now RUNNING the rest: `llms-install.md`, a Cline issue, an awesome-mcp-servers PR, mcp.so, llmstxt directories, cursor.directory. Results pending, not yet landed — check `ROADMAP.md` `## Open` for the outcome next session.
- **coldrig.dev LIVE, host-swap deployed.** Yaakov attached the domain as the Cloudflare Pages custom domain; site canonical/OG/sitemap/robots/server-card swapped to coldrig.dev (`355926c`), CAN-SPAM mailing address filled in terms/privacy (EpiphanyMade, 209 Crest Hill Road, Toms River NJ 08755), deployed to Pages production, IndexNow re-fired, Wayback snapshot captured. Verified live by this session: canonical == `https://coldrig.dev/` (HTTP 200), IndexNow key file live, Wayback snapshot from today.
- **Worker deployed (17 tools), funnel survives a stranger-agent run.** Field-path-validation fix landed (`ead131b`) after Mordy's stranger-agent funnel drive — PASS end-to-end, 3 frictions found+fixed (field-path errors naming the dot-path, `AGENTS.md` type hints, openapi `IdempotencyKey` header + campaignId note, server-card `/docs`). Separate real buyer-simulation (unprompted by us): ColdRig scored **zero appearances** in an agent's actual vendor search today (Glama auto-listing ranks #1 for "agent native cold email" instead) — frozen record `docs/research/agent-buyer-research-forensics-2026-07-14.md`; `gh repo` description re-tuned to lead "Cold email MCP server".
- **SPEC §20 (BYO domains/mailboxes) SHIPPED** after 4 adversarial rounds (`5627be4`; frozen `docs/adversarial/byo-domain-design-review-2026-07-14.md`, research `docs/research/byo-domain-verification-2026-07-14.md`) — spec only, build is next, waiting on the engine lane below.
- **Idempotency stale-'pending' claim reclaim COMMITTED** (`6152b47`, ACTIVATION Gate-2 prereq): 10-min TTL, 3 new tests incl. concurrent-race atomicity, revert-fail proven (2 tests fail on old code), platform suite 242/242.
- **Engine arc BUILT DARK, NO-SHIP.** `apps/engine/` (Node SMTP/IMAP daemon) + flag-dark Worker wiring is code-complete (27+9 tests per the builder's own count, not independently re-run by this bookkeeping pass) but **adversarial review found a blocking defect — poll-cursor loss, class "state persisted before cross-boundary effect confirmed."** Fix is IN FLIGHT with the builder; **the engine code is NOT committed** (`git log -- apps/engine/` is empty). Node-over-Go was RATIFIED by the orchestrator (A5-validated stack, buildable-today); `ARCHITECTURE.md` #6 wording needs an update once it actually commits — not done yet.
- **Mordy pilot decisions locked in:** real Launch-tier mechanics comped, no custom package (Yaakov). Per-tenant `ENGINE_TENANTS` allowlist directed for the real-adapter cutover (adversary guard-design recorded in its report). Yaakov = tenant #1, Mordy = tenant #2; dogfood campaign order captured (`bb979a6`).
- **Design pass is externally owned** (`685a202`, Yaakov ruling) — a different LLM delivers design; do not design in-session, integrate when it lands.
- Still TEST-MODE: no real vendor spend or real sending anywhere — SPEC §0 unchanged.

## In flight / next

- **Blocking:** engine poll-cursor-loss class-fix (moving cursor ownership to the consumer DO, plus a stuck-'sending' reclaim guard) → must come back to a clean re-attack → then commit. Nothing in the engine/activation lane proceeds before this.
- After the fix lands: droplet provisioning (~$6/mo, founder-approved; runbook in `ACTIVATION.md` Gate-2) → build the per-tenant `ENGINE_TENANTS` allowlist → Gate-1 smoke test (needs a purchased test domain, ~$10 approved; mailbox-provider pick still PENDING founder: Inboxkit vs. Google Workspace) → Mordy migrates as tenant #1.
- Cascade-runner still executing the registry/directory sweep (llms-install.md, Cline issue, awesome-mcp-servers PR, mcp.so, llmstxt dirs, cursor.directory) — check `ROADMAP.md` for results next session.
- Open decisions (all founder-owned): mailbox-provider pick for the Gate-1 test domain (Inboxkit vs GWS) · attorney TM clearance for the coldrig display-brand rollout · CF Web Analytics + GSC/Bing verification · pre-warmed inventory question (economics/SPEC ruling) · light-KYC scope extension to all first-time BYO intake (adversary R3/R4 flag) · post-ship audit **2026-07-26**.

## Landmines / gotchas

- **SPEC §0 lock: NO real vendor spend / real sending until the owner works `ACTIVATION.md`.** Real adapters throw `NotActivatedError`.
- **Deploys go through `npm run deploy` in `apps/platform/`** (applies remote D1 migrations BEFORE `wrangler deploy`) — never bare `wrangler deploy`; migrations through `0006` are applied.
- **Test flake guard:** `apps/platform/vitest.config.ts` sets `fileParallelism: false` — required (shared per-project Miniflare in `@cloudflare/vitest-pool-workers`); removing it re-introduces intermittent ECONNRESET/timeout flakes (see `MEMORY.md`).
- **New authed routes must register in `AUTHED_PATH_PATTERNS`** (`apps/platform/src/index.ts`) or they 404 (documented in `src/routes/README.md`); `public/index.html` is a deliberate duplicate of `public/app/index.html` synced by the dashboard postbuild (see `apps/platform/public/README.md`).
- **Mailforge API unconfirmed** (pricing page omits it; ToS presupposes it) — do not build against it before support confirms (`ACTIVATION.md` Gate 1). Warmforge "unlimited warmup" bundle is **BUNDLE LIMITED** — margin model runs on ramp-only warmup (~$4.50–5/mbx; `docs/research/warmforge-bundle-verification-2026-07-12.md`).
- **IndexNow submit is post-deploy ONLY**: `tools/indexnow/submit.sh` aborts (verified) if the key file isn't already live at the target host — running it before the site deploys just fails closed.
- **Deploy ordering requirement (now satisfied for the current wave)**: Worker must deploy before/with the site — `site/.well-known/mcp/server-card.json` advertises the live tool count; keep this order for future tool-count bumps too.
- Memory split (pre-existing, deliberate): the active account's global memory file `coldstart-platform-build.md` (`~/.claude-acct3/projects/-Users-yaakovscher/memory/`; an older copy may exist under `~/.claude-acct2`) holds session-recall state; repo `MEMORY.md` holds build lessons. Both live; don't consolidate mid-handoff.
- Uncommitted in tree (intentionally, not this bookkeeping pass's to touch): `.claude/agent-memory/**` + `apps/platform/.claude/**` (subagent memory files — not project docs, never staged) and, as of 2026-07-14, the entire `apps/engine/` build + its Worker-side wiring (`apps/platform/src/engine/{reply-processor,tick}.ts`, `env.ts`, `schema.ts`, `tenant-do.ts`, `vendors/**`, `.gitignore`) — **engine deploys are blocked until the poll-cursor-loss fix re-attacks clean**; don't provision infra against this code as-is.
- **Pages deploys from a detached-HEAD/agent worktree land as a PREVIEW, not production** — `wrangler pages deploy` treats a detached-HEAD ref as a "head" branch unless you pass `--branch main` explicitly. Always pass it for a production deploy run from an agent session.
- **npm publish and the MCP Registry publish both require Yaakov's own identity** (npm 2FA; MCP Registry's GitHub device-flow) — neither is automatable from an agent session; they need his hands each time, not just his authorization.

## Key files

- `SPEC.md` — canonical design (§19 dashboard+inbox, §18 pricing, §13 vendors, §20 BYO domains/mailboxes, §0 locks) · `ROADMAP.md` — ledger + session log (B7.1 = the dashboard lane) · `ARCHITECTURE.md` · repo `CLAUDE.md` (project law) · `MEMORY.md` (build lessons) · `ACTIVATION.md` — owner go-live checklist (Gates 0–4).
- `docs/adversarial/dashboard-spec-review-2026-07-12.md` — frozen two-round spec verdict; `docs/adversarial/byo-domain-design-review-2026-07-14.md` — frozen 4-round SPEC §20 verdict; `apps/dashboard/` — the SPA; `apps/platform/src/mcp/tools.ts` — the 17-tool MCP surface; `pw-scripts/agent-control-e2e.js` — the live agent-control proof harness.
- `FINAL-REPORT.md` — frozen 07-09 build report (status has moved on; HANDOFF + ACTIVATION are current).

## Resume — engine class-fix is the critical path

Verify preconditions: `cd ~/dev/coldstart && git status -sb` — expect `apps/engine/` (untracked) plus `apps/platform/src/engine/{reply-processor,tick}.ts`, `env.ts`, `schema.ts`, `tenant-do.ts`, `vendors/**`, `.gitignore`, `package-lock.json` dirty (the in-flight engine fix); `main` even with `origin/main`. If the working tree looks different (e.g. engine files already committed, or clean), STOP and re-orient — the state has moved since this handoff was written.

1. Check whether the poll-cursor-loss fix is done and has re-attacked clean (ask whoever's driving the engine lane, or look for a fresh adversarial verdict). If not done, that is the next task — do not skip ahead to provisioning.
2. Once re-attack is clean: commit the engine work (a real build commit, not a docs commit).
3. **STOP for founder confirmation** before provisioning the droplet (real infra spend, ~$6/mo) or purchasing the Gate-1 test domain (~$10) — both are pre-approved in principle per this handoff, but still real spend, still confirm before executing.
4. Droplet provisioning runbook: `ACTIVATION.md` Gate 2 "Go-engine host" (doctl + docker sequence, already drafted, currently uncommitted alongside the engine code).
5. Build the `ENGINE_TENANTS` per-tenant allowlist (the adversary's guard-design is recorded in its review — find and follow it) before flipping any tenant onto the real EmailPort.
6. Gate-1 smoke test on the purchased test domain, then move to Mordy's BYO-domain + BYO-mailbox intake and migration.

Stop at the first gate: confirm each spend/deploy step before proceeding to the next.
