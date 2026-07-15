# Competitor comparison-page research — Skyp / FoxReach / AgentMail / Maildoso

> Frozen research record, 2026-07-15. Researched by a real-research-worker agent (web fetch + search, all claims sourced, access date 2026-07-15 throughout); persisted by the orchestrating session because the worker role has no file-write access. Feeds the WIN-THE-COMPARISON program (ROADMAP ## Open): four comparison pages in the ranked build order at the bottom. Every UNVERIFIED flag below MUST be resolved or omitted before the corresponding claim appears on a public page.

All four names verified as real, correctly-named vendors: Skyp = skyp.ai, FoxReach = foxreach.io, AgentMail = agentmail.to, Maildoso = maildoso.ai.

---

## 1. SKYP (skyp.ai)

**Pricing** (source: https://skyp.ai/pricing, fetched directly):
- Pro: **$149/mo annual** ($199/mo monthly) — "Unlimited BYO email accounts," but only **"3 managed email accounts, 1 domain,"** "~1,500 emails/mo send capacity," 500 leads/mo, "MCP, API, and webhooks" included per the pricing page itself.
- Team ("Most popular"): **$499/mo annual** ($599/mo monthly) — "10 email accounts, 5 domains," ~5,000 emails/mo, 2,000 leads/mo, automations, team reporting.
- Growth: **$1,199/mo annual** ($1,499/mo monthly) — "30 email accounts, 15 domains," ~15,000 emails/mo, 5,000 leads/mo, intent/signals data.
- Enterprise: custom.
- ⚠️ DISCREPANCY TO FLAG: a WebSearch snippet summary (not the primary page) claimed "MCP is included with every Team, Growth, and Enterprise plan" (implying NOT Pro), but the direct page fetch listed MCP under Pro's own bullet list. Trust the primary source (MCP included at Pro) but verify once more before publishing since this is a public numbers page — UNVERIFIED which is authoritative.

**Product shape**: Fully managed (domains, Google inboxes, warmup, rotation, SPF/DKIM/DMARC auto-configured) — NOT infra-only, it's a full done-for-you GTM platform: AI writes every email "from scratch, no templates," bundles LinkedIn outreach, lead database (12+ B2B sources), a "25-stage bot-filtering pipeline" for real-vs-scanner engagement metrics, reports "97.2% delivery rate vs industry avg 85–90%" (self-reported, unverified third-party). Compliance guardrails offered for "FDA, HIPAA, SEC, FINRA, FTC, or custom" — but no explicit CAN-SPAM / one-click List-Unsubscribe / RFC-8058 language found anywhere on their features page.

**Positioning**: B2B sales teams/SDRs. Verbatim: *"The outreach platform for B2B sales teams. AI-written emails, done-for-you infrastructure, LinkedIn outreach, and contact data: one platform, no stack to assemble."*

**Discoverability**: llms.txt EXISTS (https://skyp.ai/llms.txt — hub page with markdown-mirrored site, "AI-optimized" tagline, founder info Alex Shartsis CEO / Julian Gay CTO). MCP server confirmed (native, "Email MCP Server" product page) but `/.well-known/mcp/server-card.json` returned **404** — no standard discovery file despite having an MCP server.

**Vs ColdRig — honest**: Skyp genuinely wins on content/lead-gen/LinkedIn breadth (full GTM stack vs our infra-only scope) and regulated-industry compliance guardrails. ColdRig genuinely wins on cost-at-comparable-scale: Skyp's Pro gives only 3 managed mailboxes for $149 (vs our $99/5 managed mailboxes), and Team is $499/10mbx vs materially less on our curve. No RFC-8058 claim found on Skyp's site — a real gap if true, but not confirmed absent (could be undocumented).

---

## 2. FOXREACH (foxreach.io)

**Pricing** (source: https://www.foxreach.io/pricing, fetched directly):
- Free: **$0 forever**, no credit card. 200 contacts, 500 emails/mo, **"Email accounts: Unlimited"** even on free, 25 AI credits, 1 workspace.
- Starter: **$27/mo annual** ($34/mo monthly). 5,000 contacts, 10,000 emails/mo, unlimited email accounts, 2,500 AI credits.
- Growth ("Most Popular"): **$71/mo annual** ($89/mo monthly). 50,000 contacts, 100,000 emails/mo, unlimited accounts, 3 workspaces. **API access starts here** — NOT included on Free/Starter.
- Agency: **$135/mo annual** ($169/mo monthly). 200,000 contacts, 500,000 emails/mo, unlimited team, white-label, 30 workspaces.
- ⚠️ Critical structural difference: FoxReach does NOT charge per mailbox at all — "Email accounts: Unlimited" on every tier including Free. Pricing axis is contacts/email-volume, not mailbox count. A per-mailbox price comparison to ColdRig is apples-to-oranges; the comparison page needs to say this explicitly or it reads as slop.
- UNVERIFIED: whether MCP access requires Growth+ like the REST API does, or is available free — not confirmed either way from the pages fetched.

**Product shape**: Managed (connect one inbox, FoxReach handles infra centrally). Continuous automated warmup ("rotates inboxes, pools engagement, monitors reputation," active from signup). Claims **"primary inbox at rates 30-50% higher than raw SMTP through a generic ESP."** Compliance: explicitly claims **"One-click List-Unsubscribe header, DMARC-aware sending, suppression lists"** with agent-proof enforcement ("suppression lists that agents cannot override"). Access surfaces: MCP server (23 tools per their hub page), Python SDK, REST API, CLI, n8n templates, dashboard — "every surface hitting the same state machine."

**Positioning**: AI agent builders/developers specifically, not traditional sales reps. Verbatim: *"Cold email for AI agents is outreach where an AI agent - not a human - decides whom to email, what to write, and when to follow up."* / *"Under 10 minutes from signup to first agent-driven campaign."*

**Discoverability**: llms.txt EXISTS (https://www.foxreach.io/llms.txt). Has a dedicated content asset directly competing with the #1-deciding content shape the forensics doc flagged for us: **"Cold Email with Claude Code: Skills, Subagents & cold.md"** (foxreach.io/academy/claude-code-cold-email), plus framework integration pages for LangGraph, OpenAI Agents SDK, Claude Agent SDK, CrewAI, Claude Desktop. `/.well-known/mcp/server-card.json` returned **404**.

**Vs ColdRig — honest**: FoxReach's claimed **one-click List-Unsubscribe** is a direct head-on claim against our RFC-8058 positioning — this is their loudest legitimate point of parity/threat, not a gap we can wave away (word it carefully; ColdRig has its own RFC8058-overclaim caution on record — don't overclaim on our side either). FoxReach's free tier + Claude-Code-specific content is genuinely the strongest agent-native discovery competitor of the four — it's building exactly the content asset class the forensics doc says wins buyer-agent decisions. ColdRig wins on: full API/MCP access without a paywall tier (FoxReach gates API behind $71/mo Growth), and if warmup/deliverability are core to our pitch, worth a direct feature-parity table since FoxReach's claims are marketing-page-only (no third-party deliverability verification found).

⚠️ CORRECTION CANDIDATE vs forensics doc: the forensics doc characterized FoxReach as "free tier, Claude Code docs, **no infra**" — that does NOT match this pass (they explicitly run managed mailbox/domain infra with warmup). Either the buyer meant a "no BYO-domain infra"/"no owned IP pool" nuance, or the forensics summary understated FoxReach. Re-check the original buyer transcript before relying on that line.

---

## 3. AGENTMAIL (agentmail.to)

**Pricing** (source: https://www.agentmail.to/pricing, fetched directly):
- Free: **$0/mo** — 3 inboxes, 3,000 emails/mo, 100 emails/day cap, 3 GB storage, 2 webhook endpoints, 2 team members.
- Developer: **$20/mo** — 10 inboxes, 10,000 emails/mo (no daily cap), 10 GB storage, 10 custom domains, email support.
- Startup: **$200/mo** — 150 inboxes, 150,000 emails/mo, 150 GB storage, 150 custom domains, SOC 2, Slack support. ("Early-stage startups get a free month.")
- Enterprise: custom — unlimited inboxes, bulk discounts, white-label, BYO-cloud, dedicated IPs, OIDC/SAML SSO.
- Big pricing-tier gap: nothing between $20/mo (10 inboxes) and $200/mo (150 inboxes) — no ~30–50 inbox tier.

**Product shape**: Raw programmatic inbox API — **confirmed no campaign/sequence/cold-outreach layer** ("no mention of campaign management, sequence automation, or cold outreach features" across their own marketing). Matches the forensics doc's characterization exactly (the "checklist fail" that got it rejected in the real buyer run despite best pedigree). No warmup or deliverability tooling beyond standard SPF/DKIM/DMARC auth found. No unsubscribe/compliance handling found — consistent with it not being built for marketing/cold email at all.

**Positioning**: *"Email for AI Agents — give an agent its own inbox to send, receive, reply, search, and manage threaded email over MCP."* Targets developers wiring email into autonomous software agents, explicitly distinguished from transactional ESPs like SendGrid. Verbatim: *"Use AgentMail when: Your AI agent needs its own inbox. You need to receive AND send email."*

**Discoverability — best of the four**: llms.txt EXISTS (agentmail.to/llms.txt). **`/.well-known/mcp/server-card.json` EXISTS and resolves** (the only one of the four vendors confirmed to have this file) — content: *"Email for AI agents…"*, server at https://mcp.agentmail.to/mcp, OAuth2 via Clerk. A real, standards-based agent-native discovery surface, ahead of the other three on this axis.

**Credibility**: $6M seed led by General Catalyst (announced March 2026), YC S25. Best-funded/most-credentialed of the four — matches forensics doc's "best pedigree of any candidate."

**Vs ColdRig — honest**: AgentMail's Developer tier ($20/mo, 10 inboxes) is genuinely cheaper than our entry at comparable inbox count — but it's not a fair fight because AgentMail ships zero cold-outreach tooling (no sequences, no warmup, no campaigns) — the one comparison where "cheaper" is not actually competitive on capability; the page should say so plainly rather than dodge the price gap. ColdRig wins decisively on: actual cold-email product shape (sequences, warmup, deliverability). AgentMail wins on: funding/credibility signal, best-in-class MCP discovery-file hygiene.

---

## 4. MAILDOSO (maildoso.ai)

**Pricing** (source: https://maildoso.ai/pricing, fetched directly):
- Monthly: 30 mailboxes/**$75/mo** ($2.50/mbx) · 300 mailboxes/**$225/mo** ($0.75/mbx) · 1,000 mailboxes/**$499/mo** ($0.50/mbx).
- Quarterly (legacy): 32mbx+8domains/$299 per quarter (~$99/mo, $3.10/mbx) · 68mbx+17domains/$499/quarter (~$166/mo, $2.40/mbx) · 400mbx+100domains/$2,199/quarter (~$733/mo, $1.80/mbx).
- Domain registration: **$12/year**, included free only on quarterly plans; monthly-plan customers buy separately.
- Custom volumes start at **$0.49/mbx** (their own headline: "lowest prices on the market"). No-discount policy confirmed.
- Included on all plans: self-healing mailboxes, IP rotation, CAPTCHA domain protection, reputation measurement, "API and MCP access," free deliverability audits, 30-day money-back guarantee.

**Sending limits — a real caveat for the volume math**: **Google Workspace 15 cold / 25 warm-up emails per day; SMTP 15 cold / 80 warm-up per day.** Very low per-mailbox throughput — any cost comparison must normalize for total daily send volume, not just $/mailbox, or it's misleading. Burned-out mailboxes auto-suspend from campaigns for 14 days.

**Product shape**: Managed mailboxes (register or connect domains through their dashboard — not BYO-only). Deliverability tooling: inbox placement tests "every 3 days," health scores, IP rotation, link/image domain tracking. **Unsubscribe/compliance: NOT automatic.** A secondary source describes a manual per-campaign toggle ("Campaign Setting → Add unsubscribe message in all emails") — opt-in, not an automatic RFC-8058 List-Unsubscribe-Post header by default. UNVERIFIED whether their infra sends the technical header automatically regardless of that toggle.

**Positioning**: B2B cold outreach teams/agencies, budget-focused. Claims "6,000+ companies" (Apollo, Woodpecker, ZoomInfo listed — unverified beyond Maildoso's own claim). Loudest verbatim claims: *"achieve 95%+ email deliverability," "We offer the lowest prices on the market," "Mailboxes built for Just $0.49."*

**Discoverability — weakest of the four**: llms.txt **404**. `/.well-known/mcp/server-card.json` **404**. They claim "API and MCP access" on the pricing page but no public tool list, docs page, or discovery file was found confirming what that MCP surface exposes — UNVERIFIED; needs a deeper docs-site check before publishing MCP-capability claims about them.

**Vs ColdRig — honest**: Maildoso's raw per-mailbox price is genuinely, substantially cheaper than ColdRig at every tier — their real headline strength; the comparison page should not dodge it. But their 15-cold-emails/day/mailbox ceiling means matching a given daily volume needs proportionally many more mailboxes — use a normalized "cost per 100 sends/day" table rather than raw $/mailbox (buyer agents reward honest math, punish cherry-picking). ColdRig wins clearly on: agent-native discoverability (no llms.txt, no server-card) and likely on unsubscribe/compliance rigor (their approach looks manual/opt-in; their header behavior unverified).

---

## Ranking — build order by likely buyer-search volume

1. **AgentMail** — build first. Best-funded/most-credentialed (only hard "TechCrunch-tier" credibility signal of the four), the ONLY one with a working server-card.json (surfaces on the exact "MCP server cold email" query pattern the real buyer run used), and it was directly evaluated (and rejected on a checklist technicality) in the actual buyer transcript — high recurrence probability.
2. **Skyp** — build second. Appeared directly in the real buyer run's discovery queries, landed in the "worth a pilot" tier, and per the forensics doc is "the closest shape to ColdRig" — any buyer agent that finds Skyp is structurally primed to compare it to us. Has llms.txt.
3. **FoxReach** — build third, but don't underrate it: also appeared in the real buyer run, free tier lowers evaluation friction, and it's the strongest head-to-head threat on content strategy — it already publishes the "Claude Code + cold email" content pattern. Building this page also forces sharpening our own Claude-Code flagship content.
4. **Maildoso** — build fourth. Did NOT appear in the actual buyer run's raw discovery queries (added to the target list for its heavy third-party aggregator/SEO footprint — reviewed by InboxKit, Woodpecker, Puzzle Inbox, Aerosend, Salesforge's directory, ScaledMail). Surfaces via generic "cheapest cold email infrastructure" searches; weakest fit for the agent-native query pattern. Still worth building — the price gap is real and worth owning — just not urgent.

## What could NOT be verified (resolve or omit before publishing)
- Skyp: whether MCP is truly included at the Pro tier or only Team+ (conflicting sources).
- FoxReach: whether MCP access requires a paid tier like the REST API does.
- FoxReach: the "no infra" characterization in the original forensics doc doesn't match this pass — re-check the original buyer transcript's exact wording.
- Maildoso: exact MCP tool count/surface, and whether their unsubscribe header is automatic (RFC-8058-style) or only the manual per-campaign toggle found via a secondary source.
- No funding/investor/customer-count data found for Skyp or FoxReach (searched specifically, came up empty).
- G2/Trustpilot/Reddit sentiment for any of the four — not checked this pass.

## Sources (all fetched/searched 2026-07-15)
https://skyp.ai/pricing · https://skyp.ai/features · https://skyp.ai/llms.txt · https://skyp.ai/tools/email-mcp · https://www.foxreach.io/pricing · https://www.foxreach.io/solutions/for-ai-agents · https://www.foxreach.io/llms.txt · https://www.foxreach.io/academy/claude-code-cold-email · https://www.agentmail.to/pricing · https://www.agentmail.to/ · https://www.agentmail.to/llms.txt · https://www.agentmail.to/.well-known/mcp/server-card.json · https://maildoso.ai/pricing · https://maildoso.ai/ · plus WebSearch result sets per vendor (pricing/funding/compliance).
