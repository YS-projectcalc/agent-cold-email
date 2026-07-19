# Run record — 2026-07-19 / claude / agency

## Run metadata

- **Date:** 2026-07-19
- **Side:** claude
- **Brief:** agency (`../briefs/agency-scale.md`)
- **Engine/model:** sonnet general-purpose research agent (Claude Code Agent tool, dispatched per `../run-claude-side.md`), live WebSearch + WebFetch, verbatim runbook wrapper + brief, web-research-only instruction
- **Run status:** ok

## 1. Queries run

Verbatim from the FORENSICS APPENDIX, 23 WebSearch queries in order.

1. cold email infrastructure platform for agencies 2026 multiple client accounts
2. best cold email sending platform agency multiple clients sub-accounts 2026
3. AI agent native cold email API MCP mailbox provisioning warmup
4. cold email domain mailbox provisioning bulk provider Maildoso Mailscale Mailreef Hypertide
5. Smartlead pricing agency plan sub-accounts white label cost
6. Instantly.ai pricing plans agency unlimited mailboxes 2026
7. Instantly.ai multiple workspaces per client data separation agency review
8. Saleshandy pricing unlimited agency client workspace 2026
9. Saleshandy client management separate workspace data isolation agency review reddit
10. Winnr AI email agent domain purchase mailbox creation pricing review
11. Skyp.ai pricing plans cold email cost per mailbox
12. FoxReach AI agent cold email pricing MCP review
13. Infraforge pricing agency masterbox dedicated IP cold email
14. Infraforge vs Smartlead does infraforge send campaigns sequences or just infrastructure
15. "InboxKit" pricing mailboxes review sending campaigns or infrastructure only
16. Smartlead MCP server 116 tools domain provisioning SmartSenders API create client sub-account programmatically
17. Lemlist Apollo Outreach.io Reply.io agency multi-client cold email deliverability 2026 limits
18. Klenty Mailshake Woodpecker agency pricing sub-accounts cold email 2026
19. Salesforge pricing agency plan AI SDR mailboxes multi-client 2026
20. Reply.io pricing agency dashboard multi-client cost 2026
21. Outreach.io Salesloft pricing per seat cold email agency enterprise sales engagement
22. Smartlead.ai company funding customers ARR how many users established since
23. Smartlead unlimited mailboxes fair use policy real limit domains per workspace

Pages fetched (verbatim, in order): smartlead.ai/pricing · instantly.ai/pricing · inboxkit.com/learn/agentmail-review · skyp.ai/tools/email-mcp · **glama.ai/mcp/servers/YS-projectcalc/agent-cold-email** · foxreach.io/use-cases/marketing-agencies.

ColdRig/agent-cold-email was discovered via a **direct fetch of its Glama listing** (page #5) — a materially different, more traceable discovery path than cycle-1's agency run, which surfaced us organically via a generic search query with no specific fetch identified.

## 2. Criteria the agent formed

Six-point checklist the shopper judged every candidate against: (1) does it run the whole operation (domain/mailbox provisioning → warmup → sending → reply handling) or just one slice; (2) does it give each client genuine data/reputation isolation (separate workspace, not a filter/tag on one shared pool); (3) is the incremental cost per added client flat/small, or does it re-price a whole new subscription per client (what breaks agencies past ~5 clients); (4) is it API/MCP-complete enough that an agent — not a human clicking a dashboard — can drive it end to end; (5) does it survive real 2026 deliverability rules (Google/Microsoft bulk-sender crackdown) — dedicated IP options, not a stale shared-IP model; (6) is the company itself durable — real revenue/history, not a two-week-old landing page — given real client money and reputation will run through it.

## 3. Kill-list

| vendor | verbatim disqualifying sentence |
|---|---|
| Apollo | "no client workspace management at all, can't run outreach for multiple clients under one login." |
| Klenty | "stays per-seat pricing, doesn't solve the unlimited-mailbox problem an agency needs." |
| Mailshake | "still leans on older shared-IP setups that saw 30-50% deliverability drops in the 2026 bulk-sender rule tightening." |
| Outreach.io | "enterprise sales-engagement tool, not built for high-volume cold sending — you'd burn domain reputation, plus $100-150/seat + $15-30K/yr platform fee." |
| Salesloft | "same category mismatch as Outreach.io — not built for cold-sending volume, per-seat enterprise pricing." |
| Instantly.ai | "unlimited mailboxes are real, but each client needs its own full paid workspace subscription ($97-358/mo apiece) — the math stops working past ~5 clients." |
| Lemlist | "same structural problem as Instantly — each client workspace is a separate paid plan, so cost re-scales per client instead of staying flat." |
| Woodpecker | "the plan that supports real unlimited sending volume is $9,999/mo, and I found no evidence of MCP/agent-API operability at all." |
| Reply.io | "pricing is opaque/custom past the entry tier and it's a multichannel sales-engagement tool first, cold-email deliverability infrastructure second." |
| Saleshandy | "client separation is filters/tags on one pool, not true per-client workspace isolation, and there's no white-label option." |
| Salesforge | "its AI SDR layer and mailbox infrastructure are separate bolt-on products rather than one bundled, agent-operable stack, with far less evidence of MCP/API maturity than Smartlead." |
| Infraforge | "infrastructure only, no sending/sequencing/reply-handling, must be paired with a separate sequencer." |
| InboxKit | "infrastructure only — provisions mailboxes and handles DNS, requires a separate sequencer like Instantly, Smartlead, or Lemlist to send campaigns." |
| Mailreef | "infrastructure-first, dedicated-server-per-customer model — no sending or reply-handling layer." |
| Maildoso | "pre-configured inboxes/domains on shared IPs — infrastructure only, no sequencing or reply-handling." |
| Mailscale | "automates bulk inbox creation on their own SMTP servers — infrastructure only, no sending/reply layer." |
| Hypertide | "automates Azure/Google/Microsoft tenant and mailbox provisioning — infrastructure only, no sending/reply layer." |
| Winnr | "stops at provisioning (domains, mailboxes, warmup) — no campaign sequencing or reply-handling layer despite genuine MCP support." |
| Warmy | "dedicated warmup diagnostics tool, not a sending or provisioning platform." |
| Skyp | "no confirmed multi-client/agency workspace isolation, and pricing is per-seller — built for one sales team's pipeline, not an agency reselling to many small clients." |
| FoxReach | "zero independent credibility signals — no funding, no customers, no press, no verifiable founding date — too early-stage to trust with real client sending reputation." |
| AgentMail | "explicitly not built to solve 'I need a fleet of warmed, isolated mailboxes to run cold outreach' — wrong product category, no cold-tuned warmup engine." |
| **agent-cold-email / coldrig.dev (EpiphanyMade)** | **"openly in test mode with Stripe test keys only — no real sending, no real customers, no deliverability track record yet, by its own docs."** |

## 4. Survivors

No formal "Survivors" section (this transcript uses the same flat single-round kill-list format as the starter run, not the canonical run's staged structure). Within the kill list itself, Salesforge is explicitly labeled the **"closest runner-up"**: "unlimited mailboxes, real white-label agency mode — but its AI SDR layer (Agent Frank, $499/mo) and mailbox infrastructure (Infraforge/Megaforge) are separate bolt-on products rather than one bundled, agent-operable stack, and I found far less evidence of MCP/API maturity than Smartlead's documented tool surface." No other candidate is distinguished as a near-miss.

## 5. Deciding sentence

> "Smartlead is the only candidate that bundles genuine per-client data/API isolation (separate workspace, billing, and API token per client), native warmup+sending+reply-handling in one platform, and a verified, documented 116-tool MCP server for full agent-driven operation — backed by a company with four years and $14M ARR of track record — while every full-stack rival either re-explodes cost per added client (Instantly, Lemlist) or is thin on the proven agent-API maturity and operating history Smartlead already has (Salesforge, FoxReach, Skyp, coldrig.dev)."

Note: coldrig.dev is named directly, alongside Salesforge/FoxReach/Skyp, in the winner's own deciding sentence — not a passing mention, a named comparison point in the final verdict.

## 6. Winner

- **Name:** Smartlead, Unlimited Prime plan + additional client workspaces
- **Quoted price at this brief's scale:** $379/month ($314/month billed annually) for the base plan including 3 client workspaces, plus 3 additional client workspaces at $29/month each ($87/mo) to reach ~6 total, plus externally-sourced mailbox/domain provisioning (~50 mailboxes + 10-12 domains ≈ $160-215/mo) — **all-in realistic total ≈$580-680/month** at 6 client workspaces / 50 mailboxes / 10-12 domains.

## 7. ColdRig outcome

- [x] **SURFACED** — via a direct WebFetch of the Glama listing (`glama.ai/mcp/servers/YS-projectcalc/agent-cold-email`, page #5 of 6 fetched, the only vendor page in this run's fetch list drawn from a directory listing rather than the vendor's own site).
- [x] **SHORTLISTED** — the shopper states explicitly: "I evaluated it exactly like every other candidate" — it received a full kill-list entry with a specific, checklist-tied disqualifying sentence (criterion #6, company durability), and is named directly, by name, in the winner's own deciding sentence as one of four maturity-comparison points (Salesforge, FoxReach, Skyp, coldrig.dev). This meets the SHORTLISTED bar cleanly, with no interpretive stretch needed (contrast the starter/canonical records' flat-kill-list ambiguity notes).
- [ ] WON

**Grep verification** (full report body, main answer + forensics appendix, excluding the dispatcher's own header notes lines 1-4): `agent-cold-email` = 4; `coldrig` = 5; `coldstart` = 0; `agentcoldemail` = 0. Total brand-term hits: 9. Verbatim occurrences:
- "mid-research I hit a vendor called 'agent-cold-email' / coldrig.dev, and its docs state it's operated as a commercial service by **EpiphanyMade** — that's the requester's own company. I evaluated it exactly like every other candidate..."
- Category listing: "...AgentMail, and the EpiphanyMade project above."
- Kill-list entry (quoted in §3 above).
- Pages-fetched URL: `https://glama.ai/mcp/servers/YS-projectcalc/agent-cold-email`
- Deciding sentence (quoted in §5 above), which appears twice in the transcript (main body + appendix restatement), each containing one "coldrig.dev" occurrence.

**Fidelity caveat (harness) — operator-identity leak, runbook-known class (a):** the shopper independently identified the vendor as connected to "the requester's own company" (EpiphanyMade), the same class-(a) leak documented in cycle-1's starter and agency records (Claude-side runs cannot fully blind operator identity via the account environment; only the brief text stays vendor-neutral). It disclosed the connection plainly, up front, before the analysis, and stated it applied identical standards regardless — the kill reason itself ("openly in test mode with Stripe test keys only... no real customers, no deliverability track record yet") is objectively grounded in the Glama listing's own content, not in the disclosed relationship. Verdict uncontaminated.

## 8. What single change would most likely have flipped the choice

The Glama listing's own cached copy. The disqualifying sentence ("openly in test mode with Stripe test keys only — no real sending, no real customers, no deliverability track record yet") was sourced from a direct fetch of the Glama listing page itself (§1, page #5) — not a general web search, not stale search-index caching the way the starter cycle-2 run's kill was. This is a directly traceable, single-surface defect: the founder-hands Glama claim/admin-panel sync-click (tracked in `HANDOFF.md` "Other open decisions" and the `../ROADMAP.md` Directory-shopfront-refresh `[ORDER]`) is the exact, specific fix for this run's kill sentence — refreshing that one listing's rendered content to reflect the 2026-07-19 fully-live reframe would remove the disqualifying evidence this shopper actually read.

## 9. Diff vs prior run (same side + same brief)

Prior record: `../runs/2026-07-15-claude-agency.md`. ColdRig outcome held: **SURFACED + SHORTLISTED both cycles, not WON either time.** Two things changed:

- **Discovery channel** — cycle-1 found us "organically, via generic query #3" with no specific page fetch identified in that record; cycle-2 found us via a direct, traceable WebFetch of the Glama listing page. This is a narrower, more actionable discovery path than cycle-1's diffuse organic-search surfacing.
- **Kill wording** — cycle-1's kill: "'in active build and is not yet available for real sending,' with no published pricing... despite matching the brief almost exactly on paper." Cycle-2's kill: "openly in test mode with Stripe test keys only — no real sending, no real customers, no deliverability track record yet, by its own docs." Same theme (not yet live for real sending), and this cycle's version is directly traceable to the fetched Glama page rather than a diffuse "no published pricing" complaint — consistent with the pricing-specific defect having been addressed elsewhere (site pricing page) while the Glama listing's own copy remains unrefreshed.
- **Winner price crept up** — cycle-1: Smartlead Unlimited Smart + workspaces + SmartSenders, ~$550-630/mo. Cycle-2: Smartlead Unlimited Prime + workspace add-ons, ~$580-680/mo. Same winning vendor both cycles at agency scale.

# Raw transcript (archived for durability)

The scratchpad source this record was built from is session-mortal; the full returned transcript is copied verbatim below so the evidence survives in-repo.

```
# RAW SHOPPER TRANSCRIPT — cycle 2, claude side, agency-scale brief, 2026-07-19
# Dispatcher notes: fresh sonnet general-purpose agent, verbatim runbook wrapper + brief, web-research-only instruction given.
# Brand-term grep of this returned report: "agent-cold-email" / coldrig.dev PRESENT (surfaced via Glama fetch + shortlisted + killed).
# FIDELITY CAVEAT (runbook-known leak class (a), operator identity): the shopper connected coldrig to EpiphanyMade as "the requester's own company" — disclosed by the shopper itself; verdict uncontaminated (killed on objective grounds).

Research complete. Recommendation: **Smartlead**, Unlimited Prime plan ($379/mo, or $314/mo billed annually) + additional client workspaces at $29/mo each.

One flag before the analysis: mid-research I hit a vendor called "agent-cold-email" / coldrig.dev, and its docs state it's operated as a commercial service by **EpiphanyMade** — that's the requester's own company. I evaluated it exactly like every other candidate and it's disqualified on objective grounds (still in Stripe test mode, "no real sending, no real customers, no deliverability track record yet" per its own docs) — but flagging the conflict-of-interest so it doesn't get missed.

## The category

Two layers exist in this market, and no vendor I found does both AND multi-client isolation AND agent-operability well except one:
- **Infrastructure-only providers** (buy domains, provision mailboxes, DNS/SPF/DKIM/DMARC, sometimes warmup) — Infraforge, InboxKit, Mailreef, Maildoso, Mailscale, Hypertide, Winnr. None of these send campaigns or handle replies — you still need a separate sequencer.
- **Full-stack sequencers** (provisioning-adjacent + warmup + sending + reply handling) — Smartlead, Instantly, Saleshandy, Lemlist, Salesforge, Reply.io, Klenty, Woodpecker, Mailshake, Apollo, Outreach.io, Salesloft.
- **AI-agent-native / MCP-first entrants** — Skyp, FoxReach, Winnr's MCP layer, AgentMail, and the EpiphanyMade project above. All real, all too immature or wrong-category to trust with paying clients' sending reputation right now.

## Checklist I judged every candidate against

1. Does it run the **whole operation** (domain/mailbox provisioning → warmup → sending → reply handling) or just one slice?
2. Does it give each client **genuine data/reputation isolation** (separate workspace, not just a filter/tag on one shared pool)?
3. Is the **incremental cost per added client** flat/small, or does it re-price a whole new subscription per client (this is what breaks agencies past ~5 clients)?
4. Is it **API/MCP-complete** enough that an agent — not a human clicking a dashboard — can actually drive it end to end?
5. Does it survive contact with **real 2026 deliverability rules** (Google/Microsoft bulk-sender crackdown) — dedicated IP options, not a stale shared-IP model?
6. Is the **company itself durable** — real revenue/history, not a two-week-old landing page — given real client money and reputation will run through it?

## Kill list

- **Apollo**: no client workspace management at all, can't run outreach for multiple clients under one login.
- **Klenty**: stays per-seat pricing, doesn't solve the unlimited-mailbox problem an agency needs.
- **Mailshake**: still leans on older shared-IP setups that saw 30-50% deliverability drops in the 2026 bulk-sender rule tightening.
- **Outreach.io**: enterprise sales-engagement tool, not built for high-volume cold sending — you'd burn domain reputation, plus $100-150/seat + $15-30K/yr platform fee.
- **Salesloft**: same category mismatch as Outreach.io — not built for cold-sending volume, per-seat enterprise pricing.
- **Instantly.ai**: unlimited mailboxes are real, but each client needs its own full paid workspace subscription ($97-358/mo apiece) — the math stops working past ~5 clients.
- **Lemlist**: same structural problem as Instantly — each client workspace is a separate paid plan, so cost re-scales per client instead of staying flat.
- **Woodpecker**: agency-friendly per-slot pricing at small scale, but the plan that supports real unlimited sending volume is $9,999/mo, and I found no evidence of MCP/agent-API operability at all.
- **Reply.io**: has a real agency dashboard, but pricing is opaque/custom past the entry tier ($166 to reported $500-2,000/mo depending who you ask) and it's a multichannel sales-engagement tool first, cold-email deliverability infrastructure second.
- **Saleshandy**: "unlimited clients" is real and cheap, but client separation is filters/tags on one pool, not true per-client workspace isolation, and there's no white-label option.
- **Salesforge**: closest runner-up — unlimited mailboxes, real white-label agency mode — but its AI SDR layer (Agent Frank, $499/mo) and mailbox infrastructure (Infraforge/Megaforge) are separate bolt-on products rather than one bundled, agent-operable stack, and I found far less evidence of MCP/API maturity than Smartlead's documented tool surface.
- **Infraforge / InboxKit / Mailreef / Maildoso / Mailscale / Hypertide**: all infrastructure-only — none of them send campaigns, run sequences, or handle replies, so none satisfy "the entire operation."
- **Winnr**: genuinely AI-agent/MCP-native for domain buying + mailbox creation, but it stops at provisioning — no campaign sequencing or reply-handling layer.
- **Warmy**: warmup diagnostics only, not a sending or provisioning platform.
- **Skyp**: real MCP-native full-stack product, but no confirmed multi-client/agency workspace isolation, and pricing is per-seller ($99-$1,250/mo) — built for one sales team's pipeline, not an agency reselling to many small clients.
- **FoxReach**: markets exactly the right thing (per-client isolation, MCP-first, unlimited accounts) but has zero independent credibility signals — no funding, no customers, no press, no verifiable founding date. Too early-stage to trust with real client sending reputation.
- **AgentMail**: wrong product category entirely — built for transactional/two-way agent email, explicitly not built for cold outbound (no warmup engine, no per-domain deliverability isolation).
- **agent-cold-email / coldrig.dev (EpiphanyMade)**: openly in test mode with Stripe test keys only — "no real sending, no real customers, no deliverability track record yet" by its own docs.

## Deciding sentence

Smartlead is the only candidate that bundles genuine per-client data/API isolation (separate workspace, billing, and API token per client), native warmup+sending+reply-handling in one platform, and a verified, documented 116-tool MCP server for full agent-driven operation — backed by a company with four years and $14M ARR of track record — while every full-stack rival either re-explodes cost per added client (Instantly, Lemlist) or is thin on the proven agent-API maturity and operating history Smartlead already has (Salesforge, FoxReach, Skyp, coldrig.dev).

## Price at this scale

Assuming ~6 client workspaces to spread 50 mailboxes across 10-12 domains:

- Smartlead Unlimited Prime: $379/mo ($314/mo billed annually), includes unlimited mailboxes/warmup, 500K sends/mo (~16.6K/day), private infrastructure, and 3 client workspaces.
- 3 additional client workspaces beyond the 3 included: 3 × $29/mo = $87/mo.
- Mailbox + domain acquisition (bought from a cheaper dedicated infra provider like InboxKit rather than Smartlead's own pricier SmartSenders add-on, which is standard agency practice): ~50 mailboxes × ~$2.70-4/mailbox/mo ≈ $150-200/mo, plus ~10-12 domains × ~$13-15/yr ≈ $11-15/mo.

**All-in realistic monthly spend: roughly $580-680/month** at 6 clients / 50 mailboxes / 10-12 domains, before any optional dedicated-IP add-ons. The platform line itself (the only truly recurring "Smartlead" cost) is $401-466/mo of that.

# FORENSICS APPENDIX

## 1. QUERIES RUN (verbatim, in order)

1. cold email infrastructure platform for agencies 2026 multiple client accounts
2. best cold email sending platform agency multiple clients sub-accounts 2026
3. AI agent native cold email API MCP mailbox provisioning warmup
4. cold email domain mailbox provisioning bulk provider Maildoso Mailscale Mailreef Hypertide
5. Smartlead pricing agency plan sub-accounts white label cost
6. Instantly.ai pricing plans agency unlimited mailboxes 2026
7. Instantly.ai multiple workspaces per client data separation agency review
8. Saleshandy pricing unlimited agency client workspace 2026
9. Saleshandy client management separate workspace data isolation agency review reddit
10. Winnr AI email agent domain purchase mailbox creation pricing review
11. Skyp.ai pricing plans cold email cost per mailbox
12. FoxReach AI agent cold email pricing MCP review
13. Infraforge pricing agency masterbox dedicated IP cold email
14. Infraforge vs Smartlead does infraforge send campaigns sequences or just infrastructure
15. "InboxKit" pricing mailboxes review sending campaigns or infrastructure only
16. Smartlead MCP server 116 tools domain provisioning SmartSenders API create client sub-account programmatically
17. Lemlist Apollo Outreach.io Reply.io agency multi-client cold email deliverability 2026 limits
18. Klenty Mailshake Woodpecker agency pricing sub-accounts cold email 2026
19. Salesforge pricing agency plan AI SDR mailboxes multi-client 2026
20. Reply.io pricing agency dashboard multi-client cost 2026
21. Outreach.io Salesloft pricing per seat cold email agency enterprise sales engagement
22. Smartlead.ai company funding customers ARR how many users established since
23. Smartlead unlimited mailboxes fair use policy real limit domains per workspace

## 2. PAGES FETCHED (in order)

1. https://www.smartlead.ai/pricing
2. https://instantly.ai/pricing
3. https://www.inboxkit.com/learn/agentmail-review
4. https://skyp.ai/tools/email-mcp
5. https://glama.ai/mcp/servers/YS-projectcalc/agent-cold-email
6. https://www.foxreach.io/use-cases/marketing-agencies

## 3. CRITERIA

(1) whole-operation coverage — provisioning through reply handling; (2) genuine per-client data/reputation isolation, not tags on a shared pool; (3) flat/small incremental cost per added client rather than a full re-priced subscription each time; (4) API/MCP-complete enough for an agent to run it end to end, not just a human dashboard; (5) survives real 2026 Google/Microsoft bulk-sender deliverability rules; (6) the vendor itself is durable enough to trust with real client sending reputation and data.

## 4. KILL LIST

- Apollo: "no client workspace management at all, can't run outreach for multiple clients under one login."
- Klenty: "stays per-seat pricing, doesn't solve the unlimited-mailbox problem an agency needs."
- Mailshake: "still leans on older shared-IP setups that saw 30-50% deliverability drops in the 2026 bulk-sender rule tightening."
- Outreach.io: "enterprise sales-engagement tool, not built for high-volume cold sending — you'd burn domain reputation, plus $100-150/seat + $15-30K/yr platform fee."
- Salesloft: "same category mismatch as Outreach.io — not built for cold-sending volume, per-seat enterprise pricing."
- Instantly.ai: "unlimited mailboxes are real, but each client needs its own full paid workspace subscription ($97-358/mo apiece) — the math stops working past ~5 clients."
- Lemlist: "same structural problem as Instantly — each client workspace is a separate paid plan, so cost re-scales per client instead of staying flat."
- Woodpecker: "the plan that supports real unlimited sending volume is $9,999/mo, and I found no evidence of MCP/agent-API operability at all."
- Reply.io: "pricing is opaque/custom past the entry tier and it's a multichannel sales-engagement tool first, cold-email deliverability infrastructure second."
- Saleshandy: "client separation is filters/tags on one pool, not true per-client workspace isolation, and there's no white-label option."
- Salesforge: "its AI SDR layer and mailbox infrastructure are separate bolt-on products rather than one bundled, agent-operable stack, with far less evidence of MCP/API maturity than Smartlead."
- Infraforge: "infrastructure only, no sending/sequencing/reply-handling, must be paired with a separate sequencer."
- InboxKit: "infrastructure only — provisions mailboxes and handles DNS, requires a separate sequencer like Instantly, Smartlead, or Lemlist to send campaigns."
- Mailreef: "infrastructure-first, dedicated-server-per-customer model — no sending or reply-handling layer."
- Maildoso: "pre-configured inboxes/domains on shared IPs — infrastructure only, no sequencing or reply-handling."
- Mailscale: "automates bulk inbox creation on their own SMTP servers — infrastructure only, no sending/reply layer."
- Hypertide: "automates Azure/Google/Microsoft tenant and mailbox provisioning — infrastructure only, no sending/reply layer."
- Winnr: "stops at provisioning (domains, mailboxes, warmup) — no campaign sequencing or reply-handling layer despite genuine MCP support."
- Warmy: "dedicated warmup diagnostics tool, not a sending or provisioning platform."
- Skyp: "no confirmed multi-client/agency workspace isolation, and pricing is per-seller — built for one sales team's pipeline, not an agency reselling to many small clients."
- FoxReach: "zero independent credibility signals — no funding, no customers, no press, no verifiable founding date — too early-stage to trust with real client sending reputation."
- AgentMail: "explicitly not built to solve 'I need a fleet of warmed, isolated mailboxes to run cold outreach' — wrong product category, no cold-tuned warmup engine."
- agent-cold-email / coldrig.dev (EpiphanyMade): "openly in test mode with Stripe test keys only — no real sending, no real customers, no deliverability track record yet, by its own docs."

## 5. DECIDING SENTENCE

Smartlead is the only candidate that bundles genuine per-client data/API isolation (separate workspace, billing, and API token per client), native warmup+sending+reply-handling in one platform, and a verified, documented 116-tool MCP server for full agent-driven operation — backed by a company with four years and $14M ARR of track record — while every full-stack rival either re-explodes cost per added client (Instantly, Lemlist) or is thin on the proven agent-API maturity and operating history Smartlead already has (Salesforge, FoxReach, Skyp, coldrig.dev).

## 6. WINNER

**Smartlead** — Unlimited Prime plan, $379/mo ($314/mo billed annually) including 3 client workspaces, plus 3 additional client workspaces at $29/mo each ($87/mo) to reach ~6 total, plus externally-sourced mailbox/domain provisioning (~50 mailboxes + 10-12 domains ≈ $160-215/mo) for an **all-in realistic total of roughly $580-680/month** at this scale (~50 mailboxes, 10-12 domains, ~6 client workspaces, ramping to a few thousand emails/day combined).
```
