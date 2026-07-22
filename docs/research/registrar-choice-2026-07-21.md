# Registrar choice for fresh sending-domain purchases — 2026-07-21

> Research for the founder-delegated question: which registrar is the DEFAULT for the "customer brings nothing" shape (we buy the lookalike domain on the tenant's behalf), and how does it reconcile with InboxKit (the decided mailbox vendor, whose domain-buy API we already built as a dark adapter). VERIFIED = fetched/searched this session. INFERRED = my synthesis from VERIFIED facts, not itself sourced.

## 1. Grounding — the contradiction and the coupling defect

**ACTIVATION.md:9** (Gate 0, resale legal model — mailbox-scoped ruling): "**CORRECTED 2026-07-20 (primary-source re-read) — FOUNDER RULING: "go inboxkit (fix this everywhere)".** ... **InboxKit is now the decided activation-time vendor** (Professional tier, $31/mo, 10 slots, monthly billing, cancel-anytime effective end-of-period) — Mailforge demoted to researched FALLBACK only."

**ACTIVATION.md:25** (Gate 2, live keys — still-Namecheap/Porkbun registrar line): "**Registrar account + card** — Namecheap (confirmed buy-domain API) or Porkbun (confirm purchase endpoint w/ support); real `DomainPort` adapter coded, unactivated."

These two lines were never reconciled after the 07-20 InboxKit ruling. **ROADMAP.md line 23** (Mordy-pilot arming-gate finding (a)) names the resulting code defect precisely: "domain port is welded to the same `inboxKitConfig` credential as the mailbox port (`factory.ts:142`) — an armer supplying the mailbox credential silently co-arms InboxKit as registrar, contradicting ACTIVATION.md:9's mailbox-scoped ruling vs ACTIVATION.md:25's still-Namecheap/Porkbun registrar line; needs a separate explicit domain-port arming flag + FOUNDER reconciliation."

**Verified directly against the code** (`apps/platform/src/vendors/factory.ts:136-145`):
```ts
domain: inboxKitConfig ? new RealInboxKitDomainPort(inboxKitConfig, inboxKitDomainRegistrant) : new RealDomainPort(),
mailbox: new RealMailboxPort(inboxKitConfig),
```
`inboxKitConfig` is one parameter, reused for both ports (doc comment at line 94-101 confirms: "Reused for BOTH the mailbox port and (if selected) the domain port — one InboxKit vendor account"). There is no independent gate for the domain port — supplying the mailbox credential to arm InboxKit mailboxes automatically flips the registrar to InboxKit too, with no separate opt-in. The code comment at line 138-141 still says "Porkbun stays the default registrar path (SPEC.md §11/§12, ACTIVATION.md:25) unless a dedicated InboxKit domain config is supplied" — but there IS no dedicated InboxKit domain config; it's the same var.

**Also found, not previously flagged:** `apps/platform/src/vendors/real/domain-port.ts:4` labels `RealDomainPort` itself as Porkbun ("Real DomainPort (Porkbun) — coded to the interface shape, never called"), throwing `NotActivatedError("porkbun", ...)` on every method. This contradicts SPEC.md §13's own correction ("Porkbun's domain-purchase endpoint is undocumented → buy-domain real adapter uses Namecheap as the confirmed fallback"). So today's `RealDomainPort` is a stub for a registrar (Porkbun) that SPEC itself already ruled out — it was never rebuilt against Namecheap. Whatever this doc recommends, `RealDomainPort` needs an actual rewrite, not just an activation flag flip.

**SPEC.md §12** (economics): domains are bundled into per-mailbox COGS at ~$0.50/mbx amortized (no separate SKU), at a ratio of roughly 1 domain per 2-3 mailboxes. That implies a domain budget of roughly $12-18/yr per domain to stay inside the envelope (0.50 × 12mo × 2.5 mbx/domain ≈ $15/yr).

**SPEC.md §13** (vendor shortlist / resale-permission gate): already found Porkbun's purchase endpoint undocumented, named Namecheap as the confirmed fallback registrar, and separately found InboxKit's own ToS grants only "internal business operations, non-transferable" use with no resale carve-out — the same legal gap this research reconfirms independently below (§2).

---

## 2. InboxKit as registrar

**VERIFIED** (WebFetch, `docs.inboxkit.com/register-domains-18118349e0`, 2026-07-21):
- Endpoint: `POST /v1/api/domains/register` at `https://api.inboxkit.com`.
- Required registrant/WHOIS fields: `first_name, last_name, email, address_line1, city, state, country, postal_code` (optional: `phone`, `organization`, `address_line2`).
- Payment: Stripe checkout session OR wallet balance; domains registerable for 1-10 years.
- Per-domain pricing is NOT disclosed in the docs page itself (response returns `total_cost`/`domains_count`, not a rate card). Domain monitoring add-on (InfraGuard) is $3/domain (per WebSearch synthesis of inboxkit.com marketing pages, not the API docs — lower confidence).
- Supported TLDs: not documented on this page.
- What happens to a registered domain on cancellation, and who is registrant-of-record (customer vs InboxKit as the org-of-record) — **not addressed anywhere in the API docs page.**

**VERIFIED** (WebFetch, `www.inboxkit.com/terms-of-service`, 2026-07-21):
- License scope: "InboxKit grants users a non-exclusive, non-transferable, limited license to use the services for their internal business operations" — **no resale/agency carve-out**, matching (and independently reconfirming) SPEC.md §13's prior finding about InboxKit's mailbox ToS. This is the SAME legal gap already flagged for InboxKit-as-mailbox-vendor, and it applies equally to InboxKit-as-registrar since it's one ToS covering the whole account.
- Domain ownership/registrant-of-record: **not addressed.**
- Cancellation: "Users may terminate their subscription at any time, with termination taking effect at the end of the current billing period" — silent on domain/mailbox disposition after that point.
- "Smartlead" does not appear in this ToS document (a WebSearch synthesis pass surfaced a stray line claiming "InboxKit mailboxes and domains are exclusive to Smartlead and non-transferable" — **could not confirm this in the actual ToS text via direct fetch; treat as UNVERIFIED/likely search-synthesis noise, not a real clause**, but flag it for a human skim of the live ToS page before relying on InboxKit-as-registrar in any capacity).

**Net on InboxKit-as-registrar:** the domain-ownership/portability question is not merely unresolved — it's **unaddressed** in both the API docs and the ToS, which is worse than "restricted." Coupling it to the same account as the mailbox vendor (as the code does today) means a single unresolved legal question (the internal-business-only license) now gates BOTH the domains AND the mailboxes together — if that gap turns out to bite, the tenant loses both at once, with no independent registrar relationship to fall back on.

---

## 3. External registrars with APIs

### Porkbun — VERIFIED, disqualified as a purchase-API candidate
- `.com` pricing: $11.08/yr flat (register = renew = transfer, no first-year teaser cliff) — cheapest of the three. Source: porkbun.com/products/domains, priceworld.com/domains/porkbun (2026-07-21 search).
- API: confirmed (independently, corroborating SPEC §13) that Porkbun's public API is scoped to DNS record management and pricing/availability lookups — **no documented general-purpose domain purchase/register endpoint** as of this session. Source: kb.porkbun.com articles + Postman Porkbun collection, searched 2026-07-21.
- Verdict: matches the existing SPEC.md §13 finding exactly. Porkbun stays disqualified for the buy-domain adapter; only useful (if at all) for DNS-only use cases.

### Namecheap — VERIFIED, functional and industry-proven
- API: `namecheap.domains.create` is a real, documented registration endpoint (with `AddFreeWhoisguard=yes`/`WGEnabled=yes` for free WHOIS privacy). Source: Namecheap KB, searched 2026-07-21.
- Account gating: API access requires ONE of — 20+ domains under the account, $50+ balance, or $50+ spend in the last 2 years — plus a mandatory IPv4-only IP whitelist before calls will work. Rate limits: 50/min, 700/hr, 8,000/day. Sandbox environment exists for testing before production (production calls draw from account balance immediately). Source: Namecheap API FAQ/KB, searched 2026-07-21.
- Reseller/bulk posture: no formal "reseller program" product, but reseller PRICING and white-label use via the same API is available on request (contact Namecheap to activate). Source: Namecheap KB, searched 2026-07-21.
- ToS/AUP risk: Namecheap's Acceptable Use Policy explicitly requires CAN-SPAM compliance and prohibits "transmission of unsolicited bulk email in violation of law" as suspension grounds, and Namecheap can reject or discontinue a registration within 30 days "for any reason." Source: namecheap.com/legal/hosting/aup, searched 2026-07-21. **INFERRED risk**: coldrig's own sends are CAN-SPAM-compliant permission-based outreach (not "unsolicited" in the legal sense), but a domain portfolio that visibly reads as "lookalike domains for cold email" at scale is exactly the pattern this AUP language targets on its face — a manual abuse review could conflate compliant cold email with prohibited spam. This is a real but manageable posture risk, not a hard blocker — reinforced by §4 below (Smartlead's SmartSenders already runs this exact pattern at industry scale on Namecheap without documented mass account terminations found in this search).

### Cloudflare Registrar — VERIFIED, new but structurally well-fitted
- Registrar API launched in beta ~2026-04 (blog.cloudflare.com/registrar-api-beta, domainnamewire.com 2026-04-15 coverage). Source: WebSearch 2026-07-21.
- Requirements: Cloudflare account ID, an API token with Registrar write permissions, a billing profile with a valid default payment method, a default registrant contact configured on the account, and acceptance of the Domain Registration Agreement. Source: developers.cloudflare.com/registrar/registrar-api/, fetched 2026-07-21.
- Supported now: Search (candidate names), Check (real-time availability/pricing, up to 20 domains/request), Register (usually completes synchronously in seconds; falls back to a pollable 202 workflow for longer registrations).
- **NOT yet supported via API** (dashboard-only for now): renewals, transfers, contact updates. Source: same page, fetched 2026-07-21.
- Pricing: at-cost, no markup — `.com` at $10.44/yr (register = renew, no cliff). 390+ TLDs supported overall (not all necessarily in the API beta's subset — the docs explicitly warn "only a subset of supported Cloudflare Registrar extensions are available through the API beta"). Source: multiple domain-pricing trackers + Cloudflare's own registrar page, searched 2026-07-21.
- **Structural fit**: any domain registered through Cloudflare Registrar becomes a Cloudflare DNS zone automatically, which means SPF/DKIM/DMARC/tracking-record automation rides Cloudflare's own mature, long-proven DNS/Zones API — the SAME API surface coldrig already authenticates against for `coldrig.dev` itself (wrangler-authed on this machine). This is a materially different (better) integration story than Namecheap or InboxKit, where DNS automation is a separate API surface to build and maintain. (INFERRED: not independently verified that `RealDnsScanPort`/the DNS-doctor code path already targets Cloudflare's DNS API — worth a quick grep before committing to this as a synergy claim in a build ticket, but it is a reasonable expectation given coldrig's existing CF-only infra footprint.)

---

## 4. Incumbent practice

**VERIFIED**, Smartlead SmartSenders: "SmartSenders integrates with Namecheap's API, allowing you to purchase domains and mailboxes in one click — right from your Smartlead dashboard," with SPF/DKIM/DMARC auto-configured, ~24-48hr setup. Source: smartlead.ai/blog/buy-domains-mailboxes-smartsenders-guide, smartlead.ai/email-account-setup-smartsenders, searched 2026-07-21. This directly confirms the brief's premise and is the strongest evidence that a Namecheap-API buy-domain flow for cold-email-adjacent lookalike domains is an established, non-exotic pattern at incumbent scale.

**VERIFIED**, Mailforge: domains at $14/yr, mailboxes from $3/mo, 10-slot minimum, SSL/masking add-on $2/mo/domain. Matches the number already in SPEC.md §12/§18. Source: coldiq.com/tools/mailforge, mailforge.ai/blog/scaling-cold-email-with-low-cost-domains, searched 2026-07-21.

**VERIFIED**, Zapmail/Maildoso portability complaints: search results describe Zapmail as having "documented complaints about its supply chain" and explicit advice to "ask about the migration policy explicitly before signing up and get the answer in writing" because "multiple users report difficulty with the migration due to Zapmail's unhelpful support team." Source: multiple review-aggregator sites (aerosend.io, prospeo.io, mailforge.ai comparison blog posts), searched 2026-07-21 — these are third-party review/comparison content, not primary user complaints, so treat as **moderate-confidence** signal, not a verified incident record. Still, it is exactly the "lock-in horror story" pattern the brief asked to check for, and it corroborates the general principle: an all-in-one vendor that owns both domain and mailbox provisioning, with unclear portability terms, is where migration friction concentrates. InboxKit's own ToS silence on domain ownership (§2 above) is the same shape of risk, pre-emptively.

---

## 5. Strategic analysis

- **Customer ownership/portability** (coldrig's public "your domain, you own it" posture, SPEC.md §1/§7): a registrar account under coldrig's own EpiphanyMade identity (Namecheap or Cloudflare), with the tenant's own contact info as registrant where the API allows it, keeps domain ownership crisp and independently verifiable via WHOIS/RDAP regardless of what happens with the mailbox vendor relationship. InboxKit-as-registrar makes domain standing depend on the SAME unresolved "internal business operations, non-transferable" license question already open for InboxKit-as-mailbox-vendor (ACTIVATION.md:15's still-UNVERIFIED empirical check) — stacking two unresolved legal questions on one vendor account is strictly worse than keeping them independent.
- **Exit path if InboxKit is dropped**: this is the core architectural argument. The `VendorPort` facade's entire design premise (SPEC.md §4) is that each vendor is independently swappable. Today's `factory.ts:142` breaks that premise for domains specifically — dropping InboxKit as mailbox vendor would, as currently wired, ALSO silently drop InboxKit as registrar (or vice versa) since they share one credential. A registrar decision independent of the mailbox vendor restores the intended swap-not-rebuild property: dropping InboxKit for mailboxes (e.g., if the ToS gap doesn't resolve favorably) leaves domains completely undisturbed on Namecheap/Cloudflare.
- **Cost inside the $0.50/mbx COGS envelope** (SPEC.md §12): both Namecheap (~$10-13/yr typical, InFERRED from Namecheap's general .com pricing being competitive with the other two, exact current promo/renewal rate not independently re-verified this session) and Cloudflare ($10.44/yr, VERIFIED at-cost) comfortably fit the ~$12-18/yr-per-domain implied budget. Porkbun would have fit best on pure price ($11.08/yr) but is disqualified on API grounds (§3). Cost is a wash between the two real candidates — not the deciding factor.
- **Automation completeness**: Namecheap has the most complete, longest-proven lifecycle API (register, DNS, renew, transfer) but requires a net-new vendor relationship (fund a balance, whitelist an IP, separate support channel). Cloudflare's Registrar API is real but beta and explicitly missing renewals/transfers via API today (dashboard-only) — mitigated by setting auto-renew once at registration time via the dashboard (a one-time manual step per domain until the API catches up, not per-cycle). Cloudflare's DNS-automation side (SPF/DKIM/DMARC/tracking records), by contrast, is the most mature of any option here, because it's the same long-established Cloudflare Zones API.
- **Operational simplicity for a 1-person company**: Cloudflare wins clearly. Coldrig is already 100% on Cloudflare (Workers, Pages, DNS for coldrig.dev, wrangler auth already live on this machine per multiple ROADMAP entries). Adding Cloudflare Registrar is zero new vendor accounts, zero new billing relationships, one login, one invoice. Namecheap is a genuinely new vendor: new account, funded balance, IP-whitelist maintenance, a separate support/abuse-policy relationship to track (§3's AUP risk). This matches this project's own stated instinct toward minimizing vendor sprawl for a sole operator.

---

## 6. Recommendation

**Default registrar for fresh sending-domain purchases: Cloudflare Registrar**, not InboxKit and not (for now) Namecheap-as-primary.

Rationale in one pass: Porkbun is disqualified (no purchase API, confirmed independently). InboxKit-as-registrar stacks an unresolved domain-ownership/portability question on top of the ALREADY-unresolved mailbox-ToS question, on the exact same account — a single point of failure that also violates the `VendorPort` facade's swap-not-rebuild design intent (today's code accident at `factory.ts:142` makes this literal). That leaves Namecheap vs Cloudflare as the two real candidates: both are cost-comparable and inside the COGS envelope, Namecheap has the more complete lifecycle API today, but Cloudflare is the better fit for THIS company specifically — zero new vendor relationships (coldrig is already all-in on Cloudflare), at-cost pricing with no markup, and DNS automation (the operationally trickier half of "buy domain → set SPF/DKIM/DMARC") rides the same mature Cloudflare API the platform already depends on. The Registrar API's beta gaps (no renew/transfer via API yet) are real but narrow and each has a workaround (dashboard auto-renew toggle at registration time; transfers are a rare, low-frequency operation that can stay a manual dashboard action without materially hurting the "customer's agent runs this end-to-end" thesis, since transfer-out is inherently a rare/terminal event, not a routine one).

**Keep Namecheap as the documented fallback** — not deleted, just demoted: if a specific TLD isn't in Cloudflare's API-beta subset, or the beta proves unreliable in practice once `RealDomainPort` is actually built and smoke-tested, Namecheap is the proven, industry-standard (Smartlead-precedented) escape hatch with a complete lifecycle API. This mirrors exactly how the project already treats InboxKit-primary/Mailforge-fallback for mailboxes — same pattern, different vendor.

**When to deviate to InboxKit-as-registrar**: only for the narrow case that's actually a DIFFERENT shape than "buy a fresh domain" — a customer who already owns a bare domain (the Mordy/authorpitchdesk.com case, ROADMAP.md line 19/23) and explicitly wants InboxKit to manage DNS end-to-end via its NS-delegation or Cloudflare-API-connect flows, accepting the coupling and the unresolved-ToS risk as the price of zero-touch setup. That's a "connect an existing domain to InboxKit" decision the customer opts into per-tenant, not a "we default fresh purchases here" decision — it should never be the fallback path for the customer-brings-nothing shape this research was scoped to.

**`RealDomainPort` build implication** (not just a config flip): the current file is a stub labeled "Porkbun," which SPEC.md §13 already ruled out. Whichever registrar is armed, this adapter needs an actual rewrite against a real API (Cloudflare Registrar's Search/Check/Register + Cloudflare Zones DNS calls, most likely) before ACTIVATION.md's Gate-2 registrar line can be closed — it is not simply "unactivated," it targets the wrong vendor entirely as written today.

---

## 7. The separate domain-port arming flag — exact policy

Fix `factory.ts` so the domain port has its OWN arming gate, independent of `inboxKitConfig` (the mailbox credential):

1. **Introduce a distinct config value**, e.g. `registrarConfig?: { kind: "cloudflare" | "namecheap" | "inboxkit"; credentials: ... }`, separate from `inboxKitConfig`. Never let `inboxKitConfig`'s mere presence select the domain port as a side effect.
2. **Default `registrarConfig` absent → `RealDomainPort` targets Cloudflare Registrar** (per §6) when `realAdaptersActivated` is true and the tenant isn't sandboxed/allowlisted-out, matching the pattern every other real port already follows (dark until its OWN config is supplied).
3. **`registrarConfig.kind === "inboxkit"` is the ONLY path that constructs `RealInboxKitDomainPort`**, and it must be set explicitly per-tenant (or via a global override, but never implicitly inherited from `inboxKitConfig` being present for mailboxes). Selecting it should also require `inboxKitDomainRegistrant` to be populated (already a separate param today) — both must be present together, or fall through to whatever `registrarConfig.kind` otherwise resolves to (Cloudflare/Namecheap).
4. **`registrarConfig.kind === "namecheap"` is the fallback path** — same dark-until-configured discipline, its own credential shape (API key + username + client IP for the whitelist).
5. Update the stale code comment at `factory.ts:138-141` (still says "Porkbun stays the default... unless a dedicated InboxKit domain config is supplied" — the "dedicated" config doesn't exist yet; this policy creates it) and the `RealDomainPort` file header comment (still says "(Porkbun)") to reflect whichever registrar is actually implemented first.
6. This closes ROADMAP.md line 23 finding (a) exactly as specified there: "needs a separate explicit domain-port arming flag."

---

## 8. One-line resolution of ACTIVATION.md:9 vs :25

**ACTIVATION.md:9 governs mailboxes only (InboxKit, decided 07-20); ACTIVATION.md:25 should be corrected to name Cloudflare Registrar as the new default (Namecheap demoted to fallback, Porkbun dropped entirely), and both lines should cross-reference the new independent domain-port arming flag (§7) so it's explicit that arming InboxKit mailboxes never implies arming InboxKit as registrar.**

---

## Sources (VERIFIED this session, 2026-07-21)

- https://docs.inboxkit.com/register-domains-18118349e0 (WebFetch)
- https://www.inboxkit.com/terms-of-service (WebFetch)
- https://developers.cloudflare.com/registrar/registrar-api/ (WebFetch)
- https://blog.cloudflare.com/registrar-api-beta/, https://domainnamewire.com/2026/04/15/cloudflare-launches-domain-registration-api/ (WebSearch)
- https://porkbun.com/products/domains, https://kb.porkbun.com/article/190-getting-started-with-the-porkbun-api (WebSearch)
- https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/, https://www.namecheap.com/legal/hosting/aup/ (WebSearch)
- https://www.smartlead.ai/blog/buy-domains-mailboxes-smartsenders-guide, https://www.smartlead.ai/email-account-setup-smartsenders (WebSearch)
- https://www.mailforge.ai/blog/scaling-cold-email-with-low-cost-domains, https://coldiq.com/tools/mailforge (WebSearch)
- Zapmail/Maildoso portability review aggregation: aerosend.io, prospeo.io, mailforge.ai comparison posts (WebSearch, moderate confidence — third-party review content, not primary complaints)
- Repo grounding: `ACTIVATION.md:9`, `ACTIVATION.md:25`, `ROADMAP.md` line 19/23 (2026-07-20/21 entries), `SPEC.md` §12/§13, `apps/platform/src/vendors/factory.ts:86-152`, `apps/platform/src/vendors/real/domain-port.ts:1-21`
