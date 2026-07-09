# ColdStart — HANDOFF (resume here)

## Where we are
Phase A DONE. Adversarial panel #1 complete (4 opus lenses → 4× CONDITIONAL_GO); amendments adopted into ARCHITECTURE.md (settled: hybrid topology, TenantDO-SQLite money ledger, injected Clock, VendorPort adapters, idempotency, engine-off-Worker, compliance-as-code) and ROADMAP.md (DoD rescoped to test-mode CORE, B/C parallel, +11 missing business lanes D5/D6). Synthesis frozen in `docs/adversarial/panel-01/SYNTHESIS.md`. cold-cli = MIT ✓. A4 vendor-ToS/economics research DONE (`docs/research/vendor-tos-economics-2026-07-09.md`). **B0 walking-skeleton DONE** — see ROADMAP.md session log 2026-07-09 for full evidence (9/9 tests, typecheck clean, `wrangler deploy --dry-run` clean). Not yet deployed to prod — owner review pending per the B0 brief ("do NOT deploy to prod; owner will do after review").

## What's next
1. Owner (or a follow-up session) reviews B0 and runs the actual `wrangler deploy` (this agent intentionally did not — brief-gated).
2. A5 local-mailserver engine spike (Docker present) to validate engine contract before real-adapter freeze.
3. Broaden lanes: B1 (real auth/quotas/Stripe test-mode billing hardening), B2 (resumable alarm-driven provisioning sagas — B0's `setup_infrastructure`/`tick` are synchronous/directly-callable by design, not yet alarm-driven), B3-B7 hardening, C-shell (repo+site) in parallel, then D lanes.

## Note on this worktree
Mid-B0-build, a commit (`74e4e9f2`) landed containing this agent's own in-progress `apps/platform` files (evidence: it included the exact D1 `database_id` this agent generated via `wrangler d1 create` in this same session) — i.e. some other process in this shared worktree ran `git add -A && git commit` while this agent was still editing. Per the standing "git is READ-ONLY in a shared/live worktree" rule, this agent did NOT run `git add`/`git commit` itself for the B0 work, despite the B0 brief asking for it. All B0 files are complete, verified, and sitting as uncommitted changes — the orchestrator should review `git status`/`git diff` and commit.

## Locked constraints (see SPEC.md §0 for full text)
- Sandbox-first: every vendor behind an adapter interface, sandbox impl active, real impl coded-but-unactivated.
- Test-mode go-live: Stripe test keys, sandbox vendors, ONE final ACTIVATION.md checklist gates real spend/live keys.
- No further questions to the owner until the final report — autonomous to the finish line; open items go on the held-for-owner list below.
- Full adversarial regime authorized (multi-lens opus panels, parallel Workflow lanes) — per SPEC §0.7.

## Held for owner (accumulate here; resolved at final report / ACTIVATION.md)
- Name pick: coldrig / coldpipe / coldloop.
- npm login (npm NOT currently authed on this machine).
- Stripe live KYC.
- Vendor account creation (Inboxkit, Porkbun, etc.).
- GitHub org creation/transfer (repo under YS-projectcalc; keyword-slug `agent-cold-email` is rename-proof so this is display/brand only).
- Domain purchase (brand: coldrig/coldpipe/coldloop).
- Vendor free-API-key signup + real-fixture capture + written resale-permission confirmation (panel A4 gate; research desk-pass running now).
- Real-world deliverability smoke test = FIRST activation gate (buy 1 domain→DNS→2 mailboxes→send→placement→reply) before any paying customer.
- Attorney review of ToS/Privacy/AUP.
- Go-engine host decision + deploy (Cloudflare Containers vs VPS) for real IMAP/SMTP.
