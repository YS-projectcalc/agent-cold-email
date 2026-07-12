# Cold Email Retail Pricing Landscape (FROZEN provenance, 2026-07-12)

> Frozen research record — NOT a living doc. Zero-spend desk pass, primary pricing pages fetched 2026-07-12 unless marked [secondary]. Purpose: position ColdStart's draft tiers (Launch $99 / Growth $299 / Scale $799). Conclusions fold into SPEC §18 at pricing sign-off; this file is the receipts. Researched by a budgeted sonnet research worker (8 searches, 10 fetches; Reply.io 403'd, Cleverly pricing 404'd).

## Sending/sequencing platforms (primary sources)

| Vendor | Tier | $/mo (monthly) | $/mo (annual) | Mailboxes | Contacts | Emails/mo | API gate |
|---|---|---|---|---|---|---|---|
| Smartlead | Base | $39 | $32.50 | Unlimited (BYO) | 2,000 | 6,000 | NO |
| Smartlead | Pro | $94 | $78.30 | Unlimited | 30,000 | 90,000 | NO (warmup = $39/mo add-on) |
| Smartlead | Unlimited Smart | $174 | $144.50 | Unlimited | Unlimited | 150,000 | **YES — first tier w/ API+webhooks** |
| Smartlead | Unlimited Prime | $379 | $314.60 | Unl. + 3 SmartServers/OAuth | Unlimited | 500,000 | YES |
| Instantly (Outreach) | Growth | $47 | $37.60 | Unlimited | 1,000 | 5,000 | **YES — API/webhooks on ALL plans** |
| Instantly | Hypergrowth | $97 | $77.60 | Unlimited | 25,000 | 100,000 | YES |
| Instantly | Lightspeed | $358 | $286.30 | Unl. + SISR dedicated IP pools | 100,000 | 500,000 | YES |
| Instantly (Bundle O+L+CRM) | Starter/Scale/Agency | $94 / $194 / $555 | $85 / $175 / $500 | — | 1k / 25k / 100k | 5k / 100k / 500k | YES |
| Instantly | Lead Finder (separate) | $47 (1.5k credits) → $197+ (up to 200k) | — | credit-based | | | |
| Instantly | VIP Managed (their DFY) | **$2,000–$10,000/mo custom** | | | | | |
| Saleshandy | Starter→Scale Plus | $25 / $69 / $139 / $209 | ≈same | Unlimited | 2k→100k | 6k→300k | not stated |
| Woodpecker | usage-based | $7.00 per 100 contacted prospects | (annual discount fig. suspect — reverify) | Unlimited | 500–1M+ | scales | **NO — API/webhooks/MCP = $20/mo add-on** (only vendor explicitly gating "MCP Server") |
| lemlist | Email / Multichannel | $69 / $109 per user | $55 / $87 | Unlimited senders / 5 per user | Unlimited (650M DB) | Unlimited | YES both |
| QuickMail | Starter/Growth/Agency | $49 / $99 / $299 | — | Unlimited | 1k / 25k / 100k | — | Starter NO; **Growth $99 first w/ API** |
| Salesforge | Pro / Growth | $40 / $80 | 2 mo free annual | Unl. email +LI | 1k / 10k active | 5k / 50k | Pro NO; **Growth-only API** |
| Salesforge | Agent Frank (AI path) | $499/mo (qtr/annual) + $416/mo mailbox add-on per 1k contacts | | | 500M DB | | |
| Reply.io [secondary — 403] | Starter/Pro/Ultimate | ~$59 / ~$99 / ~$139 per user | | | | | unconfirmed |
| Reply.io Jason AI [secondary] | 3 tiers | $500 / $1,500 / $3,000 (annual) | | Unlimited | 1k / 5k / 10k active | | |

## AI SDR anchors

- **11x.ai (Alice)** [secondary — publishes nothing, demo-gated]: ~$5,000/mo entry (3k contacts) → $6.5–8.5k/mo → $10–15k+/mo enterprise; Vendr median contract $40,125/yr (range $38,250–$65,550).
- **Artisan (Ava)**: own pricing page (fetched) shows tier names + lead volumes (~2,500 → ~6,000 leads/mo) but **withholds all dollar figures**; [secondary] reports $280/mo Intern, $600–660/mo Employee (sources conflict), $2,000–15,000+/mo upper tiers.

## DFY agencies [all secondary]

Range $2,000–$6,000/mo retainers by depth; anchors: Cleverly reported from $1,995/mo; Belkins $5–15k/mo; SalesHive from ~$4,000/mo (US-based ~$7k). Aggregator flag: retainer = only 60–70% of true cost — domains/data add $500–$2,000/mo + setup fees $1,500–5,000.

## All-in cost, 10 mailboxes / ~5k emails/mo

- (a) **Smartlead + own infra**: Base $39 + warmup add-on $39 + SmartSenders (5 domains × $13/yr + 10 mbx × $4.50/mo) ≈ **$128/mo, no API**; API need pushes to $174 tier ⇒ **≈$224/mo**.
- (b) **Instantly all-in**: Growth **≈$47/mo** (API included; BYO mailboxes external); + $47 Lead Finder if sourcing leads.
- (c) **DFY agency**: **$2,000+/mo** (buys labor, not just software).

## Pricing-model patterns (positioning levers)

1. **API/MCP gating is tier-specific**: Smartlead $174+, QuickMail $99+, Salesforge $80+, Woodpecker $20 add-on (names MCP explicitly); Instantly/lemlist include API broadly. The agent surface is starting to be priced.
2. **Mailbox limits are dead as a SaaS meter** — everyone advertises unlimited accounts; metering moved to volume/contacts. Per-mailbox fees survive only in the infra layer (SmartSenders $4.50/mbx/mo, $13/domain/yr).
3. **Credit-stacking**: leads/verification/enrichment billed separately push real bills to 3–5× headline (multiple sources) → "one flat number" is a differentiator.
4. **AI-SDR opacity**: order of magnitude above sequencers, demo-gated pricing → published self-serve $99–799 visibly undercuts that category while sitting above the $25–97 sequencer entry points.
5. **DFY is 20–100× the software tier** — the $99/$299/$799 draft occupies the empty middle ("agency outcomes at software prices"). Instantly itself prices managed service at $2–10k/mo.

## Could not confirm

Reply.io primary (403; 4-aggregator triangulation only) · Artisan exact $ (withheld on own page) · 11x any primary $ · Cleverly pricing page (404) · Belkins/SalesHive primaries not fetched · standalone third-party infra beyond SmartSenders (covered separately in vendor-costs-mailforge-inboxkit-2026-07-12.md) · Woodpecker annual-discount figure (extraction artifact suspected).

Primary sources: smartlead.ai/pricing · instantly.ai/pricing · saleshandy.com/pricing · woodpecker.co/pricing · lemlist.com/pricing · quickmail.com/pricing · salesforge.ai/pricing · artisan.co/pricing (all fetched 2026-07-12). Secondary: leadhaste, puzzleinbox, amplemarket, marketbetter (Reply.io); getbreakout, marketbetter, vendr (11x); salesrobot, landbase (Artisan); highticketaisystems, prospeo, litemail, saleshive (DFY).
