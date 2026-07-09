# ColdStart — ROADMAP

> Build order + status. Canonical; updated every session that touches the project.
> Program started 2026-07-09. Owner interview complete (SPEC §0). Adversarial panel #1 complete → amendments adopted (`docs/adversarial/panel-01/SYNTHESIS.md`). Autonomous to the finish line; open questions HELD for the final report, never asked mid-build.

## Definition of done — "test-mode CORE complete" (rescoped by panel #1)

The core business exists and runs itself in **test mode**: the pipe (provision→warm→send→reply, sandbox adapters) + control plane + Stripe test-mode billing/metering + agent surface (MCP+CLI+demo) + real-but-minimal compliance guardrails + the business-ops lanes (dunning, teardown, abuse-drop, metrics) + legal docs + a publish-now distribution shell that's already indexing — all adversarially hardened on the REAL surfaces — plus **ACTIVATION.md**, the single checklist of owner-hands steps that flips it live. Un-sandbox-testable *tuning* (live deliverability tuning against real Gmail, warmup optimization) is built-to-contract now and tuned at activation.

## Hardening-budget rule (panel #1)
Adversarial panels apply to what is REAL: control plane, auth, tenancy, billing, isolation logic, compliance, legal, distribution. Deliverability/warmup/AI-ops get contract-level review only until activation — don't burn budget polishing synthetic behavior.

## Phases (B and C-shell run in PARALLEL)

### Phase A — Foundation & plan hardening — DONE
- [x] A1. Canonical home: git repo; SPEC §0 locked; ROADMAP/README/CLAUDE/ARCHITECTURE/HANDOFF/MEMORY
- [x] A2. Adversarial panel #1 (4 opus lenses) — 4× CONDITIONAL_GO; amendments synthesized + adopted
- [x] A2.5 Architecture settled (ARCHITECTURE.md — hybrid topology, DO-SQLite ledger, injected clock, idempotency, engine-as-adapter)
- [x] A3. cold-cli license = MIT (verified via GitHub API 2026-07-09) — clean to fork; reference for engine contract
- [x] A4. $0 vendor-ToS resale + isolation + unit-economics research DONE (docs/research/vendor-tos-economics-2026-07-09.md) → pricing designed (SPEC §18); resale-permission gate recorded (SPEC §13 — Mailforge ToS-clean, Inboxkit needs enterprise deal, or management-service model); Porkbun buy-domain undocumented → Namecheap fallback. NO-GO branch = facade swap, does not block sandbox.
- [ ] A5. Local-mailserver engine spike (Mailpit/GreenMail, $0): validate send/reply/bounce/thread/unsub contract BEFORE `VendorPort` freeze

### Phase B — Core product
- [x] B0. **Walking skeleton DONE:** npm workspaces monorepo (`packages/shared` + `apps/platform`); Hono facade over the ~12 SPEC §6 intents; `TenantDO` (SQLite runtime state + money ledger) behind Workers RPC; injected `RealClock`/`VirtualClock`; sandbox `VendorPort` bundle (deterministic reply/bounce simulator) + `real/` stubs + factory with a demo-can't-reach-real guard; native sandbox engine (warmup ramp, tick, poll/reply-processor, threads, reporting). 9/9 tests green (E2E pipe + cap-enforcement + pause + tenant-isolation + demo-adapter-guard), typecheck clean, `wrangler deploy --dry-run` clean. See session log.
- [ ] B1. Monorepo scaffold; control plane: tenants, auth/tokens, Stripe test-mode billing+metering, quotas + per-tenant spend/provisioning caps (distinct from usage quotas)
- [ ] B2. Provisioning sagas: resumable alarm-driven jobs on clock abstraction; clock-scaled warmup ramp; idempotency keys; DO-reload/alarm-retry soak tests
- [ ] B3. `VendorPort` layer: fault-injecting sandbox impls (active) + real impls (Porkbun/Inboxkit/Stripe — coded, unactivated); one contract-test suite across both; free/demo tenants structurally can't reach a real adapter (type guard + failing test)
- [ ] B4. Sequencing + reply engine (contract, native sandbox impl): campaigns, scheduling, per-mailbox caps, rotation, stop-on-reply, suppression, **full CAN-SPAM opt-out flow** (in-body + RFC 8058 header + honor windows), subject-honesty + lookalike third-party-brand hard-reject validators, A/B
- [ ] B5. Agent surface: hosted MCP (McpAgent, ~12 tools) + CLI twin + AGENTS.md + no-signup demo (rate-limited, cost-capped, canned model outputs)
- [ ] B6. Deliverability control-loop LOGIC + tests (monitor→throttle/pause/rotate/replace, domain-burn auto-replace) — built to contract, tuned at activation
- [ ] B7. Unified inbox + reply management

### Phase C — Distribution machine (C-shell parallel with B; deep content after product is describable)
- [ ] C0. **Identity vs brand split:** keyword-permanent slug `agent-cold-email` for repo/npm/registry (never renamed); coldrig/coldpipe/coldloop = domain/display brand only, at activation
- [ ] C1. Public GitHub repo (keyword slug, under YS-projectcalc; AGENTS.md + README at agents' literal queries; guardrails prominent so abuse-scanners read it as compliance-first infra)
- [ ] C2. Docs + AEO content on Pages/github.io (crawlable, authority-accruing): AGENTS.md + OpenAPI + JSON-LD (the real assets) + llms.txt (convenience); not-yet-available + no-deliverability-guarantee disclosures; privacy policy BEFORE any waitlist email
- [ ] C3. Agent-facing free first-use: `npx agent-cold-email demo` runs full pipeline vs live sandbox, no signup; lead capture + conversion handoff at the end
- [ ] C4. SEO/AEO comparison + how-to pages targeting agent queries (after product describable)
- [ ] C5. `/.well-known/mcp/server-card.json` served; MCP registry listings (Smithery/mcp.so/PulseMCP) submitted once identity exists + scan is clean; npm publish + awesome-list PRs = ACTIVATION.md (identity-gated)
- [ ] C6. Waitlist (billed path only) + early-access flow; distribution validation harness (fresh agent + query → discovers us?) baselined + re-run per surface

### Phase D — Business automation & the missing lanes (panel #1 add)
- [ ] D1. AI support lane: support inbox → agent triage → auto-answer/escalate → daily digest (armed at activation)
- [ ] D2. Ops routines: deliverability loop, metrics/watchdog digest, **dunning/failed-payment sweep**
- [ ] D3. Legal: ToS/Privacy/AUP to the specified clause inventory (customer-is-sender + reps, indemnification, vendor-AUP pass-through, monitoring consent, no-deliverability-warranty+LoL, prohibited-use, ROSCA/state-ARL auto-renewal, DPA) — enforcement path built+tested, not paper; DRAFT-flagged for attorney review
- [ ] D4. Onboarding: self-serve signup → Stripe test checkout → token → agent instructions; **OFAC screen + friction ladder + new-tenant volume ramp**; per-tenant physical address + sender identity capture
- [ ] D5. Lifecycle ops: voluntary cancellation + infra teardown/reclaim (+ annual-domain liability accounting); abuse-offboarding ops executing the abuse-drop ToS (terminate + reclaim + honor suppression); chargeback/dispute lane
- [ ] D6. Owner business-health substrate: MRR, active tenants, margin/tenant, provisioning-failure + incident rate; status page; backups/DR for the ledger + encrypted creds; master-key storage/rotation/recovery

### Phase E — Hardening & finish
- [ ] E1. Multi-lens adversarial opus panels per REAL part (per hardening-budget rule)
- [ ] E2. Full verification battery + QA loops on every surface
- [ ] E3. Memory + ledger current; HANDOFF.md maintained
- [ ] E4. Final report: name-candidate presentation, pricing rationale, ACTIVATION.md (first activation gate = the real-world deliverability smoke test), held-questions list

## Session log
- 2026-07-09: Program start. Interview (10 Qs) locked; SPEC §0 written; repo + governance docs (CLAUDE/ARCHITECTURE/HANDOFF/MEMORY) initialized.
- 2026-07-09: Adversarial panel #1 (4 opus lenses vs SPEC+ROADMAP) → 4× CONDITIONAL_GO. Synthesis in `docs/adversarial/panel-01/`. Adopted: hybrid topology (engine off-Worker), DO-SQLite money ledger, injected clock + fault-injecting sandbox, idempotency keys, compliance-as-code (per-tenant address/identity, CA 17529.5, full opt-out, OFAC/friction ladder, demo type-guard), identity-vs-brand split (keyword-permanent slug), DoD rescoped to test-mode CORE, C-shell parallel with B, hardening-budget rule, +11 missing business lanes (dunning/teardown/abuse-ops/chargeback/health-metrics/DR/key-rotation). A3: cold-cli = MIT ✓. Next: A4 vendor research (running) + A5 engine spike, then B0 skeleton.
- 2026-07-09: **B0 walking skeleton built + verified.** Monorepo: `packages/shared` (domain types, `Clock`/`VendorPort` interfaces, zod intent schemas) + `apps/platform` (Hono facade, `TenantDO` w/ SQLite ledger via Workers RPC, `RealClock`/`VirtualClock`, sandbox `VendorPort` bundle + `real/` NotActivatedError stubs + demo-guarded factory, native engine: warmup ramp, tick, reply-processor, threads, reporting). D1 `coldstart-platform-db` created (`wrangler d1 create`, id `119be39d-05c3-4608-b628-b2cc7bddfac1`). Full flow proven end-to-end (signup→setup_infrastructure→warmup ramp via injected clock→launch_campaign→tick sends→sandbox poll returns 1 reply+1 bounce→stop-on-reply+bounce-suppression→inbox/thread/reply→metrics/account) plus per-mailbox daily-cap enforcement, pause/pause_all, tenant isolation (separate TenantDO per tenant), and the demo-can't-reach-real-adapter guard. `npm test`: **9/9 passed** (3 files). `npm run typecheck`: clean. `npx wrangler deploy --dry-run`: clean (TENANT DO + DB bindings resolved). Deliberately deferred (documented in code comments, in-scope for later phases): async resumable provisioning sagas/DO alarms (B2), Stripe test-mode wiring beyond a stub `BillingPort` (B1), full IANA timezone send-window handling (later), MCP/CLI surface (B5). Noted mid-build: this worktree is shared/live — a concurrent commit (`74e4e9f`) swept up in-progress B0 files via an automated `git add -A`; per standing git-discipline rules this agent left the final `git add`/`commit` to the orchestrator rather than committing itself. Next: A5 engine spike, B1 control-plane hardening (real auth/quotas/billing), B2 sagas.
- 2026-07-09: **B0 DEPLOYED LIVE (test mode)** → https://agent-cold-email-api.yaakovscher.workers.dev (Cloudflare free tier, sandbox vendors, remote D1 migrated, TOKEN_HASH_PEPPER secret set). Live smoke green: signup→provision(2 domains/4 mbx warming, day-1 caps)→campaign→metrics→account; tenant isolation verified on live URL (cross-tenant=404, no-token=401). NOTES for later lanes: (1) sandbox tick/clock/pollInbox are DO-RPC-only, NOT HTTP — C3 demo needs a sandbox-safe run endpoint to drive the full pipe over HTTP; (2) B0 signup only mints plan:demo — paid-plan + Stripe path is B1.
