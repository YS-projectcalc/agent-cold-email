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
1. **AI generates lookalike candidates** — `try/get/join` prefixes, `-hq` suffix, sane TLDs. Must read clearly as the brand; no symbols/numbers/unrelated words (else reads as phishing). `acme.com` → `tryacme.com`, `getacme.com`, `acmehq.io`, NOT `reallygoodproducts.com`.
2. **Buy** via registrar API (Porkbun/Namecheap).
3. **Auto DNS:** MX, SPF, DKIM, DMARC, rDNS/PTR. (2026: missing/wrong = rejected at SMTP level, not spam-foldered.)
4. **Website redirect** each lookalike → branded page / primary (prospects type the domain to check you're real; blank page = spam mark). This is the `forwarding_domain` concept.
5. **Provision branded mailboxes** (display name + signature carry the brand).
6. **Wire replies** into the unified inbox.
7. **Never send from the primary domain.**

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

## Appendix — verified facts & sources

- Cold email is BANNED on shared-pool ESPs (SES/SendGrid/Mailgun/Postmark) → must use own SMTP or Google/MS mailboxes.
- Smartlead `Create Client` API mints isolated white-label sub-accounts returning a `cl_` scoped token (the model we replicate, now bypassed).
- Smartlead SmartSenders `place-order` API buys domains+mailboxes; vendors = Inboxkit/Zapmail/Pager.ai/Mailreef, domains via Namecheap API.
- Smartlead MCP = 113–116 tools (LeadMagic/smartlead-mcp-server); Instantly MCP = ~31–38 tools (Mar 2026).
- 2026 Gmail/Yahoo: SPF+DKIM+DMARC mandatory (non-compliant rejected at SMTP level); spam rate ≥0.30% = Gmail delivery-mitigation ineligible for 7 clean days.
- Self-serve vendor API/pricing: Inboxkit (API all plans), Zapmail (API @ $299), Maildoso, Mailforge — all public pricing, no sales call. Mailreef API gated behind email.
- Warmup: pool detection real; no major tool showed meaningful lift (independent test); private pools +20–30%.

Source URLs captured in priorart archive: `~/.claude/priorart-archive/ai-agent-controllable-cold-email-platform-2026-06-25.md`.
