# ColdStart — HANDOFF (resume here)

## Where we are
Phase A DONE. Adversarial panel #1 complete (4 opus lenses → 4× CONDITIONAL_GO); amendments adopted into ARCHITECTURE.md (settled: hybrid topology, TenantDO-SQLite money ledger, injected Clock, VendorPort adapters, idempotency, engine-off-Worker, compliance-as-code) and ROADMAP.md (DoD rescoped to test-mode CORE, B/C parallel, +11 missing business lanes D5/D6). Synthesis frozen in `docs/adversarial/panel-01/SYNTHESIS.md`. cold-cli = MIT ✓. A4 vendor-ToS/economics research DONE. **B0 walking-skeleton DONE + DEPLOYED LIVE** (test mode) at https://agent-cold-email-api.yaakovscher.workers.dev. C0/C1/C2/C6 distribution shell (public repo surface, AEO docs site, waitlist form) DONE. **B5 agent surface + C6 waitlist endpoint DONE + DEPLOYED LIVE** — hosted MCP (`POST /mcp`, 12 tools, per-call fresh tenant auth), `POST /demo/run` (sandbox-only accelerated pipeline, structurally gated to demo/free plans), `packages/cli` (`agent-cold-email`, built but not yet npm-published), `POST /api/waitlist` (KV-backed, dedupe, rate-limited, CORS). Full evidence: ROADMAP.md session log 2026-07-09 (B5 entry) — 28/28 tests, typecheck clean, live curl smoke + live CLI `demo` run both pasted there.

## What's next
1. A5 local-mailserver engine spike (Docker present) to validate engine contract before real-adapter freeze — still open, was never picked up while B0/B5/C-shell ran.
2. B1 (real auth/quotas/Stripe test-mode billing hardening — signup still only ever mints `plan:demo`, no paid path).
3. B2 (resumable alarm-driven provisioning sagas — `setup_infrastructure`/`tick`/`demoRun` are synchronous/directly-callable by design, not yet alarm-driven).
4. B3 (VendorPort contract-test suite across sandbox+real), B4 (full CAN-SPAM opt-out flow + subject-honesty/lookalike validators — currently contract-level only), B6 (deliverability control-loop), B7 (deepen unified inbox).
5. C3 (CLI `npx agent-cold-email demo` distribution flip — code is done, needs npm publish, which is identity-gated/ACTIVATION.md), C4/C5 (SEO content, MCP registry listings — also identity-gated).
6. D-lanes (support/ops automation, legal, onboarding+OFAC, lifecycle ops, business-health substrate) — none started yet.

## Note on this worktree
This is a shared/live worktree used across sessions; prior sessions have occasionally found a concurrent `git add -A && git commit` sweeping up in-progress files mid-build (see git log around `74e4e9f`). The B5 session (this entry) ran with normal git enabled per its brief and committed its own work directly — check `git log` for the actual commit boundary if resuming.

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
