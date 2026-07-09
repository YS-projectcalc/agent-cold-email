# ColdStart — HANDOFF (resume here)

## Where we are (2026-07-09)
**LIVE in test mode.** The core product + distribution + agent surface are deployed and working:
- **API Worker:** https://agent-cold-email-api.yaakovscher.workers.dev — B0 full sandbox pipe + B5 agent surface (/mcp 12 tools, /demo/run, /api/waitlist). 28/28 tests.
- **Site (Pages):** https://agent-cold-email.pages.dev — AEO shell (llms.txt/openapi/server-card/sitemap/JSON-LD), honest early-access framing.
- **Public repo:** https://github.com/YS-projectcalc/agent-cold-email — public, 11 topics, AGENTS.md/README/LICENSE/site.
- **CLI:** `packages/cli` `agent-cold-email` (demo verified live; npm publish = activation).

Phases done: A (foundation+panel#1), B0/B4/B5, C0/C1/C2/C3/C6. Architecture SETTLED (ARCHITECTURE.md). Pricing SPEC §18. Vendor/economics research done (SPEC §12/13, docs/research/).

## In flight (2026-07-09)
**Panel #2 (live surfaces) fixes — 2 disjoint waves running:**
- Wave 1 (hard-builder, apps/platform + root docs): lookalike-brand guardrail (was advertised-but-absent), /signup rate limit, suppression-at-send, stop_on_reply, send-window enforce, atomic send-claim+ledger idempotency, billing order, /demo/run limits, body-size cap, token prefix.
- Wave 2 (design-builder, site/ only): docs "MCP live" honesty, `{{BRAND}}` title pre-render, CLI command names.
After both: verify → commit → redeploy Worker + Pages → push repo.
Panel #2 verdicts + records: `docs/adversarial/panel-02/`. security-isolation = CLEAN (no cross-tenant leak).

## Next lanes (ROADMAP)
B1 (paid plans + Stripe test-mode billing/metering + spend caps), B2 (resumable alarm-driven provisioning sagas — B0's are synchronous), B6 (deliverability control loop), B7 done-ish; D1-D6 (support/ops/legal/lifecycle/health); A5 (local-mailserver engine spike, Docker present); C4 (deep comparison content), C5 (registry submissions — activation); E (final panels + report). Then ACTIVATION.md (all owner-hands steps).

## Locked constraints (SPEC §0)
Sandbox-first (no vendor spend till activation); test-mode go-live + ACTIVATION.md; NO owner questions till final report; full adversarial regime.

## Held for owner → all tracked in ACTIVATION.md
Name pick (coldrig/coldpipe/coldloop), Stripe live KYC, vendor accounts + resale-model decision, npm login+publish, GitHub org transfer, domain, attorney review, email-routing arm, cron arm, Go-engine host, real-world deliverability smoke test (first activation gate).
