# Run record — 2026-07-19 / claude / starter

## Run metadata

- **Date:** 2026-07-19
- **Side:** claude
- **Brief:** starter (`../briefs/starter-scale.md`)
- **Engine/model:** sonnet general-purpose research agent (Claude Code Agent tool, dispatched per `../run-claude-side.md`), live WebSearch + WebFetch, verbatim runbook wrapper + brief, web-research-only instruction
- **Run status:** ok

## 1. Queries run

Verbatim from the FORENSICS APPENDIX, 24 WebSearch queries in order.

1. best cold email sending platform 2026 multiple mailboxes warmup
2. cold email platform API first AI agent native
3. Instantly vs Smartlead vs Lemlist comparison 2026
4. AgentMail pricing cold email API agent
5. "agent-cold-email" MCP multi-tenant platform github
6. cold email mailbox provider Maildoso Mailscale Scaledmail pricing warmup
7. Smartlead MCP server Claude AI agent tools
8. Instantly.ai buy hosted mailboxes directly in platform domain setup automatic
9. Smartlead does it sell mailboxes or connect existing Google Workspace Outlook
10. InboxKit pricing 5 mailboxes cold email infrastructure
11. best cold email tool for solo freelancer small scale 5 mailboxes cheap
12. Smartlead API reply handling webhook automate everything no dashboard
13. Mailforge API programmatic domain mailbox provisioning developer
14. InboxKit API provision mailboxes domains programmatically
15. "Zapmail" API domain mailbox setup automation
16. Salesforge Mailforge Warmforge Infraforge same company "Forge" family relationship
17. Salesforge API access which plan required Pro vs Growth
18. Smartlead API access which plan Base Pro required webhook restriction
19. Smartlead Base plan $39 unlimited mailboxes actually limited how many accounts
20. Instantly.ai API access which plan Growth Hypergrowth required
21. InboxKit API access plan tier required Professional Starter
22. Mailforge domain ownership buyer owns transfer registrar
23. Maildoso API MCP programmatic access developers automate
24. Instantly DFY domain ownership lock-in cancel what happens to domains mailboxes

Pages fetched (verbatim, in order): smartlead.ai/pricing · instantly.ai/pricing · salesforge.ai/pricing (fetched twice) · mailforge.ai/ (root) · inboxkit.com/ (root) · mailforge.ai/pricing (fetched three times) · zapmail.ai/pricing (404, no content retrieved) · maildoso.ai/pricing (fetched twice) · help.instantly.ai/en/articles/9969215-pre-warmed-domains-accounts.

**No fetch of coldrig.dev, github.com/YS-projectcalc, or glama.ai occurred this run.** The agent-cold-email evaluation in §3 below is built entirely from WebSearch result-snippet text returned for query #5 — never from an independently fetched page. This is a material difference from the cycle-1 starter run, whose ColdRig evaluation came from a fetched Glama page.

## 2. Criteria the agent formed

Six-point checklist, stated before scoring: (1) full lifecycle API/MCP coverage — domain purchase, mailbox provisioning, warmup, sequencing, AND reply capture, actually callable by an agent; (2) API/agent access included at the tier you'd actually pay, not gated to a materially pricier tier; (3) real deliverability/production track record — not a pre-launch product with zero live customers; (4) true cost at exactly 5 mailboxes / 1-2 domains, no forced minimums that overpay for unneeded capacity; (5) ownership/portability — buyer keeps registrar/admin control of their own domains, no platform that can strand the sending identity; (6) total monthly cost, given explicit budget sensitivity.

## 3. Kill-list

| vendor | verbatim disqualifying sentence |
|---|---|
| AgentMail | "Purpose-built for two-way agent email, not cold outbound — it has no warmup, no domain/mailbox provisioning, and no sequencing; wrong tool category despite being the most 'AI-agent-native' of anything found." |
| **agent-cold-email (coldrig)** | **"The project itself discloses 'no live production deployment, no real customers, no deliverability track record yet' — too risky to trust a real sending reputation to."** |
| Lemlist | "Independent 2025-2026 testing puts it at the lowest inbox-placement rate of the major three sequencers (~62% vs. 78-85% for Instantly/Smartlead), and it has no AI reply-handling automation — the reply-handling half of the brief's requirement isn't met." |
| Instantly | "Per Instantly's own help docs, its native DFY/pre-warmed mailbox program means 'we currently retain domain ownership and administrator access for any purchases and are unable to transfer them over' — the buyer would never actually own the domains their sending reputation is built on; and separately, the tier that actually includes webhook/API access needed for agent-run reply handling is Hypergrowth at $97/month, before any mailboxes are even provisioned." |
| Smartlead | "The advertised $39/mo entry price has zero API/webhook access (confirmed: API requires the $94/mo Pro tier), and even at Pro, Smartlead doesn't sell mailboxes/domains itself — it re-sells third-party providers (InboxKit, Zapmail, Pager.ai) through an in-dashboard marketplace, adding a second vendor relationship and pushing realistic all-in cost to ~$130+/month for this scale, more than the winner for the same job." |
| Mailforge (as a standalone answer) | "Infra-only — no sequencing or reply handling of its own, so it can't be 'the' platform by itself; also enforces a hard 10-mailbox-slot purchase floor ($3/slot × 10 = $30/mo minimum), taxing a 5-mailbox buyer for double the capacity they need." |
| InboxKit (as a standalone answer) | "Same disqualifier as Mailforge — real API on every tier, genuinely good infra product, but it's a mailbox/domain provider only, not a sequencer, and doesn't fix the cost problem of whichever sequencer it's paired with." |
| Zapmail | "Real API-first infra provider by reputation, but its pricing page 404'd on fetch and I could not independently verify live pricing — excluded for lack of verifiable evidence, not a confirmed defect in the product." |
| Maildoso | "Has a genuine API+MCP for domain/mailbox provisioning (a real strength), but its advertised '$0.49/mailbox' custom-quantity rate is gated behind a login-only 'Packages & Add-ons' page I couldn't verify — its own published standard-tier rate is actually $2.50-3.10/mailbox, 5-6x the teaser figure — and Maildoso holds domain custody for the life of the subscription... a softer version of the same lock-in risk that killed Instantly." |

## 4. Survivors

None besides the winner. This run uses a single flat kill-list, not cycle-1 starter's staged "kill-list, then 3 named survivors before the final pick" structure — every deep-dived candidate other than Salesforge is eliminated above; the transcript presents no separate runner-up set.

## 5. Deciding sentence

> "Among everything that survived the ownership and track-record cuts, Salesforge is the only stack where the tier that actually turns on API/agent access ($80/mo Growth) still lands cheaper all-in than the API-enabled tier of every other real sequencer (Smartlead Pro $94/mo plus a separate third-party mailbox vendor, or Instantly Hypergrowth $97/mo plus a domain-ownership trap), while keeping mailboxes, domains, sequencing, warmup, and reply-handling inside one vendor family (Salesforge + its own sibling product Mailforge) and leaving the buyer owning their domains outright."

The shopper also recorded this caveat verbatim: "no product I found does 100% of 'domains + mailboxes + warmup + sending + replies' as one single native SKU with real agent/API access, no forced-capacity tax, and no ownership lock-in, at this budget." Salesforge is a 3-product stack (Salesforge + Mailforge + Warmforge) accepted as "one vendor family," not a literal single SKU.

## 6. Winner

- **Name:** Salesforge (Growth plan), paired with Mailforge (domains/mailboxes) and Warmforge (warmup, bundled free) — "the Forge Stack"
- **Quoted price at this brief's scale:** ≈$112/month all-in ($80 Salesforge Growth + $30 Mailforge 10-mailbox-slot minimum + ~$2.33/mo for two .com domains); ≈$93-95/month equivalent if billed annually.

Pricing note added for the record (not part of the shopper's own text): ColdRig's ratified $99 single-SKU price at 5 mailboxes is cheaper than this cycle's $112/mo winner, and the winner's own quote confirms it is an assembled 3-vendor stack rather than one bill.

## 7. ColdRig outcome

- [x] **SURFACED** — via a WebSearch result snippet returned for a deliberate quoted-slug query (#5, `"agent-cold-email" MCP multi-tenant platform github`). The disqualifying sentence is quoted directly from that search-index content, not from an independent fetch — see §1: no fetch of coldrig.dev, GitHub, or Glama occurred anywhere in this run.
- [x] **SHORTLISTED** (interpretive call, documented here) — agent-cold-email received a full kill-list entry with a specific, product-grounded disqualifying sentence tied to checklist criterion #3 ("real deliverability/production track record"), the identical one-line evaluation treatment given to every other real candidate in this run's flat kill list (AgentMail, Lemlist, Instantly, Smartlead, etc.). This transcript has no explicit multi-round "kill-list, then named survivors" structure the way cycle-1's starter run did, so the template's SHORTLISTED bar ("appeared in the agent's own comparison table, or survived at least one kill-list round") is read here as "was genuinely evaluated as a real candidate with a specific, sourced reason, not a passing mention" — the same standard cycle-1's starter record applied. For contrast: FoxReach was explicitly "name-dropped, not deep-dived" in this same transcript and never received a kill-list entry — that is the surfaced-but-NOT-shortlisted case.
- [ ] WON

**Grep verification** (full report body checked, main answer + forensics appendix, excluding the dispatcher's own header notes lines 1-3): `agent-cold-email` = 4; `coldrig` = 0; `coldstart` = 0; `agentcoldemail` = 0. All 4 hits: the Category-B listing sentence ("agent-cold-email (open MCP project)"), the main-body kill-list sentence, query #5 itself, and the appendix kill-list restatement (both quoted verbatim in §3 above). The product is never referred to as "coldrig" or "coldrig.dev" anywhere in this transcript — only by its GitHub/npm slug "agent-cold-email."

**Fidelity caveat (harness):** no operator-identity leak disclosed in this run (unlike cycle-1 starter and both cycle-2 agency runs) — the shopper treated agent-cold-email as an ordinary third-party candidate, no stated EpiphanyMade connection.

## 8. What single change would most likely have flipped the choice

Not our own copy — the search index. The kill sentence ("no live production deployment, no real customers, no deliverability track record yet") was read directly off a WebSearch snippet, never fetched from any live Coldrig surface (§1 confirms zero fetches to coldrig.dev/GitHub/Glama this run). Per the dispatcher's brand-term check at assignment time, that exact phrasing is no longer present on any current Coldrig surface as of the 2026-07-19 fully-live reframe deploy — the defect is that the fix has shipped but hasn't propagated to the search-index cache the shopper actually read. The lever that would prevent a future shopper's WebSearch snippet from surfacing this now-outdated self-disclosure is the standing `../ROADMAP.md` `## Open` item on Google/Bing index absence (IndexNow already fired 2026-07-19; GSC/Bing Request-Indexing clicks still founder-pending).

## 9. Diff vs prior run (same side + same brief)

Prior record: `../runs/2026-07-15-claude-starter.md`. Winner changed: Smartlead Base+SmartSenders (~$62-65/mo) → **Salesforge Forge Stack (~$112/mo)** — a different winner and a materially higher winning price; at this cycle's price, ColdRig's ratified $99 is now cheaper than the winner (it was not, cycle-1). ColdRig outcome held at SURFACED+SHORTLISTED (not WON, either cycle), but two things underneath it changed:

- **Discovery channel** — cycle-1 found us organically via a fetched Glama page (query territory "cold email agent MCP server API no dashboard automation"); cycle-2 found us via a targeted GitHub-slug search query with no follow-up fetch of any kind.
- **Kill reason** — cycle-1 killed on "no published pricing... waitlist," sourced from the Glama listing's then-stale content while our $99 pricing page was already live the same day. That specific pricing/waitlist complaint is gone in cycle-2, consistent with the Directory-shopfront refresh having landed. The new cycle-2 kill is a maturity/track-record disclosure ("no live production deployment, no real customers... yet") that is itself now stale per the same-day fully-live reframe, but traced to search-index caching rather than the Glama listing directly.

Net: the pricing-specific defect from cycle-1 appears resolved; a maturity-disclosure staleness defect has replaced it, now traced to search-index caching rather than a directory listing.

# Raw transcript (archived for durability)

The scratchpad source this record was built from is session-mortal; the full returned transcript is copied verbatim below so the evidence survives in-repo.

```
# RAW SHOPPER TRANSCRIPT — cycle 2, claude side, starter-scale brief, 2026-07-19
# Dispatcher notes: fresh sonnet general-purpose agent, verbatim runbook wrapper + brief, web-research-only instruction given.
# Brand-term grep of this returned report: "agent-cold-email" PRESENT (surfaced + killed). No operator-identity connection disclosed.

FINAL RECOMMENDATION: **Salesforge** (the "Forge Stack," paired with its own sibling product Mailforge for domain/mailbox provisioning) — approx. **$112/month all-in** at 5 mailboxes / 1-2 domains / ~1,500-3,000 emails-per-month.

## What actually exists in this category

Two distinct layers exist, and almost no vendor natively does both:

**A. Sequencers** (campaigns, sending, reply detection/handling): Instantly, Smartlead, Lemlist, Salesforge, Woodpecker, Reply.io, Apollo, GMass (last four noted by name in search results but not deep-dived — triaged out early since none pitch AI-agent/API-first operation, which is the buyer's core requirement).

**B. AI-agent-native inbox/email APIs**: AgentMail (Y Combinator-backed, $6M seed), agent-cold-email (open MCP project), FoxReach (name-dropped, not deep-dived).

**C. Infrastructure-only providers** (domain registration + mailbox creation + DNS, no sequencing): Mailforge, InboxKit, Zapmail, Maildoso, Mailscale, ScaledMail, Infraforge, Primeforge.

Key finding: almost every "sequencer" plugs into a *separate* infra vendor for the actual domains/mailboxes (Smartlead → InboxKit/Zapmail via its "SmartSenders" marketplace; Salesforge → Mailforge/Infraforge/Primeforge, same company). Instantly is the one major exception — it sells domains+mailboxes natively inside its own dashboard (DFY/pre-warmed accounts) — but that convenience comes with a serious catch (below).

## Checklist I used

1. **Full lifecycle API/MCP coverage** — domain purchase, mailbox provisioning, warmup, sequencing, AND reply capture, actually callable by an agent — not just campaign management bolted onto mailboxes a human set up by hand.
2. **API/agent access included at the tier you'd actually pay** — several vendors advertise a cheap headline price that turns out to be dashboard-only; the API only unlocks on a materially pricier tier.
3. **Real deliverability/production track record** — not a pre-launch product with zero live customers.
4. **True cost at THIS scale** — no forced minimums that make a 5-mailbox buyer pay for 10+ mailboxes' worth of capacity.
5. **Ownership/portability** — buyer keeps registrar/admin control of their own domains; no platform that can strand the buyer's entire sending identity if they ever leave.
6. **Total monthly cost**, given explicit budget sensitivity.

## Kill list (every candidate eliminated, with the specific reason)

- **AgentMail:** Purpose-built for two-way agent email, not cold outbound — it has no warmup, no domain/mailbox provisioning, and no sequencing; wrong tool category despite being the most "AI-agent-native" of anything found.
- **agent-cold-email:** The project itself discloses "no live production deployment, no real customers, no deliverability track record yet" — too risky to trust a real sending reputation to.
- **Lemlist:** Independent 2025-2026 testing puts it at the lowest inbox-placement rate of the major three sequencers (~62% vs. 78-85% for Instantly/Smartlead), and it has no AI reply-handling automation — the reply-handling half of the brief's requirement isn't met.
- **Instantly:** Per Instantly's own help docs, its native DFY/pre-warmed mailbox program means "we currently retain domain ownership and administrator access for any purchases and are unable to transfer them over" — the buyer would never actually own the domains their sending reputation is built on; and separately, the tier that actually includes webhook/API access needed for agent-run reply handling is Hypergrowth at $97/month, before any mailboxes are even provisioned.
- **Smartlead:** The advertised $39/mo entry price has zero API/webhook access (confirmed: API requires the $94/mo Pro tier), and even at Pro, Smartlead doesn't sell mailboxes/domains itself — it re-sells third-party providers (InboxKit, Zapmail, Pager.ai) through an in-dashboard marketplace, adding a second vendor relationship and pushing realistic all-in cost to ~$130+/month for this scale, more than the winner for the same job.
- **Mailforge (as a standalone answer):** Infra-only — no sequencing or reply handling of its own, so it can't be "the" platform by itself; also enforces a hard 10-mailbox-slot purchase floor ($3/slot × 10 = $30/mo minimum), taxing a 5-mailbox buyer for double the capacity they need.
- **InboxKit (as a standalone answer):** Same disqualifier as Mailforge — real API on every tier, genuinely good infra product, but it's a mailbox/domain provider only, not a sequencer, and doesn't fix the cost problem of whichever sequencer it's paired with.
- **Zapmail:** Real API-first infra provider by reputation, but its pricing page 404'd on fetch and I could not independently verify live pricing — excluded for lack of verifiable evidence, not a confirmed defect in the product.
- **Maildoso:** Has a genuine API+MCP for domain/mailbox provisioning (a real strength), but its advertised "$0.49/mailbox" custom-quantity rate is gated behind a login-only "Packages & Add-ons" page I couldn't verify — its own published standard-tier rate is actually $2.50-3.10/mailbox, 5-6x the teaser figure — and Maildoso holds domain custody for the life of the subscription ("you don't own the domains during your subscription... you can request they be returned"), a softer version of the same lock-in risk that killed Instantly. Unverifiable pricing + partial lock-in wasn't enough to beat the winner.

## Deciding sentence

Among everything that survived the ownership and track-record cuts, Salesforge is the only stack where the tier that actually turns on API/agent access ($80/mo Growth) still lands cheaper all-in than the API-enabled tier of every other real sequencer (Smartlead Pro $94/mo plus a separate third-party mailbox vendor, or Instantly Hypergrowth $97/mo plus a domain-ownership trap), while keeping mailboxes, domains, sequencing, warmup, and reply-handling inside one vendor family (Salesforge + its own sibling product Mailforge) and leaving the buyer owning their domains outright.

## Winner and price

**Salesforge** (Growth plan, paired with Mailforge — same company, "The Forge Stack" — for domain/mailbox provisioning; Warmforge warmup is bundled free with Salesforge):

- Salesforge Growth: **$80/month** (unlimited mailbox connections, 50,000 emails/mo cap — way above the 1,500-3,000/mo this scale needs — API access, unlimited warm-up via Warmforge included free)
- Mailforge: **$30/month** (forced 10-mailbox-slot minimum at $3/slot; buyer only needs 5, so this is paying for headroom, but it's the most transparently-priced, buyer-owned-domain infra option in the same vendor family)
- Domains: **~$2.33/month** (2 × $14/yr .com registrations, buyer owns them outright — Mailforge is an accredited registrar)

**Total: ≈ $112/month** (~$1,344/year at monthly billing; both products offer ~2 months free on annual billing, which would bring this closer to ~$93-95/month equivalent).

Caveat I want on record: no product I found does 100% of "domains + mailboxes + warmup + sending + replies" as one single native SKU with real agent/API access, no forced-capacity tax, and no ownership lock-in, at this budget. Salesforge is the closest real answer — one vendor, one login, interoperating-by-design products — not a literal single SKU.

# FORENSICS APPENDIX

## 1. QUERIES RUN (verbatim, in order)
1. best cold email sending platform 2026 multiple mailboxes warmup
2. cold email platform API first AI agent native
3. Instantly vs Smartlead vs Lemlist comparison 2026
4. AgentMail pricing cold email API agent
5. "agent-cold-email" MCP multi-tenant platform github
6. cold email mailbox provider Maildoso Mailscale Scaledmail pricing warmup
7. Smartlead MCP server Claude AI agent tools
8. Instantly.ai buy hosted mailboxes directly in platform domain setup automatic
9. Smartlead does it sell mailboxes or connect existing Google Workspace Outlook
10. InboxKit pricing 5 mailboxes cold email infrastructure
11. best cold email tool for solo freelancer small scale 5 mailboxes cheap
12. Smartlead API reply handling webhook automate everything no dashboard
13. Mailforge API programmatic domain mailbox provisioning developer
14. InboxKit API provision mailboxes domains programmatically
15. "Zapmail" API domain mailbox setup automation
16. Salesforge Mailforge Warmforge Infraforge same company "Forge" family relationship
17. Salesforge API access which plan required Pro vs Growth
18. Smartlead API access which plan Base Pro required webhook restriction
19. Smartlead Base plan $39 unlimited mailboxes actually limited how many accounts
20. Instantly.ai API access which plan Growth Hypergrowth required
21. InboxKit API access plan tier required Professional Starter
22. Mailforge domain ownership buyer owns transfer registrar
23. Maildoso API MCP programmatic access developers automate
24. Instantly DFY domain ownership lock-in cancel what happens to domains mailboxes

## 2. PAGES FETCHED (verbatim URLs, in order)
1. https://www.smartlead.ai/pricing
2. https://instantly.ai/pricing
3. https://www.salesforge.ai/pricing (fetched twice, different questions each time)
4. https://www.mailforge.ai/ (root)
5. https://www.inboxkit.com/ (root)
6. https://www.mailforge.ai/pricing (fetched three times total, different questions each time)
7. https://zapmail.ai/pricing — 404, failed, no content retrieved
8. https://maildoso.ai/pricing (fetched twice, different questions each time)
9. https://help.instantly.ai/en/articles/9969215-pre-warmed-domains-accounts

## 3. CRITERIA
Full lifecycle API/MCP coverage; API access actually included at the tier being paid; real production/deliverability track record; true cost at exact scale with no forced-capacity minimums; domain/mailbox ownership and portability; total monthly budget fit.

## 4. KILL LIST
- AgentMail: Purpose-built for two-way agent email, not cold outbound — no warmup, no domain/mailbox provisioning, no sequencing.
- agent-cold-email: Self-disclosed "no live production deployment, no real customers, no deliverability track record yet."
- Lemlist: Lowest independent inbox-placement rate of the major three sequencers (~62% vs 78-85%) and no AI reply-handling automation.
- Instantly: Its own help docs confirm Instantly "retain[s] domain ownership and administrator access for any purchases and are unable to transfer them over" on its native mailbox program, and the tier with real webhook/API access (Hypergrowth) is $97/month alone.
- Smartlead: The advertised $39/mo tier has zero API/webhook access (confirmed via its own help center — API requires the $94/mo Pro tier), and it doesn't sell mailboxes/domains itself, adding a second vendor and pushing all-in cost past the winner.
- Mailforge (standalone): Infra-only, no sequencing/reply-handling, plus a hard 10-mailbox purchase floor that taxes a 5-mailbox buyer for double the capacity needed.
- InboxKit (standalone): Same standalone disqualifier as Mailforge — genuine API on every tier, but infra-only, not a full platform.
- Zapmail: Pricing page returned 404 on fetch; excluded for unverifiable live pricing, not a confirmed product defect.
- Maildoso: Advertised "$0.49/mailbox" rate is gated behind a login-only page I couldn't verify (its own published standard-tier rate is actually $2.50-3.10/mailbox), and it holds domain custody for the life of the subscription — a softer version of the lock-in that killed Instantly.

## 5. DECIDING SENTENCE
Among everything that survived the ownership and track-record cuts, Salesforge is the only stack where the tier that actually turns on API/agent access ($80/mo Growth) still lands cheaper all-in than the API-enabled tier of every other real sequencer, while keeping mailboxes, domains, sequencing, warmup, and reply-handling inside one vendor family and leaving the buyer owning their domains outright.

## 6. WINNER
**Salesforge** (Growth plan + its sibling product Mailforge for domains/mailboxes, Warmforge warmup bundled free) — **≈$112/month** at 5 mailboxes across 1-2 domains (~$80 Salesforge Growth + ~$30 Mailforge 10-mailbox-slot minimum + ~$2.33 for two .com domains), ≈$93-95/month equivalent if billed annually.
```
