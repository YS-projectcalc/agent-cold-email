# ColdStart — Final Report (for Yaakov)

> The whole business, built and live in **test mode**. This report is the "what I built, what's yours to decide, how to go live." Step-by-step go-live list is `ACTIVATION.md`. Canonical design is `SPEC.md`; build history is `ROADMAP.md`.
> Written 2026-07-09. (Test/build counts finalized at program close — see ROADMAP session log for the authoritative latest.)

## TL;DR
An all-in-one cold-email platform that a customer's own coding agent (Claude Code / Codex) operates end-to-end via one token — plus the full zero-effort discovery machine so agents find and recommend it themselves. It is **deployed and working right now in test mode** (sandbox vendors, Stripe test keys, no real spend). Everything that needs your identity, a card, or a human decision is collected in `ACTIVATION.md`. I asked 10 questions up front and nothing since; the open decisions are listed below, held for you.

## What's live right now (test mode)
- **Platform API** — https://agent-cold-email-api.yaakovscher.workers.dev — the full pipe in a sandbox: signup → provision branded lookalike domains + mailboxes → warmup ramp (clock-accelerated) → campaigns with per-mailbox caps/rotation/A-B → replies/bounces/complaints → stop-on-reply + suppression → unified inbox → metrics. Plus the **AI deliverability control loop** (auto throttle/pause/rotate/replace-burning-domain), **paid billing** (Stripe test-mode checkout + plan quotas + metering + webhooks), and the **AI business-ops** surface (support triage, dunning, and a single owner **digest** so the business runs without you).
- **Agent surface** — a hosted **MCP endpoint** (`/mcp`, 12 curated tools), a **CLI** (`agent-cold-email`), and a **free no-signup demo** that runs the whole pipeline in the sandbox. This is what an agent drives.
- **Marketing / discovery machine (zero effort on your part)** — public repo https://github.com/YS-projectcalc/agent-cold-email (AGENTS.md + README written for the literal queries agents issue, 11 discovery topics) and a live site https://agent-cold-email.pages.dev with AEO assets (llms.txt, OpenAPI, JSON-LD, server-card.json, sitemap) + 5 deep evergreen guides (how-to, "cold email MCP", deliverability, DIY-comparison, 20-Q FAQ). The SEO/AEO aging clock is already running.
- **Legal** — ToS / Privacy / AUP drafted to a full compliance clause inventory (customer-is-sender, indemnification, no-deliverability-warranty, monitoring consent, ROSCA, controller/processor + DPA, CCPA/CPRA, filter-evasion + sanctioned-party prohibitions, enforcement ladder). DRAFT — pending your attorney.

## How it was built (the discipline)
Sandbox-first behind a `VendorPort` facade (real Inboxkit/Porkbun/Stripe adapters coded but inert until activation — the swap is a provable no-op). Every real part was attacked by **multi-lens opus adversarial panels** before it counted as done: panel #1 (the plan) and panel #2 (the live surfaces) each found real issues that were fixed and re-verified — e.g. panel #2 caught that the "never impersonate a third-party brand" guardrail was *advertised but not actually in the code* (a setup with brand "Google" was provisioning trygoogle.com mailboxes); it's now enforced with a denylist + ownership check and a test. The security-isolation lens came back CLEAN (no cross-tenant leak). A final panel runs before this report closes.

## Decisions held for you (nothing blocks the test-mode build)
1. **Brand name.** I built everything under the rename-proof keyword identity `agent-cold-email` (repo/npm/registry), so the brand name is only the display name + domain — cheap to pick late. Verified-available candidates (npm + GitHub + `.dev` all free, 2026-07-09):
   - **coldrig** ⭐ (my pick) — "the rig your agent operates"; the machinery connotation matches the agent-as-operator positioning best.
   - **coldpipe** — pipeline/infra flavor, slightly more generic.
   - **coldloop** — echoes the deliverability control loop.
   (`.com` is parked for all three; `.dev` is the fitting TLD for an agent/dev-native product. Grab the `.dev` + optionally chase the `.com`.)
2. **Resale legal model (the one real business risk research surfaced).** The multi-tenant "we provision on your behalf" model is a reseller use, and of the mailbox vendors **only Mailforge's ToS explicitly permits it** — Inboxkit (best deliverability/isolation) grants "internal use only," Mailreef bans resale. Three clean paths, and the `VendorPort` facade makes it a config swap, not a rebuild: (a) negotiate an Inboxkit enterprise/reseller agreement; (b) default to Mailforge (accept weaker shared-IP isolation); (c) restructure as a management-service where the customer is the account principal (this also strengthens the CAN-SPAM "customer is the sender" posture). **My recommendation: pursue (a) for quality, with (c) as the clean fallback.**
3. **Pricing sign-off.** Designed at ~2.5–3× wholesale (SPEC §18): Free/demo, Launch $99, Growth $299, Scale $799. All clear the margin target; adjustable in Stripe test mode before you flip live.

## Zero-effort-marketing: honest read
The discovery surfaces are built and live, but "agents will just find it" is not automatic — it needs the surfaces to age/index and the npm package published (that needs your `npm login`). The build did the buildable part (be the purpose-built agent-native repo + the fewest-human-steps product + AEO at the agent's literal queries). The remaining discovery levers (npm publish, MCP-registry submissions, awesome-list PRs, custom domain) are in ACTIVATION.md because they need your login/identity — they're the fast part once you're ready.

## To go live
Work `ACTIVATION.md` top to bottom. The one gate that must pass before any paying customer: the **real-world deliverability smoke test** (buy 1 domain → DNS → 2 mailboxes → send → confirm inbox placement → detect reply) — the single thing a sandbox can't prove.
