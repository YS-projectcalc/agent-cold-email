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

## In flight (2026-07-09, cont'd)
**B1 money path built, NOT yet deployed.** `POST /checkout` (real Stripe test-mode Checkout Session when `STRIPE_SECRET_KEY` is set, else a fully-exercisable simulated session/landing route), plan quotas + a distinct sandbox/paid provisioning-cap runaway guard enforced in `setup_infrastructure`, per-mailbox/mo + per-send metering aggregating into `account().usageCents` (+ inert Stripe usage-report call), idempotent `POST /webhooks/stripe` (signature-verified when `STRIPE_WEBHOOK_SECRET` is set). 65/65 tests green, typecheck clean (3 workspaces), `wrangler deploy --dry-run` clean. Real-Stripe code paths are coded-to-docs but UNVERIFIED (no key anywhere) — that's the activation gate. Left uncommitted (shared worktree, git-guard) — orchestrator to review + commit + redeploy.

## In flight (2026-07-09, cont'd)
**B6 deliverability control loop built, NOT yet deployed.** SPEC §10 monitor→decide→act as sandbox LOGIC + tests. `engine/deliverability.ts` (pure `evaluate` + first-party rate gather, fraction units — Gmail 0.30%=0.003) + `engine/deliverability-actions.ts` (throttle via `cap_override`, pause via `deliv_status`, retire+auto-replace a burning domain, per-window replacement cap, audit table). Wired into the tick BEFORE scheduling; send picker excludes paused mailboxes (= ROTATE). Sandbox EmailPort now injects spam-complaints for "complaint"-tagged recipients; reply-processor suppresses+attributes them per-mailbox. Surfaced in `account().deliverability` + `infrastructure_status` per-mailbox health (12-tool surface unchanged, responses extended). 78/78 tests (13 new), 2 interaction guards revert-fail-proven, typecheck + `wrangler deploy --dry-run` clean. New schema: `mailboxes.deliv_status`/`cap_override`, `tenant_profile.primary_domain`, `deliverability_actions` table (all back-filled via `ensureColumnMigrations`). Deferred to activation: threshold VALUES vs live Gmail, a recovery/un-pause path. Left uncommitted (shared worktree) — orchestrator to review + commit + (decide whether to) redeploy.

## In flight (2026-07-09, cont'd)
**D1/D2/D6 business-ops automation built, NOT yet deployed.** New `apps/platform/src/admin/` surface (support triage KB/classifier, dunning decision, D1 helpers, cross-tenant ops-sweep/digest logic + README) behind a SEPARATE `ADMIN_TOKEN` bearer (`src/require-admin-auth.ts`, timing-safe, fails closed): `POST /admin/support/triage` + `GET /admin/support/digest` (D1), `POST /admin/ops/dunning-sweep` + `GET /admin/ops/digest` (D2/D6), public `GET /status` (D6). `src/scheduled.ts` is the Cron Trigger entry point (deliverability sweep → dunning sweep → digest, for every tenant) — `wrangler.toml`'s `[triggers]` block is commented-out, armed at activation (ACTIVATION.md Gate 4 already lists both "Arm email routing" + "Arm scheduled ops"). New D1 migration `0002_admin_ops.sql` (`support_tickets`, `dunning_events`). 102/102 tests green (24 new), typecheck clean (root, 3 workspaces), `wrangler deploy --dry-run` clean. Left uncommitted (shared worktree, git-guard) — orchestrator to review + commit + (decide whether to) redeploy.

## Next lanes (ROADMAP)
B2 (resumable alarm-driven provisioning sagas — B0's are synchronous), B7 done-ish; D1-D6 (support/ops/legal/lifecycle/health); A5 (local-mailserver engine spike, Docker present); C4 (deep comparison content), C5 (registry submissions — activation); E (final panels + report). Then ACTIVATION.md (all owner-hands steps, +wiring a real Stripe TEST key + `STRIPE_WEBHOOK_SECRET`). B6 deliverability loop = built (above); D2 ops routines can now reference it.

## Locked constraints (SPEC §0)
Sandbox-first (no vendor spend till activation); test-mode go-live + ACTIVATION.md; NO owner questions till final report; full adversarial regime.

## Held for owner → all tracked in ACTIVATION.md
Name pick (coldrig/coldpipe/coldloop), Stripe live KYC, vendor accounts + resale-model decision, npm login+publish, GitHub org transfer, domain, attorney review, email-routing arm, cron arm, Go-engine host, real-world deliverability smoke test (first activation gate).
