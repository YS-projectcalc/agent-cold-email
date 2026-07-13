# ColdStart — Handoff

Agent-operated cold-email platform, BUILT + LIVE in test mode. Live: API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (dashboard at `/app`) · site https://agent-cold-email.pages.dev · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming ColdStart with zero prior context. Re-orient from the `## Resume` step below, then VERIFY its preconditions still hold.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything has CHANGED, surface exactly what and ask before acting. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · real vendor spend · npm publish · external send) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-13)

- **Dashboard + Unified Inbox (SPEC §19): SHIPPED — merged, DEPLOYED LIVE, PUSHED, CI green.** The optional, agent-configurable human dashboard + unified inbox is live at https://agent-cold-email-api.yaakovscher.workers.dev/app (Worker version `e9734c42`, served same-origin via the Worker's `[assets]`; D1 migration `0006_dashboard_sessions` applied remotely). `main` == `origin/main` == `71bcd81` (pushed 2026-07-13; GitHub CI run `29246972278` = success). MCP surface grew 12→15 tools (`get_dashboard`, `configure_dashboard`, `label_thread`); the agent-controls-the-layout path was proven ON PROD (MCP `configure_dashboard` → rev 1→2, `editedBy: mcp`, note badge rendered). Gates before ship: spec adversarial rounds NO-SHIP→SHIP (`docs/adversarial/dashboard-spec-review-2026-07-12.md`), fresh-context security re-attack SHIP (0 blocking), fresh-context UX review fixes all landed, verification battery ALL-PASS (platform 233/233 ×2, dashboard 93/93, typecheck/build/`check:dangerous-html` clean). Full detail: `ROADMAP.md` B7.1 + the 2026-07-12/13 session-log entries. Screenshots (gitignored, on disk): `pw-shots/dashboard-m5-final/`.
- **Still TEST-MODE:** no real vendor spend or real sending anywhere — SPEC §0 unchanged; the deploy shipped the dashboard onto the already-live sandbox API.
- **Prior arcs (all closed, all pushed):** AEO content live on Pages (`3477e7f`, deployment `96a55be8`; weekly citation-panel cron armed, TREND rows → `tools/aeo-panel/runs/TREND.md`) · engine round-2 fix lane (`d342cd0`, re-attack CLEAN) · core build COMPLETE since 07-09 (3 adversarial panels) · Gate-0 founder decisions all CLOSED 07-12 (brand **coldrig** — `coldrig.dev` registered, TM clearance pending; vendor **Mailforge-first** + Dedicated-tier option approved; pricing **$99/$299/$799 + deferred paywall**) — records in `ACTIVATION.md` Gate 0 + `docs/research/*2026-07-12*`.

## In flight / next

- Next action (summary; exact command in `## Resume`): build the two non-blocking dashboard follow-ups — MCP `list_campaigns` + `activity` tools (HTTP-only today, MCP-parity gap) and refresh `site/openapi.yaml` (documents 13 operations; stale vs the 3 new MCP tools + new HTTP routes: `/dashboard/*`, `/campaigns` GET, `/activity`, `/threads/:id/label`, inbox v2 params) → see `ROADMAP.md` B7.1 follow-ups + the 2026-07-13 (deploy) session-log entry.
- Still running: **none** (all session agents delivered + idle; watchdog cron deleted; no dev servers left listening).
- In progress (not finished): **none** — the dashboard lane is fully closed.
- Open decisions / blockers (all founder-owned): attorney TM clearance for the coldrig display-brand rollout · coldrig.dev DNS wiring + Pages custom-domain attach · CF Web Analytics + GSC/Bing verification · npm auth/publish (`ACTIVATION.md` Gate 3) · standing brand-account authorization · then `ACTIVATION.md` Gates 1–4 toward real sending. Post-ship audit scheduled **2026-07-26** (checklist: `ROADMAP.md` 2026-07-12 (ship) entry).

## Landmines / gotchas

- **SPEC §0 lock: NO real vendor spend / real sending until the owner works `ACTIVATION.md`.** Real adapters throw `NotActivatedError`.
- **Deploys go through `npm run deploy` in `apps/platform/`** (applies remote D1 migrations BEFORE `wrangler deploy`) — never bare `wrangler deploy`; migrations through `0006` are applied.
- **Test flake guard:** `apps/platform/vitest.config.ts` sets `fileParallelism: false` — required (shared per-project Miniflare in `@cloudflare/vitest-pool-workers`); removing it re-introduces intermittent ECONNRESET/timeout flakes (see `MEMORY.md`).
- **New authed routes must register in `AUTHED_PATH_PATTERNS`** (`apps/platform/src/index.ts`) or they 404 (documented in `src/routes/README.md`); `public/index.html` is a deliberate duplicate of `public/app/index.html` synced by the dashboard postbuild (see `apps/platform/public/README.md`).
- **Mailforge API unconfirmed** (pricing page omits it; ToS presupposes it) — do not build against it before support confirms (`ACTIVATION.md` Gate 1). Warmforge "unlimited warmup" bundle is **BUNDLE LIMITED** — margin model runs on ramp-only warmup (~$4.50–5/mbx; `docs/research/warmforge-bundle-verification-2026-07-12.md`).
- npm NOT authed on this machine (publish = owner-hands, Gate 3).
- Memory split (pre-existing, deliberate): the active account's global memory file `coldstart-platform-build.md` (this session: `~/.claude-acct3/projects/-Users-yaakovscher/memory/`; an older copy may exist under `~/.claude-acct2`) holds session-recall state; repo `MEMORY.md` holds build lessons. Both live; don't consolidate mid-handoff.
- Uncommitted in tree (intentionally): `.claude/agent-memory/**` + `apps/platform/.claude/**` (subagent memory files — not project docs, never staged).

## Key files

- `SPEC.md` — canonical design (§19 dashboard+inbox, §18 pricing, §13 vendors, §0 locks) · `ROADMAP.md` — ledger + session log (B7.1 = the dashboard lane) · `ARCHITECTURE.md` · repo `CLAUDE.md` (project law) · `MEMORY.md` (build lessons) · `ACTIVATION.md` — owner go-live checklist (Gates 0–4).
- `docs/adversarial/dashboard-spec-review-2026-07-12.md` — frozen two-round spec verdict; `apps/dashboard/` — the SPA; `apps/platform/src/mcp/tools.ts` — the 15-tool MCP surface; `pw-scripts/agent-control-e2e.js` — the live agent-control proof harness.
- `FINAL-REPORT.md` — frozen 07-09 build report (status has moved on; HANDOFF + ACTIVATION are current).

## Resume — KIND A: unblocked, non-destructive build step (verify, then proceed)

Verify preconditions: `cd ~/dev/coldstart && git status -sb` shows `## main...origin/main` with no ahead/behind and no dirty files outside `.claude/agent-memory/**` + `apps/platform/.claude/**`; then `cd apps/platform && npm test` is green (233 tests). If either has drifted, surface exactly what changed and ask before acting.

Then implement the queued follow-ups (non-destructive, fully specified):
1. Add MCP tools `list_campaigns` and `activity` in `apps/platform/src/mcp/{tools,schemas}.ts`, thin wrappers over the existing TenantDO methods `listCampaigns` / `activity` (same pattern as tools 13–15; every dashboard capability must stay MCP-reachable — SPEC §19.0 parity law). Ship tests per repo law (every new behavior asserted; suite stays green).
2. Regenerate/extend `site/openapi.yaml` to cover the current HTTP surface (add `/dashboard/session|logout|views*`, `GET /campaigns`, `GET /activity`, `POST /threads/{id}/label`, inbox v2 query params; bump the operation count from 13). Keep it consistent with `AGENTS.md` (already at 15 tools).
3. Run the full battery (root `npm run typecheck` + both suites + build), then commit on main.
Stop at the first gate: **do not deploy or push without confirmation** (deploy = `npm run deploy` in `apps/platform/`, founder-gated per session convention; site redeploy for openapi.yaml = `wrangler pages deploy site --project-name agent-cold-email`, also confirm first).
