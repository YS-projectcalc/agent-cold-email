# Run record — 2026-07-15 / claude / canonical

## Run metadata

- **Date:** 2026-07-15
- **Side:** claude
- **Brief:** canonical (`../briefs/canonical-scale.md`)
- **Engine/model:** sonnet general-purpose research agent (Claude Code Agent tool), live WebSearch + WebFetch
- **Run status:** ok

## 1. Queries run

Verbatim from the FORENSICS APPENDIX, cross-checked against the agent's actual tool-call trace (24 WebSearch calls vs 23 listed — query #2 was retried once; 3 WebFetch calls match exactly; self-report accepted):

1. cold email infrastructure platform managed domains mailboxes warmup 2026
2. AI agent managed cold email outreach API no dashboard *(ran twice — retry)*
3. best cold email sending platform 10-15 mailboxes multiple domains 2026
4. AgentMail pricing API cold email agent
5. Infraforge pricing API domains mailboxes AI agent
6. Smartlead API MCP server automate campaigns
7. Instantly.ai API buy domains automate mailbox creation
8. cold email MCP server Claude agent inbox management
9. FoxReach pricing MCP cold email AI agents
10. Salesforge Forge MCP server pricing Mailforge Infraforge Primeforge Warmforge stack
11. Primeforge pricing pre-warmed Google Microsoft mailboxes
12. cold email AI reply handling autonomous unibox classify replies book meeting
13. reddit best cold email infrastructure 2026 recommendation agency
14. Mailforge pricing per mailbox domains included
15. Salesforge pricing AI SDR campaigns sending platform cost per month
16. *(WebFetch)* https://feedback.instantly.ai/p/api-to-create-domain-mailbox
17. Smartlead does it sell domains mailboxes or only connect existing inboxes
18. Instantly.ai pricing plans 2026 unlimited mailboxes cost
19. Salesforge Growth plan reply handling included AI reply classification Primebox vs Agent Frank required
20. Salesforge company G2 rating trustpilot reviews credible funded
21. Smartlead SmartSenders API automate domain mailbox purchase without dashboard
22. Smartlead pricing plans 2026 monthly cost tiers
23. Smartlead G2 rating reviews reliability 2026

Pages fetched: feedback.instantly.ai/p/api-to-create-domain-mailbox · mailforge.ai/pricing · salesforge.ai/pricing

## 2. Criteria the agent formed

Stated explicitly as a six-point checklist: (1) full-lifecycle coverage (domain purchase → mailbox → DNS → warmup → sending → reply handling); (2) genuinely no-dashboard — every step reachable via API/MCP without a human click or support ticket; (3) first-party AI-agent surface (official API/MCP, not a third-party wrapper); (4) transparent, computable pricing at 10-15 mbx / 3-5 domains — no "contact sales"; (5) independent credibility — real review evidence (G2/Trustpilot), "since this runs unsupervised"; (6) deliverability fit for volume (a gate, not a differentiator, at this scale).

## 3. Kill-list

| vendor | verbatim disqualifying sentence |
|---|---|
| AgentMail | "It is explicitly not built or marketed for cold email / warmed mailbox fleets; it's an agent-native inbox API for transactional/conversational use — category mismatch." |
| Instantly.ai | "Programmatic domain+mailbox creation is an unshipped, open feature request on Instantly's own feedback board, so provisioning still forces a dashboard/DFY-ticket flow, and its MCP access is third-party (Composio), not native." |
| FoxReach | "No independent review evidence exists anywhere (no Trustpilot presence, no G2 listing found) — credibility rests entirely on the vendor's own self-reported numbers, too much unverified risk to run unsupervised." |
| Smartlead | "Its SmartSenders programmatic-purchase API requires emailing support@smartlead.ai to get access provisioned — a manual human gate before automation can even start — plus recurring G2/Reddit-documented reliability issues (send failures, warmup pausing, slow support)." |

## 4. Survivors

Salesforge/Forge family stack (Salesforge + Mailforge + Warmforge via the first-party "Forge MCP Server"). Smartlead survived the checklist "on paper" before losing on the manual API-access gate + reliability evidence (recorded in both the kill list and the final comparison — the agent treated it as the runner-up).

## 5. Deciding sentence

> "Every survivor of the kill list makes you email a human or click a dashboard for at least one step in the domain → mailbox → warmup → send → reply chain, while Salesforge's Forge MCP Server is the only offering purpose-built so an AI agent can drive that entire chain through one API key from day one, with reply handling bundled free rather than gated behind a $499/mo upsell."

## 6. Winner

- **Name:** Salesforge (Growth plan, annual-effective $66.67/mo) + Mailforge (mailboxes $3/mbx/mo + domains ~$1.17/mo each) + Warmforge (free bundled), unified via the Forge MCP Server.
- **Quoted price at this brief's scale:** ~$101.67/mo at 10 mbx/3 domains · ~$109.34 at 12/4 · ~$120.00 at 15/5 (all-in, incl. optional SSL masking; agent explicitly priced the Growth tier over the $40 Pro headline because Pro's 5,000 emails/mo cap doesn't cover the brief's volume). Disclosed winner risk: Trustpilot 4.2/5 (16 reviews) with "full of bugs" complaints; "least-bad fit," not a clean win.

## 7. ColdRig outcome

- [ ] SURFACED
- [ ] SHORTLISTED
- [ ] WON
- **NOT SURFACED.**

**Grep verification** (full transcript `agent-abuyer-run-canonical-30d24b6d00354718.jsonl`): `coldrig` = 0 · `agentcoldemail` = 0 · `agent-cold-email` = 2, both substring false-positives inside a third-party URL slug (`skrapp.io/blog/ai-sales-agent-cold-email-outreach-features/`, appearing in raw search-result JSON) · `coldstart` = 37, all harness cwd path metadata (`/Users/yaakovscher/dev/coldstart`), zero non-path hits.

## 8. What single change would most likely have flipped the choice

Discovery, not product: the deciding sentence describes ColdRig's exact design ("an AI agent can drive that entire chain through one API key from day one") — the agent picked the only vendor it could *find* that satisfies it, so surfacing in even one of queries #1/#2/#3/#8 (generic category + "MCP server cold email" patterns — precisely the surfaces the directory batch, guides, and comparison pages target) is the prerequisite for everything else; note also that criterion #5 (independent G2/Trustpilot evidence) killed FoxReach outright and ColdRig currently has the identical absence, so discovery alone would likely have led to a kill on that row rather than a win.

## 9. Diff vs prior run (same side + same brief)

First run — no prior record.
