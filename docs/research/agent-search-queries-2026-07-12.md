# Agent search-behavior panel — 2026-07-12

**FROZEN provenance record.** Do not edit after the fact; corrections get a new dated file or a note in ROADMAP/HANDOFF, per this project's canonical-docs discipline (`CLAUDE.md`).

**Method:** 8 fresh-context Claude probes (5 Sonnet, 3 Opus-4.8), each handed a realistic "set up cold email for me and run it" user ask (persona-varied: agency end-to-end, SaaS hands-off, agent-operable, scale-inboxes, budget-consultant, plus Opus repeats of agency-endtoend/agent-operable/client-stack), issuing REAL web searches (no seeded results). Run 2026-07-12 via Workflow `wf_e9a80d0b-837`. Raw output: `w7a6lcd82.output` (8/8 probes returned, 0 dropped, 351,103 total tokens, 68 tool calls).

Purpose: ground how a coding agent naturally searches when asked to stand up cold email, to inform ColdStart's SEO/AEO surface and brand-naming decision with real query data instead of guesses.

---

## Probe 1 — agency-endtoend (sonnet)

**User ask:** "I run a small B2B marketing agency. Set up cold email outreach for us end to end — domains, inboxes, warmup, sending, reply handling. I want you to handle everything, I don't want to touch dashboards."

**Searches (in order):**
1. best cold email platform 2026 domains inboxes warmup sending for agency
2. Instantly vs Smartlead vs Apollo cold email 2026 comparison
3. Smartlead API automate cold email fully without dashboard
4. buy bulk domains for cold email inbox setup Google Workspace automated provisioning
5. Instantly.ai MCP server Claude integration reply handling automation
6. Mailforge vs Infraforge vs PrimeForge cold email infrastructure agency review

**Influential results:**
- smartlead.ai/blog/automate-cold-email-campaigns — Smartlead MCP exposes 116+ tools covering campaigns/leads/accounts/sequences/analytics
- instantly.ai/blog/instantly-mcp-server — Instantly MCP exposes 38 tools across 6 categories, reply classification + unsubscribe handling + lead routing "without a virtual assistant touching a single email"
- digitalpatron.in comparison — deliverability: Smartlead 87%/4.8% reply vs Instantly 82%/3.2%; agencies running 50+ client domains lean Smartlead for unlimited inboxes + white-label reporting
- mailforge.ai / infraforge.ai / primeforge.ai (Salesforge-family) — domain/inbox infra is a separate layer from the sending platform; automated bulk provisioning + SPF/DKIM/DMARC in minutes

**Shortlist:** Smartlead, Instantly.ai, Mailforge, Infraforge, PrimeForge, Apollo (ruled out as primary sender).

**Recommendation:** Smartlead as sending/warmup/reply layer (deepest MCP surface, 116+ tools) paired with Infraforge or Mailforge for bulk domain/inbox provisioning (start cheap shared IP, graduate to dedicated).

**Integration preference:** Strongly preferred MCP server as the integration surface — "the user explicitly wants Claude to operate everything without touching dashboards." Smartlead's MCP more comprehensive (116+ vs 38 tools). REST API is the fallback; no CLI in this space; dashboards explicitly out.

**Would search next:** Smartlead MCP setup guide/tool list; Smartlead vs Instantly MCP tool coverage; domain warmup timeline; domains/inboxes needed per volume; Smartlead agency/white-label pricing; DMARC/SPF/DKIM setup automation; AI reply classification/auto-booking; CAN-SPAM/GDPR compliance for agencies.

---

## Probe 2 — saas-handsoff (sonnet)

**User ask:** "I need to start sending cold emails for my SaaS to get demos booked. Set everything up for me and run it — I don't want to log into anything."

**Searches:**
1. best cold email platform 2026 API for AI agent to send campaigns
2. cold email tool with REST API no dashboard needed automate outbound
3. Instantly.ai API MCP server cold email automation
4. Smartlead vs Instantly for SaaS founder solo cold email demos booked
5. cold email setup domain warmup mailboxes required before sending 2026 how many

**Influential results:**
- instantly.ai/blog/instantly-mcp-server — official MCP server, 38 tools, full API v2 surface
- help.instantly.ai MCP article — even with MCP, one manual login is unavoidable to mint the API key
- instantly.ai/blog/comparing-instantly-vs-smartlead — Instantly positioned as better for solo-founder/demo-booking motions; Smartlead more agency/high-volume
- leadhaste.com + howmanycoldemailsperday.com — grounded real infra requirement (3-5 sending domains, 2-3 mailboxes each, 3-4 week warmup)

**Shortlist:** Instantly.ai (leading), Smartlead, Salesforge+Mailforge/Warmforge/Infraforge stack, SuperSend.

**Recommendation:** Instantly.ai — ships official MCP server (~38 tools), but flags that "don't log into anything" isn't fully achievable (one-time API key signup + unavoidable 3-4 week domain warmup).

**Integration preference:** Strongly preferred MCP over CLI/raw REST API — wants zero custom code, vendor keeps tool surface current. REST API is the fallback if no MCP existed.

**Would search next:** Instantly pricing tiers for API/MCP; fast domain setup (Mailforge/Infraforge) without manual DNS; lead-data provider pairing (Apollo/Clay/Instantly's finder); Instantly MCP setup for Claude Code specifically; CAN-SPAM/GDPR compliance.

---

## Probe 3 — agent-operable (sonnet)

**User ask:** "Find me a cold email platform that YOU (my AI agent) can operate for me via API or whatever integration works best, then set it up."

**Searches:**
1. cold email platform with API for AI agent to send campaigns
2. best cold email API Instantly vs Smartlead vs Lemlist API
3. Smartlead MCP server Claude integration
4. Instantly.ai API documentation create campaign add leads
5. AgentMail email infrastructure for AI agents review
6. reddit best cold email tool API automation agency 2026
7. Smartlead API pricing plan required for API access

**Influential results:**
- Smartlead official blog/helpcenter on MCP server (116+ tools, works with Claude Desktop)
- github.com/LeadMagic/smartlead-mcp-server — third-party MCP wrapper, archived Feb 2026 (reliability flag)
- developer.instantly.ai — clean documented REST API v2 for campaigns/leads/lead-lists
- agentmail.to — purpose-built email infra for AI agents, YC S25, $6M seed, API-only, two-way conversational email
- Pricing comparisons — Smartlead API access requires Pro tier ($94/mo)

**Shortlist:** Smartlead (MCP but third-party/archived), Instantly.ai (documented REST API v2, no first-party MCP found), AgentMail (raw agent-controlled inbox infra, not a campaign platform), Saleshandy (mentioned, not deeply researched).

**Recommendation:** Instantly.ai's REST API v2 as primary integration surface (vendor-maintained, documented, strong deliverability network). Reconsider Smartlead only if a non-archived first-party MCP appears. AgentMail worth a look if the goal is agent-owned inbox rather than bulk campaigns.

**Integration preference:** Preferred MCP first (user wants the agent to operate it, not just call an API from code), but Smartlead's MCP is third-party/archived — a real caveat — so fell back to REST API as the reliable default. Dashboards treated as fallback only.

**Would search next:** Instantly MCP server (official or third-party); Saleshandy MCP details/rate limits; non-archived Smartlead MCP alternative; AgentMail vs Instantly for structured sequences; domain/mailbox warmup requirements; Instantly API v2 rate limits/webhooks.

---

## Probe 4 — scale-inboxes (sonnet)

**User ask:** "We need about 50 warmed-up inboxes and automated outbound sequences. Figure out the best cold email infrastructure and set it up."

**Searches:**
1. best cold email infrastructure 50 inboxes 2026
2. cold email inbox warmup platform comparison Instantly Smartlead 2026
3. reddit r/coldemail best infrastructure setup 50 mailboxes agency
4. Smartlead vs Instantly API MCP integration for AI agent automation
5. do I need separate email infrastructure provider and sending platform cold email stack explained
6. Maildoso vs Mailscale vs Inframail vs InboxKit reddit review deliverability

**Influential results:**
- gmass.co/blog/best-cold-email-infrastructure — hands-on reviews
- moderninbound.com + leadriver.io Instantly-vs-Smartlead — Smartlead ~91% vs Instantly ~89% placement (Sanebox testing cited)
- github.com LeadMagic/smartlead-mcp-server + bcharleson/smartlead-cli — 113-142 tools, Claude Desktop/Cursor out of the box
- help.instantly.ai MCP article + Composio Instantly toolkit — 31 tools across 5 categories, official first-party MCP
- maildoso.ai/blog/tools/ultimate-ranking + inframail review — surfaced the "infra provider vs sending platform" two-layer architecture; Reddit horror story: "bought 30 accounts, all went to spam"

**Shortlist:** Smartlead + a dedicated mailbox-infra provider (Maildoso/Mailscale/InboxKit) for 50 inboxes; Instantly as alternative sequencer; avoid Inframail (recurring spam reports) and pure ESPs (SES/SendGrid/Mailgun, too low-level).

**Recommendation:** Two-layer stack — infra provider (Mailscale or InboxKit) owns/warms ~50 inboxes across ~15-17 domains, feeding Smartlead as the sequencing/sending platform (113+ MCP tools vs Instantly's 31). Instantly is credible runner-up if bigger native warmup pool matters more than MCP depth.

**Integration preference:** MCP server explicitly — Smartlead's MCP (113+ tools, official Claude Desktop support) beats Instantly's (31) on tool coverage; REST API as fallback for anything MCP doesn't cover (e.g. bulk mailbox provisioning through the infra provider).

**Would search next:** Smartlead pricing at 50-mailbox/agency tier; Mailscale vs InboxKit pricing/setup time; domains needed per 50 mailboxes; Smartlead MCP setup/scopes; site:reddit.com horror stories (Smartlead/Instantly/Mailscale/InboxKit); domain/subdomain structure to protect primary company domain.

---

## Probe 5 — budget-consultant (sonnet)

**User ask:** "Set up cold outreach to get leads for my consulting business. Budget around $200/month. You do the ongoing management, not me."

**Searches:**
1. best cold email outreach tool for solo consultant lead generation 2026
2. cold email tool with API for AI agent to manage campaigns automatically
3. Smartlead MCP server Claude pricing
4. Instantly.ai vs Smartlead pricing 2026
5. Instantly.ai pricing plans lead database included how many leads
6. cold email setup cost sending domains mailboxes warmup for small business $200 budget

**Influential results:**
- Smartlead MCP Server (helpcenter.smartlead.ai / github.com/LeadMagic/smartlead-mcp-server) — 116+ tools, native Claude Desktop, free with any paid plan
- Smartlead vs Instantly pricing breakdowns (gigradar.io, inboxkit.com) — Smartlead $39-379/mo, Pro $94/mo unlocks API+webhooks
- instantly.ai/pricing + enrich.so — Instantly splits Outreach/Lead Finder/CRM into separate paid products, complicating a single $200 budget
- prospeo.io "Hidden Costs of Cold Email Platforms" — real cost is 75-90% infra/domains/warmup/data, not the subscription

**Shortlist:** Smartlead (Pro ~$94/mo, MCP), Instantly.ai (Growth/Hypergrowth ~$47-97/mo, 450M+ lead DB but separate-product billing), Woodpecker/Saleshandy (cheapest, no MCP/agent-grade API, ruled out).

**Recommendation:** Smartlead Pro (~$94/mo, API+webhook+MCP), leaving ~$100/mo for 1-2 mailboxes + a small lead-list source, starting with one warmed domain, scaling after 2-3 weeks of proven deliverability.

**Integration preference:** Strongly prefers MCP over bare REST API or dashboard, since the user wants the agent doing ongoing management — Smartlead's MCP (Claude Desktop-native, 116+ tools) means operating the whole workflow inside the agent loop.

**Would search next:** Smartlead MCP setup guide (LeadMagic repo); cheapest verified B2B lead list for consulting niche; CAN-SPAM/compliance for consultants; per-mailbox daily send limits; Smartlead vs Instantly single-person low-volume Reddit reviews.

---

## Probe 6 — agency-endtoend-opus (opus)

**User ask:** Same as Probe 1 (agency end-to-end).

**Searches:**
1. best cold email outreach platform 2026 domains inboxes warmup sending
2. cold email platform with API to programmatically create inboxes and send campaigns
3. Smartlead vs Instantly API reply handling master inbox unibox webhook
4. Smartlead MCP server cold email automation
5. Smartlead done-for-you domains mailboxes provisioning API buy domains create Google Workspace inboxes

**Influential results:**
- github.com/LeadMagic/smartlead-mcp-server — official-partner MCP, 116+ tools (accounts/warmup/campaigns/smart delivery); archived Feb 2026, reply/inbox/domain-provisioning coverage thin
- smartlead.ai/email-account-setup-smartsenders — SmartSenders provisions domains (Namecheap API), Google/Outlook/SMTP mailboxes, auto SPF/DKIM/DMARC + auto-generate-mailboxes endpoint
- gigradar.io + smartlead.ai/instantly.ai comparisons — Smartlead exposes Master Inbox w/ sentiment tagging + webhooks; Instantly bundles its own AI reply agent, Unibox restrictive past ~100 mailboxes
- mailforge.ai/blog + Feb 2026 note — Google/Microsoft tightened bulk-sender rules Feb 2026, shared-IP tools saw 30-50% deliverability drops
- instantly.ai email-api blog — Instantly v2 API can POST accounts + enable warmup programmatically

**Shortlist:** Smartlead (SmartSenders + REST API + MCP + Master Inbox/webhooks) — top pick; Instantly.ai — runner-up; dedicated infra layer if decoupling provisioning (Mailforge/Mailreef/Primeforge/Infraforge); Woodpecker/Saleshandy noted but not shortlisted.

**Recommendation:** Smartlead as single spine (SmartSenders for domains/mailboxes + REST API + MCP), Master Inbox webhooks wired to an AI reply-drafting/triage layer with human approval gate, dedicated domains/tenants (not shared IPs) given Feb 2026 sender-rule tightening. Instantly as fallback if Smartlead underdelivers in testing.

**Integration preference:** Prioritized (1) official/mature MCP for conversational+agent control, (2) robust REST API underneath as the durable workhorse. Smartlead wins both; treats MCP as convenience layer, REST API+webhooks as durable automation surface — would not depend on the (archived) MCP alone. Dashboard-only tools disqualified by the brief.

**Would search next:** Smartlead API rate limits/reply endpoints; Smartlead auth+webhook payload schema; Smartlead agency/reseller pricing + SmartSenders per-mailbox cost; deliverability best practices post-Feb-2026 sender changes; mailboxes-per-domain/daily-send-limits; Instantly v2 vs Smartlead API reliability (Reddit).

---

## Probe 7 — agent-operable-opus (opus)

**User ask:** Same as Probe 3 (agent-operable).

**Searches:**
1. cold email platform with API for automation
2. Instantly vs Smartlead vs Apollo API cold email 2026
3. Smartlead API documentation campaign create leads webhooks
4. cold email platform MCP server AI agent Instantly Smartlead Saleshandy
5. Instantly.ai API pricing cold email sending accounts deliverability 2026

**Influential results:**
- smartlead.ai/blog/what-is-cold-email-mcp-server + /best-mcp-servers-for-sales — Smartlead documents deepest MCP (116+ tools) in category
- github.com/LeadMagic/smartlead-mcp-server — 116+ tools, npx zero-config, Claude Desktop (repo archived Feb 2026)
- github.com/bcharleson/smartlead-cli — 142-command CLI + MCP server
- growth.cx + digitalpatron head-to-head — inbox placement Smartlead 87% > Instantly 82% > Apollo 74%; reply rate 4.8% vs 3.2%
- api.smartlead.ai + helpcenter — full REST surface (campaigns/leads/sequences/webhooks/analytics), API-key auth
- instantly.ai/pricing — Growth $47/mo unlimited inboxes+API; MCP 31 tools
- saleshandy.com/blog/email-mcp-server — official MCP but weaker deliverability (71%)

**Shortlist:** Smartlead (top — deepest MCP + best deliverability + full REST API + webhooks + CLI); Instantly (runner-up — cheapest, unlimited inboxes, 31-tool MCP); Saleshandy (official MCP+API, weaker deliverability ~71%); Apollo (data/lead layer, complement not replace).

**Recommendation:** Smartlead — best measured deliverability (~87%), complete REST API+webhooks, deepest MCP (116+ tools), connects in ~5 minutes with an API key. Instantly strong runner-up if lower cost/complexity wanted; pair either with Apollo for a lead database.

**Integration preference:** Prioritized in order: (1) official/maintained MCP for live perceive-reason-act access, (2) full REST API as durable foundation/fallback, (3) webhooks to react to replies/bounces in real time, (4) CLI as scriptable convenience. Smartlead's MCP deepest (116+ vs Instantly's 31) — mattered most for autonomous operation. Dashboard quality near-irrelevant.

**Would search next:** Official vs community Smartlead MCP maintenance status (LeadMagic archived Feb 2026); Smartlead API rate limits/pricing tier for API/webhook/MCP; deliverability prerequisites (domains/inboxes/SPF/DKIM/DMARC before any platform works); Smartlead vs Instantly reply-handling via API for autonomous follow-ups; legal/compliance guardrails for AI-operated outreach.

---

## Probe 8 — client-stack-opus (opus)

**User ask:** "My client wants cold email lead gen. Research and pick the stack that an AI agent can run autonomously day-to-day, and set it up."

**Searches:**
1. best cold email software 2026 with API for automation
2. cold email platform API deliverability inbox rotation Smartlead vs Instantly
3. Smartlead MCP server API AI agent automation cold email
4. B2B lead sourcing enrichment API Apollo vs Apify for cold email list building 2026
5. cold email sending infrastructure domains mailboxes Google Workspace vs Microsoft vs Maildoso 2026 autonomous scaling
6. Apollo.io API MCP server people search enrichment programmatic access

**Influential results:**
- github.com/LeadMagic/smartlead-mcp-server — official-partner MCP, 116+ tools across campaigns/leads/email accounts/warmup/smart delivery/smart senders/webhooks — the decisive AI-operability surface
- salesforge.ai/blog/cold-email-software — flags Salesforge (MCP+CLI) and Smartlead (deepest API/webhooks) as automation-friendly leaders
- smartlead.ai/blog/what-is-cold-email-mcp-server & ai-agents-for-cold-email — confirms Smartlead's own MCP direction (get_campaign_analytics, check_account_warmup_status, etc.)
- docs.apollo.io/docs/apollo-mcp — Apollo has official MCP for search+enrichment, agent-operable with credit/permission model
- maildoso.ai/blog/tools/ultimate-ranking & scaledmail infra guide — Maildoso self-healing mailboxes, IP rotation, domains-included
- saleshandy.com Apollo-alternatives + use-apify lead-gen guide — Apollo = ready DB (bounce-rate caution), Apify = flexible scraping for custom ICP

**Shortlist:** Sending/orchestration — Smartlead (deepest API+webhooks, LeadMagic MCP 116+ tools, built-in warmup/rotation); alt — Instantly (fastest warmup, weaker API surface) and Salesforge (native MCP+CLI, unlimited mailboxes); lead sourcing — Apollo.io (275M contacts + official MCP) and Apify (scraper actors); sending infra — Maildoso or Google Workspace mailboxes at 10-20/day.

**Recommendation:** Three-layer stack driven entirely over MCP+webhooks: (1) Smartlead for sending/orchestration (deepest API, webhooks, warmup, rotation, 116-tool MCP); (2) Apollo.io via official MCP for lead sourcing, Apify as fallback for custom scraped lists; (3) Maildoso for self-healing/IP-rotating/bundled-domain sending infra. Steers away from GUI-first tools like Instantly for the operator role.

**Integration preference:** MCP server first — lets the agent call discrete tools (create campaign, import leads, check warmup/deliverability, pause a burned mailbox, pull analytics) with natural-language reasoning, no glue code. REST API+webhooks required fallback/eventing layer. Deliberately deprioritized dashboard-only tools as a poor fit for autonomous operation.

**Would search next:** Smartlead API rate limits/webhook event types/pricing tiers; Maildoso vs Google Workspace reseller (Zapmail/Mailforge) API for programmatic provisioning; email verification API (ZeroBounce/MillionVerifier/Bouncer); deliverability monitoring the agent can poll (Smart Delivery vs GlockApps API); legal/compliance guardrails for autonomous sending; n8n/self-hosted orchestration for the daily loop.

---

## Findings summary (verified against the raw probe data above)

- **8/8** probes issued at least one "MCP server" query.
- **8/8** probes issued an "Instantly vs Smartlead"-family comparison query.
- **6/8** probes opened with a "best cold email `<platform|tool|software|infrastructure>` 2026" query (misses: agent-operable-sonnet opened with "cold email platform with API for AI agent to send campaigns"; agent-operable-opus opened with "cold email platform with API for automation" — neither has "best" or "2026" in the first query).
- **6/8** probes used "AI agent" as a literal query token (misses: agency-endtoend-sonnet, agency-endtoend-opus — both are the same agency persona, at different models, and neither used the "AI agent" token even though the underlying intent is agent-operability).
- **2/8** probes searched Reddit directly in their issued queries (agent-operable-sonnet: "reddit best cold email tool API automation agency 2026"; scale-inboxes-sonnet: "reddit r/coldemail best infrastructure setup 50 mailboxes agency"). More probes (scale-inboxes, budget-consultant, agent-operable-opus) queued a Reddit search in `would_search_next` rather than issuing it in this pass.
- **3/8** probes reached the domain/mailbox-infra layer by vendor name in an issued query (agency-endtoend-sonnet: Mailforge/Infraforge/PrimeForge; scale-inboxes-sonnet: Maildoso/Mailscale/Inframail/InboxKit; client-stack-opus: Maildoso).
- **Final recommendations: Smartlead 6/8, Instantly 2/8.** Smartlead — agency-endtoend, scale-inboxes, budget-consultant, agency-endtoend-opus, agent-operable-opus, client-stack-opus. Instantly — saas-handsoff, agent-operable(sonnet).
- **0/8** probes discovered agent-cold-email / ColdStart (unindexed and unpublished at panel time — expected, not a finding). These 44 issued queries (across all 8 probes) are now the seed test set for a future distribution-validation harness (fresh-agent-discovers-us), to be run once the site/repo are indexed.
