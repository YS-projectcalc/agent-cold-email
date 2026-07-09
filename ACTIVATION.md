# ColdStart — ACTIVATION (owner-hands checklist)

> The single list of steps that need Yaakov's identity, card, or a human decision — the only things NOT done autonomously. Everything else ships in test mode. Work top-to-bottom to go live. Each item says WHY it can't be automated and WHAT's already wired waiting for it.
> Status maintained through the build; grouped by go-live phase. Nothing here is a blocker to the test-mode product being complete.

## Gate 0 — Decisions only you can make
- [ ] **Pick the brand name** — candidates verified available 2026-07-09: **coldrig** / **coldpipe** / **coldloop** (all: npm free; GitHub org free; coldrig+coldpipe `.dev`/`.sh`/`.io` free, coldloop `.dev` free). The keyword slug `agent-cold-email` is already the permanent repo/npm/registry identity (rename-proof), so the brand name is only the **domain + display name** — low-risk to decide late. Rationale + recommendation in FINAL-REPORT.md.
- [ ] **Resale legal model** (SPEC §13 gate) — choose: (a) negotiate an **Inboxkit enterprise/reseller agreement**; (b) default real adapter to **Mailforge** (only vendor whose ToS explicitly permits reselling; accept shared-IP isolation); or (c) **management-service** structure (customer is the account principal — also satisfies the CAN-SPAM "customer is sender" posture). The `VendorPort` facade makes this a config swap, not a rebuild.
- [ ] **Pricing sign-off** — tiers designed (SPEC §18: Free/Launch $99/Growth $299/Scale $799), all clearing 2.5–3x. Adjust numbers in Stripe test mode before flipping live if desired.

## Gate 1 — Prove the real pipe ($ + identity; do BEFORE onboarding any paying customer)
- [ ] **Real-world deliverability smoke test** (the deferred SPEC §11 Phase-0 spike): buy 1 real domain → set DNS (SPF/DKIM/DMARC/rDNS) → provision 2 real mailboxes → send 1 email → confirm inbox placement → detect the reply. This is the one thing sandbox cannot prove. Everything is built to run it; it needs a card + a live mailbox.
- [ ] **Vendor free-API-key signup + fixture capture** — get free API keys (Inboxkit or chosen vendor, Porkbun/Namecheap), run the read-only real-contract capture, and re-seed the `VendorPort` contract-test fixtures from real responses (replaces the doc-derived sandbox fixtures). Confirms the real adapters match reality before the swap.
- [ ] **Written resale-permission confirmation** from the chosen mailbox vendor + the exact per-tenant isolation boundary (separate Google/M365 org per customer vs shared) — settles SPEC §7's isolation claim.

## Gate 2 — Live keys & accounts (identity/KYC-gated)
- [ ] **Stripe live KYC** — swap test keys for live; the billing/metering/dunning/dispute lanes are built against the real Stripe API in test mode, so this is a key swap + business verification.
- [ ] **Mailbox vendor account + card** (Inboxkit primary / Mailforge fallback) — real `MailboxPort` adapter is coded, throws `NotActivatedError` until wired.
- [ ] **Registrar account + card** — Namecheap (confirmed buy-domain API) or Porkbun (confirm purchase endpoint w/ support); real `DomainPort` adapter coded, unactivated.
- [ ] **Go-engine host** — stand up the forked cold-cli Go daemon (24/7 SMTP/IMAP) on Cloudflare Containers or a small VPS; wire the Worker↔engine boundary contract (already designed). This is the real `EmailPort`.

## Gate 3 — Distribution surfaces that need your login
- [ ] **npm publish** `agent-cold-email` — CLI is built + repo-hosted; needs `npm login` (npm NOT authed on this machine). This is the surface agents install from — high priority.
- [ ] **GitHub org** — create the `agent-cold-email` (or brand) org and transfer the repo from YS-projectcalc (keep the old namespace to preserve the 301 redirect). Repo already public + AEO-optimized under YS-projectcalc.
- [ ] **Custom domain** — point the brand domain at the Cloudflare Pages site + set the MCP/API on a branded host; update `server-card.json` + OpenAPI `servers`.
- [ ] **MCP registry submissions** — Smithery / mcp.so / PulseMCP (some are form/login-gated); `.well-known/mcp/server-card.json` is served so scans are clean.
- [ ] **Awesome-list PRs** — submit to awesome-mcp-servers / relevant lists under the org identity (outward PRs = your identity).

## Gate 4 — Legal & ops arming
- [ ] **Attorney review** of ToS / Privacy / AUP (built to the specified clause inventory, DRAFT-flagged) before real customers.
- [ ] **Arm email routing** for support@ + reply ingestion (Cloudflare Email Routing / vendor IMAP) — AI support triage lane is built, disarmed.
- [ ] **Arm scheduled ops** — deliverability loop, dunning sweep, metrics digest crons (built, disabled in test mode).
- [ ] **OFAC screening provider** key (if using a paid list) — screening hook is built; wire the data source.

## Cron watchdog note (session-scoped)
The autonomous build watchdog cron (`baf7d82d`, every 3h) is **session-only and auto-expires after 7 days** — it does not survive a machine restart. Not part of the product; just keeps this build session resilient to usage-limit interruptions.
