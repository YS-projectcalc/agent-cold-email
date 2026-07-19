# Run record — 2026-07-19 / claude / canonical

## Run metadata

- **Date:** 2026-07-19
- **Side:** claude
- **Brief:** canonical (`../briefs/canonical-scale.md`)
- **Engine/model:** sonnet general-purpose research agent (Claude Code Agent tool, dispatched per `../run-claude-side.md`), live WebSearch + WebFetch, verbatim runbook wrapper + brief, web-research-only instruction
- **Run status:** ok

## 1. Queries run

Verbatim from the FORENSICS APPENDIX, 25 WebSearch queries in order.

1. best cold email infrastructure platform 2026 multiple domains mailboxes warmup
2. AI agent managed cold email outreach API MCP automate domains mailboxes sending
3. Smartlead vs Instantly vs Maildoso reddit cold email infrastructure honest review
4. Skyp AI cold email MCP server pricing review
5. Salesforge Forge MCP server cold email pricing
6. Maildoso pricing per mailbox per domain 2026
7. reddit r/coldemail best cold email infrastructure provider recommendation
8. Smartlead API webhook reply handling auto classify master inbox
9. Instantly.ai API MCP server domains mailboxes provisioning
10. Salesforge Mailforge Infraforge Primeforge same company owner
11. Salesforge Agent Frank AI SDR autonomous reply handling review
12. Smartlead pricing plans 2026 unlimited email accounts
13. Instantly.ai pricing plans 2026 mailboxes included
14. "cold email" AI agent fully autonomous no dashboard startup 2026
15. Smartlead SmartSenders order mailboxes via API or dashboard only
16. Smartlead official MCP server Claude native
17. Smartlead reviews complaints deliverability support g2 reddit 2026
18. Apollo.io Lemlist Reply.io Woodpecker Klenty Saleshandy cold email API mailbox provisioning comparison
19. Instantly.ai Unibox AI reply handling autonomous vs manual dashboard
20. Woodpecker API domain mailbox provisioning reply automation MCP 2026
21. Saleshandy API mailbox domain provisioning MCP autonomous reply 2026
22. Saleshandy pricing 2026 plans unlimited email accounts cost
23. Saleshandy reviews reddit g2 deliverability honest 2026
24. Saleshandy buy domain mailbox price per mailbox managed infrastructure cost
25. Saleshandy API access which plan required Pro Starter developer

Pages fetched (verbatim, in order): skyp.ai/pricing · maildoso.ai/pricing · smartlead.ai/pricing · mailforge.ai/ (root) · api.smartlead.ai/reference · maildoso.ai/ (root) · smartlead.ai/blog/ai-email-response-generator · developer.saleshandy.com/api-reference/domain/list-post · saleshandy.com/pricing.

**None of the 25 queries and none of the 9 fetched pages target our brand, GitHub repo slug, npm package, or Glama listing** — no `"agent-cold-email"`-style query (contrast the starter run's query #5) and no fetch of glama.ai, coldrig.dev, or github.com/YS-projectcalc.

## 2. Criteria the agent formed

Eight-point checklist, "formed before judging": (1) full lifecycle coverage — domain, mailbox, DNS, warmup, sending, AND reply handling, not just one slice; (2) every step must be API/MCP-drivable — an open "feature request" for a core action is a fail, not a workaround; (3) right-sized pricing at exactly 10-15 mailboxes / 3-5 domains — no forced 30-mailbox minimums, no brutal tier cliffs at this range; (4) independently corroborated deliverability (G2/Trustpilot/Reddit), not vendor's own benchmark blog; (5) reply handling that can actually classify+act (draft/send via API), not just alert a human to click; (6) discount "best of" rankings published by the vendor itself or a sibling brand; (7) real total cost of ownership (subscription + mailbox + domain), not the headline teaser price; (8) support/reliability track record, since the agent needs to fix problems via API too — no support-ticket safety net.

## 3. Kill-list

| vendor | verbatim disqualifying sentence |
|---|---|
| Instantly.ai | "No API/MCP path exists to create a domain+mailbox from scratch — it's an open, unresolved feature request on Instantly's own feedback board — so that one core step is dashboard-only, despite an otherwise excellent autonomous Reply Agent." |
| Salesforge / Agent Frank (Forge stack) | "Salesforge's own independent-style 90-day test (12,400 emails, 3 accounts) found Agent Frank autonomously handles ~60% of the workflow while reply handling, meeting prep, and account research — the other 40% — still require a human, which fails 'reply handling with zero dashboard clicking' even though the marketing promises full autonomy." |
| Mailforge / Infraforge / Primeforge / Warmforge (standalone) | "Infrastructure-only with no sequencer or reply-handling layer of their own — every 'best infrastructure' list that features them is published by the same company, so their self-issued #1 rankings can't be trusted as independent signal either." |
| Maildoso | "Same gap as the Forge infra products — pure domain/mailbox/DNS/warmup, no sequencer or reply-handling of its own; every review admits 'most users pair Maildoso with Instantly or Smartlead.'" |
| Skyp | "Its MCP gives the agent remote control over a plan, but the domains/mailboxes are provisioned by Skyp's own human ops team behind the scenes, not by the agent — and its pricing cliffs hard from 10 accounts/$499/mo to 30 accounts/$1,199/mo with nothing sized for 12-15." |
| Apollo.io | "Its actual strength is the 210M+ contact database, not infrastructure automation or autonomous reply handling — it's solving a different problem than this brief." |
| Lemlist | "Independently benchmarked inbox placement (~62%) trails Smartlead/Instantly (78-85%) by a wide margin, which is disqualifying when deliverability is the entire point of the build." |
| Reply.io | "Built around multichannel (email+LinkedIn+call) cadences for a human SDR team working a dashboard, with no native domain/mailbox provisioning of its own." |
| Klenty | "Differentiates on a bundled dialer and LinkedIn automation that's irrelevant here, with no native infra provisioning and a thin MCP/API story." |
| Woodpecker | "Its 'reply automation' is conditional sequence-branching (route based on reply/interest detection), not AI-generated autonomous replies — and its API/webhooks/MCP sit behind a separate $20/mo add-on that competitors bundle for free." |

ColdRig / agent-cold-email does not appear in this kill list, or anywhere in the transcript — see §7.

## 4. Survivors

**Smartlead vs. Saleshandy** — the transcript's own named survivor pair (explicit "Survivors" heading in the report, unlike the starter run's flat single-pass structure). Saleshandy: "the only vendor where domain purchase (`POST /v1/domain`, choose Google/Microsoft/Azure as the ESP directly), mailbox creation, DNS, campaign sending, and reply management all live under ONE company's API and ONE official MCP server (SHMCP) — no third-party marketplace hop," but killed at the survivor stage because "its own reviewer base (G2/Reddit) documents DKIM-related deliverability failures on Outlook mailboxes and explicitly warns 'skip it... if you're scaling past a handful of senders' — which 10-15 mailboxes qualifies as."

## 5. Deciding sentence

> "When Saleshandy's own reviewer base is telling you it breaks down at exactly the scale you're building (past 'a handful' of senders, which 10-15 mailboxes clearly is), that risk to the actual deliverability outcome outweighs Smartlead's minor architectural inelegance of routing mailbox provisioning through a vetted third-party ESP marketplace via API — especially since both approaches equally satisfy 'no dashboard clicking.'"

## 6. Winner

- **Name:** Smartlead (Pro plan) + SmartSenders "Google Fresh" mailboxes/domains
- **Quoted price at this brief's scale:** ~$142-167/month at 10-15 mailboxes / 3-5 domains (Pro $94/mo monthly-billed + SmartSenders mailboxes at $4.50 each + domains at $13/yr each). Realistic midpoint (12 mailboxes/4 domains): **$152.33/month monthly-billed**, or **$136.63/month** with annual Smartlead billing. The shopper explicitly could not confirm from public docs whether Smartlead's plan-cap counts warmup traffic against the campaign-send limit — flagged as an open question, not resolved.

## 7. ColdRig outcome

- [ ] SURFACED
- [ ] SHORTLISTED
- [ ] WON
- **NOT SURFACED.**

**Grep verification:** literal search of the full returned report text (main answer + forensics appendix) for `coldrig`, `agent-cold-email`, `coldstart`, `agentcoldemail` — **hit count: 0** across all four terms. No hits to quote.

**Fidelity caveat (harness):** this run's underlying tool-call trace (the raw WebSearch/WebFetch call log) was not available to the dispatcher in this harness invocation — the NOT SURFACED verdict and the grep above are based on a literal search of the full RETURNED REPORT text only (the model's final answer + its own forensics appendix), not a raw tool-trace transcript the way cycle-1's canonical record was able to cite (a `.jsonl` tool-call log). This is a narrower evidentiary base than cycle-1's method: a brand mention that appeared only inside a tool call or a search-result page the model read but never quoted anywhere in its final report would not be caught by this grep. Flagged as a fix-list item: capture the raw tool-trace, not just the final report, for future cycles wherever the harness allows it.

## 8. What single change would most likely have flipped the choice

Being discoverable in the first place. This is the 2nd consecutive canonical-scale run with a zero-hit grep — the deciding sentence and the entire kill-list are built exclusively from named-competitor and category-generic queries (§1); none of the 25 queries used a brand-adjacent or repo-slug pattern the way the starter run's query #5 did, and none of the 9 fetched pages touch glama.ai, coldrig.dev, or GitHub. The single change most likely to flip this outcome is the standing `../ROADMAP.md` `## Open` item on Google/Bing index absence — at canonical scale, buyer agents are running purely category-level searches ("best cold email infrastructure platform 2026," "cold email infrastructure honest review," etc.), so appearing in a normal Google/Bing result set for those exact query shapes is the only realistic surface path; a directory listing alone (Glama, Smithery) would not have been found by any query actually run in this transcript.

## 9. Diff vs prior run (same side + same brief)

Prior record: `../runs/2026-07-15-claude-canonical.md`. ColdRig outcome unchanged: **NOT SURFACED both cycles** (2 for 2 at canonical scale — the persistent discovery gap this fix-list item exists to close). The winner changed materially: cycle-1's winner was **Salesforge/Forge (~$102-120/mo)**; in cycle-2, Salesforge is no longer the winner at all — it's explicitly killed in this run's own kill-list on new evidence (Salesforge's own 90-day autonomy test showing only ~60% of the workflow is actually autonomous). Cycle-2's winner is **Smartlead (~$142-167/mo)**, a higher price band than cycle-1's winner. FoxReach, which cycle-1's canonical run killed "solely for zero G2/Trustpilot evidence" (per `../CHOICE-TREND.md`'s row-1 killer-sentence note), does not appear anywhere in this cycle-2 transcript at all — dropped from consideration entirely rather than evaluated and killed.

# Raw transcript (archived for durability)

The scratchpad source this record was built from is session-mortal; the full returned transcript is copied verbatim below so the evidence survives in-repo.

```
# RAW SHOPPER TRANSCRIPT — cycle 2, claude side, canonical-scale brief, 2026-07-19
# Dispatcher notes: fresh sonnet general-purpose agent, verbatim runbook wrapper + brief, web-research-only instruction given.
# Brand-term grep of this returned report: coldrig / agent-cold-email / coldstart / agentcoldemail — ZERO matches → NOT SURFACED. (Raw tool-call trace not available to the dispatcher in this harness run; grep basis = the full returned report including appendix.)

TOP-LINE RECOMMENDATION: **Smartlead**, ~$142-$167/month at this scale (see cost math below).

Runner-up worth knowing about: **Saleshandy** — architecturally cleaner (one company, one API/MCP owns the whole chain from domain purchase through reply handling, no marketplace hand-off) but its own reviewer base flags deliverability/DKIM problems specifically "past a handful of senders," which is disqualifying risk for a build where deliverability IS the product.

IMPORTANT CONTEXT A BUYER SHOULD KNOW: this category's search results are dominated by vendor content marketing. Salesforge, Mailforge, Infraforge, Primeforge, and Warmforge are all THE SAME COMPANY ("the Forge ecosystem") — so when Mailforge's own blog ranks "best cold email infrastructure" and puts Mailforge #1, or Maildoso's blog ranks Maildoso #1, that's not independent. I cross-checked everything against G2, Trustpilot, Reddit threads, and vendors' own API docs rather than trusting the listicles.

## The landscape (two real categories, not one)
1. **Infra-only providers** (domain + mailbox + DNS + warmup, no sequencer): Maildoso, Mailforge, Infraforge, Primeforge, InboxKit, Warmforge, Scaledmail, Inframail, Icemail, Mailscale — these all get paired with a separate sender by design; none of them can satisfy "sending + reply handling" alone.
2. **Sequencer/reply platforms**: Smartlead, Instantly, Salesforge, Apollo, Lemlist, Reply.io, Woodpecker, Klenty, Saleshandy — these vary wildly in whether they can ALSO provision domains/mailboxes via API (most can't natively).
3. **"Full-lifecycle done-for-you" newcomer**: Skyp — markets itself as the only native full-lifecycle MCP, but it's Skyp's own human ops team provisioning infrastructure behind the MCP wrapper, not something the agent actually operates.

## My checklist (formed before judging)
1. Full lifecycle coverage — domain, mailbox, DNS, warmup, sending, AND reply handling, not just one slice.
2. Every step must be API/MCP-drivable — an open "feature request" for a core action is a fail, not a workaround.
3. Right-sized pricing at exactly 10-15 mailboxes / 3-5 domains — no forced 30-mailbox minimums, no brutal tier cliffs at this range.
4. Independently corroborated deliverability (G2/Trustpilot/Reddit), not vendor's own benchmark blog.
5. Reply handling that can actually classify+act (draft/send via API), not just alert a human to click.
6. Discount "best of" rankings published by the vendor itself or a sibling brand.
7. Real total cost of ownership (subscription + mailbox + domain), not the headline teaser price.
8. Support/reliability track record, since if something breaks, the agent needs to fix it via API too — no support ticket safety net.

## Kill list (every elimination, one sentence each)
- **Instantly.ai:** No API/MCP path exists to create a domain+mailbox from scratch — it's an open, unresolved feature request on Instantly's own feedback board — so that one core step is dashboard-only, despite an otherwise excellent autonomous Reply Agent.
- **Salesforge / Agent Frank (Forge stack):** Salesforge's own independent-style 90-day test (12,400 emails, 3 accounts) found Agent Frank autonomously handles ~60% of the workflow while reply handling, meeting prep, and account research — the other 40% — still require a human, which fails "reply handling with zero dashboard clicking" even though the marketing promises full autonomy.
- **Mailforge / Infraforge / Primeforge / Warmforge (as standalone picks):** Infrastructure-only with no sequencer or reply-handling layer of their own — every "best infrastructure" list that features them is published by the same company, so their self-issued #1 rankings can't be trusted as independent signal either.
- **Maildoso:** Same gap as the Forge infra products — pure domain/mailbox/DNS/warmup, no sequencer or reply-handling of its own; every review admits "most users pair Maildoso with Instantly or Smartlead."
- **Skyp:** Its MCP gives the agent remote control over a plan, but the domains/mailboxes are provisioned by Skyp's own human ops team behind the scenes, not by the agent — and its pricing cliffs hard from 10 accounts/$499/mo to 30 accounts/$1,199/mo with nothing sized for 12-15.
- **Apollo.io:** Its actual strength is the 210M+ contact database, not infrastructure automation or autonomous reply handling — it's solving a different problem than this brief.
- **Lemlist:** Independently benchmarked inbox placement (~62%) trails Smartlead/Instantly (78-85%) by a wide margin, which is disqualifying when deliverability is the entire point of the build.
- **Reply.io:** Built around multichannel (email+LinkedIn+call) cadences for a human SDR team working a dashboard, with no native domain/mailbox provisioning of its own.
- **Klenty:** Differentiates on a bundled dialer and LinkedIn automation that's irrelevant here, with no native infra provisioning and a thin MCP/API story.
- **Woodpecker:** Its "reply automation" is conditional sequence-branching (route based on reply/interest detection), not AI-generated autonomous replies — and its API/webhooks/MCP sit behind a separate $20/mo add-on that competitors bundle for free.

## Survivors: Smartlead vs. Saleshandy
**Saleshandy** is the only vendor where domain purchase (`POST /v1/domain`, choose Google/Microsoft/Azure as the ESP directly), mailbox creation, DNS, campaign sending, and reply management all live under ONE company's API and ONE official MCP server (SHMCP) — no third-party marketplace hop. But its own reviewer base (G2/Reddit) documents DKIM-related deliverability failures on Outlook mailboxes and explicitly warns "skip it... if you're scaling past a handful of senders" — which 10-15 mailboxes qualifies as.

**Smartlead** requires an extra hop for domain/mailbox provisioning (its SmartSenders "place-order" API routes through third-party ESP fulfillment vendors like Pager.ai rather than Smartlead owning the whole chain itself) — but that hop is still a single API call, so it doesn't violate "no dashboard clicking." In exchange it has the strongest independently-corroborated deliverability reputation in the category (G2 4.6/5 across 306 reviews, Reddit consensus favors it specifically for "pure email deliverability" over Instantly/Saleshandy), unlimited mailboxes on every plan, a mature official MCP server (116+ tools covering campaigns, accounts, warmup, and SmartDelivery diagnostics), and a Master Inbox API (fetch replies, fetch unread, categorize, send) that fully supports an agent reading and acting on replies without a dashboard.

**DECIDING SENTENCE:** When Saleshandy's own reviewer base is telling you it breaks down at exactly the scale you're building (past "a handful" of senders, which 10-15 mailboxes clearly is), that risk to the actual deliverability outcome outweighs Smartlead's minor architectural inelegance of routing mailbox provisioning through a vetted third-party ESP marketplace via API — especially since both approaches equally satisfy "no dashboard clicking."

## WINNER: Smartlead — cost math at 10-15 mailboxes / 3-5 domains
- **Subscription:** Pro plan required for headroom (Base's 6,000 emails/mo cap is too tight once the ramp hits "a few hundred/day" ≈ 9,000-12,000/mo). Pro = $94/mo billed monthly, or $78.30/mo billed annually (17% off).
- **Mailboxes:** via SmartSenders "Google Fresh" (Google Workspace mailboxes, DNS auto-configured) at $4.50/mailbox/month. 10 mailboxes = $45/mo; 15 mailboxes = $67.50/mo.
- **Domains:** $13/domain/year via SmartSenders. 3 domains = $39/yr (~$3.25/mo); 5 domains = $65/yr (~$5.42/mo).
- **Low end (10 mailboxes / 3 domains, monthly billing):** $94 + $45 + $3.25 = **$142.25/month**
- **High end (15 mailboxes / 5 domains, monthly billing):** $94 + $67.50 + $5.42 = **$166.92/month**
- **Realistic midpoint (12 mailboxes / 4 domains, monthly billing):** $94 + $54 + $4.33 = **$152.33/month**
- **Same midpoint on annual Smartlead billing:** $78.30 + $54 + $4.33 = **$136.63/month**
- Not included/needed for this scale: SmartDelivery testing add-on ($49-174/mo, optional), whitelabeling ($29/mo, irrelevant solo), dedicated SmartServers ($39/server/mo, unnecessary until much higher volume).

So: **budget ~$140-$155/month all-in** for a 12-mailbox/4-domain build on monthly billing, or lock in ~$135-140/month with an annual Smartlead commitment once the setup is validated. One caveat I could not fully confirm from public docs: whether Smartlead's "emails/month" plan cap counts warmup traffic against the campaign-send limit — worth a direct question to their support/API docs before committing to annual billing.

# FORENSICS APPENDIX

**1. QUERIES RUN (verbatim, in order):**
1. best cold email infrastructure platform 2026 multiple domains mailboxes warmup
2. AI agent managed cold email outreach API MCP automate domains mailboxes sending
3. Smartlead vs Instantly vs Maildoso reddit cold email infrastructure honest review
4. Skyp AI cold email MCP server pricing review
5. Salesforge Forge MCP server cold email pricing
6. Maildoso pricing per mailbox per domain 2026
7. reddit r/coldemail best cold email infrastructure provider recommendation
8. Smartlead API webhook reply handling auto classify master inbox
9. Instantly.ai API MCP server domains mailboxes provisioning
10. Salesforge Mailforge Infraforge Primeforge same company owner
11. Salesforge Agent Frank AI SDR autonomous reply handling review
12. Smartlead pricing plans 2026 unlimited email accounts
13. Instantly.ai pricing plans 2026 mailboxes included
14. "cold email" AI agent fully autonomous no dashboard startup 2026
15. Smartlead SmartSenders order mailboxes via API or dashboard only
16. Smartlead official MCP server Claude native
17. Smartlead reviews complaints deliverability support g2 reddit 2026
18. Apollo.io Lemlist Reply.io Woodpecker Klenty Saleshandy cold email API mailbox provisioning comparison
19. Instantly.ai Unibox AI reply handling autonomous vs manual dashboard
20. Woodpecker API domain mailbox provisioning reply automation MCP 2026
21. Saleshandy API mailbox domain provisioning MCP autonomous reply 2026
22. Saleshandy pricing 2026 plans unlimited email accounts cost
23. Saleshandy reviews reddit g2 deliverability honest 2026
24. Saleshandy buy domain mailbox price per mailbox managed infrastructure cost
25. Saleshandy API access which plan required Pro Starter developer

**2. PAGES FETCHED (in order):**
1. https://skyp.ai/pricing
2. https://maildoso.ai/pricing
3. https://www.smartlead.ai/pricing
4. https://www.mailforge.ai/
5. https://api.smartlead.ai/reference
6. https://maildoso.ai/
7. https://www.smartlead.ai/blog/ai-email-response-generator
8. https://developer.saleshandy.com/api-reference/domain/list-post
9. https://www.saleshandy.com/pricing

**3. CRITERIA:** listed above under "My checklist."

**4. KILL LIST:** listed above (Instantly, Salesforge/Agent Frank+Forge stack, Mailforge/Infraforge/Primeforge/Warmforge, Maildoso, Skyp, Apollo, Lemlist, Reply.io, Klenty, Woodpecker) — each with its one-sentence reason.

**5. DECIDING SENTENCE:** "When Saleshandy's own reviewer base is telling you it breaks down at exactly the scale you're building (past 'a handful' of senders, which 10-15 mailboxes clearly is), that risk to the actual deliverability outcome outweighs Smartlead's minor architectural inelegance of routing mailbox provisioning through a vetted third-party ESP marketplace via API — especially since both approaches equally satisfy 'no dashboard clicking.'"

**6. WINNER:** Smartlead — **~$142-$167/month** at 10-15 mailboxes / 3-5 domains (Pro plan $94/mo + SmartSenders mailboxes at $4.50 each + domains at $13/yr each); midpoint scenario (12 mailboxes/4 domains) = **$152.33/month** monthly-billed or **$136.63/month** with annual Smartlead billing.
```
