# Review-site listings + dogfood-calls scope — 2026-07-21 (research record)

> Founder-delegated ("research deeply and choose") per `ROADMAP.md` `## Open` 2026-07-21 "Research lanes dispatched" entry, item (d). Grounded in `tools/buyer-panel/runs/2026-07-19-claude-canonical.md`, `2026-07-19-claude-agency.md`, `tools/buyer-panel/CHOICE-TREND.md`, and `docs/research/dogfood-targets-2026-07-14.md`, plus two dispatched sub-worker passes (G2/Capterra; TrustRadius/Product Hunt/AlternativeTo/AI-agent directories). VERIFIED = direct-source citation found this pass. INFERRED = reasoning without a direct source. Sub-worker source files are quoted inline below with their own confidence tags preserved.

## Why this matters (grounding recap)

Two independent 2026-07-19 buyer-panel runs (fresh Claude research agents, live web search, standardized brief) both crowned Smartlead. The canonical-scale run's own winning citation explicitly names "**G2 4.6/5 across 306 reviews**" as part of the deciding evidence for deliverability trust (`tools/buyer-panel/runs/2026-07-19-claude-canonical.md:143`). This is not a one-off: the 2026-07-15 canonical run killed FoxReach *solely* for "no independent review evidence... too much unverified risk to run unsupervised" (`CHOICE-TREND.md` row 1) — an absence ColdRig currently shares. ColdRig has zero G2/Capterra/TrustRadius presence today. The standing `## Open` 2026-07-15 [IDEA] item ("Independent-review presence (G2/Trustpilot/Capterra)") has been sitting un-actioned for six days while two more buyer-panel cycles reproduced the same class of gap.

---

# Decision 1 — Review-site listings

## Corporate context (VERIFIED, changes the landscape)

G2 acquired Capterra + Software Advice + GetApp from Gartner (announced 2026-01-29, closed ~2026-02-05, ~$110M) — `company.g2.com/news/g2-acquires-capterra-software-advice-getapp`, corroborated PR Newswire. The properties still run separate dashboards/pricing near-term, but Capterra listing inquiries now route through `listings@g2digitalmarkets.com`. Practically: G2 and Capterra are now one commercial relationship, not two separate vendor asks.

## G2

1. **Cost (VERIFIED, `sell.g2.com/create-a-profile`):** free basic profile — "you can claim your profile for free," 3 admins, basic review collection, "Users Love Us" badge eligibility (20+ reviews at 4.0+). Paid tiers (VERIFIED, `sell.g2.com/plans` + FY26 pricing PDF): Starter $299/mo or $2,999/yr; Pro/Enterprise custom. Gated behind paid: public review *responses* (Starter+), buyer analytics (Pro+), and — as of a 2025-06-24 policy change (VERIFIED, `company.g2.com/news/badge-accessibility-changes`) — the badge *graphic* display (earning the badge/Grid placement itself stays free; "Users Love Us" is exempt from the graphic-paywall).
2. **Requirements:** new-profile review ~3-5 business days (INFERRED, secondary sourcing); claim ~1-3 days; claiming email should match the product domain (INFERRED).
3. **Minimum reviews for a displayed score:** no primary G2 statement found for the base star rating (GAP). What IS verified: Grid Report inclusion needs ≥10 reviews per product (category needs 6+ products with 10+ each and 150+ total); "Users Love Us" needs 20+ at 4.0+.
4. **Solicitation rules (VERIFIED, `legal.g2.com/community-guidelines`):** ALLOWED — direct email/DM asks, landing-page review requests, closed-community asks, in-app prompts. BANNED — sentiment-segmented targeting (asking only happy customers), incentives conditioned on a positive review, fake reviews, pressuring reviewers. Incentives are capped at **$100** and incentivized reviews must be labeled as such.
5. **Empty/thin-profile risk:** no first-hand evidence found either way (GAP) — but see the citation study below, which is the strongest available signal and points toward "presence, not volume, is what's load-bearing."
6. **AI-agent citation — the single most important finding this pass (VERIFIED, `quoleady.com/llmo-research`, dated 2026-06-04, fetched directly):** across tools ChatGPT cites on "[tool] alternatives"-style queries, **99% had G2 reviews present, 100% had Capterra reviews present, 78.8% had a Wikipedia page.** Critically, *review count vs. citation rank correlation is weak-to-negative* (G2: −0.16, G2 score: −0.11) — having reviews at all is close to a hard filter for being surfaced; having *many* reviews does not reliably buy a better rank. No direct evidence was found of the exact "cite the numeric star rating verbatim" pattern our own buyer-panel transcripts show (the Smartlead 4.6/306 pattern) — that specific mechanism remains corroborated only by our own transcripts, not by this external study — but the presence-filter finding independently supports acting on G2/Capterra regardless.

## Capterra (+ GetApp, Software Advice)

1. **Cost:** basic listing, review responses, and badges are free (INFERRED/secondary — `capterra.com/vendors` describes benefits without a pricing table). Paid tier is PPC-only: ~$2/click floor, ~$500/mo minimum (secondary/approximate, formal terms at `capterra.com/legal/ppc-service-description`). One profile spans all three Gartner Digital Markets properties.
2. **Requirements (VERIFIED, `capterra.com/legal/listing-guidelines`, fetched directly):** a genuine packaged B2B/B2C product, fitting an existing category, publicly available with a clear call to action, listed under the product's real name on a vendor-controlled site. **Beta products are explicitly allowed to list**, with only a working public site plus **at least 1 review within the first calendar year** required. Approval is content-team discretion, no published SLA.
3. **Minimum reviews for a displayed score:** 5 published reviews (all-time) for the Star Rating badge — secondary-sourced (a blog citing the Gartner Digital Markets help center, dated 2026-04-27), one level removed from primary. The beta-listing rule above implies a profile can sit at zero reviews for up to a year without penalty.
4. **Solicitation rules (VERIFIED, `capterra.com/legal/community-guidelines`):** fair/unbiased asks across a broad cross-section of customers required (no cherry-picking). Incentives ARE allowed if nominal, offered equally regardless of the rating given, and disclosed — this is more permissive than G2's flat $100 cap, with no stated dollar ceiling in what was found. Banned: sentiment-targeted asks, purchased/fake reviews, coaching reviewers on content, off-site collection, non-disparagement clauses, pressuring reviewers.
5. **Empty-profile risk:** same evidentiary gap as G2 — no first-hand account found; Capterra's own beta-listing tolerance (zero reviews allowed for up to a year) is itself a strong signal that the platform does not treat an empty profile as reputationally damaging.
6. **AI-agent citation (VERIFIED, same Quoleady study):** 100% of ChatGPT-cited tools had Capterra reviews present; count-vs-rank correlation −0.21 — same "presence is the filter, volume isn't" pattern as G2.

## TrustRadius

1. **Cost:** free basic vendor profile (VERIFIED, `trustradius.com/products/trustradius-vendors/pricing`, corroborated by a third-party SaaS-review roundup). Paid "Customer Voice Package" is **≈$30,000/product/year** (third-party estimate — TrustRadius doesn't publish this figure; `solutions.trustradius.com/pricing` fetched directly but doesn't list the number itself) — an order of magnitude past G2's paid tier.
2. **Requirements/approval:** the scoring/verification methodology page returned a 403 on direct fetch — no primary approval-timeline source obtained (GAP). A "Trusted Sellers" designation exists as an inferred compliance layer.
3. **Minimum activity for a score:** "Top Rated" award needs 10+ reviews in 12 months, a trScore ≥7.5, and 0.5% category traffic share (VERIFIED via a summary of TrustRadius's public criteria). trScore itself weights newer and randomly-sourced reviews more heavily specifically to counter vendor cherry-picking. Whether a bare score displays at just 1 review is unverified (blocked by the 403).
4. **Solicitation rules — materially different from G2/Capterra (VERIFIED verbatim, `trustradius.freshdesk.com`, "How TrustRadius Acquires Reviews"):** TrustRadius runs the incentivized outreach itself, as standing policy — **$25 gift card on the first two outreach emails to a customer, $50 on the third**, on a fixed Tuesday/Friday/Friday send cadence. Vendors are required to submit a full, representative customer contact list ("discourages cherry-picking... random samples... [have a] more positive impact on trScore"), due one week before the campaign launches. This is corroborated by practitioner accounts (a SaaS-review blog, and community gift-card posts from Auth0/Cisco customers). No explicit list of banned practices was found for TrustRadius specifically (GAP) — but the mechanism itself is structurally different: it's a vendor-paid, TrustRadius-run acquisition service, not a self-serve ask.
5. **Thin-profile risk:** not found directly for TrustRadius; only a general (weak) inference that low review volume reads as low-signal.
6. **AI-agent citation (VERIFIED, `usehall.com` citation-analysis study, fetched directly):** TrustRadius's strongest showing is 6.35% presence in Google AI Overviews for B2B software — 0-2% in other contexts — a distant third behind G2/Capterra. TrustRadius does allow all AI-crawler access via robots.txt. **There is no "cold email" category on TrustRadius** — the closest fits are Email Deliverability, Email Marketing, or Sales Email Tracking. A **live SERP check for "best cold email software 2026" returned zero TrustRadius, Product Hunt, or AlternativeTo pages in the top organic results — the category is currently dominated entirely by vendor listicles.**

## Product Hunt

1. **Cost:** listing itself is free (VERIFIED, multiple sources). Optional paid add-ons: "Ship" pre-launch tool ($59/mo annual, $79/mo monthly), featured placement ($250-1,000), "Promoted Product" (~$4,000) — the paid figures are third-party estimates (INFERRED), not PH's own published rate card.
2. **Requirements:** no pre-listing verification gate found — self-service launch, reactive moderation only (INFERRED).
3. **How ranking actually works:** NOT raw upvote count — a quality/velocity/comment-depth/maker-responsiveness/voter-credibility weighting; a "Power User" vote is worth roughly 30-50 fresh-account votes; fresh/unverified accounts are discounted; counts are re-filtered roughly every 2 hours (secondary/practitioner sourcing — PH doesn't publish the formula, but PH's own vote-integrity explainer confirms manipulation-detection exists, VERIFIED via `help.producthunt.com` article 11869098). The product page persists indefinitely as an indexed URL after launch day ends (INFERRED).
4. **Solicitation rules (VERIFIED verbatim, PH Community Guidelines):** "Mass messaging users, asking for upvotes, using bots, incentivizing upvotes, and any other form of artificially increasing activity... is not acceptable." Self-promoting comments get removed; penalties escalate contribution-removal → loss of contribution access → account suspension.
5. **Thin/failed-launch risk — the clearest negative evidence found across every platform in this research:** real accounts of underperforming launches describe finishing "below a food blender" at ~200 upvotes, or being "stuck at #26 all day under 50 points," with one poster noting "not being on the featured list is essentially like being on page 2 of Google" (a marketing blog + a PH community forum post + an HN thread on bought-upvote detection). A counterpoint exists — some of those same accounts relaunched later and hit top-5 finishes, so a bad launch isn't permanently disqualifying reputationally — **but the weak launch page itself stays indexed and visible forever**, unlike a quiet, low-review G2/Capterra profile that reads as neutral.
6. **AI-agent citation:** the `usehall.com` citation study doesn't mention Product Hunt at all, and the live category SERP check found zero PH pages. This is a genuine gap (not independently confirmed as "PH doesn't matter for AI citation"), but combined with finding 5, there's no upside case for rushing a launch now.

## AlternativeTo

1. **Cost:** entirely free, no vendor tier found at all (VERIFIED via FAQ + multiple failed searches for a paid option) — monetizes via ads, not vendor fees.
2. **Requirements (VERIFIED, FAQ fetched directly):** a "Suggest new application" flow; approval takes roughly a few days up to a week; **new submitting accounts must wait one week before they're allowed to submit**; name/website fields require verification; all changes are admin-reviewed.
3. **Ranking mechanism:** a proprietary Rank + Likes score; the FAQ states "the more organic the like is, the better," with no disclosed minimum threshold. A category spot-check (search-text sourced, lower confidence) found **single-digit likes are the norm in this exact category** — Instantly.ai at 1 like, Apollo.io at 5, Snov.io at 9.
4. **Solicitation rules (VERIFIED, FAQ):** "Incentivizing people to upvote (with discounts, gifts and so on) or, worse, creating fake accounts... may trigger the algorithm to drop it in the ranks." Organic asks are implicitly fine.
5. **Thin-profile risk:** not found directly, but the category norm itself (near-zero likes across established competitors) means a bare listing is unremarkable, not a red flag.
6. **AI-agent citation:** not mentioned in the `usehall.com` study; no presence in the live category SERP check (GAP, not a confirmed non-event).

## AI-agent-facing directories (Glama and others)

- **Glama** (where ColdRig already has a listing, `glama.ai/mcp/servers/YS-projectcalc/agent-cold-email`) — VERIFIED via direct fetch: ranking is **purely algorithmic** (License grade A/B, Quality grade A-F, Maintenance grade A-D; sorted by usage/downloads/stars). **There is no visible user-review or rating-submission mechanism on Glama at all.** A search-snippet claim that Glama has "reviews from real agent traffic" could not be corroborated on direct fetch and should be treated as inaccurate or stale — flagged as a contradiction, not relied on.
- **Smithery** (where ColdRig is also published): no built-in ratings/reviews mechanism, per comparison sources.
- **Official MCP Registry**: structured metadata only, no ratings.
- **MCPReview.dev**: self-describes community ratings/reviews for MCP servers, but this was found only via a search snippet, not independently fetched — flag for a future verification pass, not urgent.
- **MCP Toplist / awesome-mcp GitHub lists / AwesomeAgents.ai leaderboard**: these are repo-metadata popularity rankings (stars, commit activity), not buyer reviews; AwesomeAgents specifically remains unverified beyond a snippet.
- **Net finding:** the G2-style "4.6/306, cited as the deciding sentence" mechanism has **no mature analog yet in AI-agent-facing directories** — this whole category currently ranks on algorithmic/repo-quality signals, not buyer sentiment. This explains, retroactively, why the standing ROADMAP work on Glama has been about metadata/tool-count accuracy (the actual lever on that surface) rather than reviews — that instinct was already correct, and this research confirms there isn't a parallel "get Glama reviews" lever to add to it yet.

## Recommendation — Decision 1

**Create free listings now, no paid spend, on G2, Capterra, and AlternativeTo:**
- **G2 and Capterra are the highest-leverage, lowest-risk move available.** The Quoleady citation study is the strongest piece of new evidence this pass: presence on both platforms is close to a *hard filter* for being cited by an AI agent doing "[category] alternatives"-style research (99-100% of cited tools had a listing) — while review *count* barely correlates with citation rank. That means the profile itself, populated with real company/product info even at zero reviews, is very likely doing most of the discoverability work — waiting for reviews to accumulate before listing gets the sequencing backwards. Capterra's own written policy explicitly tolerates beta products with as few as 1 review inside a full year, which is direct platform-level confirmation that an early/thin listing is not treated as a red flag on their end.
- **AlternativeTo** — free, zero downside, and the category norm (single-digit likes on Instantly/Apollo/Snov.io) means a bare ColdRig listing will look completely unremarkable, not weak. List it in the same batch as G2/Capterra since it costs nothing beyond the submission form and the one-week new-account wait.
- **Create a free TrustRadius profile too, but do not engage their paid or incentivized review programs.** The basic listing costs nothing; skip their $30k/yr Customer Voice Package and — separately — skip their own incentivized-outreach service entirely for now, since it requires submitting a full customer contact list we don't have yet, and its category/AI-citation footprint for cold email specifically is currently the weakest of the four platforms researched (0% presence in a live "best cold email software 2026" SERP check).
- **Defer the Product Hunt launch specifically** — not because listing costs anything, but because this is the one platform where a weak showing is uniquely visible and permanently indexed (real accounts of launches finishing "below a food blender" or stuck at #26). ColdRig launching today, with zero customers and zero organic community, is very likely to produce exactly that outcome. Time the launch to a real capability or traction milestone instead — e.g., "tenant self-serve real sending is live" or "first real pilot customer" — so the launch has an actual story and a plausible reason for a founder's own network to show up on day one.

**Chosen N for soliciting reviews (not for creating listings) = 1.** Listings go up immediately; asking for a *review* waits until one real, genuinely-using tenant exists — Mordy's pilot, once it completes at least one real send cycle. This N is small deliberately: the risk this research keeps surfacing isn't "too few reviews," it's reviews that read as manufactured to a skeptical reader (human or AI-buyer-agent). One honest, detailed review from an actual user is worth more than several generic ones solicited on day one, and it's consistent with Capterra's own official floor (their beta policy accepts exactly 1 review as sufficient for a full year). Do not chase G2's 10-20-review badge thresholds yet — that's a later-stage goal once there are enough genuine users to ask honestly, not a launch gate. When Mordy's review lands, ask via each platform's own compliant mechanism (G2: direct ask, no incentive beyond the $100 cap and full disclosure if used; Capterra: same, nominal/disclosed incentive if used) — never TrustRadius's paid campaign model until there's a real list of customers to submit.

---

# Decision 2 — Dogfood-calls scope

## Gating (grounded in current ROADMAP/ACTIVATION state, verified via `ROADMAP.md` read 2026-07-21)

Dogfood cannot start before real, tenant-facing sending is armed — and per `ROADMAP.md`'s `## Open` entries, that arming is **not yet complete**:
- Mordy's pilot (the first real end-to-end tenant test) is itself gated on: Cloudflare Tunnel + `ENGINE_BASE_URL` + `ENGINE_TENANTS` wiring, an InboxKit key re-paste (session-local secret, currently gone), and the InboxKit adapter's five REQUIRED-BEFORE-ARMING items (a)-(e) — domain/mailbox credential separation, an exact-match guard before the destructive mailbox-cancel call, a vendor idempotency key, a display-honesty fix so vendor-reported reputation scores don't reach the customer-facing dashboard as if authoritative, and empirical verification of the mailbox-search match semantics.
- The Gmail OAuth consent screen is still in **Testing** status — refresh tokens expire roughly weekly (next expiry flagged 2026-07-26 in ROADMAP). Any real sustained send campaign, including a dogfood one, inherits this instability until the consent screen moves to Production or token re-minting becomes routine.
- Engine-level real sending (the gmail_api transport) has been smoke-tested successfully from the droplet — that's a capability proof, not the same thing as a customer-facing (or self-facing) tenant being fully wired to use it end-to-end.

**Conclusion: dogfood rides the same arming wave as the Mordy pilot, not a separate one.** There is no case for building a parallel dogfood-only sending path — it would duplicate exactly the InboxKit + OAuth + tunnel wiring Mordy's pilot already needs, and a second untested path is a second place to find bugs. Recommend dogfood is explicitly sequenced to start **after** Mordy's pilot has completed at least one real, unremarkable send cycle (proof the arming holds under real conditions) rather than racing it — this is a credibility campaign; sending from an unstable pipeline risks the exact reputational failure the campaign is trying to prevent (a bounced/failed disclosed-agent email to a cold-email influencer is a uniquely bad look).

## Tenant/domain shape

Dogfood should run under its **own dedicated tenant and its own sending domain(s)**, not reuse Mordy's tenant or domain. The entire premise of the campaign — "we drink our own champagne," signed "The Coldrig agent, on behalf of EpiphanyMade" (per the frozen copy) — requires the sending identity to be visibly ColdRig itself. InboxKit Professional's already-purchased 10 Google-mailbox-slot plan has headroom for this: Mordy's pilot needs 2 mailboxes on his domain; a handful more (2-4) on a ColdRig-owned domain fits inside the existing plan with no new vendor spend.

## Batch size + cadence (fresh-domain warmup reality)

The list is small (28 targets, deliberately not padded — per the frozen doc's own note) and the constraint is the **warmup clock, not list size**: even 2-3 fresh mailboxes at conservative week-1 volume (roughly 5-10 sends/day/mailbox, the standard ramp floor for a brand-new domain) could clear all 28 targets in a single day of raw capacity — which is exactly what NOT to do. Recommend:
- **Do not blast the full 28 on day one of a fresh domain.** Stagger into small daily tranches (roughly 5-8/day) spread across the ~4-week warmup ramp already assumed in the frozen doc's own framing ("Sends remain gated on engine + mailboxes + ~4wk warmup").
- Ramp shape: week 1 lowest volume/highest scrutiny recipients (or hold entirely if warmup-provider guidance says seed-only traffic in week 1), week 2-3 increasing volume as deliverability signals stay clean, week 4 clears any remaining tranche. This mirrors the ROADMAP's own documented physics (5 mailboxes ≈ 2.2-3.3k sends/mo ceiling at 15-30/day/mailbox) — 28 targets is trivially small relative to that ceiling, so there's no pressure to compress the timeline.

## Target selection from the 28 (tiered sequencing, not "send to everyone at once")

1. **Tier C first (AI-agent/MCP writers, items 20-28)** — lowest reputational risk, most naturally receptive to the disclosed-agent conceit (it's literally their beat), and any reply or mention directly reinforces the AEO/directory-placement work already underway. Start here.
2. **Tier A second (cold-email/lead-gen creators, items 1-7)** — highest scrutiny (they will read the headers and judge the mechanics) but highest strategic payoff (a positive mention from Alex Berman or Patrick Dang is disproportionately valuable). Send once the domain has some clean sending history from the Tier C tranche, not on day one.
3. **Tier B (adjacent RevOps/growth, items 8-19) — optional, lowest priority, safe to skip or use as warmup-volume filler** if the schedule allows; least differentiated audience for this specific "agent-run outreach" story.
4. **Competitor blogs (Smartlead/Instantly/Lavender) stay excluded** by default, matching the frozen doc's own founder-gated flag (§3.1) — recommend holding that exclusion for the dogfood wave specifically; it reads as attention-bait, not a genuine credibility proof, and a competitor is the least likely recipient to give an honest reaction either way.
5. **Jack Clark/Import AI stays gated on explicit founder sign-off**, exactly as the frozen doc already flags (§3.2) — do not fold this name into a general "go" on the program.

## Disclosure posture

Use the frozen disclosure-forward copy as-is (either body variant; founder's call on tone) — this is a compliance commitment, not just a stylistic choice. The unsubscribe/"no thanks" mechanic promised in the copy must route through the platform's **real** suppression/one-click-unsubscribe path (already live, per ROADMAP), not a manual side-channel — anything else would make the campaign's own disclosure copy dishonest about what happens when someone opts out.

## CAN-SPAM / compliance constraints

- **Must go through the actual product send path** (`launch_campaign` / equivalent tool, real suppression list, real one-click unsubscribe) — a hand-crafted, out-of-product send would prove nothing about the product and would violate the entire "dogfood" premise.
- Physical address requirement is already satisfied — the frozen copy bakes in "209 Crest Hill Road, Toms River, NJ 08755."
- No incentivized replies of any kind (the "roast it publicly" CTA is an engagement hook, not a review solicitation — keep it that way).
- **Boundary to respect, not a blocker:** dogfood targets are press/influencers, not customers. None of them are review-eligible on G2/Capterra from this interaction alone (per Decision 1's solicitation-rules findings — both platforms require genuine product usage/purchase, and G2 explicitly bans sentiment-segmented targeting) — if any convert into genuine product users later, *that* usage would make them review-eligible, but do not conflate "they replied to our cold email" with "ask them for a G2 review."

## Success metrics

- **Reply rate** (any reply) — proves real deliverability and a real human read it.
- **Count of engaged/curious replies** ("show me" requests) — direct engagement with the disclosed-agent conceit, the actual point of the campaign.
- **Unprompted public mentions** (a tweet, a newsletter aside, a "someone cold-emailed me with a disclosed AI agent" post) — this is the real marketing asset the frozen doc anticipates ("also a marketing asset the docs can cite"), more valuable than any single reply, and the natural thing to fold into landing/AEO copy once it exists.
- **Zero spam complaints / zero deliverability degradation on the sending domain** — a hard floor, not a nice-to-have; a bad outcome here damages the domain for the platform's real business, not just the dogfood experiment.
- **Explicit non-metric: demos or signups.** These 28 are press/influencers, not ICP buyers — judging the campaign by conversion would apply the wrong yardstick and make a successful credibility campaign look like a failed sales one.

## How results feed the buyer-panel + review-site loop

- Dogfood targets themselves are **not** the review-site pipeline (see CAN-SPAM section) — Mordy, once his pilot is live and sending real campaigns, remains the correct N=1 candidate for Decision 1's first solicited G2/Capterra review.
- A clean dogfood outcome (replies, an unprompted mention) becomes a citable proof point for landing copy / `agent-evaluation.md` ("we ran our own outreach through our own platform — here's what happened") — a distinct AEO/credibility signal from review-site presence, worth folding into the next copy batch once real results exist.
- Feed the next buyer-panel cycle: if a dogfood target's reaction produces any public commentary, that's exactly the kind of "independently corroborated" evidence the 2026-07-19 buyer-panel transcripts reward and the 2026-07-15 run punished FoxReach for lacking.

---

## Sources

- `tools/buyer-panel/runs/2026-07-19-claude-canonical.md` (G2 4.6/5/306-reviews deciding-sentence evidence, line 143 of transcript)
- `tools/buyer-panel/runs/2026-07-19-claude-agency.md` (ColdRig SURFACED+SHORTLISTED via direct Glama fetch; named in winner's deciding sentence)
- `tools/buyer-panel/CHOICE-TREND.md` (FoxReach killed solely for zero G2/Trustpilot evidence, row 1)
- `docs/research/dogfood-targets-2026-07-14.md` (28-target list, tiering, disclosure copy, founder-decision flags §3.1-3.6)
- `ROADMAP.md` (`## Open`, read 2026-07-21: Mordy pilot arming gaps, InboxKit adapter arming gates (a)-(e), Gmail OAuth Testing-status token churn, standing 2026-07-15 [IDEA] "Independent-review presence" item)
- `company.g2.com/news/g2-acquires-capterra-software-advice-getapp`; `sell.g2.com/create-a-profile`; `sell.g2.com/plans`; `company.g2.com/news/badge-accessibility-changes`; `legal.g2.com/community-guidelines`
- `capterra.com/vendors`; `capterra.com/legal/listing-guidelines`; `capterra.com/legal/community-guidelines`; `capterra.com/legal/ppc-service-description`
- `quoleady.com/llmo-research` (2026-06-04) — the G2/Capterra presence-vs-citation study
- `trustradius.com/products/trustradius-vendors/pricing`; `solutions.trustradius.com/pricing`; `trustradius.freshdesk.com` ("How TrustRadius Acquires Reviews")
- `usehall.com` citation-analysis study; live SERP check for "best cold email software 2026"
- `help.producthunt.com` article 11869098 (vote-integrity); Product Hunt Community Guidelines
- AlternativeTo FAQ (submission/verification/like-ranking policy)
- Direct fetch of ColdRig's own `glama.ai/mcp/servers/YS-projectcalc/agent-cold-email` listing
- Full sub-worker transcripts relayed via team-lead: `g2-capterra-findings.md` and `trustradius-ph-alternativeto-findings.md` (scratchpad, 2026-07-21) — quoted/summarized above with their own VERIFIED/INFERRED/GAP tags preserved.
