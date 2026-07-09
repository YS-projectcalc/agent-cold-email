# ColdStart — HANDOFF (resume here)

## Where we are
Phase A DONE. Adversarial panel #1 complete (4 opus lenses → 4× CONDITIONAL_GO); amendments adopted into ARCHITECTURE.md (settled: hybrid topology, TenantDO-SQLite money ledger, injected Clock, VendorPort adapters, idempotency, engine-off-Worker, compliance-as-code) and ROADMAP.md (DoD rescoped to test-mode CORE, B/C parallel, +11 missing business lanes D5/D6). Synthesis frozen in `docs/adversarial/panel-01/SYNTHESIS.md`. cold-cli = MIT ✓. **B0 walking-skeleton build IN FLIGHT** (spec-builder). A4 vendor-ToS/economics research IN FLIGHT.

## What's next
1. Verify B0 skeleton (npm test green + isolation + demo-guard tests) → deploy to prod → check B0.
2. Fold A4 vendor research into a pricing/vendor decision; A5 local-mailserver engine spike (Docker present) to validate engine contract before real-adapter freeze.
3. Broaden lanes: B1-B7 hardening, C-shell (repo+site) in parallel, then D lanes.

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
