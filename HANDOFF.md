# ColdStart — Handoff

Agent-operated cold-email platform, BUILT + LIVE in test mode. Live: API https://agent-cold-email-api.yaakovscher.workers.dev · site https://agent-cold-email.pages.dev · repo https://github.com/YS-projectcalc/agent-cold-email · Code: `~/dev/coldstart/`

> **You are resuming ColdStart with zero prior context. Re-orient from the `## Resume` step below, then VERIFY its preconditions still hold** (the decisions listed as pending may have been made since this was written — check `ACTIVATION.md` Gate 0 first). **If they hold, proceed per Resume — don't ask open-endedly what to work on.** If anything has CHANGED, surface exactly what and ask before acting. **STOP and confirm before any destructive/irreversible/founder-owned step** (deploy · push · real vendor spend · npm publish · external send) — this project's SPEC §0 locks NO real vendor spend until the owner works ACTIVATION.md.

## Where we are right now (2026-07-12)

- **Build: COMPLETE (test-mode CORE) since 2026-07-09.** 130/130 tests, 3 adversarial panels remediated, all lanes live in sandbox (full pipe, AI deliverability loop, Stripe test-mode billing, MCP 12 tools + CLI + demo, support/dunning/digest, lifecycle). Worker v `13f8ee36`, D1 migrations through 0004, `STRIPE_*` unset by design (webhook fails closed). Details: `FINAL-REPORT.md` (point-in-time build report).
- **This session (07-12) was the founder-decisions round.** State of the 3 held decisions:
  1. **Name — structure SETTLED, word PENDING.** Adversarial NO-SHIP on pure-keyword "agentcoldemail" as brand (`docs/adversarial/name-review-2026-07-12.md`): keep distinct brand + permanent `agent-cold-email` keyword slug. Standing word candidate: **coldrig** (`coldrig.dev` verified AVAILABLE, `coldrig.com` PARKED, checked 07-12). Attorney trademark clearance required on whichever word is picked.
  2. **Vendor resale model — DECIDED: Mailforge-first** at activation while pursuing an Inboxkit enterprise/reseller agreement in parallel; **option c APPROVED (07-12) as the ADDITIONAL premium "Dedicated" tier** (customer owns their Inboxkit account, we operate it) — fast-follow, build prereq = per-tenant `VendorPort` credentials. `ACTIVATION.md` Gate 0/1/2 updated; positioning + blast-radius rationale in `ROADMAP.md` final 2026-07-12 entries.
  3. **Pricing — analysis COMPLETE, sign-off PENDING (now unblocked).** ⚠️ Key findings: Mailforge standalone all-in ≈ **$13.5/mbx/mo** (Warmforge warmup $10/mbx is NOT in the $3 headline); the Salesforge "unlimited Warmforge" bundle was then desk-verified **BUNDLE LIMITED** (99-cap + Whitelabel exclusion — `docs/research/warmforge-bundle-verification-2026-07-12.md`), so the margin basis is the **ramp-only warmup model: all-in ~$4.50–5.00/mbx, draft tiers clear ~2.6–3.3×**. Inboxkit direct-retail verified: $46/mo @5 mbx, $61 @10, $285–296 @50, API on all tiers. Full receipts: `docs/research/pricing-landscape-2026-07-12.md` + `docs/research/vendor-costs-mailforge-inboxkit-2026-07-12.md`.
- **Agent-search panel** (8 probes, 46 verbatim queries — note: the frozen doc's "44" line is an undercount, 46 is correct per `ROADMAP.md` correction pointer): agents search category keywords ("cold email MCP server" 8/8, "Instantly vs Smartlead" 8/8) but cite proper nouns — the empirical basis for the name structure. The derived SEO/AEO backlog WITH its arguments (tool-count-heuristic counter-page, assembly-question guide, maintenance signals, exact-phrasing guides) is frozen at `docs/research/aeo-backlog-2026-07-12.md` — pending owner green-light. Raw queries: `docs/research/agent-search-queries-2026-07-12.md`.

## In flight / next

- Next action: present/confirm the two remaining founder decisions → see `## Resume` below (single source for the exact steps).
- Still running: none — all 07-12 lanes landed and are frozen in `docs/research/` + `docs/adversarial/`.
- In progress (not finished): none.
- Open decisions / blockers: (1) brand word pick; (2) pricing sign-off — now UNBLOCKED: the bundle question is desk-resolved (BUNDLE LIMITED — see Landmines), sign off against the ramp-only COGS model (~$4.50–5.00/mbx) in `docs/research/warmforge-bundle-verification-2026-07-12.md` + the competitive landscape in `docs/research/pricing-landscape-2026-07-12.md`.

## Landmines / gotchas

- **SPEC §0 lock: NO real vendor spend / real sending until the owner works `ACTIVATION.md`.** Everything real-adapter throws `NotActivatedError` until wired.
- **Mailforge API is unconfirmed:** their pricing page omits it from included features; their ToS presupposes it exists. Do not build against it before the support confirmation (`ACTIVATION.md` Gate 1).
- **Warmforge/Salesforge "unlimited warmup" bundle: RESOLVED — BUNDLE LIMITED, do not rely on it** (ToS 99-accounts/workspace warmup cap + Whitelabel FAQ excludes Warmforge from the reseller option). The margin model runs on **ramp-only warmup** instead (~$4.50–5.00/mbx all-in — `docs/research/warmforge-bundle-verification-2026-07-12.md`); the drafted support inquiry there is optional upside only.
- The Mailforge 63%-placement claim in the research is **competitor-authored (Inboxkit)** — directional only.
- npm is NOT authed on this machine (npm publish = owner-hands, `ACTIVATION.md` Gate 3).
- Memory split (pre-existing): global memory (`~/.claude-acct2/.../memory/coldstart-platform-build.md`) holds session-recall state; repo `MEMORY.md` holds build lessons. Both are live; don't consolidate mid-handoff.
- Cron watchdog `baf7d82d` from the original build session was session-only w/ 7-day expiry — dead; ignore references to it.

## Key files

- `ACTIVATION.md` — the owner go-live checklist (Gates 0–4), updated 07-12 with decision state + 2 new Gate-1 verification items.
- `FINAL-REPORT.md` — the build report (frozen at 07-09; decision status has moved on — HANDOFF + ACTIVATION are current).
- `docs/research/agent-search-queries-2026-07-12.md` · `pricing-landscape-2026-07-12.md` · `vendor-costs-mailforge-inboxkit-2026-07-12.md` — frozen decision research (the 46-query AEO target list lives in the first).
- `docs/adversarial/name-review-2026-07-12.md` — name verdict (NO-SHIP pure-keyword; hybrid structure).
- `SPEC.md` — canonical design (§18 pricing, §13 vendors, §0 locks) · `ROADMAP.md` — ledger + session log · `ARCHITECTURE.md` · repo `CLAUDE.md` (project law) · `MEMORY.md` (build lessons).
- Deploy (when authorized): `cd apps/platform && wrangler deploy` · migrations `wrangler d1 migrations apply coldstart-platform-db --remote` · site `wrangler pages deploy site --project-name agent-cold-email`.

## Resume — KIND B: the next steps are founder-owned decisions (present, don't execute)

First verify preconditions: read `ACTIVATION.md` Gate 0 — if any of the three items below is already marked decided there, skip it and move to the next.

Present these to Yaakov, with the pre-computed recommendations:

1. **Brand word** — options: **coldrig** (recommendation; `.dev` free, `.com` parked), coldpipe, coldloop (verification in `docs/adversarial/name-review-2026-07-12.md`). On pick: register the `.dev`, start attorney TM clearance, then update site/server-card display branding (slug `agent-cold-email` stays everywhere).
2. ~~Option-c additional premium tier~~ — **DECIDED 07-12: APPROVED** as the Dedicated tier, fast-follow (see "Where we are" #2.2). No founder action needed now; the per-tenant `VendorPort` credentials build item goes on the build queue when activation work starts.
3. **Pricing sign-off — UNBLOCKED.** Present the numbers: ramp-only COGS ~$4.50–5.00/mbx (`docs/research/warmforge-bundle-verification-2026-07-12.md`) means the draft tiers (Launch $99 / Growth $299 / Scale $799, quotas in `packages/shared/src/pricing.ts`: 2dom/5mbx · 6/20 · 18/60) clear ≥2.5× on the Mailforge path; landscape positioning in `docs/research/pricing-landscape-2026-07-12.md` (the "empty middle" between $47–174 software and $2k+ DFY). Ask for sign-off or adjusted numbers; optional upside first: founder may send the drafted Warmforge support inquiry (same frozen doc) chasing warm-only bundle eligibility.

After decisions land: record them in `ACTIVATION.md` Gate 0 + `ROADMAP.md` session log, then work `ACTIVATION.md` top-to-bottom (first hard gate before any paying customer: the real-world deliverability smoke test, Gate 1). Optional autonomous work needing no founder input: the A5 engine spike (Docker local-mailserver IMAP-contract validation, see `ROADMAP.md` §remaining) and the SEO/AEO backlog IF green-lit.
