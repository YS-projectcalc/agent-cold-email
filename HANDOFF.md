# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE:** site https://coldrig.dev · API+dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email@0.2.0` · MCP Registry 0.2.2 (24 tools) · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming coldrig with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold** (lane states, git SHAs, live URLs). If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything CHANGED, surface exactly what and ask. **STOP and confirm before any destructive/irreversible/founder-owned step** — EXCEPT where the 2026-07-22 autonomy grant (below) explicitly covers it.

## Where we are right now (2026-07-22, go-live program mid-flight)

**Standing authorization (founder, verbatim on the ledger):** *"Keep working autonomously. You have authorization to merge and push and deploy everything when done so that it's ready for all customers to go. make sure to update all info everywhere."* Plus arming authorization: arming steps execute autonomously (Keychain keys + SSH droplet + wrangler secrets); only browser-consent clicks return to the founder. Full program definition: `ROADMAP.md ## Open` → "AUTONOMOUS GO-LIVE PROGRAM AUTHORIZED" entry (2026-07-22).

- **Shipped today:** the 2026-07-21/22 wave DEPLOYED (Worker `1cb56729`, site `25844cc6`, 24 tools live-verified incl. 3 lead tools; registry 0.2.2). **Stripe LIVE** (charges+payouts enabled; live webhook `we_1Tw00lRKYEFKoA9wH6Zh2onE`; single-use live code `MORDYPILOT` = 60% off → Mordy pays $39.60/mo — founder-ruled). Test-mode billing E2E browser-proven (promo → $0 → no card → webhook → tenant launch/active). InboxKit + Stripe live keys + live webhook secret all in macOS Keychain (account `coldrig`, services `inboxkit-api-key`, `stripe-live-secret-key`, `stripe-live-publishable-key`, `stripe-live-webhook-secret`).
- **Founder rulings today (all on ledger):** OFAC-stubbed pilot YES · prewarm pilot buy WITHDRAWN (no Instantly deadline; prewarmed lookalikes impossible by construction) · Mordy price 60% off · registrar = Cloudflare default (delegated choice) · review-sites list-now/PH-defer + dogfood scope (delegated) · magic-link login + human signup + one-funnel "Free sign up" (design in flight) · warm-lead Q1-Q6 ratified (built + deployed).

## In flight / next

- **Next action** (one-line; exact steps in `## Resume`): process the four in-flight lanes per the program → see `ROADMAP.md ## Open` "AUTONOMOUS GO-LIVE PROGRAM AUTHORIZED".
- **Still running (result-bearing, 4 lanes — task outputs under `/private/tmp/claude-503/-Users-yaakovscher/b380b1f8-5dd1-4412-8ff6-3e30b328f084/tasks/`):**
  1. `i3i4-adversary` — verdict on the I3+I4 credential-path build (branch `worktree-agent-a8f87cd1437a20f72`, 3 commits, builder-green: engine 95/13f, platform 625/90f, 6 RED-proofs). Writes `docs/adversarial/i3i4-build-review-2026-07-22.md`. SHIP → merge; SHIP-after-fixes → fix round to the same builder (resume, don't re-dispatch).
  2. `brand-sweep-builder` — "ColdStart"→Coldrig customer-visible class sweep (worktree `agent-a3b6ad8f1d279ebb6`, LOCKED = mid-write; includes deriving the "(test mode)" suffix from the key prefix). On land → adversary → merge → **deploy Worker → THEN flip live Stripe keys** (brand fix must deploy before live customers see checkout).
  3. `signup-auth-design` (opus) — magic-link + human signup + one-funnel design → `docs/research/human-signup-magic-link-design-2026-07-22.md`; then adversary on design → build.
  4. `ga-gates-design` (opus) — OFAC v1 (SDN list) / spend ceiling / pending-activation state / slot auto-upgrade → `docs/research/ga-gates-design-2026-07-22.md`; then adversary on design → build.
- **Watchdog:** session-only cron `71d097fa` (every 3h at :41, 7-day expiry) re-enters the program after usage-limit gaps. It DIES with the session — a fresh session must not expect it and may re-create it.
- **After lanes land (program order):** I3+I4 merge → brand merge → battery on integrated tree → deploy Worker → **live Stripe key flip from Keychain** (verify session-creation only — NEVER complete a live charge) → signup-auth build → GA-gates build (incl. gate (a) domain-port `registrarConfig` flag — S, blocks credential-push activation) → ARMING (autonomous per grant: tunnel + `ENGINE_BASE_URL` + `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`/`GMAIL_OAUTH_GRANTS` secrets + gate-(e) throwaway-mailbox verify) → final all-surfaces info pass + IndexNow.
- **Open founder items (none block the lanes):** www.coldrig.dev custom-domain click (NXDOMAIN today — and the Stripe business profile lists `https://www.coldrig.dev`!) · uptime-prober service name · GSC sitemap/Request-Indexing + Bing clicks · Cline test [gated:founder-hold] · Instant Start SKU price ratification (gated on credits→USD verify).

## Landmines / gotchas

- **Live money:** the Worker still runs TEST Stripe keys until the brand fix deploys; the flip is a deliberate program step. `MORDYPILOT` is live-mode and single-use — do NOT "test" it (a completed live checkout charges a real card; the test-mode twin was consumed proving the flow). Never print Keychain values; read via `security find-generic-password -a coldrig -s <service> -w`.
- **Unmerged lane branches:** `worktree-agent-a8f87cd1437a20f72` (I3+I4) holds real work; the brand-sweep worktree (`agent-a3b6ad8f1d279ebb6`) is MID-WRITE (locked) — do NOT prune either. Earlier lane branches (`worktree-agent-ab4beea4…`, `worktree-agent-ae74fe3c…`) are merged; branches kept for revertability.
- **Simulate endpoint:** `GET /checkout/simulate` 404s whenever Stripe OR engine is armed (`isRealSpendArmed`) — expected, not a bug. Adding any vendor env binding without extending that guard trips `apps/platform/test/spend-armed-env-coverage.test.ts` RED by design.
- **promotion_codes API:** pin `Stripe-Version: 2024-06-20` or POST /v1/promotion_codes rejects `coupon` (see repo `MEMORY.md`).
- **Site deploys whatever is on disk** (`npx wrangler pages deploy site --project-name=agent-cold-email --branch=main`) — check `git status` first. Deploy-ordering law: Worker before site whenever counts/claims change.
- **`site/agent-evaluation.md` still says "Stripe cannot take money yet"** — TRUE until the live-key flip; the program's final info pass updates it (claim-surface class — sweep by inventory, not memory).
- UNVERIFIED left: none material — live claims above were command-verified at write time (registry 0.2.2, tools/list=24, charges_enabled TRUE, MORDYPILOT active). Prior history: `archive/2026-07-22-golive-program/prior-HANDOFF.md`.

## Key files

- `ROADMAP.md ## Now / ## Open` — single source of truth for every open item + the program entry. `archive/ROADMAP-done.md` — drained done items.
- `docs/adversarial/*-2026-07-2{1,2}.md` — frozen verdicts (committed as of `c8b9ee3`) · `docs/research/*-2026-07-2{1,2}.md` — frozen designs/research.
- `archive/2026-07-22-golive-program/` — prior-HANDOFF snapshot + promo-checkout E2E evidence (screenshots + browser script).
- `apps/platform/src/engine/activation.ts` (live activation gate) · `apps/platform/src/engine/billing.ts` (`isRealSpendArmed`) · `apps/platform/src/billing/stripe-client.ts` (inline pricing + required coupon constraints comment).

## Resume — KIND A: process the in-flight lanes per the authorized program

Verify preconditions: `git -C ~/dev/coldstart status -sb` → main at/past `0105a6a`, in sync with origin (skill-produced doc commits may sit above it). `curl -s https://agent-cold-email-api.yaakovscher.workers.dev/status` → `{"status":"ok"}`. Then check each lane: if this is the SAME session, the task list / notifications carry them; if this is a FRESH session (task list gone), check on disk instead — does `docs/adversarial/i3i4-build-review-2026-07-22.md` exist? do `docs/research/human-signup-magic-link-design-2026-07-22.md` / `docs/research/ga-gates-design-2026-07-22.md` exist? `git -C ~/dev/coldstart/.claude/worktrees/agent-a3b6ad8f1d279ebb6 log --oneline -2` for the brand sweep. For each delivered lane, process per `ROADMAP.md ## Open` → "AUTONOMOUS GO-LIVE PROGRAM AUTHORIZED": adversary verdicts gate merges; merge → battery → deploy per the deploy-ordering law; the live-key flip follows the brand-fix deploy. A lane that died at a usage limit: RESUME it via SendMessage to its agent id — never re-dispatch its scope. Continue autonomously under the grant; stop only at browser-consent clicks or genuinely new founder-scope decisions.
