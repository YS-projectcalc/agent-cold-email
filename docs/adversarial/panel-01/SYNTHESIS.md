# Adversarial Panel #1 — Synthesis & Adopted Amendments

> 4 opus lenses (business-scope, architecture, distribution-aeo, compliance-abuse) attacked SPEC + ROADMAP before build. **All 4 = CONDITIONAL_GO.** Raw per-lens verdicts frozen alongside this file (`*.json`). This synthesis is the orchestrator's scope decision; ROADMAP/SPEC/ARCHITECTURE amended accordingly. 2026-07-09.

## Verdict: CONDITIONAL_GO ×4 → GO with amendments. No lens found a fatal flaw; every lens found real de-risking work. Nothing here changes the locked owner decisions (SPEC §0) — it strengthens the plan under them.

## The one contradiction the panel forced us to resolve
SPEC §11 (Phase 0 = a REAL end-to-end spike) vs SPEC §0.1 (no vendor spend until activation). Both can't hold literally. **Resolution:** the "prove the pipe" spike splits into two — the parts provable at **$0 with no owner identity** move into the build now; the parts needing a card/KYC move to ACTIVATION.md's FIRST gate.
- **$0-now:** validate the send/reply/bounce/thread/unsub engine contract against a **local dockerized mail server** (Mailpit/GreenMail speaking real SMTP+IMAP); read the actual vendor ToS for resale permission + isolation model; model fully-loaded unit economics on paper.
- **Activation gate 1 (owner-hands, first thing at activation):** buy 1 domain → DNS → 2 real mailboxes → send → confirm inbox placement → detect reply, BEFORE any paying customer.

## Adopted amendments (by area)

### A. De-risk the sandbox fiction (business + architecture lenses)
1. Sandbox adapters are **fault-injecting, clock-aware simulators** (rate limits, 5xx, timeouts, async bounces, provisioning failures, partial batches) — never happy-path mocks.
2. **One contract-test suite runs against BOTH sandbox and (future) real adapters** — the real-adapter swap must be a provable no-op. Fixtures seeded from vendor API docs now; re-seeded from real API captures at activation.
3. `VendorPort` interfaces are frozen only after the local-mailserver engine spike validates the engine half of the contract.

### B. Architecture settled (architecture lens) — see ARCHITECTURE.md
4. **Hybrid topology.** Public sites + MCP + control-plane + provisioning sagas on Cloudflare (Workers/DO/Pages/Queues). The always-on IMAP/SMTP engine is a **Go daemon on a VM/container** — a real-adapter concern hosted at activation. Design the Worker↔engine boundary contract NOW; the sandbox implements the engine natively in-Worker.
5. **Money ledger lives in the tenant DO's SQLite** (integer cents, real transactions), Stripe = source of truth, idempotent per-tenant webhook handling. D1 = control-plane index + a Queues-fed read-model for cross-tenant reporting **and** the abuse-aggregation loop (which has no home in a pure per-tenant-DO design).
6. **Single injected Clock abstraction**; ban direct wall-clock reads (lint gate). Warmup ramp + scheduling on a DO-alarm scheduler driven by that clock (NOT Cloudflare Workflows — they can't be virtual-clocked). This is what makes weeks-long warmup testable in minutes AND honest.
7. **Idempotency keys on every side-effecting VendorPort op**; sandbox simulates duplicate Queue delivery + mid-step crash so idempotency is exercised in test mode. (At-least-once Queues + retried alarms on money ops = correctness trap otherwise.)
8. MCP via the Agents SDK `McpAgent` (streamable HTTP). The "paste one token" remote-MCP config must be **verified to actually connect in both Claude Code and Codex** with screenshots (distribution-critical unknown).

### C. Compliance is a BUILD requirement, not a doc (compliance lens — 3 CRITICALs)
9. **Per-tenant advertiser physical postal address** captured at onboarding + injected into every footer. EpiphanyMade's single address covers only EpiphanyMade's own marketing. Sandbox exercises the REAL footer-render path so a missing address FAILS a test in test mode.
10. **Per-tenant verified legal sender identity**; lookalike domains registered to identify the customer, not EpiphanyMade (co-initiator risk).
11. **Beyond CAN-SPAM: CA B&P 17529.5** (private right of action, $1k/email). Hard validators in the engine: sender-identifying From/domain mapping to the tenant's real identity; **subject-line honesty guardrail** on agent-supplied subjects; lookalike generator **hard-rejects any third-party brand** (tighten SPEC §8's soft rule).
12. **Full CAN-SPAM opt-out flow**, not just the RFC 8058 header: conspicuous in-body opt-out, 10-business-day honor, 30-day link validity, ad-identification, no sale/transfer of opted-out addresses.
13. **OFAC/denied-party screening** at signup before any real send; **onboarding friction ladder + new-tenant volume ramp** (business-email verify, Stripe Radar/3DS, list-provenance attestation) before uncapped real sends. Prevention-first because per-tenant complaint data is statistically thin.
14. **ToS/AUP clause inventory is specified before drafting** and the **enforcement path (auto-pause/terminate) is built + tested**, not paper-only (FTC means-and-instrumentalities facilitator liability): customer-is-sender designation + reps; indemnification; Inboxkit + Google/MS AUP pass-through; explicit monitoring consent; no-deliverability-warranty + LoL; prohibited-use list; auto-renewal/ROSCA + state-ARL disclosure; privacy policy + DPA (CCPA/CPRA).
15. **Free/demo tenants are STRUCTURALLY incapable of a real adapter** — a type/config guard, not convention, covered by a test that fails if any real adapter is reachable from a demo context. Rate-limit + fingerprint the no-signup demo.
16. Marketing copy: not-yet-available disclosure, no deliverability guarantee, honest AI-role claims, **never frame warmup as filter-evasion**; publish a privacy policy before collecting one waitlist email; EpiphanyMade's own early-access emails are CAN-SPAM compliant.

### D. Distribution — identity vs brand (distribution lens — CRITICAL)
17. **Split IDENTITY (keyword, permanent) from BRAND (name, deferred).** Repo/npm/registry use a **keyword-exact slug that never needs renaming** (`agent-cold-email`); coldrig/coldpipe/coldloop are the DOMAIN + display brand only, chosen at activation. This makes §0.6's aging clock real instead of orphaned-at-rename.
18. Ship a **working keyword-first npm CLI** whose `demo` runs the full pipeline against the live test-mode sandbox with no signup — the artifact that intercepts the agent's build-first instinct. (npm *publish* still needs owner login → activation; the CLI is built + repo-hosted now.)
19. Prioritize **GitHub repo + in-repo/Pages AEO content ABOVE MCP registries** (§17's own test showed the organic flow queries WebSearch + GitHub). Serve `/.well-known/mcp/server-card.json` so registry scans are clean when we do list.
20. Demote llms.txt to a convenience; **AGENTS.md + OpenAPI + JSON-LD are the real assets.**
21. A **re-runnable distribution validation harness**: fresh agent + "do cold email" query → does it discover/recommend us? Baseline §17's result; run before/after each surface.

### E. Scope & sequencing (business lens)
22. **DoD rescoped to "test-mode CORE complete"**: pipe + control plane + billing + agent surface + minimal-but-real guardrails + legal + publish-now distribution shell + ACTIVATION.md. Un-sandbox-testable *tuning* (live deliverability tuning, warmup optimization) → "tune-at-activation" backlog with contract-level review. (We still BUILD the deliverability loop logic + tests; we don't pretend to tune it against a Gmail that isn't receiving mail.)
23. **Phase C shell runs in PARALLEL with Phase B** to start the aging clock immediately; deep comparison content lands once the product is describable.
24. **Hardening-budget rule:** adversarial panels apply to what is REAL (control plane, auth, tenancy, billing, isolation logic, legal). Deliverability/warmup/AI-ops get contract-level review only until activation — protects the token budget from polishing synthetic behavior.
25. **New business lanes added to ROADMAP** (were entirely missing): dunning/failed-payment, voluntary-cancellation + infra teardown/reclaim + annual-domain liability, abuse-offboarding ops, chargeback/dispute handling, owner business-health metrics, backups/DR + encrypted-cred key rotation, per-tenant spend/provisioning caps (distinct from usage quotas), our own transactional-email on separate reputation, status page.

## Deferred to ACTIVATION.md (owner-hands, gathered — never asked mid-build)
Real vendor free-API-key signup + fixture capture; vendor ToS resale confirmation in writing; the real-world deliverability smoke test (gate 1); Stripe live KYC; npm login + publish; GitHub org creation/transfer; brand domain purchase; attorney review of legal docs; cold-cli license re-confirm if code is reused verbatim.
