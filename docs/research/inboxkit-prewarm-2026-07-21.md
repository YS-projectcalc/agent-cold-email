# InboxKit prewarm mechanics — research (2026-07-21)

> Grounded in: `ROADMAP.md` ## Open 2026-07-20 "Mordy pilot — InboxKit runway" entry (Professional $39/mo purchased, 10 Google slots, wallet 0 credits, workspace "Starter") + `SPEC.md` §12/§12.1/§13/§18 (economics, prior pre-warmed-inventory analysis on the now-superseded Mailforge/Warmforge cost basis). This doc answers the founder's live question and redoes §12.1's math on InboxKit's actual numbers.
>
> Sourcing convention: **VERIFIED** = fetched directly from an InboxKit-owned surface (docs.inboxkit.com API reference, inboxkit.com pricing/learn pages) with a quote or close paraphrase. **INFERRED** = reasoned from verified facts but not itself stated anywhere. **THIRD-PARTY** = independent review/comparison sites (not InboxKit-authored) — treated as corroborating, not primary.

---

## 1. What POST /prewarm/buy-domain actually buys

**VERIFIED** (docs.inboxkit.com/buy-prewarmed-mailboxes-22248586e0, OpenAPI spec):

- Endpoint: `POST https://api.inboxkit.com/v1/api/prewarm/buy-domain`, header `X-Workspace-Id` required.
- Body: `domains[]` array, each entry needs either `domain_id` **or** `domain_name`. Spec text: *"Must have either domain_id or domain_name"*; `domain_id` is described as *"Id of the domain (from search results)"*; `domain_name` is *"alternative to domain_id"* with no further constraint documented.
- Optional per-domain `mailboxes[]` array (username/display-name/profile-picture customization), optional `sequencer_uid` to auto-assign into a sequencer, `keep_warming` boolean — **defaults true**, and the spec explicitly says it continues warming *"for up to 12 weeks"* post-purchase.
- Response returns `total_price` denominated in **credits**. The docs' own worked example: **3 mailboxes across 2 domains = 24 credits.**
- Separately, third-party review coverage (see §2) and search-engine indexing of InboxKit's own site describe a dashboard **"Prewarm Inventory"** section, and one indexed snippet from InboxKit's own content reads *"Search from all available prewarm mailboxes."*

**What this means, reconciled:** the `domain_id … from search results` phrasing plus the "Search from all available prewarm mailboxes" line both point to the same model — `domain_id` refers to an entry in InboxKit's **own existing inventory** of domains they have already registered and run through warmup traffic, not a fresh-name lookup against the open registrar market. You browse/search that inventory and buy a specific already-aged domain+mailbox bundle. The `domain_name` alternative parameter is **not clearly documented as accepting an arbitrary customer-owned domain string** for this endpoint — it reads more like a way to reference a specific known inventory domain by name instead of by id, consistent with everything else on this page. No sentence anywhere in the fetched docs says "type in your own domain and get it prewarmed."

**This is confirmed by InboxKit's own honesty framing** (VERIFIED, inboxkit.com/learn/pre-warmed-google-workspace-accounts): *"Customers select from existing inventory rather than providing their own domains. Pricing correlates with domain age."* And separately: pre-warmed accounts are *"a real, admin-accessible Gmail business mailbox[es] on a real domain that has been run through 14-16 days of warmup traffic on an isolated network before you take delivery."* This is mechanically identical to what SPEC §9 already calls the "time-shift trick" — the vendor ran the clock on a domain of *their* choosing before you existed as a customer. It cannot be otherwise: warmth is accumulated sending/engagement history bound to a specific domain+mailbox identity; there is no way to backdate that history onto a domain you already own and have never sent from.

One inboxkit.com/learn page (buy-pre-warmed-email-accounts-guide) also lists a "Bring Your Own Domain" bullet under InboxKit's purchase flow, worded as *"You provide the domain; InboxKit configures it with pre-warmed mailboxes from their inventory."* Read literally this is internally contradictory (a domain can't inherit warmth from a different domain's history), and it directly conflicts with the sibling learn page's *"select from existing inventory rather than providing their own domains."* Most likely reading: that bullet describes InboxKit's **ordinary** (non-prewarm) provisioning flow — bring a domain, InboxKit sets up **fresh** mailboxes on it that then warm normally — mislabeled by that particular marketing page's copy, not a second, contradictory route into the *actual* prewarm-buy-domain product. Flagging this as an unresolved copy inconsistency on InboxKit's own site rather than resolving it in our favor.

### Direct answer to "can we use it on any domain and it's prewarmed?"

**No.** `authorpitchdesk.com` (or any domain a customer already owns) cannot be run through this endpoint and come out prewarmed. Prewarming only comes attached to a domain InboxKit already owns and has been quietly warming in its own inventory; buying it hands you a **different domain name** than the one you wanted, with domain-transfer/ownership moving to you after purchase. Your own domain still has to run the real ~2–4 week clock (SPEC §9) the ordinary way — nothing shortens that for a domain you bring.

Are the inventory domains "lookalike-nameable" (can you pick a name close to your brand)? **No evidence of that anywhere.** They're vendor-registered generic domains that existed before knowing who'd buy them — inventory-pick only, not brand-generated. This directly matches the concern already flagged in `SPEC.md` §12.1(b): *"Pre-warmed stock is necessarily on vendor-owned/generic domains… tenant-adjacent domains are what a sender wants."*

---

## 2. Pricing: credits, per-mailbox tiers, age/quality claims

**VERIFIED (first-party, inboxkit.com/learn — marketing copy, not the strict API reference)**, cross-cited by three independent scrapes converging on the same numbers:

| Warmup age tier | Price | 
|---|---|
| 2–4 weeks warmed | **$6/mailbox** |
| 4–8 weeks warmed | **$7/mailbox** |
| 8+ weeks warmed | **$9/mailbox** |

Plus **domain transfer costs separately** (example given: .com = **$15**). Ships with SPF/DKIM/DMARC already configured, connects to a sequencer immediately. Recommended **first-day send volume is conservative regardless of pre-warm status**: *"Start sending at 20-30 messages per mailbox per day. Ramp by 10% per day over the first week"* — i.e. InboxKit does **not** claim prewarmed = immediate max-volume sending, only immediate *eligibility* to start the ramp instead of waiting weeks to start it.

**Credits-to-dollar conversion: UNVERIFIED.** No public page states 1 credit = $X. The one concrete data point is the API doc's own worked example (24 credits = 3 mailboxes/2 domains). If the $6–9/mbx + $15/domain-transfer figures above are the real basis, that combination could range roughly $27–48 depending on tier, which doesn't cleanly divide into "24" at any obvious round number — suggesting either the example used a cheaper/promotional tier, the $6-9 figures are a rounded marketing simplification of the true credit-metered price, or transfer cost isn't part of that particular example. **INFERRED, not confirmed:** wallet credits are most likely $1-denominated USD (consistent with "credits are consumed as mailbox renewals and other services are processed" and separately-quoted cent-level pricing elsewhere on the pricing page, e.g. "Inbox Placement Tests at just 5 cents each"), but treat this as a planning estimate only — **confirm with a real top-up or a support ticket before quoting a customer-facing margin on it.**

**Honest quality caveat (VERIFIED, InboxKit's own copy):** *"Self-warmed mailboxes on an isolated network produce slightly better first-month inbox placement than pre-warmed on the same network."* Pre-warmed buys **speed**, not superior long-term quality — matches SPEC §9's own stance almost verbatim. Separately: *"Pre-warming handles the initial reputation ramp, but ongoing spam folder risk is dominated by list quality, message copy, and volume discipline"* and pre-warmed inboxes carry **no placement/deliverability/compliance guarantee** (this exact disclaimer is also how competitor Warmforge frames it — an industry-standard caveat, not InboxKit-specific).

---

## 3. Warmup add-on ($3/mbx/mo) — mechanics

**VERIFIED**, converging across InboxKit's own API-integration guide and third-party reviews:

- **Pool type: isolated, not shared.** *"Isolated warmup keeps each mailbox independent, and each mailbox builds its own reputation without sharing engagement signals with other users."* This matters directly against SPEC §9's warning that shared/public pools are discounted by Gmail/MS (closed-loop-graph + datacenter-IP detection) — an isolated-per-mailbox pool is the higher-quality kind SPEC already flags as preferable (+20-30% vs public pools).
- **Ramp:** AI-powered, ~14 days, smart volume ramp from **2 to 40 emails/day**.
- **API surface:** a dedicated "Warmup" category among InboxKit's *"70+ public endpoints across 14 categories"* (confirmed categories list also includes Domains, Mailboxes, Cloudflare, Webhooks, DNS, Tags, Inbox Placement, InfraGuard, Email Insights, and Prewarm as separate categories — Warmup and Prewarm are **distinct** product lines, not the same feature). The guide references *"Warmup subscriptions"* (plural, per-mailbox), implying it's toggleable per mailbox rather than an account-wide switch, and `GET /warmup/pricing` (already known from the prior session, per ROADMAP) is the pricing-lookup endpoint. **Exact start/stop/target-volume parameter names were not independently re-verified in this pass** — confirm against the live OpenAPI spec at arming time rather than assuming REST shape.
- **When to turn it off:** the natural point is once the mailbox has cleared the ramp and is running on real campaign traffic that itself generates enough reply/open signal — SPEC §9's own framing ("maximize REAL replies via the customer's actual campaigns — the unbeatable signal") applies directly; running paid synthetic warmup traffic in parallel with genuine campaign sends past the ~4-week mark is spend without much marginal benefit once real engagement exists.

---

## 4. Pilot recommendation — Mordy, authorpitchdesk.com, Instantly deadline 07-28

**Constraint recap:** Mordy's Instantly subscription renews ~2026-07-28 (7 days out). `authorpitchdesk.com` is a bare domain (zero DNS records confirmed 07-21) that will need real DNS setup + ~2–4 weeks of natural warmup once mailboxes are provisioned on it — and that provisioning itself is still gated on getting either nameserver-delegation or a Cloudflare API token from whoever holds the zone (separate open item, not resolved by this research).

**Options:**
1. **Do nothing extra** — wait for authorpitchdesk.com's own DNS/warmup clock. Risk: Mordy has effectively zero real send capability before Instantly renews, undermining the stated goal of testing the regular self-serve flow end-to-end before that date.
2. **Buy 1 prewarmed domain (2–3 mailboxes) from InboxKit's Prewarm Inventory now**, run the pilot's first sends from it immediately, while authorpitchdesk.com warms in parallel on the normal clock — then cut sends over once the branded domain clears warmup.
3. Buy 2 prewarmed domains for redundancy/higher volume — same trade-offs as (2), roughly double cost, and doubles the number of unfamiliar domains a prospect might see.

**Cost estimate for option 2 (2 domains only if going that route):**
- Mid-tier (4–8wk, $7/mbx) × 2 mailboxes = $14, + one domain transfer (~$15 for .com) ≈ **~$29** for one domain/2 mailboxes.
- Cheapest defensible tier (2–4wk, $6/mbx) × 2 mailboxes + transfer ≈ **~$27**.
- If InboxKit's own 24-credit example is closer to real-world cost at $1/credit (unverified), a comparable bundle could land materially lower (~$24 for 3 mbx/2 domains).
- **Ballpark: $25–35 for one domain, ~2 mailboxes** — trivially small next to the $39/mo already being paid for the Professional plan, and a rounding error against the value of not losing pilot momentum before the Instantly deadline.

**Deliverability trade-off, stated plainly:** the recipient will see mail arriving from a domain that has **no visible connection to "Author Pitch Desk"** — it's whatever generic name InboxKit had in inventory, not a lookalike of Mordy's brand. That's a real trust/legitimacy cost SPEC's whole lookalike-domain design (§8) exists to avoid. It is mitigated, not eliminated, by keeping the branded name/signature/reply-to consistent even though the envelope domain isn't brand-matched, and by treating it explicitly as a **temporary bridge**, not the permanent sending identity.

**Recommendation:** buy **one** prewarmed domain (not two) at the 2–4 or 4–8 week tier, 2 mailboxes, ~$27–29 all-in, to get Mordy sending inside the 07-28 window — while authorpitchdesk.com's DNS connection (still gated on the registrar/CF-token ask) proceeds in parallel on its normal clock, and cut sends over to the branded domain the moment it clears. Don't buy a second domain up front; only add one if 2 mailboxes' worth of volume (InboxKit's own guidance: 20–30 sends/mbx/day ramping — roughly 40–90/day combined by end of week 1) proves insufficient for whatever volume the pilot actually needs. This is real vendor spend (~$27–29) on top of the existing comped-pilot posture — **flag for founder sign-off before purchase**, same as the "optional 1–2 lookalike spreads" item ROADMAP already carries as a deferred founder call. This research answers that deferred call: **yes, worth doing, one domain, ~$30, temporary bridge only.**

---

## 5. Product question — offer "prewarmed start" as a SKU to all customers?

**Wholesale basis (this vendor, this session):** ~$6–9/mailbox one-time by age tier + ~$15/domain transfer (all-in for a 2-mailbox/1-domain bundle: **~$27–33** at the top tier). This *replaces* — doesn't stack with — the ~2–4 week span the $3/mbx/mo warmup add-on would otherwise run for that box, since the box is bought already past that stage.

**Competitor landscape (how the market prices instant-start), all THIRD-PARTY/first-party-marketing sourced, not independently spend-verified:**

| Vendor | Prewarm offering | Pricing posture |
|---|---|---|
| **InboxKit** (our vendor) | Tiered by domain age, dashboard inventory browse | $6/$7/$9 per mbx (2-4/4-8/8+ wk) + domain transfer |
| **Zapmail** | Pre-warmed inventory, claims 12wk warmup | Pricing **not publicly listed** — quote/gated |
| **ScaledMail** | Add-on, one-time 14-day warmup | $2–3/inbox one-time |
| **Superwave** | Warmup **bundled at every tier** (no separate a-la-carte charge) | Differentiator vs ScaledMail/others; effective per-inbox ~$1-2 higher than comparable pre-warmed Google Workspace |
| **Maildoso** | **No genuine prewarm product** — customer's own sequencer (Smartlead/Instantly) runs warmup, not Maildoso itself | N/A |
| **Mailforge** | Shared-IP infra, lower placement (~63% vs InboxKit real-account ~82%, per InboxKit's own comparison — take the specific numbers with a grain of salt as vendor-vs-competitor marketing, but the shared-IP-vs-real-account quality gap direction is consistent across independent sources) | $3/slot baseline + Warmforge $10-12/inbox/mo warmup |

**Every vendor that offers this treats it as a narrow, extra-cost SKU layered alongside normal provisioning — never a default-bundled feature, never marketed as replacing real branded-domain warmup.** Even Instantly (per the prior byo-domain-verification-2026-07-14 research already in this repo) ships "Pre-Warmed Domains & Accounts" as a supplement, not instead of, BYO-connect/DFY-fresh.

**Suggested retail, applying the platform's own 2.6–3.3x target margin (SPEC §12/§18):** on a ~$27–33 wholesale bundle (1 domain, 2 mailboxes, top tier), retail lands around **$70–110** for that bundle, or framed per-mailbox at roughly **$20–30/mailbox one-time** (2.6-3x on the $7-9 wholesale ceiling, domain-transfer cost amortized in or passed through near-cost since it's a one-time pass-through the customer would otherwise pay directly anyway).

**Honesty constraints (non-negotiable, per SPEC's own "never market warmup as magic" principle and CLAUDE.md anti-slop/claim-accuracy discipline):**
1. Must disclose the mailbox/domain is **vendor-prewarmed on a non-branded, inventory-picked domain** — not the customer's chosen brand lookalike, and not their own domain sped up.
2. Must disclose **no placement/deliverability guarantee** — matches InboxKit's own disclaimer and the industry-standard framing (Warmforge uses near-identical language).
3. Must disclose that **self-warmed mailboxes on an isolated network slightly outperform pre-warmed ones after the first month** (InboxKit's own admission) — it buys speed, not a permanently better mailbox.
4. Must NOT claim "instant full-volume sending" — same conservative ramp (20-30/day day 1, +10%/day) applies regardless of prewarm status.

**Recommendation: yes, offer it — as an optional "Instant Start" add-on SKU, not a default/bundled feature**, priced roughly **$20–30/mailbox** (or a flat bundle price ~$70-110 for a starter domain+2mbx package), with the four disclosures above surfaced at time of purchase (dashboard + MCP tool description both). This reuses the InboxKit vendor plumbing already being built (no new vendor integration needed — same adapter, different endpoint), matches how every serious competitor in this space packages the same capability, and gives coldrig a legitimate answer to the exact "how fast can I start sending" question the buyer-panel runs (`ROADMAP.md` buyer-panel entries) keep surfacing as a comparison point. Fold into the pricing/SKU design alongside the existing quantity-billing migration (`ROADMAP.md` 2026-07-19 founder rulings batch) rather than as a separate pass — same billing surface, one more line item.

---

## Sources

- https://docs.inboxkit.com/buy-prewarmed-mailboxes-22248586e0 (API reference — prewarm/buy-domain)
- https://docs.inboxkit.com/register-domains-18118349e0 (API reference — domains/register, for contrast)
- https://www.inboxkit.com/learn/buy-pre-warmed-email-accounts-guide (first-party marketing/education)
- https://www.inboxkit.com/learn/pre-warmed-google-workspace-accounts (first-party marketing/education)
- https://www.inboxkit.com/learn/inboxkit-api-integration-guide (first-party — API overview, endpoint categories)
- https://www.inboxkit.com (pricing page, fetched 2026-07-21 — showed $31/mo Professional; **our own purchase per ROADMAP was $39/mo, and multiple third-party reviews independently confirm $39/mo** — the $31 figure is likely an annual-billing-equivalent rate mislabeled on that scrape, not resolved further in this pass)
- https://www.infraforge.ai/blog/inboxkit-review (third-party review — plan pricing corroboration)
- https://coldemailkit.com/tools/inboxkit (third-party review — plan pricing corroboration, notes no credits system on base plans)
- https://www.aerosend.io/review/inboxkit/ (third-party review)
- https://maildoso.ai/pricing, https://www.inboxkit.com/learn/maildoso-pricing, https://litemail.ai/blog/maildoso-alternative-2026-actually-pre-warmed-inboxes-vs-fresh-inboxes (Maildoso pricing/no-native-warmup)
- https://www.mailforge.ai/, https://www.warmforge.ai/, https://www.inboxkit.com/learn/mailforge-review (Mailforge/Warmforge pricing + placement comparison)
- https://www.scaledmail.com/pricing, https://www.inboxkit.com/learn/scaledmail-review, https://puzzleinbox.com/blog/scaledmail-review-2026-honest-verdict/ (ScaledMail prewarm add-on pricing)
- https://puzzleinbox.com/blog/superwave-review-2026-honest-verdict (Superwave bundled-warmup positioning)

No InboxKit account/credential access was used — all findings are from public docs/marketing/review pages. Nothing was purchased or spent in the course of this research.
