# ColdStart / coldrig — Handoff

Agent-operated cold-email platform. **LIVE (test mode):** site https://coldrig.dev · API + dashboard https://agent-cold-email-api.yaakovscher.workers.dev (`/app`) · npm `agent-cold-email@0.1.0` · MCP Registry `io.github.YS-projectcalc/agent-cold-email` · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming with zero prior context. Re-orient from `## Resume` below, then VERIFY its preconditions still hold.** If they hold and the step is non-destructive, proceed — don't ask open-endedly what to work on. If anything has CHANGED, surface exactly what and ask before acting. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · real vendor spend · npm publish · external send) — SPEC §0 locks NO real vendor spend until the owner works `ACTIVATION.md`.

## Where we are right now (2026-07-15 — "day 2")

- **External design integration MERGED to main.** `d68be4f` merges `design/coldrig-human-interface` (tip `442383d`, based on `355926c` — 11 commits behind main at merge time) onto main's tip, resolving conflicts by keeping main's shipped compliance/legal content while adopting the designer's new pages, styling, and continuous-pricing model. 104 files changed (verified via `git show --stat d68be4f`), full human-journey pages, dashboard Billing/Setup/Signup/Recovery bundles rebuilt, $99-first pricing on every surface, `compare-vs-salesforge` page. Adversary: Round 1 **NO-SHIP** (`status.html:7` health-endpoint CTA 404'd, `/health` should be `/status`) → fixed + frozen in `a64f837` → **FINAL VERDICT: SHIP** in `db80c00` (verified in `docs/adversarial/design-integration-review-2026-07-15.md`). Two non-blocking follow-ups carried forward: an unverifiable waitlist-CORS-origin note, and the `support-kb.ts` stale-tier finding (below). **NOT deployed.**
- **Pricing RATIFIED by Yaakov in-session:** pitch = "starts at $99/5 mailboxes, +$10/mailbox"; sends guidance never caps (approximate/informational only, never contractual). Backend billing migration (Stripe quantity-billing, spend ceiling, plan enums) is open core work, not yet started. **Confirmed stale:** `support-kb.ts` (`draftBillingAnswer()`, verified in file) still quotes the retired three-tier model verbatim — "Launch $99/mo (5 mailboxes...), Growth $299/mo..., Scale $799/mo..." — contradicts the ratified pricing; ledgered in `ROADMAP.md`, not yet fixed.
- **CLI 0.2.0 stdio MCP mode COMMITTED, `324a15c`, adversary SHIP after 2 rounds** (Round 1 NO-SHIP — flaky test lane from connect-first ordering — fixed, FINAL VERDICT SHIP, verified in `docs/adversarial/cli-mcp-bridge-review-2026-07-15.md`). New `agent-cold-email mcp` subcommand bridges stdio to the hosted streamable-HTTP endpoint; stdio serves `initialize` locally first, upstream connect backgrounded. **Not yet published** — `server.json` already claims npm `agent-cold-email@0.2.0`, so the 0.2.0 npm publish must land before/with any MCP-registry metadata update (owner sequencing note in the verdict doc, not a code defect). **Owner publish steps (operational, not repo-verifiable — take as reported):** `cd packages/cli && npm publish` (2FA) then `mcp-publisher login github && mcp-publisher publish` from repo root — cached `mcp-publisher` token reported expired, re-login needed.
- **Directory batch, founder-authorized, executed this round** (full detail + screenshots: `ROADMAP.md`, `pw-shots/directory-batch-2026-07-15/`): llmstxt.site ✓ submitted · directory.llmstxt.cloud ✓ submitted (Tally) · mcp.so ✓ submitted, free tier (submission `b5135b9d`) · awesome-mcp-servers PR #10106 — badge commit `1cc4948` pushed + reply posted, merge is now the maintainer's move · Glama — already-listed (auto-crawled), claim needs Yaakov's GitHub-OAuth click · Smithery — STAGED not published, blocked on the gateway reserving the `Authorization` header (needs a Worker `X-API-Key` bearer-equivalent change, queued for the deploy batch) · cursor.directory — blocked on a repo-root `.mcp.json` file (not yet added, post-push item) · Cline — HELD on honesty (their submission form requires attesting a real Cline test was run; not done, never false-attest) · PulseMCP — bot-walled, needs Yaakov's own browser or the drafted email.
- **Business-readiness verdict landed** (critique skill, drafter+skeptic, 2026-07-15; full text `ROADMAP.md` `## Open`, verified). Survivors: **(a) monitoring/alerting is the one genuinely unplanned gap** — nothing pages anyone, `/status` only does `SELECT 1` (`routes/status.ts:10`), ops cron is dark, no engine-droplet watchdog, `ACTIVATION.md` has zero monitoring items — recommended: build a synthetic-check + founder-notify lane and add it to ACTIVATION Gate 2 as an arming prerequisite, **build is recommended but not yet founder-approved to start**; (b) no ops outbound-email channel — blocks both dunning notices and support replies; (c) support triage is regex, not AI (`support-kb.ts:19-58`, no LLM call anywhere in the repo) — fine today since the site makes no AI-support claim (verified), but never market it as AI until it's real; (d) no tenant-invocable data-erasure endpoint (teardown deletes exist, but nothing customer-callable); (e) **`ACTIVATION.md:67` is STALE** — it claims the CAN-SPAM address is still a placeholder, but it's actually filled: verified `EpiphanyMade, 209 Crest Hill Road, Toms River, NJ 08755, US` present in both `site/terms.html:93` and `site/privacy.html:91`, no placeholder text remains — fix the doc line; (f) attorney review remains the real legal gate. Dissolved by the skeptic (do not re-raise): "complaint-breaker unreachable," "no row-level DELETE," the CAN-SPAM-placeholder-as-violation claim.
- Local `main` is **19 commits ahead of `origin/main`** (verified via `git status`); push/deploy remain founder-gated. **The deploy batch is now COMPLETE**: design + pricing + legal/DPA + `/unsubscribe` + compliance copy, optionally riding along with the queued `X-API-Key` change and the `ACTIVATION.md:67` doc fix if they land first.
- Everything from earlier rounds still holds (engine `eb8ee42`+`7616d19`, allowlist `f74687d`, B4 opt-out `ecfc5b2`, legal D3 `5bade3e`, docs `5a30457`, npm+MCP Registry live, coldrig.dev live). See `archive/2026-07-14-activation-day/prior-HANDOFF.md` for that detail if needed.

## In flight / next

- **Nothing is in flight.** Verify with `git status --short` (should be clean) and `git log --oneline -3` (tip should show `324a15c`/`ff359e3`/`db80c00`).
- **Non-gated code work available right now, no founder input needed:** the `X-API-Key` bearer-equivalent Worker change (unblocks the Smithery publish), the `.mcp.json` repo-root file (unblocks cursor.directory's rescan), the `ACTIVATION.md:67` doc-line fix (address is already filled, just correct the checklist wording), the `support-kb.ts` stale-tier fix (rewrite `draftBillingAnswer()` to the ratified $99+$10/mailbox model), and B4's A/B-testing increment. All four small fixes can ride into the deploy batch; adversary-gate anything code-behavior-affecting before committing (the two doc/copy-only fixes don't need a full round, but don't skip a sanity check).
- **Monitoring/alerting lane is RECOMMENDED but NOT YET FOUNDER-APPROVED to start** — this is a scope decision (new cron + external-notify wiring), not pure execution; ask before building, don't infer approval from "it's on the ledger."
- **Founder-gated queue:**
  - Deploy-go + push — Worker (`npm run deploy` in `apps/platform/`, D1 migrations first) BEFORE site (`--branch main`).
  - The two CLI publish commands (npm 2FA, `mcp-publisher` re-login + publish).
  - Glama OAuth claim click · PulseMCP submission (browser or email) · GSC/Bing indexation + Cloudflare Web Analytics toggle.
  - Mailbox provider ruling (Inboxkit vs Google Workspace) + ~$10 test domain + engine-host droplet provisioning (runbook `ACTIVATION.md` Gate 2, CLEARED).
  - Dogfood campaign's 3 founder calls (competitors? Jack Clark/Import AI? "roast it publicly" CTA risk).
  - Cline real-setup test (~10 min, unblocks the Marketplace submission).
  - Manual-reply footer ratification (`apps/platform/src/engine/threads.ts:147`, carried from the prior round, still unresolved).
  - Attorney review of legal docs · TM clearance for the display brand.
  - Monitoring-lane go/no-go (above).
- Full itemized list: `ROADMAP.md` `## Now` + `## Open`.

## Landmines / gotchas

- **Design integration is DONE and merged (`d68be4f`) — but that doesn't reopen the "design here" door.** The external LM's deliverable landed via a conflict-resolved merge (ledger docs kept OURS/main, MEMORY untouched — see the merge commit for the full resolution policy). If more design/polish work is needed later, confirm with Yaakov whether it routes externally again or is now in-repo scope — don't assume either way.
- **`support-kb.ts` quotes retired pricing** (`draftBillingAnswer()`) — a real customer-facing inconsistency between the AI-support-adjacent copy and the ratified $99+$10/mailbox model. Low-risk mechanical fix, listed above as available non-gated work.
- **`ACTIVATION.md:67` is stale** (says CAN-SPAM address is a placeholder; it's filled) — don't trust that checklist item's wording without re-verifying like this round did; it's a doc-only fix, not a real gap.
- **Smithery's gateway reserves the `Authorization` header** — do not attempt the Smithery publish until the `X-API-Key` Worker change ships, or the listing goes live pointing at a broken connection (exactly the "unshipped claim" failure class this project has been sweeping for all week).
- Engine (`eb8ee42`) and the allowlist (`f74687d`) are both committed but DARK; B4 opt-out (`ecfc5b2`) is committed and live-code-ready but undeployed. Arming/deploying still carries the engine's two Gate-2 residuals (crash-window MUST resolve-or-founder-accept; multi-instance N/A) — do not silently provision past those.
- **Stripe CANNOT take money:** `STRIPE_SECRET_KEY` unset in prod — `/checkout` returns a simulated URL and upgrades a tenant with zero card/dollars. Webhook fails closed (503). ACTIVATION Gate 2.
- Deploys: Worker via `npm run deploy` in `apps/platform/` (D1 migrations FIRST — never bare `wrangler deploy`). Pages deploys **must pass `--branch main`** or land as preview. This round's deploy batch needs Worker before site (same reason as last round: copy now describes real endpoint behavior).
- `apps/platform/vitest.config.ts` `fileParallelism: false` is REQUIRED (shared Miniflare) — removing it re-introduces flakes.
- npm + MCP-Registry credentials are Yaakov's identity (2FA / device-flow) — publishes need his hands.
- This repo is a shared/live worktree across concurrent agent sessions — re-`git status`/re-Read before editing tracked docs; don't `git checkout`/`reset`/`clean` any path without confirming nothing else is mid-write there. (This exact file has repeatedly reported "modified since read" mid-edit from a concurrent process — always re-Read and diff-check rather than assume the edit landed cleanly.)

## Key files

- `SPEC.md` (§0 locks · §12/§12.1 economics · §19 dashboard · §20 BYO domains/mailboxes) · `ROADMAP.md` (`## Now` / `## Open` ledger, canonical for full directory-batch and business-readiness detail) · `ACTIVATION.md` (owner-hands gates; **Gate 2 engine line = CLEARED TO PROVISION**; line 67 stale, see Landmines) · `ARCHITECTURE.md` (#6 = Node engine, ratified) · `CLAUDE.md` (project law) · `MEMORY.md` (build lessons) · `AGENTS.md` (the 17-tool surface).
- `docs/adversarial/design-integration-review-2026-07-15.md` (`FINAL VERDICT: SHIP`) · `docs/adversarial/cli-mcp-bridge-review-2026-07-15.md` (`FINAL VERDICT: SHIP`) · `docs/adversarial/engine-host-review-2026-07-14.md` · `docs/adversarial/engine-tenants-allowlist-review-2026-07-14.md` · `docs/adversarial/b4-optout-review-2026-07-14.md` · `docs/adversarial/byo-domain-design-review-2026-07-14.md`.
- `support-kb.ts` (`draftBillingAnswer()` — stale tiers) · `apps/platform/src/routes/status.ts:10` (monitoring gap — `SELECT 1` only) · `apps/platform/src/engine/threads.ts:147` (manual-reply footer decision point) · `packages/cli/` (0.2.0 stdio MCP mode, committed not published).
- `pw-shots/directory-batch-2026-07-15/` — screenshots for this round's directory submissions.
- `archive/2026-07-14-activation-day/` — prior-day provenance dir (`prior-HANDOFF.md`, `scratch-rescue/`, `verifier-scratch/`).

## Resume — KIND B: the next step is founder-owned (verify, then confirm before acting)

**Verify first:** `git -C ~/dev/coldstart status --short` (should be clean) and `git log --oneline -3` (tip should show `324a15c`, `ff359e3`, `db80c00`). If that holds, everything in this file is current.

**Non-gated code work you can start without asking (small, mechanical, adversary-gate before committing):**
1. `X-API-Key` bearer-equivalent on the Worker (unblocks Smithery).
2. Repo-root `.mcp.json` (unblocks cursor.directory).
3. `ACTIVATION.md:67` — fix the stale CAN-SPAM-placeholder wording (address is already filled).
4. `support-kb.ts` `draftBillingAnswer()` — rewrite off the retired three-tier model onto $99+$10/mailbox.
5. B4's A/B-testing increment (still the only sizable non-gated build left).
Do NOT start the monitoring/alerting lane without Yaakov's explicit go — it's a scope decision, not execution, even though it's ledgered as recommended.

**With Yaakov's confirmation, the deploy batch is ready — same order as last round:**
1. `npm run deploy` in `apps/platform/` (Worker — D1 migrations first).
2. Site deploy (`--branch main`) — design integration + pricing + legal/DPA + compliance copy.
3. Don't skip step 1 — site copy now describes real endpoint behavior that must exist first.

**Then, whenever he has time (none block each other):**
1. The two CLI publish commands (npm 2FA, `mcp-publisher` re-login).
2. Glama OAuth click, PulseMCP submission, GSC/Bing + CF Analytics toggle.
3. Mailbox provider + test domain + droplet provisioning.
4. Dogfood's 3 founder calls, Cline real-setup test, manual-reply footer ratification.
5. Monitoring-lane go/no-go, attorney review, TM clearance.

**If resuming with no founder input available at all:** work the 5 non-gated items above in order, adversary-gating each before commit. Do not start anything beyond what's in `ROADMAP.md` `## Open` without asking.

Do NOT deploy, push, or spend without confirming with Yaakov first.
