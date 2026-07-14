# BYO-Domain Intake — Competitor & Cloudflare-for-SaaS Verification (FROZEN provenance, 2026-07-14)

> Frozen research record — NOT a living doc. Ground-truths the BYO-domain intake ladder in `SPEC.md` §20. Question: how do incumbents (Smartlead/Instantly) and the multi-tenant custom-hostname primitive (Cloudflare for SaaS) actually connect a customer's own domain/mailbox, and does any of them ask for nameserver delegation. Answer, in one line: **no incumbent asks for NS delegation** — the deepest DNS ask found anywhere is a single CNAME.

## Smartlead

- **Mailbox connect = OAuth, not delegation.** "Gmail/Google oAuth 1 Click Authentication" — the customer authorizes via Google's consent screen; Smartlead never touches the domain's nameservers. (`helpcenter.smartlead.ai/en/articles/50-…`)
- **SmartSenders (DFY domain+mailbox purchase) still configures records, not zones.** "lets you purchase domains and mailboxes directly inside the platform… DNS records including SPF, DKIM, and DMARC are configured automatically" — this is the **we-manage-zone** mode in our terms, and it only applies to domains Smartlead/SmartSenders itself sells (fresh, no live infra to protect). (`smartlead.ai/email-account-setup-smartsenders`)
- **Tracking domain ask = a single CNAME.** Verbatim record: `Type: CNAME, Host: emailtracking, Value: open.sleadtrack.com`. This is the deepest DNS-level ask found for a domain the customer already owns and uses. (`helpcenter.smartlead.ai/en/collections/15-…`)

## Instantly

- **Mailbox connect = OAuth / app-password / SMTP+IMAP**, same as Smartlead — no delegation. (`help.instantly.ai/en/articles/6222224-…`)
- **DFY new-domain purchase**: "purchase new domains… Instantly will automate the DNS configuration" with a **24–72 hour** turnaround — again, only for domains Instantly itself sells fresh (no live infra). (`help.instantly.ai/en/articles/11991261-…`)
- **Separate "Pre-Warmed Domains & Accounts" product** exists alongside DFY purchase — confirms the industry pattern of selling fresh, vendor-owned, pre-aged domains rather than automating anything on a customer's existing/primary domain. (`help.instantly.ai/en/articles/9969215-…`)

## Cloudflare for SaaS (the multi-tenant custom-hostname primitive)

- Positioning: "Extend Cloudflare security and performance to your customers' custom or vanity domains" — pattern example `app.customer.com → service.saas.com`, i.e. **subdomain CNAME onto our infra**, not zone delegation of the customer's apex. (`developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/`)
- **Pricing/scale**: 100 hostnames included, **$0.10/additional hostname** up to a 50,000 cap. (`developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/`, confirmed by the 2025-05-19 pay-as-you-go changelog: `developers.cloudflare.com/changelog/post/2025-05-19-paygo-updates/`)
- **Zones-per-account cap for full zone delegation (the alternative, heavier primitive) is UNCONFIRMED in official docs** — flagged as such; not something to build a capacity model on without direct confirmation.

## What this settles for SPEC §20

1. Zero precedent, across two direct incumbents and the platform primitive Cloudflare ships for exactly this multi-tenant problem, for asking a customer to delegate nameservers on a domain with live infra. The heaviest ask in the wild is a single CNAME (Smartlead tracking) or a subdomain CNAME pattern (Cloudflare for SaaS).
2. "Automatic DNS configuration" in both incumbents' own language applies **only to domains they themselves sell** — i.e. our `we-manage-zone` mode is industry-standard for fresh/vendor-owned domains, never for an existing customer domain.
3. Cloudflare for SaaS's custom-hostname primitive (CNAME-based, $0.10/hostname to 50k) is the right shape for our subdomain-scale (`send.customer.com`) management — cheap, proven at scale, no delegation required.
