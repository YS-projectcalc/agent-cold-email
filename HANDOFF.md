# ColdStart — HANDOFF (resume here)

## ⭐ PROGRAM COMPLETE (test-mode CORE) — 2026-07-09
The entire business is BUILT, DEPLOYED, LIVE in test mode, and hardened through 3 adversarial opus panels (all remediated + live-verified). **130/130 tests.** Nothing else is buildable autonomously — remaining work needs the owner (ACTIVATION.md) or is refinement of working systems.

**Live:**
- API (Worker v 13f8ee36): https://agent-cold-email-api.yaakovscher.workers.dev — full sandbox pipe + AI deliverability loop + Stripe test-mode billing/quotas + MCP(12 tools)/CLI/demo + admin support/dunning/digest + lifecycle(cancel/teardown/terminate/chargeback). D1 `coldstart-platform-db` (migrations through 0004). Secrets set: TOKEN_HASH_PEPPER, ADMIN_TOKEN. STRIPE_* unset by design (webhook fails-closed until activation).
- Site (Pages `agent-cold-email`): https://agent-cold-email.pages.dev — AEO shell + 5 deep guides + legal, clean URLs.
- Repo (public): https://github.com/YS-projectcalc/agent-cold-email

**Owner deliverables:** `FINAL-REPORT.md` (summary + name rec coldrig + 3 held decisions) · `ACTIVATION.md` (every owner-hands step) · `docs/adversarial/panel-0{1,2,3}/` (panel records) · `docs/research/` (vendor/economics provenance).

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
