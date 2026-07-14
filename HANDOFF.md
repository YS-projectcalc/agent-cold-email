# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE (test mode):** site https://coldrig.dev · API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email@0.1.0` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything has CHANGED, surface exactly what and ask before acting. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · real vendor spend · npm publish · external send) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-14 — "activation day, round 2" — all non-founder-gated roadmap exhausted)

- **`ENGINE_TENANTS` per-tenant email-port allowlist BUILT + COMMITTED DARK, `f74687d`, adversary SHIP.** Comped-pilot shape: an allowlisted paid tenant routes email through `RealEmailPort` while domain/mailbox/billing/metrics stay sandbox; `parseEngineTenants` is total and fail-closed (unset/empty/wildcard/malformed ⇒ empty set, exact-string match only, no throw path); plan-check dominant (`isDemoOrFree` still forces sandbox even if allowlisted); global gate dominant (`realAdaptersActivated=false` ⇒ allowlist changes nothing); tenantId sourced from the DO's constructor-verified identity, never request input. Frozen verdict `docs/adversarial/engine-tenants-allowlist-review-2026-07-14.md`, `VERDICT: SHIP` (verified in file) — attacked wildcard/prefix/unicode/regex-token parsing, plan-check dominance, gate composition, id provenance; all held. Platform suite grew 263→284 (+21 tests, matches the commit's own count), typecheck 0. **Carried into `ACTIVATION.md` Gate 2` (verified present):** removing a tenant from `ENGINE_TENANTS` needs a DO restart/eviction to take effect (adapters cache per-DO) — plan revocation accordingly; post-arm, a paid tenant NOT on the allowlist gets a sandbox email port by design (allowlist strictly narrows).
- **B4 opt-out increment BUILT + COMMITTED, `ecfc5b2`, adversary SHIP after 4 rounds** (frozen verdict `docs/adversarial/b4-optout-review-2026-07-14.md`, verified: Round 1 NO-SHIP → Round 2 NO-SHIP → Round 3 NO-SHIP (one-line survivor) → **Round 4 SHIP**). Ships: public `/unsubscribe` (HMAC-SHA256-tokened one-click over `tenantId:email`, GET side-effect-free/scanner-safe, POST does the write, domain-separated key off `TOKEN_HASH_PEPPER`, constant-time compare), dual `List-Unsubscribe` (mailto + https) + `List-Unsubscribe-Post`, a full CAN-SPAM compliance footer (sender identity + physical address read from `tenant_profile`, fail-safe: a blank identity/address marks the send `'failed'` with an ops-visible event instead of sending non-compliant mail), typed-unsubscribe reply detection (conservative exact-phrase matcher, overrides `stop_on_reply`). Platform suite now **319/319 (53 files)**, typecheck 0 (verified via commit message + doc; not independently re-executed by this bookkeeping pass).
  - **The RFC 8058 marketing-overclaim DEPLOY BLOCKER is CLEARED.** Confirmed by grep: zero remaining hits of "verified sender identity" / the false footer claim across `README.md`, `ARCHITECTURE.md`, `site/faq.html`, `site/pricing.html`, `site/guide-*.html`, `site/openapi.yaml` — the adversary's round-3/round-4 sweep caught and fixed the last two survivors (`site/guide-mcp-cold-email.html:84`, `README.md:82`, `ARCHITECTURE.md:52`).
- **Ledger flip committed, `19a5f45`** (ROADMAP.md only) — B4 opt-out entry closed, deploy blocker cleared, remaining B4 scope narrowed to two items (below).
- Local `main` is **9 commits ahead of `origin/main`** (verified via `git status`); push/deploy remain founder-gated.
- Everything from the earlier rounds still holds: engine committed dark `eb8ee42` (+ nit-fix `7616d19`), legal D3 `5bade3e` (undeployed), docs reconciliation `5a30457`, npm + MCP Registry live, coldrig.dev live, SPEC §20 (BYO domains) shipped-verdict (build not started). See `archive/2026-07-14-activation-day/prior-HANDOFF.md` for that detail if needed.

## In flight / next

- **Nothing is in flight. All non-founder-gated roadmap items are exhausted.** Verify with `git status --short` (should be clean) and `git log --oneline -3` (tip should be `19a5f45`/`ecfc5b2`/`f74687d`) before trusting this.
- **REMAINING B4 scope (not started, not founder-blocked, could be picked up without asking):** (a) A/B testing for sequences — unbuilt, contracted in SPEC only. (b) A founder call is needed first on the manual-reply path: `apps/platform/src/engine/threads.ts:147` (the inbox `reply` tool) sends footerless, with no `List-Unsubscribe` header — adversary-ruled *defensibly transactional* (a direct reply to an inbound message, not a new outbound send), but Yaakov should ratify that reading or order the footer added regardless. This is now the founder-decision item, not a code blocker — (a) can proceed independently.
- **The deploy batch is now UNBLOCKED** (was blocked on the RFC 8058 overclaim, now cleared) — see Resume for the exact ordering.
- **Founder-gated queue, otherwise unchanged from prior rounds:**
  - Deploy batch: legal pages (`5bade3e`) + all site copy fixes (`ecfc5b2`) + the new `/unsubscribe` endpoint, deployed together — **Worker BEFORE site**, per the standing deploy-ordering landmine.
  - Manual-reply footer ratification (new, above).
  - PRICING RULING — designer + Yaakov converged on $49 + $10/mailbox; live `pricing.html` also has an internal send-estimate math inconsistency to fix in the same pass. Detail: `ROADMAP.md` `## Open`.
  - PulseMCP submission — prepared, needs Yaakov's direct in-session statement.
  - Smithery / mcp.so / cursor.directory — behind GitHub-OAuth; one headed login persists a profile.
  - llmstxt.site + directory.llmstxt.cloud — scripts ready in `archive/2026-07-14-activation-day/scratch-rescue/`, ~10s each.
  - Droplet provisioning — runbook in `ACTIVATION.md` Gate 2, CLEARED, not yet run.
  - Mailbox provider ruling (Inboxkit vs Mordy's own Google Workspace) + ~$10 test domain purchase.
  - Dogfood campaign — 3 founder calls (competitors? Jack Clark/Import AI? "roast it publicly" CTA risk). List + copy: `docs/research/dogfood-targets-2026-07-14.md`.
  - Stripe live activation (Gate 2) · Cloudflare Web Analytics toggle.
- Full itemized list: `ROADMAP.md` `## Now` + `## Open`.

## Landmines / gotchas

- **`ENGINE_TENANTS` allowlist revocation needs a DO restart.** Adapters are cached per-Durable-Object; removing a tenant from the env var does not take effect until that tenant's DO restarts/evicts. Plan any revocation with this in mind (`ACTIVATION.md` Gate 2).
- **Engine (`eb8ee42`) and the allowlist (`f74687d`) are both committed but DARK.** Arming needs `ENGINE_BASE_URL` + `ENGINE_AUTH_SECRET` set AND carries the two engine Gate-2 residuals (crash-window MUST resolve-or-founder-accept; multi-instance N/A) — do not silently provision past those.
- **The RFC 8058 overclaim is CLEARED — don't reintroduce it.** If future copy edits touch compliance language, the banned phrase class is "physical postal address and verified sender identity are injected into every message footer" stated as a flat present-tense fact when it isn't (it's real now, post-`ecfc5b2`, but re-check before any future claim expansion, e.g. if new pages get added).
- **Stripe CANNOT take money:** `STRIPE_SECRET_KEY` unset in prod — `/checkout` returns a simulated URL and upgrades a tenant with zero card/dollars (intentional test-mode; anyone with the API can self-upgrade). Webhook fails closed (503, `STRIPE_WEBHOOK_SECRET` unset). ACTIVATION Gate 2.
- **No human can buy or use this today** — no human signup form, no dashboard billing controls. `[ORDER]` on record for the external design lane. Evidence: `pw-shots/human-journey-2026-07-14/` (14 screenshots, both widths, gitignored).
- **Design is EXTERNALLY owned** (`685a202`) — a different LLM builds landing/human pages in `~/Documents/Codex/2026-07-14`. Do NOT design here — integrate + re-verify when handed over.
- Deploys: Worker via `npm run deploy` in `apps/platform/` (applies D1 migrations FIRST — never bare `wrangler deploy`). Pages deploys from an agent worktree **must pass `--branch main`** or they land as preview, not production. **This round's deploy batch needs Worker deployed before the site** (the site's compliance copy now describes real endpoint behavior that must exist first).
- `apps/platform/vitest.config.ts` `fileParallelism: false` is REQUIRED (shared Miniflare) — removing it re-introduces flakes.
- npm + MCP-Registry credentials are Yaakov's identity (2FA / device-flow) — publishes need his hands.
- This repo is a shared/live worktree across concurrent agent sessions — re-`git status`/re-Read before editing tracked docs; don't `git checkout`/`reset`/`clean` any path without confirming nothing else is mid-write there. (Hit once this round: an Edit reported "file modified since read" on `HANDOFF.md` itself — re-Read confirmed no content loss, but always re-verify rather than assume.)

## Key files

- `SPEC.md` (§0 locks · §12/§12.1 economics · §19 dashboard · §20 BYO domains/mailboxes) · `ROADMAP.md` (`## Now` / `## Open` ledger) · `ACTIVATION.md` (owner-hands gates; **Gate 2 engine line = CLEARED TO PROVISION**, allowlist DO-restart note added) · `ARCHITECTURE.md` (#6 = Node engine, ratified) · `CLAUDE.md` (project law) · `MEMORY.md` (build lessons) · `AGENTS.md` (the 17-tool surface).
- `docs/adversarial/engine-host-review-2026-07-14.md` (engine, `VERDICT: SHIP`) · `docs/adversarial/engine-tenants-allowlist-review-2026-07-14.md` (allowlist, `VERDICT: SHIP`) · `docs/adversarial/b4-optout-review-2026-07-14.md` (opt-out flow, 4 rounds, final `VERDICT: SHIP`) · `docs/adversarial/byo-domain-design-review-2026-07-14.md` (BYO, frozen).
- `docs/research/dogfood-targets-2026-07-14.md` — 28-target dogfood list + copy (frozen) · `docs/research/warmforge-bundle-verification-2026-07-12.md` + `docs/research/vendor-costs-mailforge-inboxkit-2026-07-12.md` — sourcing for §12/§18 cost basis.
- `apps/engine/` — Node SMTP/IMAP daemon, committed (`eb8ee42`), flag-dark · `apps/platform/src/vendors/factory.ts` — the `ENGINE_TENANTS` allowlist gate · `apps/platform/src/engine/threads.ts:147` — the manual-reply footer decision point.
- `archive/2026-07-14-activation-day/` — this day's provenance dir (`prior-HANDOFF.md`, `scratch-rescue/` for pending llmstxt/Tally scripts, `verifier-scratch/` for completed verification-drive scripts).

## Resume — KIND B: the next step is founder-owned (verify, then confirm before acting)

**Verify first:** `git -C ~/dev/coldstart status --short` (should be clean) and `git log --oneline -10` (tip should show `19a5f45`, `ecfc5b2`, `f74687d` in that order). If that holds, all code work that doesn't need Yaakov is done for this arc.

**With Yaakov's confirmation, the deploy batch is ready to go — in this order:**
1. `npm run deploy` in `apps/platform/` (Worker — applies D1 migrations first, ships the `/unsubscribe` endpoint and the allowlist code, both still flag-dark/no-op until armed).
2. Site deploy (`--branch main`) — legal pages (`site/dpa.html`, updated terms/privacy/aup) + all the compliance-copy fixes from `ecfc5b2`.
3. Do NOT skip step 1 — the site's compliance copy now describes real endpoint behavior (the `/unsubscribe` link, the footer claims) that must actually exist before the copy goes live, or the overclaim problem reappears in a new form (copy true in the repo, false in prod).

**Then, whenever he has time for each (none block each other, no fixed order required):**
1. Rule on the manual-reply footer question (`threads.ts:147`) — ratify "defensibly transactional, no footer needed" or order it added.
2. Provision the engine host (~$6/mo droplet, verbally approved) — runbook in `ACTIVATION.md` Gate 2, CLEARED.
3. Mailbox provider (Inboxkit vs Google Workspace) + ~$10 test domain — both block the Gate-1 real-send smoke.
4. Pricing ruling, PulseMCP statement, directory logins (Smithery/mcp.so/cursor.directory), dogfood's 3 founder calls, Stripe live activation, Cloudflare Analytics toggle.

**If resuming with no founder input available at all:** the only non-gated code work left is B4's A/B-testing increment — de-risk and adversary-gate it exactly like every other lane before committing. Do not start a new roadmap item beyond what's in `## Open` without asking.

Do NOT deploy, push, or spend without confirming with Yaakov first.
