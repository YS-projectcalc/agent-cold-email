# Mailforge & Inboxkit Cost Structures (FROZEN provenance, 2026-07-12)

> Frozen research record — NOT a living doc. Primary pricing/ToS pages fetched 2026-07-12 (all pages are JS-driven calculators; several re-fetched 2–3× to resolve toggle-state conflicts; direct primary fetch preferred over aggregators on every discrepancy). Purpose: (1) COGS under the DECIDED Mailforge-first path; (2) Inboxkit direct-retail math for the management-service (option c) tier analysis. Supersedes the $7/mbx fully-loaded estimate in vendor-tos-economics-2026-07-09.md FOR THE MAILFORGE PATH (that estimate was Inboxkit-based and still holds for the Inboxkit path).

## ⚠️ HEADLINE FINDING

**Mailforge's advertised $3/mailbox is ~4× below its real all-in cost: warmup is NOT included** (it's the separate Warmforge product at **$10/mailbox/mo**, first slot free). Standalone all-in ≈ **$13.5/active mailbox/mo** — warmup is ~74% of COGS and breaks SPEC §18's 2.5–3× margin model at the planned $13–15 retail line. **Escape hatch (unverified at scale): "Using Salesforge? Warmforge Is Included!" with "unlimited mailbox slots to warm up"** — a Salesforge Growth subscription ($80/mo) would flatten warmup COGS to ~$0 marginal. Whether "unlimited" survives reseller-scale fair-use is now a Gate-1 activation verification item.

## Mailforge (mailforge.ai, primary)

- **Slot billing confirmed** (ToS + pricing verbatim): "charged based on the number of slots, not the number of active mailboxes"; **minimum 10 slots**.
- Slot price (from 25-slot calculator state): **$3.00/slot/mo monthly billing; $2.40/slot/mo yearly** (flat 20% off). [Discrepancy: woodpecker.co blog claims $3.75/$2.50 — primary fetch treated as authoritative.]
- Domains: **$14/domain/yr** (.com). Optional SSL/domain-masking $2/domain/mo (monthly) or $6/domain/yr.
- Included: automated DNS, support, hosting. **NOT included: warmup, API not listed.**
- **Warmup = Warmforge** (warmforge.ai): **$10/slot/mo** (monthly/quarterly consistent; annual "2 months free" — exact annual digit unextractable from JS toggle); 1 slot free. **Salesforge bundling: Warmforge included w/ unlimited warmup slots** (verbatim) — the load-bearing unverified-at-scale lever.
- **API ambiguity**: pricing page omits API from included features; secondary sites claim "no API"; **Mailforge's own ToS presupposes it** ("limit your API calls to a reasonable volume" — no numeric limits, no tier gates; Mailforge has no named tiers at all). → direct support confirmation required before modeling API reliability (activation item).
- **Sub-accounts (reseller mechanism, ToS primary)**: "You must use sub-accounts to separate email traffic of your own clients"; "indirect Mailforge subscriber… managing and/or reselling Mailforge to your clients." No published extra fee (inferred from absence).
- Shared IP: no pool sizes published. Dedicated IP = sibling **Infraforge**: $4.00/slot/mo quarterly ($3.32 yearly), min 10 slots, $14/domain/yr, **dedicated IP $99/IP/mo**, Masterbox workspace layer $7–9/workspace/mo, **API explicitly included**. [White-label $4→$2.50/mbx figure: secondary only.]
- Deliverability: Mailforge publishes no self-reported placement numbers. [Competitor-authored, bias-flagged: Inboxkit's comparison claims Mailforge 63% avg placement / 23% spam (54–72% variability) vs own 82%/8% — unverified.]

### Mailforge all-in COGS per ACTIVE mailbox/mo
(assumptions: linear slot pricing from 25-slot example; Warmforge standalone $10; domains $14/yr amortized at vendor-recommended 2–3 mbx/domain; SSL add-on excluded)

| Slots | Slots (mo/yr billing) | Warmforge | Domains | All-in monthly-billed | All-in yearly-billed | **Per-mailbox** |
|---|---|---|---|---|---|---|
| 10 | $30 / $24 | $100 | ~$4.67–5.83 | ~$135 | ~$129 | **$13.47–13.58 / $12.87–12.98** |
| 50 | $150 / $120 | $500 | ~$23–29 | ~$673–679 | ~$643–649 | same per-mbx (linear) |
| 200 | $600 / $480 | $2,000 | ~$93–117 | ~$2,693–2,717 | ~$2,573–2,597 | same per-mbx (linear) |

**Scenario B (Salesforge bundle verifies):** ≈ $3.00 slot + ~$0 warmup marginal + ~$0.47–0.58 domains ≈ **$3.5–3.6/mbx marginal + $80/mo fixed** (Salesforge Growth) — restores >2.5× at a $12–15 retail line.

## Inboxkit direct-retail (inboxkit.com, primary) — the option-c pass-through math

Tiers: **Professional $31/mo base (10 slots incl.)** + $3.10/addl mbx annual ($3.50 monthly) · **Agency $81/mo (30 incl.)** + $2.70 ($3.25) · **Enterprise $250/mo (100 incl.)** + $2.50 ($2.99). **Base platform fee does NOT change with billing period** (verified via toggle probe) — only per-additional-mailbox rates carry the "save 20%". Add-ons: **warmup $3/mbx/mo**; InfraGuard 1st month free (ongoing price unpublished); $30/Azure tenant (M365 only). **API + webhooks included on ALL plans** (no tier gate). No domain sales found (page silent).

| Mailboxes | Cheapest tier | Platform | Addl mbx | Warmup | **All-in/mo** |
|---|---|---|---|---|---|
| 5 | Professional (10-slot floor) | $31 | $0 | $15 | **$46** ($9.20/mbx) |
| 10 | Professional | $31 | $0 | $30 | **$61** ($6.10/mbx) |
| 50 | Agency + 20 addl | $81 | $54–65 | $150 | **$285–296** (~$5.70–5.90/mbx) |

Note: at 50, Enterprise ($250 base) is WORSE than Agency+20 until utilization nears its 100-slot ceiling.

## Spot-checks

- **Maildoso** (primary, fetched 2×): 30 mbx = $75/mo (**$2.50/mbx**); 300 = $225; 1,000 = $499. **No ~100 tier** (30→300 jump; in-app custom packages "from $0.49/mbx" unverifiable without login). Domain $12/yr, not bundled on monthly plans.
- **Zapmail** (primary; /pricing 404s — pricing on root): Starter $39/mo (10 Google mbx, +$3.50/mbx) · Growth $99 (30, +$3.25) · Pro $299 (100, +$3.00, **API exclusively at this tier**).

## Gotchas (billing traps)

1. Slot billing ≠ active billing (Mailforge + Infraforge): deleting mailboxes never reduces the bill.
2. 10-slot minimums (both).
3. Annual prepay no-refund + 7-day cancel notice (Mailforge/Salesforge ToS).
4. Warmup excluded from Mailforge's $3 headline (~3× the slot cost via Warmforge; dominant COGS line unless Salesforge-bundled).
5. Inboxkit platform fee is a fixed floor (5 active mailboxes still pay full $31 Professional).
6. Inboxkit warmup ($3/mbx) is an add-on, not in the headline rate.
7. Zapmail API gated to $299 Pro only.
8. Maildoso's 30→300 tier cliff.
9. Domains are a hidden per-domain line ($14/yr; 2–3 mbx/domain guidance) — real secondary cost driver.
10. Mailforge API: ToS confirms existence, pricing page omits it — support inquiry before relying on it (only Infraforge lists API as included).

## Unconfirmed

Warmforge exact annual rate · Mailforge slot-price linearity at 10/200 (extrapolated from 25) · InfraGuard ongoing price · Infraforge white-label exact rates · Maildoso custom-package rate at 100 · Mailforge IP pool sizes.

Sources (all accessed 2026-07-12): mailforge.ai/pricing · mailforge.ai/terms · mailforge.ai/deliverability · warmforge.ai/pricing · infraforge.ai/pricing · inboxkit.com/pricing · maildoso.ai/pricing · zapmail.ai (root) · [secondary] inboxkit.com/learn/mailforge-review, woodpecker.co/blog/mailforge-pricing, infraforge.ai/whitelabel.
