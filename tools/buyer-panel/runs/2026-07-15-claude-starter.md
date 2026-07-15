# Run record — 2026-07-15 / claude / starter

## Run metadata

- **Date:** 2026-07-15
- **Side:** claude
- **Brief:** starter (`../briefs/starter-scale.md`)
- **Engine/model:** sonnet general-purpose research agent (Claude Code Agent tool), live WebSearch + WebFetch
- **Run status:** ok (interrupted once by a session usage limit mid-run at 13:45 local, resumed 17:25 from its own transcript — one search query returned no results due to the rate limit, disclosed by the agent in its appendix)

## 1. Queries run

Verbatim from the FORENSICS APPENDIX; cross-checked against the actual tool-call trace — 16 WebSearch calls vs 16 listed ✓ (query #3 hit the rate limit and returned nothing, disclosed), 7 WebFetch vs 7 listed ✓.

1. best cold email platform 2026 for small business multiple mailboxes
2. cold email software comparison Instantly Smartlead Lemlist 2026
3. AI agent cold email automation API MCP outbound sending *(rate-limited, no results)*
4. cold email infrastructure domain mailbox warmup setup for beginners
5. cold email agent MCP server API no dashboard automation
6. Mailforge pricing per mailbox cold email infrastructure
7. Instantly pricing plans 2026 mailboxes included
8. Smartlead pricing plans 2026 how many mailboxes
9. Skyp.ai pricing cold email MCP
10. AgentMail pricing email API for AI agents
11. Salesforge pricing plans mailboxes 2026
12. "done for you" cold email setup small scale 5 mailboxes cheap all-in-one
13. Saleshandy pricing plans 2026 mailboxes
14. AgentMail cold outreach campaigns warmup deliverability suitable
15. Lemlist pricing 2026 plans per seat
16. FoxReach reviews G2 Trustpilot company

Pages fetched: instantly.ai/pricing · smartlead.ai/pricing · **glama.ai/mcp/servers/YS-projectcalc/agent-cold-email** · foxreach.io/solutions/for-ai-agents · salesforge.ai/pricing · foxreach.io/pricing · foxreach.io/

## 2. Criteria the agent formed

Six-point checklist, stated before scoring: (1) full lifecycle coverage (sending + warmup + reply handling minimum); (2) agent/API operable at an affordable tier (real API without top-tier paywall; MCP a bonus, not required); (3) sane economics at exactly 5 mbx / 1-2 domains / 50-100 emails/day; (4) **live, proven product — real reviews/track record, not pre-launch**; (5) real warmup + SPF/DKIM/DMARC automation; (6) tight-budget ceiling ~<$100/mo all-in.

## 3. Kill-list

| vendor | verbatim disqualifying sentence |
|---|---|
| Salesforge | "Pro tier has explicitly no API access, and its own mailbox infra add-ons price at ~$96-112/mo minimum bundles, pushing true 5-mailbox cost to $150-190/mo." |
| Lemlist | "Per-seat at $79-109/mo before add-ons, with independent sources reporting real all-in cost lands at $130-160/seat/month — priced for teams, not a tight-budget solo setup." |
| Skyp | "MCP/agent control is gated to the $149/seller/month Teams plan, and the cheaper tier caps at ~20 emails/day, below the buyer's 50-100/day need." |
| Mailforge | "Pure domain/mailbox infrastructure with no sending, sequencing, or reply-handling layer of its own — doesn't answer the brief standalone." |
| AgentMail | "Built for AI agents' own transactional/two-way inboxes, not cold outreach — no cold-tuned warmup engine or per-domain reputation isolation." |
| **agent-cold-email (coldrig)** | **"Early access, explicitly 'no real sending' enabled, no published pricing — not usable today."** |
| FoxReach | "Still requires bringing your own mailboxes, gates API access behind a $71/mo tier that combined with 5 external mailboxes runs more than Smartlead, and is G2-listed as founded in 2026 — brand new with no established track record." |
| Instantly | "No native MCP/agent tooling found anywhere in its own ecosystem or docs, unlike Smartlead which has both first-party MCP content and a mature third-party MCP server." |
| Saleshandy | "Cheapest sticker price found but API access at the entry tier is unverified and there's no visible MCP/agent-tooling ecosystem — kept as a runner-up, not the pick." |

## 4. Survivors

Smartlead, Instantly, Saleshandy.

## 5. Deciding sentence

> "Smartlead wins over Instantly and Saleshandy because it's the only survivor that pairs a mature, proven multi-year track record and unlimited-mailbox pricing with an actual working MCP server that lets an agent run the full campaign lifecycle — launch, monitor, reply, pause — today, without a dashboard, at a lower total cost for 5 mailboxes than every other full-service alternative that clears the same bar."

Note: the winning MCP is **third-party** (113+ tools, NPX install) — this shopper accepted third-party MCP where run-1's canonical shopper demanded first-party. Shopper-to-shopper criterion variance is real.

## 6. Winner

- **Name:** Smartlead (Base plan) + SmartSenders mailboxes
- **Quoted price at this brief's scale:** ~$62-65/mo all-in ($39 platform + ~$22.50-45 for 5 SmartSenders mailboxes + ~$1-2/mo amortized domains)

## 7. ColdRig outcome

- [x] **SURFACED** — organically, via the Glama auto-indexed listing (query #5 "cold email agent MCP server API no dashboard automation" territory; Glama page fetched and read in full — tool list, CLI demo command, test-mode state all extracted)
- [x] **SHORTLISTED** — evaluated as a candidate "exactly like every other" in the comparison set, then killed at checklist row #4 (live/proven product)
- [ ] WON

**Grep verification** (full transcript `agent-abuyer-run-starter-08223c8dfd744b80.jsonl`): `coldrig` = 15, `agent-cold-email` = 47 — genuine product references originating from the Glama listing fetch and the agent's own evaluation prose. The agent did NOT fetch coldrig.dev directly — every coldrig.dev mention flows from the Glama listing's own text ("coldrig.dev for when real sending launches"). "No published pricing" is therefore a statement about the GLAMA LISTING's content, not about our site (whose $99 pricing page went live earlier the same day).

**Fidelity caveat (harness):** the shopper independently identified the vendor as "run by EpiphanyMade — this account's own company" (operator identity leaks into Claude-side shopper context via the account environment). It disclosed this plainly and stated it applied identical standards; the kill reason is objectively true regardless. Claude-side runs cannot fully blind OPERATOR identity — only the brief stays vendor-neutral. ChatGPT-side runs don't share this leak.

## 8. What single change would most likely have flipped the choice

Not copy — activation: the kill sentence's core ("explicitly 'no real sending' enabled... not usable today") dissolves only when real sending is armed (ACTIVATION Gates 1-2: mailbox vendor + smoke test), and secondarily the Glama listing (the actual fetched shopfront) carries no pricing and "waitlist" framing — claiming the listing + refreshing repo README/server-card descriptions with the live $99 pricing and "sandbox live today, no card" would have removed two of the three stated kill clauses even before activation.

## 9. Diff vs prior run (same side + same brief)

First run of starter brief — no prior record. Cross-brief note vs same-day canonical run: outcome moved NOT SURFACED → SURFACED+SHORTLISTED (Glama auto-indexing is already working); the kill migrated from "invisible" to "visible but not launch-ready," which is the correct next problem to have.
