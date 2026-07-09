# ColdStart — ROADMAP

> Build order + status. Canonical; updated every session that touches the project.
> Program started 2026-07-09. Owner interview complete (SPEC §0) — autonomous to the finish line; open questions HELD for the final report, never asked mid-build.

## Definition of done ("finish line")

The entire business exists and runs itself in **test mode**: product deployed (Stripe test keys, sandbox vendors), public marketing/distribution surfaces LIVE and indexing, AI-ops lanes built, legal docs done, everything adversarially hardened — plus a single **ACTIVATION.md** checklist of owner-hands steps (cards, KYC, npm login, org transfer, domain buy, name pick) that flips it live.

## Phases

### Phase A — Foundation & plan hardening — IN PROGRESS
- [x] A1. Canonical home: git repo, SPEC updated with locked decisions, ROADMAP, README
- [ ] A2. **Adversarial panel #1 (multi-lens opus) against the plan itself** — attack SPEC + this roadmap + stack decision BEFORE building
- [ ] A2.5 Architecture decision recorded (proposal below; panel may amend)
- [ ] A3. cold-cli license check + fork/reference decision

### Phase B — Core product (the platform)
- [ ] B1. Monorepo scaffold; control plane: tenants, auth/tokens, Stripe test-mode billing + metering, quotas
- [ ] B2. Provisioning service: resumable async jobs (buy domain → DNS → mailboxes → warmup ramp), sandbox clock-scaling so weeks-long warmup is testable in minutes
- [ ] B3. Vendor adapter layer: `VendorPort` interfaces; sandbox impls (active) + real impls (Porkbun, Inboxkit, Stripe live — coded, unactivated)
- [ ] B4. Sequencing + reply engine: campaigns, scheduling, per-mailbox caps, rotation, stop-on-reply, suppression, RFC 8058 one-click unsub, A/B variants
- [ ] B5. Agent surface: hosted MCP (~8–12 curated tools) + CLI twin + AGENTS.md/skill + no-signup demo mode
- [ ] B6. Deliverability AI control loop: monitor → throttle/pause/rotate/replace, domain-burn auto-replace
- [ ] B7. Unified inbox + reply management

### Phase C — Distribution machine (the "zero-effort marketing" surface)
- [ ] C1. Public GitHub repo, keyword-first name; AGENTS.md + README written for agents' literal queries
- [ ] C2. Docs + marketing site live (SEO/AEO: llms.txt, OpenAPI, JSON-LD, sitemap, comparison pages), early-access framing
- [ ] C3. **Agent-facing free first-use:** demo command running the full pipeline against sandbox, no signup
- [ ] C4. SEO/AEO content engine: evergreen comparison + how-to pages targeting agent queries
- [ ] C5. Registry/directory listings (MCP registries; npm publish + awesome-list PRs may land in ACTIVATION.md if identity-gated)
- [ ] C6. Waitlist + early-access flow

### Phase D — Business automation (zero-effort operation)
- [ ] D1. AI support lane: support inbox → agent triage → auto-answer/escalate → daily digest (armed at activation)
- [ ] D2. Scheduled ops routines: deliverability loop, metrics/watchdog digest
- [ ] D3. Legal: ToS, Privacy, AUP (CAN-SPAM-forward, EpiphanyMade entity; DRAFT-flagged for attorney review)
- [ ] D4. Onboarding: self-serve signup → Stripe test checkout → token → agent instructions

### Phase E — Hardening & finish
- [ ] E1. Multi-lens adversarial opus panels per part (standing, per SPEC §0.7)
- [ ] E2. Full verification battery + QA loops on every surface
- [ ] E3. Memory + ledger current; HANDOFF.md maintained
- [ ] E4. **Final report:** name-candidate presentation, pricing rationale, ACTIVATION.md, held-questions list

## Architecture proposal (A2.5 — pending adversarial panel #1)

Cloudflare-first (wrangler already authed; deployable with zero new accounts): Workers + Hono facade, Durable Objects for tenant state + provisioning jobs (DO alarms natively model weeks-long resumable warmup), D1 for the control-plane ledger, Queues where fan-out needs it, Pages for the sites, Workers Cron for ops loops. The forked Go engine (cold-cli) needs long-lived IMAP/SMTP — that cannot run on Workers; proposal: design the engine contract-first with a native sandbox implementation in the Worker, and treat the Go fork + container host as a real-adapter concern at activation. Panel #1 attacks this before it's final.

## Session log
- 2026-07-09: Program start. Interview (10 Qs) locked; SPEC §0 written; repo initialized; ROADMAP + README created. Next: adversarial panel #1.
