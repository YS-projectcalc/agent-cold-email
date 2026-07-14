# ColdStart — SPEC

> Working name (placeholder). Canonical spec; single source of truth. Date: 2026-06-25.
> Status: design locked through architecture; build program started 2026-07-09 (see ROADMAP.md).

## 0. Locked business decisions (owner interview, 2026-07-09 — final; no further questions until activation)

1. **Spend:** NO real vendor spend until the final activation session. Build sandbox-first: every vendor behind an adapter interface with a high-fidelity `sandbox` implementation active and a `real` implementation (Inboxkit/Porkbun/Stripe) coded against public API docs but unactivated.
2. **Entity:** EpiphanyMade operates the business (ToS party, CAN-SPAM address, Stripe account).
3. **Name:** deferred — build keyword-first/brand-independent (GitHub repo renames 301-redirect; npm publish held since names can't rename). Three verified-available candidates presented at the end: **coldrig / coldpipe / coldloop** (all npm-free; coldrig+coldpipe: GitHub + .dev/.sh/.io all free; no product collisions found).
4. **Go-live = test mode:** everything built + deployed with Stripe test keys and sandbox vendors; ONE final activation checklist collects every step needing the owner's identity/card (Stripe live KYC, vendor signups, npm login, GitHub org create/transfer, domain purchase).
5. **Pricing:** full authority delegated — tiers at ~2.5–3x wholesale; free first-use = sandboxed dry-run (no real sends), abuse-proof.
6. **Public surfaces publish NOW:** public GitHub repo (under YS-projectcalc, transfer at activation), live docs/marketing site, MCP registry listings — early-access/waitlist framing until backend activates. SEO/AEO aging clock starts immediately.
7. **Orchestration:** full adversarial regime authorized — multi-lens opus panels against every part, parallel Workflow lanes.
8. **Compliance:** US-first, compliance-forward (suppression, RFC 8058 one-click unsub, physical address, per-mailbox caps, complaint auto-pause, light KYC, abuse-drop ToS). EU/GDPR deferred + geo-gated.
9. **Marketing reach:** owned surfaces + directories only (site, GitHub, npm, MCP registries, awesome-list PRs, directory listings). No community posting as the owner; no astroturfing.
10. **Support/ops:** AI-run by default (built now, armed at activation) — the business itself must run on agents with a digest to the owner.

---

## 1. What it is

A multi-tenant platform. A user signs up, drops in a credit card, and gets **one connection token** to paste into their own coding agent (Claude Code / Codex). From then on, **their agent runs cold email end-to-end**: buys branded lookalike domains, provisions + warms inboxes, sends sequences, manages replies, reports metrics. We orchestrate wholesale email infrastructure underneath; **the customer's agent is the brain / content engine.**

Positioning: **"Strap this to your Claude Code and you have what you need."** Deliberately simpler than Smartlead (which exposes 116 tools + a complex multi-step setup). The complexity of incumbents is the opening.

---

## 2. Core decisions (locked)

- **Skip Smartlead as upstream.** Integrate the same wholesale vendors Smartlead itself rents from, directly. (= **L1** on the independence ladder, §3.)
- **We OWN:** control plane, billing, orchestration/facade, agent surface, AI ops, deliverability control loop.
- **We RENT:** domains (registrar API), mailboxes + base warmup + base deliverability monitoring (self-serve mailbox vendor; primary = **Inboxkit**).
- **We FORK:** the sequencing + reply engine (**cold-cli**); optionally the warmup-pool infra (**warmbly**) at L2.
- **Agent surface** = curated **~8–12 high-level tools** (NOT a re-export of vendor complexity), shipped as a **hosted MCP + CLI twin + a discovery skill/AGENTS.md**. Tiny toolset → low MCP token cost.
- **Content generation is the customer's agent's job** — not a layer we build.
- **Per-customer isolation is mandatory** (own domains/mailboxes/IPs per customer).
- **Warmup:** offered, AI-driven, **honest about the weeks-long ramp**; rented pre-warmed boxes to shorten cold-start. Never marketed as magic.

---

## 3. Independence ladder (roadmap frame)

Key fact: **Smartlead is itself an aggregator** — it owns almost no infra (domains via Namecheap API; Google/Outlook mailboxes via Inboxkit/Zapmail/Pager.ai; SMTP+IPs via Mailreef). "What Smartlead has" at the infra layer = the same wholesalers anyone can integrate.

| Layer | What we own | Build cost | Dependency |
|---|---|---|---|
| L0 — resell Smartlead | facade + billing | days | total (Smartlead) — *fallback only* |
| **L1 — cut the middleman ⭐ (target)** | facade + own sequencer over wholesale vendors | weeks–2mo | vendors, not Smartlead |
| L2 — own mail infra | Mailcow/Postal/mox + leased dedicated IPs + own warmup pool | months + **perpetual ops** | none |

The **facade is the abstraction that lets us climb L1→L2 invisibly** (same agent tools, swap backend vendor). Target L1; L2 only selectively, at scale. Note: fresh self-hosted IPs often deliver *worse* than rented established ones — L2 is not automatically "better."

---

## 4. Architecture — facade spine + 3 planes

```
customer's Claude Code / Codex
        │  (one MCP line + token, or `npx coldstart ...`)
        ▼
[ Surface ]  curated ~8–12 tool MCP  +  CLI twin  +  discovery skill
        ▼
[ Plane C — Facade / Orchestration API ]
   the ~8–12 intents, scoped per tenant; guardrails, metering,
   audit, inbox management, metrics. Thin transports sit over this.
        ▼
[ Plane B — Provisioning service ]
   async, resumable jobs: buy domains → DNS → provision+warm
   mailboxes → allocate quota. (warmup spans weeks → not request/response)
        ▼
[ Plane A — Identity & Billing ]
   signup, Stripe card-on-file, markup/metering, quotas,
   tenant ↔ vendor mapping (encrypted creds per tenant)
        ▼
   underneath: registrar API (domains) + mailbox-vendor API
   (inboxes/warmup/monitoring) + forked cold-cli (sequencing/IMAP)
   + Claude (our ops AI: lookalike gen, deliverability loop)
```

Design rule for the facade: **few, high-level intents that HIDE vendor complexity.** This is both the simplicity wedge and what keeps MCP token cost negligible.

---

## 5. The stack — rent / fork / build per layer

| # | Layer | Mode | Concretely | Effort | Cost |
|---|---|---|---|---|---|
| 1 | Domains (branded lookalikes) | build over API | Porkbun or Namecheap API + AI lookalike generator + website redirect | LOW | ~$10–15/domain/yr |
| 2 | DNS (SPF/DKIM/DMARC/rDNS) | build over API | registrar/Cloudflare DNS API + verify ("doctor") | LOW | ~free |
| 3 | Mailboxes (reputation-bearing) | **rent** | Inboxkit (primary) — real Google/MS + isolation + warmup + monitoring | MED | ~$3/mbx/mo |
| 4 | Sequencing engine | **fork** | cold-cli (sequences, scheduling, caps, rotation, A/B, unsubscribe) | MED | free (OSS) |
| 5 | Reply / bounce / inbox | **fork + build** | cold-cli IMAP detection + build unified inbox + mgmt tools | MED | free |
| 6 | Warmup | rent + build | vendor base warmup + our AI human-mimicry layer; honest timing | MED | varies |
| 7 | Content/personalization | **descoped** | customer's agent owns it; we add optional helpers only | LOW | usage |
| 8 | Control plane (auth, billing, tenancy, isolation, quotas, guardrails, provisioning, **inbox mgmt, metrics**) | **build** | Stripe + Postgres + resumable job queue | MED–HIGH | eng time |
| 9 | Agent surface (curated MCP + CLI + skill) | **build** | thin transport over plane C | MED | eng time |
| 10 | Deliverability ops | **build as AI control loop** | AI agent over vendor signals: monitor → pause/rotate/replace/throttle | MED | eng time |

---

## 6. Agent surface — the tools (~8–12)

```
setup_infrastructure(brand, primary_domain, domains, inboxes_each, persona)  → async job id
infrastructure_status()         → provisioning + warmup + send-readiness date + per-mailbox health
launch_campaign(offer, leads, schedule, sequence?)  → create/activate (sequence by customer agent or our helper)
campaign_results() / metrics()  → replies, bounces, complaints, placement, warmup health (opens OFF by default)
inbox() / thread(id) / reply(thread, body) / mark(thread, status)  → unified reply mgmt, stop-on-reply
pause(campaign) / pause_all()
account()                       → usage / billing / quota
[optional helpers] write_sequence(offer, audience) · suggest_domains(brand)
```

---

## 7. Isolation model (how one bad customer ≠ company death)

- **Every customer = own dedicated lookalike domains, never shared.** A burned domain is contained and replaced. **Domain burn of 8–18%/month is normal** → auto-retire-and-replace is a built-in feature, not a failure.
- **Mailbox/IP isolation** via the vendor (Inboxkit domain isolation / dedicated-IP option / per-tenant Workspace).
- **The real residual risk is narrow:** the upstream vendor (or Google/MS) terminating **our master reseller account** over aggregate abuse. Mitigated by per-tenant complaint monitoring + auto-pause + light KYC + ToS. **Guardrails exist to protect vendor standing — there is no shared reputation pool to protect** (correcting an earlier overstatement that called single-customer abuse "existential" for deliverability; it isn't, given isolation).
- **Underlying Google/MS AUP applies** to the rented mailboxes; customers are bound as if direct Google/MS customers.

Required guardrails (also legal hygiene): suppression list, **one-click unsubscribe (RFC 8058)**, per-domain/day caps (~40–50/mbx/day), spam-complaint monitoring (Gmail ineligibility threshold = 0.30%), auto-pause.

---

## 8. Lookalike-domain workflow (concrete)

Given brand + primary domain:
0. **Third-party-brand hard-reject (enforced in code).** Before any candidate generation or purchase, `setup_infrastructure` validates the request (`apps/platform/src/engine/brand-guard.ts`): (a) a well-known-brand denylist (google, microsoft, apple, amazon, meta, paypal, stripe, netflix, …) rejects impersonation of major brands; (b) the asserted `brand` must correspond to the `primaryDomain` (normalized substring match), so lookalikes provably derive from the tenant's *own* stated identity, not an arbitrary third party. Violations return HTTP 400. In test mode this brand↔domain consistency check stands in for real domain-ownership proof; full cryptographic ownership verification (DNS TXT / registrar) is an activation step (`ACTIVATION.md`).
1. **AI generates lookalike candidates** — `try/get/join` prefixes, `-hq` suffix, sane TLDs. Must read clearly as the brand; no symbols/numbers/unrelated words (else reads as phishing). `acme.com` → `tryacme.com`, `getacme.com`, `acmehq.io`, NOT `reallygoodproducts.com`.
2. **Buy** via registrar API (Porkbun/Namecheap).
3. **Auto DNS:** MX, SPF, DKIM, DMARC, rDNS/PTR. (2026: missing/wrong = rejected at SMTP level, not spam-foldered.)
4. **Website redirect** each lookalike → branded page / primary (prospects type the domain to check you're real; blank page = spam mark). This is the `forwarding_domain` concept.
5. **Provision branded mailboxes** (display name + signature carry the brand).
6. **Wire replies** into the unified inbox.
7. **Never send from the primary domain** — default posture; §20 defines the consented exception.

---

## 9. Warmup — what's true, what we do

**Mechanics:** a pool network manufactures engagement (other inboxes open/reply/rescue-from-spam); ramp ~5/day wk1 → 25–40/day wk4 (~4 wks); builds domain history + IP reputation; **must run forever** (a mailbox that only sends cold and gets zero replies is detectable by pattern).

**2026 reality (honest):**
- Public-pool signal is **discounted** — Gmail/MS detect the closed-loop graph + datacenter-IP bots ("dashboard shows opens, Gmail sees bots").
- Independent test: **no major warmup tool showed meaningful deliverability lift.**
- Private/vetted pools = +20–30% vs public.
- **"Pre-warmed" = time-shift trick:** vendor runs the warmup cycle on pre-aged domains/established IPs before handover.

**Our approach:** rent base warmup (vendor) + **AI human-mimicry layer** (diverse real-world traffic, varied content/timing — strongest when it generates *non-closed-loop* activity) + rented pre-warmed boxes for cold-start + **maximize REAL replies** via the customer's actual campaigns (the unbeatable signal). Honest about ramp time. **AI mimicry is an incremental edge in an arms race vs Google, not a permanent moat** — don't bet the company on out-botting the bot-detector. The graph topology, not content quality, is the hard detection layer.

---

## 10. Deliverability ops = AI control loop (not a manual specialist team)

The **mailbox vendor provides the raw machinery + signals** (bounce rate, spam-complaints, placement-test results, warmup health). **Our AI deliverability agent runs the loop:** monitor → decide → act — auto-pause a degrading mailbox, rotate sending, **detect a burning domain and auto-buy + warm a replacement**, throttle volume per-mailbox health.

This turns the "perpetual specialist ops" burden into an **automated control loop** — tractable at L1 (we react to vendor signals), heavier at L2 (raw monitoring is ours). Honest boundary: **AI automates the response within the rules; it cannot change how Gmail/Microsoft judge you.**

---

## 11. Build sequence

- **Phase 0 — de-risk (days):** confirm one mailbox vendor's API + economics (Inboxkit) + Porkbun. **Manually spike the full pipe once:** buy 1 domain → set DNS → provision 2 mailboxes → send 1 email via forked cold-cli → detect the reply. Prove end-to-end before building product around it.
- **Phase 1 — MVP (weeks):** control plane (auth + Stripe + 1 tenant) + provisioning over {Porkbun + Inboxkit} + forked cold-cli + curated MCP + inbox + metrics. Single vendor, rent everything. Ship to a handful of users.
- **Phase 2 — productize:** guardrails, AI warmup layer, AI deliverability control loop, billing markup/metering, multi-vendor abstraction behind the facade, agent-skill distribution.
- **Phase 3 — selective L2:** own mail servers/IPs where margin justifies.

---

## 12. Economics (wholesale; verified 2026-07-09 — primary sources, see docs/research/vendor-tos-economics-2026-07-09.md)

- Domains (Porkbun, primary): **.com $11.08/yr**, .net $12.52, .io $28→$52 renewal, .co $16→$31 renewal. Default lookalikes to **.com** (no renewal cliff; burn-replacements pay full renewal). Maildoso/Mailforge bundle domains at $12–14/yr.
- Mailboxes (all-in = mailbox + warmup): **Inboxkit** $3.1/$2.7/$2.5 per mbx/mo (Pro/Agency/Ent) **+ $3/mbx/mo warmup ≈ $5.5–6.1 all-in**, API on all paid tiers. **Maildoso** $2.5→$0.5/mbx (30→1000, cheapest at volume). **Mailforge** $3/mbx yearly (shared IP; billed on slots). **Mailreef** server-based $240–249/mo ~150 mbx/server, +$0.001/send. **Zapmail** ~$3–3.5/mbx, API gated to $299 tier.
- **Stripe:** 2.9% + 30¢ domestic; ~$15/dispute (cold-email = high-chargeback category → dunning + dispute lane required).
- Fully-loaded cost/mailbox ≈ **$7/mo** (mailbox+warmup+domain amortization+8–18%/mo burn replacement+Stripe). Retail per-mailbox line (§18) at $13–15 clears the **2.5–3x** target. **Margin** = retail − wholesale; **quota lever** = mailbox/domain/lead allocations per tenant + per-tenant spend caps.

---

## 13. Self-serve vendor shortlist (no sales call required)

| Vendor | Self-serve | API | Real Google/M365 | Isolation | Built-in warmup + monitoring | Price |
|---|---|---|---|---|---|---|
| **Inboxkit ⭐** | yes | **all plans** | Google/MS/Azure | domain isolation | AI warmup + placement + bounce monitoring | $39/$99/$299 |
| Zapmail | yes | Pro tier only ($299) | Google/MS | workspace isolation | AI warmup, pre-warmed option | $39/$99/$299 |
| Maildoso | yes | on plans | SMTP + GW combo | mixed | placement + self-healing bundled | ~$1.9–2.5/mbx |
| Mailforge | yes | yes | ❌ shared-IP SMTP | ⚠️ shared IP | DNS automation | $2–3/mbx |
| Mailreef | ❌ (email for API) | gated | SMTP + dedicated IP | ✅ dedicated IP | ❌ no warmup | ~$3.99/mbx |

**Primary = Inboxkit** (API on every plan + warmup + monitoring + isolation built in → we inherit base deliverability machinery). Zapmail = pre-warmed alt. Maildoso = best $/mbx. Mailreef = best isolation but not self-serve. **Term that applies to all:** mailboxes governed by Google/MS terms; comply as if a direct customer.

**⚠ RESALE-PERMISSION GATE (research 2026-07-09, activation-blocking for the LEGAL model — not the sandbox build).** A multi-tenant "we provision on your behalf" wrapper is a resale/agency use. Per each vendor's OWN ToS: **only Mailforge explicitly permits it** ("indirect subscriber… reselling… to your clients" via required sub-accounts). **Inboxkit** grants only "internal business operations, non-transferable" (no resale carve-out; enterprise-negotiated terms are the escape hatch). Zapmail = internal-use-only. **Mailreef explicitly prohibits** resale. Maildoso = silent. **Resolution paths (activation decision):** (a) negotiate an Inboxkit enterprise/reseller agreement; (b) default the real adapter to Mailforge (ToS-clean, accept weaker shared-IP isolation); or (c) restructure as a **management-service** where the customer is the account principal — which also satisfies the "customer is the CAN-SPAM sender" compliance posture (§compliance). The `VendorPort` facade makes this a swap, not a rebuild. **Porkbun's domain-purchase endpoint is undocumented** (DNS confirmed only) → buy-domain real adapter uses **Namecheap** (documented registration API) as the confirmed fallback.

---

## 18. Pricing (delegated design authority, 2026-07-09 — canonical; drives Stripe test-mode products + site pricing page)

Value metric = **per-mailbox/mo** (tracks our cost) + a platform fee (control plane, agent surface, deliverability loop, AI support). Domains bundled (needed for the mailboxes anyway). Sends are naturally bounded by deliverability caps (~40–50/mbx/day) so no separate send meter — simpler for an agent to reason about. Packaged bundles (agents pick clean options):

| Tier | Price/mo | Mailboxes | Domains | ~Sends/mo | Fully-loaded cost | Gross margin |
|---|---|---|---|---|---|---|
| **Free / Demo** | $0 | 0 (sandbox dry-run, NO real sends) | — | 0 real | ~$0 | the abuse-proof first-use (`npx agent-cold-email demo`) |
| **Launch** | $99 | 5 | 2 | ~1,000 | ~$36 | ~64% |
| **Growth** ⭐ | $299 | 20 | 6 | ~6,000 | ~$138 | ~54% |
| **Scale** | $799 | 60 | 18 | ~20,000 | ~$409 | ~49% |
| **Custom** | platform $49 + $13/mbx/mo | 60+ | ⅓ of mbx | metered | — | negotiated (reseller wholesale improves it) |

All paid tiers clear the 2.5–3x per-mailbox target ($13–15 retail vs ~$6 wholesale). **Free/Demo is structurally sandbox-only** (type-guarded, tested) — abuse-proof. Card-on-file at signup; auto-renew with ROSCA/state-ARL disclosure + easy-cancel. Numbers stay adjustable in Stripe test mode until activation.

---

## 14. OSS to fork (verified by reading repos)

- **andersmyrmel/cold-cli** (Go, agent-first sequencer; ships AGENTS.md + 26KB ARCHITECTURE.md). Does: sequences/scheduling/per-mailbox caps/rotation/A-B variants/`{{placeholder}}` templating, IMAP reply-bounce-unsub detection, `doctor` (MX/SPF/DKIM/DMARC + domain age), List-Unsubscribe, threading. SQLite or Postgres. Sends via Google Workspace (`gws` subprocess) or generic SMTP/IMAP. → **our sequencing + reply engine.** Key files: `internal/tick.go`, `internal/scheduler.go`, `internal/send.go`, `internal/reply.go`. ⚠ confirm license before forking.
- **warmbly/warmbly** (Go, Apache-2.0). Self-host cold-email + warmup: one worker per IP, per-IP reputation, pool warmup + spam-score tracking, envelope encryption, React admin UI. → **L2 warmup-pool / own-IP option.**
- **openfrens/openmailserver** (Python + `mox`). Agent-native mailbox provisioning on own domains via HTTP API/CLI. → **L2 mailbox-provisioning option.**

---

## 15. Hard truths / risks

- **Skipping Smartlead = becoming a cold-email-infrastructure company.** Software is cheap/ownable (cold-cli + facade); **deliverability is the real ongoing job** (now automatable via the AI loop, but still the core challenge).
- **Moat is thin.** Durable edges = distribution (be the agent's default) + onboarding friction-collapse + AI ops. Vendors could close it (e.g. Smartlead adds card-on-file PLG).
- **Warmup is depreciating** — don't over-invest; never market as magic.
- **Vendor AUP (Google/MS) sits underneath**; aggregate abuse threatens the master account.
- **Legal NOT yet researched** — CAN-SPAM (US, opt-out + physical address), GDPR/PECR (EU, stricter). Gating for productization. Must ship suppression + one-click unsubscribe + opt-out from day one.
- **Domain burn (8–18%/mo) is a normal cost,** not a failure mode.

---

## 16. To confirm in Phase 0

1. **Inboxkit API:** programmatic per-customer isolation (separate domains/mailboxes per tenant), token scoping, exact endpoints for buy-domain / create-mailbox / warmup / metrics.
2. **Reseller economics:** is there a reseller/agency tier, or do we buy retail and resell at markup? What sets the margin.
3. **cold-cli license.**
4. **Default mailbox type:** Google/MS (Inboxkit/Zapmail, best deliverability + isolation) vs SMTP (Mailforge/Maildoso/Mailreef, cheaper). Tradeoff: deliverability vs cost vs isolation.
5. **Stripe metered-billing model** (per-mailbox/mo + per-domain + usage).

---

## 17. Distribution — agent-recommended, human-activated

**Tested, not assumed.** A live Claude Code instance, handed "do cold email end-to-end" then asked "is there a platform I can sign up for so you do it all," **defaulted to Smartlead** (found via WebSearch + the Smartlead MCP GitHub repo + Smartlead's SEO content). Findings:

**The thesis "AI picks the least-resistance path" is half-true.**
- ✅ Validated: agents want a tool to drive (not hand-roll forever), reject black-box AI-SDRs (Artisan/11x "slop"), and reason themselves to exactly our shape — minimal tools, agent-as-brain, clean REST/CLI over a heavy 116-tool MCP.
- ❌ Naive part: "least resistance" resolves to the **most discoverable incumbent**, not the newest/simplest tool. A thin-web-presence newcomer would not surface at all.

**Real mechanic = agent-recommended, human-activated.** Agent recommends → human signs up + pays (the test agent flagged "the card is yours" every time) → human hands the token back. Not autonomous discovery. Contestable.

**Two failure modes to beat:**
1. **Agent hand-rolls past us** — before being asked about platforms, the agent's default was to *assemble* the pipeline from raw parts. A coding agent's first instinct is to build, not shop.
2. **Agent shops and finds the incumbent** — Smartlead owns the surfaces an agent queries.

**Win condition: manufacture discoverability on the surfaces agents actually query (not just Google SEO).**

| Surface | Incumbent today | Our play |
|---|---|---|
| Web/SEO answer content | Smartlead (years of content) | AEO at the agent's literal queries; slow |
| GitHub (agent cites repos) | LeadMagic 3rd-party Smartlead MCP | **be THE purpose-built agent-native repo + AGENTS.md** |
| MCP registries (Smithery/mcp.so) | thin | early-mover |
| npm / PyPI | thin | early-mover |
| Model training priors | incumbents | unavailable early |

Three requirements to win the recommendation moment:
1. **Own the agent-tooling surfaces** — strong GitHub repo, AGENTS.md, Claude skill, MCP + CLI, registry/npm presence — so an agent searching for *tooling* finds "the cold-email platform built to be run by your agent."
2. **Be objectively the fewest human steps** — agents optimize for least human effort, so genuine friction-collapse (one signup + token vs DIY vendor stitching) *is* the discovery edge.
3. **Be unmistakably agent-native** in language incumbents don't use, so the agent recognizes it as built for *it*.

**Moat vs. agent self-assembly (design requirement, not marketing).** As agents improve they may wire up Porkbun + Inboxkit directly and skip a thin wrapper — the real existential threat, bigger than Smartlead. Defense = be the **stateful, billed backend an agent can't hold in a session**: card-on-file + multi-tenant billing, per-customer isolation, weeks-long provisioning/warmup jobs, deliverability control loop. **Therefore the product must NOT be a thin stateless API proxy** — its value is the durable backend state, which is what makes "sign up + token" beat "hand-roll 3 vendor APIs every session." (Reflected in Planes A/B, §4.)

**Probability (honest):** adopt *a* tool — HIGH · prefer our shape once seen — HIGH · discover/recommend us over Smartlead by default today — LOW. **The thesis works only if discoverability is a built product surface, not gravity.** "The AI will just find it" is the one part that won't happen on its own.

Prior art note: `sales-smartlead` and `open-salesblink/skill` already exist — the "skill wrapping a cold-email backend" idea is partly in the wild.

---

## 19. Dashboard + Unified Inbox — the optional human surface (spec locked 2026-07-12; adversarial verdict SHIP, two rounds — record: `docs/adversarial/dashboard-spec-review-2026-07-12.md`)

> Grounded in: priorart Launchpad `agent-controlled-dashboard-unified-inbox-coldrig-2026-07-12.md`, repo map (2026-07-12), premium-b2b design archive 2026-06-04, adversarial verdict r1.

## 19.0 Positioning — the dashboard is optional, and the agent runs it

Product thesis stays agent-first ("no dashboard required"). This surface is the **optional human window** onto an agent-run system; its differentiator is that it is **AI-native**: the customer's agent can configure it — layout, visible widgets, saved views, notes, thread triage — via the same MCP/API surface it already uses. Agent-layout-control is in scope by **founder directive 2026-07-12** (supersedes the YAGNI objection; recorded here and in ROADMAP). [F8]

**Parity law (hard invariant):** every dashboard capability remains available via MCP/CLI; every dashboard mutation calls the same TenantDO methods MCP calls. Dashboard-originated state is only (a) views/layout, (b) thread labels — both agent-readable/writable via MCP. The dashboard may never become the required path for anything.

## 19.1 Architecture

- **App**: `apps/dashboard/` — Vite + React + React Router SPA (pattern: cloudflare/agentic-inbox, Mail-0/Zero `apps/mail`). Gets its own `README.md` at creation (repo law), wired into root CI scripts (typecheck + test + build). [F10]
- **Serving (exact config)** [F3]: built with Vite `base: '/app/'` into `apps/platform/public/app/`; platform Worker `wrangler.toml` gains:
  ```toml
  [assets]
  directory = "public"
  binding = "ASSETS"
  not_found_handling = "single-page-application"
  run_worker_first = ["/*", "!/app/*"]
  ```
  Intended behavior: every non-`/app` path hits the Worker exactly as today (API untouched, no CORS changes — same origin); `/app/*` serves static assets with SPA fallback for client routes. **M1 gate: a `wrangler dev` spike proving `/inbox`→JSON, `/app/inbox`→index.html, `/app` (no trailing slash)→redirect or SPA (not a Worker 404), and unknown API path→JSON 404** — the last requires adding a JSON `app.notFound()` handler to the Hono app (none exists today; Hono defaults to text/plain). favicon/manifest live under `/app/` (Worker owns all non-/app paths, so no root-level static files). [NEW-4] If the declarative config can't scope the fallback cleanly, fall back to a Worker-side `ASSETS.fetch` shim for `/app/*` (decision recorded in spike result). No D1 migration and no DO-class migration is needed for new tables — TenantDO creates them via `CREATE TABLE IF NOT EXISTS` on next wake (constructor bootstrap); the new mailbox column ships via the existing `ensureColumnMigrations` path. [F3, F7]
- **Auth (v1 = httpOnly cookie session, opaque id)** [F1, NEW-1]: token-gate screen POSTs the pasted tenant bearer to `POST /dashboard/session` → verified via the normal token hash → creates a server-side session (D1 migration `0006_dashboard_sessions`: `session_hash` (SHA-256+pepper of a random 256-bit id), `tenant_id`, `created_at`, `expires_at` TTL 30d) → response sets `Secure; HttpOnly; SameSite=Strict; Path=/` cookie carrying the OPAQUE session id — the cookie is never the raw credential. SPA never stores the token in JS-readable storage (no localStorage, never in URLs/fragments). `requireAuth` gains a cookie fallback (session lookup → tenant) when no `Authorization` header is present, and exposes WHICH method authenticated (`authVia: 'bearer' | 'cookie'`) for provenance stamping [NEW-5]. **CSRF posture (global, not per-route)** [NEW-1]: SameSite=Strict is same-SITE-scoped (eTLD+1) — once app and marketing site share `coldrig.dev` at activation it no longer isolates them — so a middleware on the ENTIRE authed surface enforces: auth came via cookie AND method is not GET/HEAD ⇒ require header `X-Coldstart-Client: dashboard`, else 403. This covers every legacy destructive route (`/cancel`, `/checkout`, `/campaigns`, `/threads/*`), not just `/dashboard/*`; DoD includes a test that a cookie-authed `POST /cancel` WITHOUT the header returns 403. `POST /dashboard/logout` deletes the session row + clears the cookie. Token revocation/suspension mid-session → API 401s → SPA drops to the token-gate screen with an explanatory state (suspended vs invalid). [F10]
- **Data fetching**: TanStack Query (interval polling + refetch-on-focus; per-widget `refreshSeconds` in layout JSON). No SSE in v1 (recorded as later upgrade).
- **Rendering stack**: Tailwind (tokens extended from `site/assets/style.css`, incl. dark mode) + minimal copied shadcn-style primitives + TanStack Virtual (thread list) + cmdk (palette). System font stack (no external CDN/fonts); tabular-nums on all numerics; KPI-hero/data-table/chip patterns per premium-b2b archive. Perf budget: initial JS ≤ 200 KB gzip, route-split; Lighthouse mobile perf ≥ 85 on the dashboard route (sandbox data). [F10]
- **Content safety — ONE pipeline for ALL untrusted rendered content** [F1]: two classes, both specified:
  1. **Email message HTML** (activation-era; sandbox is text): DOMPurify strict pre-pass → iframe `srcdoc` + `sandbox` (NO `allow-scripts`) + injected `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">` + `<base target="_blank">`.
  2. **Agent-authored strings** (agent_note markdown, labels, view names, edited_by_note, widget string props) — treated as UNTRUSTED (the agent reads attacker-controlled inbound mail and may echo it): labels/names/notes render as `textContent` only (plain text, no HTML path exists); `agent_note` markdown renders through a restricted renderer with raw-HTML pass-through DISABLED → DOMPurify strict allowlist (no images in v1) → link `href` scheme allowlist (`https:`, `mailto:` only) → single sanctioned render node. `dangerouslySetInnerHTML` is banned outside the two sanctioned sinks above (CI grep guard). Layout JSON is data, never interpolated into markup; widget props are zod-validated typed values.

## 19.2 Data model (TenantDO SQLite additions; constructor bootstrap, no migration) [F3]

```sql
CREATE TABLE IF NOT EXISTS dashboard_views (
  id TEXT PRIMARY KEY,              -- slug
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,   -- row version for optimistic concurrency [F5]
  layout_json TEXT NOT NULL,        -- zod-validated (packages/shared)
  layout_schema_version INTEGER NOT NULL DEFAULT 1,
  edited_by TEXT NOT NULL,          -- transport-derived: 'dashboard' | 'mcp' | 'api' [F4]
  edited_by_note TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,              -- free-form; canonical set styled in UI, not enforced
  source TEXT NOT NULL,             -- transport-derived: 'dashboard' | 'mcp' | 'api'
  updated_at TEXT NOT NULL
);
-- mailboxes: ADD COLUMN last_polled_at TEXT (via ensureColumnMigrations); set by runPollInbox
-- on every poll incl. sandbox — backs the per-mailbox last-sync UI claim. [F7]
```

Canonical label set (recommended): `interested`, `meeting_booked`, `not_now`, `out_of_office`, `wrong_person`, `do_not_contact`. Classification is the customer agent's job (agent labels via MCP; humans override; source tracked).

**Default-view lifecycle** [F6]: first `GET /dashboard/views*` lazily seeds view `default` (starter layout, `is_default=1`, `edited_by='api'`) — a fresh tenant always renders. Exactly one default enforced transactionally: `POST .../:id/default` promotes and demotes the previous atomically; `POST` create → non-default unless it's the only view; `DELETE` refuses the default view (promote another first) and the last view.

## 19.3 Layout-as-data schema (packages/shared, zod)

As r1 (12-col `gridPos`, `visible`, typed `props`; mobile = single column ordered by (y,x)). Widget registry v1: `kpi_row`, `mailbox_health`, `campaign_performance`, `activity_feed`, `inbox_preview`, `agent_log`, `agent_note`, `quota_usage`. Unknown type/invalid props ⇒ 422 with a structured, agent-repairable error listing valid types + schemas; stored-but-unknown type renders a graceful "unsupported widget" card. Every widget defines **loading skeleton, error, and empty states** (design-reviewed, not just empty). [F10]

## 19.4 API additions (tenant auth = bearer OR dashboard cookie)

| Method | Path | Notes |
|---|---|---|
| POST | `/dashboard/session` · `/dashboard/logout` | cookie exchange / clear [F1] |
| GET | `/dashboard/views` | list (id, name, is_default, rev, edited_by, updated_at) |
| GET | `/dashboard/views/:id` | full layout + rev |
| PUT | `/dashboard/views/:id` | full-layout upsert; **requires `rev`; mismatch ⇒ 409 {currentRev, currentLayout}** [F5] |
| POST | `/dashboard/views` · `/dashboard/views/:id/default` · DELETE `/dashboard/views/:id` | lifecycle per §19.2 [F6] |
| GET | `/campaigns` | NEW DO method `listCampaigns` (id, name, status, counts) — acknowledged new work, not a wrapper [F9] |
| GET | `/activity` | NEW DO method merging `events` + `deliverability_actions`, cursor-paginated [F9] |
| POST | `/threads/:id/label` | set/clear label |
| GET | `/inbox` **v2** | **cursor pagination (`limit` default 50, `cursor`), filters (`mailbox`, `campaign`, `label`, `read`, `include_nonreply` for bounces/OOO), single JOINed query (kills the N+1), row fields: threadId, subject, snippet, leadEmail, mailboxEmail + deliv_status, campaignId + campaign name, label + source, lastEventType/Ts, markStatus** [F2]. **Cursor is composite `(lastEventTs, rowid)` matching `ORDER BY lastEventTs DESC, rowid DESC`** — same-ts ties are routine (send + simulated reply share ts); DoD includes a pagination test crossing a same-ts page boundary without loss/duplication [NEW-2]. subject/snippet are not columns: resolved via `json_extract` from `campaigns.sequence_json` (per-step subject) and `events.metadata_json` body — builder verifies per-step resolution [NEW-3]. MCP `inbox` tool gains the same optional params (shared DO method — agents get filters too). Backward-compatible defaults. |

Provenance is **server-derived from transport** — cookie-authed = `dashboard`, MCP = `mcp`, bearer HTTP = `api`; no client-supplied actor header exists. Plumbing [NEW-5]: `requireAuth` exposes `authVia`; each route maps transport → `source` and passes it as an explicit param to the DO method (MCP handler passes `'mcp'`). The lazy-seeded default view is stamped `'system'` (badge suppressed — it was not agent-configured). UI badge: `mcp`/`api` → "Configured by your agent — <note>"; `dashboard` → "by you"; `system` → none. Documented as advisory-truthful (an agent could perform the cookie exchange; the badge reflects transport, which only an interactive paste normally establishes). [F4]

## 19.5 MCP additions (tools 13–15)

`get_dashboard` (list/fetch views incl. rev) · `configure_dashboard` (create/update/delete/promote view; same rev-precondition semantics, 409-equivalent structured error with currentRev+layout so the agent can rebase; optional `note`) · `label_thread`. All record provenance `mcp`.

## 19.6 Inbox UX spec

As r1 (3-pane keyboard-first desktop: j/k, Enter, e, r, l, u, Cmd+K, auto-advance; single-pane gesture-first mobile with bottom tabs) with these additions:
- Swipe actions get a **5-second UNDO toast** (mis-swipe recovery). [F10]
- Filters bar + palette expose mailbox/campaign/label/read + the explicit **"Bounces & OOO" toggle** (backed by `include_nonreply` server param). [F2]
- List is server-paginated (infinite scroll via cursor) + client-virtualized. [F2]
- Health surfacing: persistent banner when any mailbox `paused`/`throttled`; Settings→Mailboxes shows per-mailbox `last_polled_at` + warmup + deliv_status. [F7]
- **A11y floor**: full keyboard traversal across panes, visible focus rings, ARIA roles on list/detail/palette/tabs, focus trap + restore in dialogs/sheets, WCAG AA contrast in both themes. [F10]
- Timestamps render browser-local with ISO-8601 tooltip. [F10]
- 401 mid-session → token-gate screen with suspended-vs-invalid explanation. [F10]

## 19.7 Definition of done (v1)

1. Unit: layout validation (valid/invalid/unknown-type), label flows, view lifecycle (seed stamped `system`, single-default, 409 on stale rev, delete guards), cookie session (opaque id, TTL, logout deletes row; **cookie-authed `POST /cancel` without `X-Coldstart-Client` → 403** [NEW-1]), inbox v2 (pagination/filters/fields, no N+1 — query-count asserted; **same-ts cursor-boundary test** [NEW-2]), auth 401s. Full suite stays green (148+ maintained).
2. Serving spike evidence: `/inbox`→JSON, `/app/inbox`→index.html, unknown API→JSON 404 (wrangler dev). [F3]
3. Live drive (sandbox): signup → demo/run → dashboard populated (KPIs, mailboxes w/ last-poll, campaigns, threads); first-load with fresh tenant renders seeded default view (no empty crash). [F6]
4. **Agent-control proof**: MCP `configure_dashboard` reorders/hides widgets + writes agent_note → UI reflects on next poll with "Configured by your agent" badge; `label_thread` → label chip appears; human override flips source; stale-rev write → structured 409 the agent can repair. [F4, F5]
5. Playwright CLI screenshots: 1440px & 390px × dashboard, inbox, thread, composer × light & dark; design-review loop until clean.
6. Security checks in-suite: agent_note with `<script>`/`javascript:` link/`<img onerror>` renders inert; label with HTML renders as text; no `dangerouslySetInnerHTML` outside sanctioned sinks (grep guard in CI). [F1]
7. Fresh-context adversarial re-attack CLEAN. SPEC §0 intact (zero real vendor spend; sandbox data only).

## 19.8 Build order

- **M1 backend** (spec-builder, sonnet high): serving spike FIRST (gate, incl. JSON notFound + `/app` no-slash handling) → TenantDO schema bootstrap + `last_polled_at` → shared zod layout schema/registry types → inbox v2 DO method + route (composite cursor) → listCampaigns/activity → views CRUD + lifecycle + rev CAS → D1 `0006_dashboard_sessions` + cookie session (opaque id) + `authVia` + GLOBAL CSRF middleware → MCP tools 13–15.
- **M2 dashboard SPA shell + widgets** (design-builder + spec-builder): tokens, grid renderer, widget registry v1 with skeleton/error/empty states, provenance badges, Settings.
- **M3 inbox** (design-builder + spec-builder): virtualized paginated list, filters, thread detail, composer, labels, keyboard + swipe + undo, Cmd+K.
- **M4 agent-control e2e + saved views + dark mode + a11y pass** (spec-builder).
- **M5 perfection loop**: screenshot 1440/390 → design-review/impeccable → design-builder fixes → repeat until clean; verifier battery; adversary re-attack gate.

Out of scope v1 (recorded): SSE/delta streaming, snippets/templates, multi-user assignment, push notifications, drag-and-drop human layout editing (humans get show/hide + reorder; the AGENT is the primary layout editor — the product bet), our-own-AI reply classifier (the customer's agent classifies).

---

## 20. BYO domains & mailboxes (customer brings any domain, incl. primary — ruled 2026-07-14)

> Founder ruling (ROADMAP, 2026-07-14): customers may bring **any** domain to send from, including their primary, with informed consent. Adversarial record: `docs/adversarial/byo-domain-design-review-2026-07-14.md`. Round 1 (naive delegation-first flow) found 3 blocking gaps — no remedy for a burned *primary* domain, TXT-verification proving control but not legitimacy, no primary-specific guardrails/consent — resolved below. Round 2 (re-review of this drafted §20) found 2 further blocking defects in the draft's numbers/incentives, since fixed: §20.5's shortened ramp explicitly excludes primary domains (§20.2), and §20.2's complaint breaker is redefined with a rolling window + volume floor + absolute-complaint floor instead of a bare rate. Round 3 (re-review of that fix) found 1 further blocker — §20.6's Mordy-pilot classification contradicted itself, calling `authorpitchdesk.com` both "zero live infra" and the host of Mordy's existing live Workspace mailboxes — since fixed: the domain is correctly reclassified as `records-to-apply` (live GWS = live infra by §20.1's own scan definition), with "dedicated-outreach, not primary" retained. This revision (round 4) awaits re-review before shipping. Industry-norm grounding: `docs/research/byo-domain-verification-2026-07-14.md` — **no incumbent (Smartlead/Instantly) or multi-tenant primitive (Cloudflare for SaaS) ever asks for nameserver delegation on a domain with live infra**; the heaviest DNS ask found anywhere is a single CNAME.

## 20.1 Intake ladder (risk-ordered, subdomain-first)

Two DNS-control modes only — no third "automation tier":
- **`we-manage-zone`** — fresh domains and fresh subdomains only, with two sub-cases of different risk: (i) a **fresh standalone domain** (freshly bought, zero history) — delegation is free of the primary-domain risk entirely, the same shape as buying a lookalike; (ii) a **fresh subdomain of the customer's existing primary** (`send.customer.com`) — safer than apex delegation (isolated from apex MX/website/SPF/DMARC) but **NOT lookalike-equivalent**: it is still organizationally tied to the primary, and reputation can bleed across that parent relationship (mail-provider and blocklist heuristics sometimes weigh apex-adjacent signals) — treat as **primary-adjacent**, not risk-free, even though it sits in the automated-DNS mode. **Primary-adjacent has one concrete guardrail, not just a caution note**: subdomain-of-primary sending inherits **§20.2's complaint-rate circuit breaker** (the operationalized rolling-window/volume-floor/absolute-floor definition, not the blunter lookalike-path default of relying on Gmail's own 0.30% ineligibility line, §7) — reputation bleed to the parent domain is exactly the failure mode a tighter breaker catches early, before it compounds into something that touches the primary's own standing. Daily caps and DMARC-window/consent requirements stay at the lookalike-path baseline (§7) for this sub-case — only the breaker is elevated. Both sub-cases get full automatic DNS (MX/SPF/DKIM/DMARC/rDNS), same as the existing lookalike flow (§8).
- **`records-to-apply`** — everything else, including any apex/primary domain with live infra. We return the exact records; **"customer's agent applies them" is a delivery mechanism of this mode, not a separate automation tier** — the agent may not hold registrar API creds, so the flow must degrade gracefully: agent-applied (MCP returns structured records, agent calls its own registrar API) → **copy-paste fallback** (human pastes records at their DNS host) with **poll-verify against the authoritative NS** (check on a backoff schedule; **7-day idle timeout** → mark intake abandoned, surface a "still waiting on your DNS" state, offer human-walkthrough copy). No mode silently blocks forever.

**Default** = a dedicated sending subdomain (`we-manage-zone`, primary-adjacent — carries the elevated breaker above, NOT lookalike-equivalent) or a fresh dedicated BYO domain (no live infra, customer-named instead of AI-generated). **Only the fresh-standalone-domain case is genuinely the same risk profile as today's lookalike flow** — a fresh domain has no organizational tie to anything, exactly like a lookalike; the subdomain-of-primary case does not get that equivalence, per the caution above. **Apex/primary sending is permitted but is the highest tier: `records-to-apply` ONLY, never NS delegation**, regardless of how badly the customer wants the simpler flow.

**Mandatory pre-flight live-infra scan** gates every path, run before any DNS-mode is even offered:
- Existing **MX** on the exact hostname (mail already flowing) → live infra found.
- Existing **A/AAAA** (a website hosted there) → live infra found — **except registrar-default parking**: NS records still at the registrar's own defaults (never repointed) with the A-record resolving to a known parking-page IP/ASN, not a resolved customer-facing site, is NOT live infra. A freshly-registered domain still sitting on its registrar's parking page must still qualify for the `we-manage-zone` happy path — the scan checks for a *repointed* record, not merely a present one.
- Existing **SPF `include:`** entries (other legitimate senders authorized) → live infra found; if `records-to-apply` proceeds, we merge into the existing SPF record, never clobber it.
- **DMARC policy already `quarantine`/`reject`** (enforcement mode) → live infra found (and doubles as a reputation signal, §20.5).
- **DNSSEC DS record at the parent zone** → hard-block applies to **apex/whole-domain NS delegation only**: repointing an entire signed zone's authority without a matching DS update breaks resolution outright (SERVFAIL on validating resolvers) → **hard-block delegation until the DS record is removed**, independent of the other findings. **Subdomain delegation under a signed parent is a normal, valid DNSSEC configuration** (an "insecure delegation" — the parent simply publishes no DS for that child label) and is NOT blocked by this rule; the risk is specific to re-pointing a whole signed zone, not to delegating a child label.

Any live-infra hit on the target hostname → **hard-refuse NS delegation**, offer subdomain or `records-to-apply` instead. No live infra found → subdomain/fresh-domain delegation proceeds normally.

**Concentration posture (`we-manage-zone`).** Every `we-manage-zone` delegation lands in our Cloudflare account — the same "no shared reputation pool, but a shared operational dependency" shape as §7's mailbox-vendor risk. Cloudflare's official docs are silent on a hard zones-per-account cap (`docs/research/byo-domain-verification-2026-07-14.md`), so exposure here is bounded by policy rather than a documented ceiling: **primary domains never delegate to us at all** (`records-to-apply` only, above) — only fresh/subdomain domains do, which caps the blast radius of any account-level Cloudflare incident to the disposable-domain population, never a customer's live business domain.

## 20.2 Primary-domain guardrails

§10's auto-burn-and-replace remedy cannot fire on a primary domain — it **is** the customer's business, not a disposable resource. Substitute remedy on any primary-domain trigger that would otherwise burn-and-replace: **hard-pause all sending on that domain** + a runbook reference for the customer's own recovery steps (the domain is theirs to fix, not ours to replace) + **two distinct alert paths, not one**: the **customer** gets a dashboard banner + account-contact email (it's their domain — they need to know immediately, not learn it from a paused campaign), and the **owner** gets the §D6 portfolio-wide digest (a different audience with a different need: cross-tenant visibility, not per-incident recovery instructions).

Additional guardrails, all stricter than the lookalike path (§7) because there is no replacement lever:
- **Complaint-rate circuit breaker — never a bare rate.** A bare 0.10% rate is unimplementable at this tier's own volume: at the ≤20 sends/mbx/day cap below, a single complaint on a low-volume day can read as 1%+, making a bare-rate breaker a one-click griefing vector (forward-and-complain a couple of times to sabotage someone else's real domain) as well as a false-pause hazard. The breaker instead requires **all three** conditions on a **trailing 7-day rolling window**: (1) **≥100 sends** across the domain's mailboxes in the window (a volume floor below which a rate is statistical noise, not signal — reachable by even a single mailbox within the window itself, in ~5 days at the ≤20/day cap, so this isn't a de facto exemption for the smallest primaries); (2) **≥3 absolute complaints** in the window (a floor independent of rate — one or two complaints, however they land on the rate math, never trip an automatic hard-pause on someone's real business domain; this is the direct fix for the griefing/false-pause vector, and it's the binding constraint at most realistic primary-domain volumes since 3 complaints already exceeds 0.10% below ~3,000 trailing-window sends); (3) **rate ≥0.10%** of trailing-window sends (still a third of Gmail's own 0.30% ineligibility line, §7 — the margin exists because a burned lookalike is a Tuesday and a burned primary domain is not recoverable by buying a new one; this becomes the binding constraint only once volume scales past the point where 3 complaints alone would clear it). **Below the volume floor, any complaint routes to a soft response instead of an automatic pause**: halve the domain's daily cap + flag for human review — a single data point below the floor is genuinely ambiguous (could be a real early signal or an unhappy one-off) and deserves a look, not an automatic and potentially griefable trigger.
- **Lower daily caps than the lookalike path**: **≤20 sends/mailbox/day** during active cold sending (vs ~40-50/mbx/day lookalike, §7) — a primary domain's mailbox is presumed to also carry the customer's real business mail, so cold volume must not crowd it, and the cap gives more room to notice a problem before it compounds. **This is a hard ceiling the standard ramp clamps to, not a separate limit racing it**: at any ramp day, primary-domain send volume is `min(§9's scheduled day-N volume, 20/mbx/day)` — so even at §9's generic week-4 steady-state (25-40/day), a primary domain never exceeds 20/mbx/day; the ramp schedule keeps its normal pacing/shape, only the ceiling is lower.
- **Mandatory DMARC `p=none` observation window before first send** — minimum **14 days** of passive monitoring (7-day floor only if the pre-flight scan already found the domain in enforcement mode, §20.1, since that's itself evidence of a clean existing baseline). **Rationale is anti-breakage, not reputation-building**: the window exists so aggregate reports are reviewed and nothing the customer already legitimately runs through that domain gets silently broken by our added volume/records — it is not a warmup signal and does not shorten anything downstream. Stated openly: this adds roughly **two weeks to onboarding** for any primary-domain customer, a real cost weighed against the alternative of breaking their existing mail.
- **No schedule compression — on two axes, not one.** (1) **Pace**: the AI control loop's ramp schedule is authoritative; there is no "rush" override regardless of pilot/deadline pressure. (2) **Length**: primary domains are categorically excluded from the shortened-ramp branch (§20.5) regardless of reputation signal — an established-good-reputation *primary* still takes the full standard ramp, because more existing reputation at stake is more to protect, not a license to move faster. Both axes exist because the downside of getting this wrong is the customer's real domain, not a replaceable one.

## 20.3 BYO abuse gate

**TXT verification proves control of a domain, not legitimacy of its use** — a bad actor can prove they control `paypa1-support.com` just as easily as a legitimate customer proves they control their own primary domain. The brand-guard (`apps/platform/src/engine/brand-guard.ts`, §8 step 0) extends to the BYO path:
- Run the existing well-known-brand **denylist** against the BYO domain itself (not just the asserted `brand` field).
- Add a **registrable-lookalike / homoglyph check** against well-known brands — the `paypa1.com` class (digit-for-letter substitution, added/dropped characters, confusable Unicode) — since a BYO domain skips the "derived from your own stated brand" consistency check that lookalike generation enforces by construction.
- **TXT-verified-but-suspicious (denylist near-miss or homoglyph hit) → human-review/KYC escalation queue, not auto-admit.** Ownership proof and abuse screening are independent gates; passing one never waives the other.

Stated explicitly because it's easy to conflate: **domain-age/blocklist reputation checks (§20.5) are a deliverability control** (will this domain land in inboxes) — **they are not the abuse control** (is this a legitimate use of the domain). A domain can be old, clean, and blocklist-free while still being an active phishing lookalike; the two checks run independently and both must pass.

**Residual, named plainly — this gate does not catch everything.** A **non-famous third-party impersonation** (a target outside the denylist) or a **generic-phish domain** (`secure-billing-support.com` — no specific brand impersonated, so the homoglyph check has nothing to key off) can pass both the denylist and the homoglyph check, because neither test is a general phishing classifier. The backstop is downstream, not at intake: the **complaint-rate circuit breaker (§20.2)** catches abuse in-flight regardless of what slipped past intake, and every **BYO-primary intake additionally routes through light-KYC (§D4)** before its first send — not because primary intake is presumed abusive, but because it is the highest-consequence path and the cheapest place to put a human look.

## 20.4 Consent mechanics

Primary-domain sending requires a **separate, unbundled acknowledgment screen** — not a checkbox buried in general ToS acceptance. Exact risk framing: the customer is told plainly that cold-sending from their primary domain puts **their real business mail and domain reputation at stake** — a burned primary domain degrades deliverability for every legitimate email the business sends, not just cold outreach, and (§20.2) there is no auto-replace remedy. The system logs, alongside the acknowledgment: the domain, a timestamp, and the pre-flight live-infra-scan result (so there's a record of exactly what risk was disclosed against what was actually found on the domain at consent time). The spec states plainly: **the waiver does not remove the business's exposure** (chargebacks, customer churn from a degraded primary domain, reputational cost) — it documents informed consent, it does not substitute for the technical safeguards in §20.1/§20.2, which remain the primary defense.

## 20.5 Warmup branch on intake reputation

The intake scan produces a reputation signal the warmup machine (§9) consumes — but the **primary/non-primary axis gates first, before the reputation signal is even consulted**:

- **Primary domains (the tenant's declared `primary_domain`, §6/§8) never get a shortened ramp, regardless of reputation signal.** This is §20.2's "no schedule compression" restated on the ramp-*length* axis: more existing reputation at stake is more to protect, not a license to move faster. An established-good-reputation primary still takes the full standard 28-day ramp below, **clamped throughout to §20.2's ≤20/mbx/day ceiling** (the `min()` rule defined there) — the reputation signal is real, but for a primary domain it only ever gates the *blocklisted → reject* branch, never the *shortened* one.
- **Non-primary BYO domains** (a dedicated subdomain, or a dedicated aged/secondary domain that isn't the tenant's flagship identity) get the full three-branch reputation ladder:
  - **Established-good-reputation** — composite signal: domain age above **2 years** + clean check against public blocklists (Spamhaus DBL/SURBL-class) + DMARC already in enforcement (`p=quarantine`/`p=reject`) **+ positive evidence of an ACTIVE MX in real use** (not merely a resolvable MX record, and not merely a *long-resolving* one). **The required evidence is DMARC aggregate-report volume (or an equivalent actual-send-volume signal we have direct visibility into) showing ongoing legitimate mail flow — passive-DNS history / historical resolution consistency alone is insufficient**, because it only proves an MX record existed over time, never that mail actually moved through it; passive-DNS is corroborating context at most, never the qualifying evidence by itself. This requirement exists specifically so an **aged-dormant or domain-marketplace-flipped domain** (old, clean, even DMARC-enforced, but with no actual sending history) does not qualify for a shortcut it hasn't earned — age and cleanliness alone are necessary but not sufficient. All four signals present → **shortened ramp**: 7–10 days to reach steady-state volume, still gated by the same per-mailbox health monitoring as any ramp (§10), never a flat unlock.
  - **Unknown/fresh** (no disqualifying signal but no established track record either, or established-signal-minus-active-sending-evidence) → standard **28-day** ramp per §9 (~5/day wk1 → 25-40/day wk4).
  - **Blocklisted** at intake (hit on a public blocklist) → **reject at intake**, before any ramp begins, for both primary and non-primary domains. This sits in the deliverability lane, not the abuse-KYC queue (§20.3) — a blocklisted-but-legitimately-owned domain is simply not viable to send from yet; it is not evidence of abuse.

## 20.6 BYO-mailbox composition (the Mordy-pilot seam)

BYO mailboxes connect via **OAuth (Google Workspace/M365) or SMTP+IMAP with an app password** — the same industry-norm connect flow both Smartlead and Instantly use (`docs/research/byo-domain-verification-2026-07-14.md`) — bypassing our mailbox-provisioning path entirely; we never create or own the mailbox. Where the platform still needs to publish something (e.g. a GWS-generated DKIM selector for a *platform-provisioned* mailbox on a BYO domain), it is published as a DNS **record** under `records-to-apply` (§20.1) — never via delegation.

Domain source × mailbox source is a 2×2; not all four combinations are in scope at pilot:

| | **Platform-provisioned mailbox** | **BYO mailbox (OAuth/SMTP+IMAP connect)** |
|---|---|---|
| **Platform-provisioned domain (lookalike, fresh)** | Existing baseline flow, GA today (§8) | Out of scope — a fresh lookalike domain has no pre-existing mailbox to bring |
| **BYO domain (subdomain or primary)** | GA-target: vendor provisions a new Workspace/M365 mailbox under the customer's domain; DNS via `records-to-apply` (same mechanism as above, against a domain we don't own) | **Pilot-first (Mordy: `authorpitchdesk.com` + existing Workspace boxes)** — zero provisioning-vendor coordination needed, just an `EmailPort` OAuth/SMTP+IMAP connector; ships before the provisioned-mailbox combo because it's the smaller build |

**Mordy-pilot classification (corrected).** `authorpitchdesk.com` is a **dedicated-outreach domain, not a primary** — that half of the classification holds and its consequences follow: **no primary-domain consent screen** (§20.4 only applies to primary-domain sending) and **no primary-tier guardrails** (§20.2 doesn't apply — baseline lookalike-path guardrails, §7, invoked instead), because this domain isn't the tenant's flagship business identity. **But it is not a fresh, zero-live-infra domain, and the earlier draft's premise was wrong on that point**: it already runs Mordy's live Google Workspace mailboxes (2-3 boxes, actively sending via his current Instantly setup, ROADMAP:47/49) — a domain running live GWS publishes Google's own MX/SPF/DKIM records, which is live mail infra by §20.1's own scan definition. His existing outreach mail through this domain **is** existing mail; there's no "purchased for sending only with nothing on it yet" case here. Consequently: DNS handling for this pilot is `records-to-apply`, never `we-manage-zone` — §20.1's pre-flight scan would (correctly) hard-refuse NS delegation on this domain regardless of the primary/non-primary distinction, since it already has live infra. In practice this likely needs **no DNS management at all beyond an optional tracking record**: we OAuth-connect his already-authenticated Workspace mailboxes directly (§20.6 above, the BYO-mailbox path), so there's no mailbox-provisioning DNS to set — at most a single tracking CNAME, the same minimal ask found industry-wide (`docs/research/byo-domain-verification-2026-07-14.md`). Ramp: since it's non-primary, the full §20.5 reputation ladder applies at intake as normal (not hard-coded to any one branch) — whichever of established-good / unknown-fresh / blocklisted the actual scan finds for this specific domain.

**BYO-mailbox hard-pause scope.** For BYO mailboxes (Mordy's existing Workspace boxes), a hard-pause (§20.2, or any control-loop pause) can only stop **our engine's queued/scheduled sends through that mailbox** — we don't own the mailbox, so we cannot lock the customer out of it or block their other mail through it. This is weaker than the platform-provisioned case, where pausing the mailbox IS pausing the mailbox; stated here so the control loop's guarantee is documented accurately rather than implied to be absolute.

---

## Appendix — verified facts & sources

- Cold email is BANNED on shared-pool ESPs (SES/SendGrid/Mailgun/Postmark) → must use own SMTP or Google/MS mailboxes.
- Smartlead `Create Client` API mints isolated white-label sub-accounts returning a `cl_` scoped token (the model we replicate, now bypassed).
- Smartlead SmartSenders `place-order` API buys domains+mailboxes; vendors = Inboxkit/Zapmail/Pager.ai/Mailreef, domains via Namecheap API.
- Smartlead MCP = 113–116 tools (LeadMagic/smartlead-mcp-server); Instantly MCP = ~31–38 tools (Mar 2026).
- 2026 Gmail/Yahoo: SPF+DKIM+DMARC mandatory (non-compliant rejected at SMTP level); spam rate ≥0.30% = Gmail delivery-mitigation ineligible for 7 clean days.
- Self-serve vendor API/pricing: Inboxkit (API all plans), Zapmail (API @ $299), Maildoso, Mailforge — all public pricing, no sales call. Mailreef API gated behind email.
- Warmup: pool detection real; no major tool showed meaningful lift (independent test); private pools +20–30%.

Source URLs captured in priorart archive: `~/.claude/priorart-archive/ai-agent-controllable-cold-email-platform-2026-06-25.md`.
