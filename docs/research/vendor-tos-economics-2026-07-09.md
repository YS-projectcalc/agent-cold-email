# Vendor ToS / Isolation / API / Economics — Desk Research (FROZEN provenance, 2026-07-09)

> Frozen research record (like the priorart archive) — NOT a living doc. Zero-spend desk pass, public ToS/pricing/docs only, no signups. Conclusions folded into SPEC §12/§13 + the pricing design; this file is the receipts.

## Headline findings (load-bearing)

1. **RESALE PERMISSION — the model risk.** Only **Mailforge** explicitly permits the multi-tenant reseller model in its own ToS ("indirect subscriber… on behalf of your own clients… reselling Mailforge to your clients", via required sub-accounts). **Inboxkit** (SPEC primary) grants only "a non-exclusive, non-transferable, limited license… for their internal business operations" — no resale carve-out; enterprise-negotiated terms (§17.5) are the stated escape hatch. **Zapmail** = non-sublicensable/internal-use-only. **Mailreef** = explicit prohibition ("will not… resell… to any third party"). **Maildoso** = ToS silent (thin doc).
   - **Design implication:** the facade already abstracts the vendor. Real-adapter primary target stays **Inboxkit** *pending an enterprise reseller agreement*, with **Mailforge** as the ToS-clean fallback (accepting its weaker shared-IP isolation), OR restructure legally as a **management-service** (customer is the account principal — which also satisfies the compliance lens's "customer is the CAN-SPAM sender" posture). **This is a top ACTIVATION decision; it does not block the sandbox/test-mode build.**

2. **Porkbun domain PURCHASE endpoint NOT publicly documented.** Only DNS/pricing/SSL/ping endpoints confirmed (`/dns/create/{domain}`, `/dns/editByNameType/…`, `/pricing/get`, `/ping`). A `/domain/getRegistrationRequirements/{tld}` exists (implies registration is possible for some TLDs) but no confirmed register/buy path. **Buy-domain real-adapter needs Namecheap (documented registration API) as the confirmed fallback**, or Porkbun-support confirmation, at activation. Sandbox is unaffected.

3. **Inboxkit isolation is UNCLEAR** — homepage says "isolated panel per domain" (UI language); a competitor says UI-only; a Smartlead partner doc says separate Google Workspace / MS365 tenant per domain. No Inboxkit-authored technical doc settles per-CUSTOMER org isolation. SPEC §7's "no shared reputation pool" stays CONDITIONAL on verified isolation (a written-confirmation activation gate). Mailreef has the strongest documented isolation (dedicated server + IP per customer) but prohibits resale.

## Confirmed economics inputs (primary sources)

| Item | Confirmed price | Source type |
|---|---|---|
| Inboxkit mailbox | $3.1/$2.7/$2.5 per mbx/mo (Pro/Agency/Ent) + **$3/mbx/mo warmup** | primary pricing page |
| Inboxkit API | included on all paid tiers (from Professional $31/mo) | primary |
| Maildoso mailbox | $2.5 → $0.5/mbx/mo (30 → 1000); domain reg $12/yr | primary |
| Mailforge mailbox | $3/mbx/mo (yearly), min 10 slots, billed on SLOTS not active; .com $14/yr | primary |
| Mailreef | server-based $240-249/mo, ~150 mbx/server, +$0.001/send | primary |
| Zapmail | ~$3-3.5/mbx/mo; API gated to $299 Pro tier (third-party) | third-party |
| Porkbun domains | .com $11.08/yr · .net $12.52 · .io $28→$52 renewal · .co $16→$31 renewal | primary |
| Stripe | 2.9% + 30¢ domestic; +0.5% keyed, +1.5% intl; ~$15/dispute | primary |

**Domain-burn note:** replacement domains bought after year 1 pay full renewal (no first-year discount) — the .io/.co renewal cliff matters; default to .com for lookalikes.

## Google/Yahoo bulk-sender rules to pass through to tenants (official)
- Gmail (≥5,000/day to Gmail, since 2024-02-01): SPF+DKIM+DMARC; one-click unsubscribe + visible in-body link; **spam rate <0.30%** in Postmaster Tools.
- Yahoo: SPF+DKIM + valid DMARC (≥p=none must pass); functioning List-Unsubscribe, RFC 8058 one-click "highly recommended"; spam <0.3%.

## Explicit gaps (carry to activation verification)
Porkbun purchase-endpoint; Inboxkit true per-customer org isolation; Zapmail/Mailreef primary-source API-tier + isolation; Maildoso full commercial ToS; Yahoo exact volume threshold; full Inboxkit/Mailforge endpoint inventories. Full source list: 21 URLs (in the research agent's return; primary vendor ToS/pricing/docs + Google/Yahoo/Stripe official).
