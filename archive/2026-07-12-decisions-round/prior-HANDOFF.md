# ColdStart — HANDOFF (resume here)

## ⭐ PROGRAM COMPLETE (test-mode CORE) — 2026-07-09
The entire business is BUILT, DEPLOYED, LIVE in test mode, and hardened through 3 adversarial opus panels (all remediated + live-verified). **130/130 tests.** Nothing else is buildable autonomously — remaining work needs the owner (ACTIVATION.md) or is refinement of working systems.

**Live:**
- API (Worker v 13f8ee36): https://agent-cold-email-api.yaakovscher.workers.dev — full sandbox pipe + AI deliverability loop + Stripe test-mode billing/quotas + MCP(12 tools)/CLI/demo + admin support/dunning/digest + lifecycle(cancel/teardown/terminate/chargeback). D1 `coldstart-platform-db` (migrations through 0004). Secrets set: TOKEN_HASH_PEPPER, ADMIN_TOKEN. STRIPE_* unset by design (webhook fails-closed until activation).
- Site (Pages `agent-cold-email`): https://agent-cold-email.pages.dev — AEO shell + 5 deep guides + legal, clean URLs.
- Repo (public): https://github.com/YS-projectcalc/agent-cold-email

**Owner deliverables:** `FINAL-REPORT.md` (summary + name rec coldrig + 3 held decisions) · `ACTIVATION.md` (every owner-hands step) · `docs/adversarial/panel-0{1,2,3}/` (panel records) · `docs/research/` (vendor/economics provenance).

**2026-07-12:** The `coldrig`/keyword-first brand-name decision (FINAL-REPORT.md held item #1) now has empirical search data behind it — `docs/research/agent-search-queries-2026-07-12.md` (8-probe agent panel) shows agents search category keywords + incumbent comparisons, never brand names, supporting keyword-first naming over a clever brand. It also surfaced an SEO/AEO backlog: incumbent-comparison pages (Smartlead/Instantly vs agent-cold-email), a tool-coverage matrix (MCP tool counts, deliverability %s), and "how many inboxes do I need" + warmup-timeline guides — all pending owner direction, not yet built.

**2026-07-12 owner-decisions status (FINAL-REPORT.md held items):** #1 name — structure now **SETTLED** per adversarial review (`docs/adversarial/name-review-2026-07-12.md`): the pure-keyword brand "agentcoldemail" is NO-SHIP; keep the shipped distinct-brand + permanent-keyword-slug split. Word pick still pending — coldrig remains the standing candidate; re-verified `coldrig.dev` **AVAILABLE**, `coldrig.com` **PARKED**. See `ACTIVATION.md` Gate 0. #2 resale legal model — unchanged: **DECIDED** (verbal, in-session): start with Mailforge (option b) as the activation-time real mailbox vendor while pursuing an Inboxkit enterprise/reseller agreement (option a) in parallel; management-service (option c) stays under active evaluation as a possible additional offering tier, not decided. See `ACTIVATION.md` Gate 0/1/2. #3 pricing — analysis **COMPLETE** (`docs/research/pricing-landscape-2026-07-12.md`, `docs/research/vendor-costs-mailforge-inboxkit-2026-07-12.md`). Key finding: Mailforge standalone all-in is ~$13.5/mbx/mo (Warmforge's $10/mbx warmup is NOT included in the $3 headline slot rate) vs the Inboxkit direct-retail path, whose verified all-in is $46/mo at 5 mailboxes ($9.20/mbx), $61/mo at 10 ($6.10/mbx), and $285–296/mo at 50 (~$5.70–5.90/mbx), API included on all tiers. The new Gate-1 Salesforge-bundle verification item ("unlimited warmup slots included" with a Salesforge subscription) decides which margin model holds for the Mailforge path. Option-c (management-service) analysis was also delivered to the founder: viable as an additional premium BYO-account tier. Awaiting founder direction on all three.

## To go live
Work `ACTIVATION.md` top to bottom. First gate before any paying customer: the real-world deliverability smoke test.

## Remaining (ACTIVATION-hardening backlog — none block test-mode)
B2 resumable alarm sagas + end-of-period-teardown & send→bill reapers; D4 OFAC screening (needs real signups); A5 local-mailserver engine spike (Docker present; validates real IMAP contract before the swap); D6 per-tenant margin + backups/DR + master-key rotation; real Stripe live + vendor + Go-engine wiring; distribution-validation harness (fresh-agent-discovers-us, meaningful only post-index). All in ROADMAP §"remaining" + ACTIVATION.

## Locked constraints (SPEC §0)
Sandbox-first; test-mode; NO owner questions till the report (done — held items are in ACTIVATION/FINAL-REPORT); full adversarial regime (done, 3 panels).

## Key ops notes
- Two-builder git rule: subagents leave commits to the main loop (git-guard); parallel builders must touch DISJOINT files (apps/platform vs site/ vs root docs).
- Deploy: `cd apps/platform && wrangler deploy`; migrations `wrangler d1 migrations apply coldstart-platform-db --remote`; site `wrangler pages deploy site --project-name agent-cold-email`.
- Cron watchdog baf7d82d (3h, session-only, 7-day expiry) — build resilience, not product.
