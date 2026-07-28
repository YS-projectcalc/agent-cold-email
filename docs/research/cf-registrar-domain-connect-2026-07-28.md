# CF-Registrar domain connect — research record (2026-07-28)

> Two parallel research lanes (InboxKit connect-wall + industry CF-Registrar workarounds), frozen. Feeds the domain-onboarding-matrix copy order (ROADMAP `## Open` 2026-07-27) and the InboxKit support escalation.

## Question 1 — what gates InboxKit's `cloudflare-domains/connect` 400 "domain is not allowed"?

**Unresolved from public sources; support-only territory.** Empirically ruled out (live probes 2026-07-27/28): workspace-ID mismatch (single workspace `c5188ced…`, header correct on every call; `/domains/nameservers` succeeded under it), internal ban (`GET /domains/available?domain=dmhadvisor.com` → `banned:false`), DNS content (zone completely bare at failure time), missing domain entity (entity created via nameservers flow → workspace shows `domains:1, assignable_domains:1` — failure identical before AND after), `zone_id` param, wallet credits (documented only on the register/purchase endpoint, not connect), plan gating (no public evidence; low confidence). Documented request shape (inboxkit.com/learn/inboxkit-api-integration-guide): `zone_id, domain, api_token` (+ empirically `auth_type`) — matched. Rate limit (10/5min) — wrong error shape.

**Surviving hypotheses:** (a) backend requires an ACCOUNT-scoped CF token (their flow may list zones/memberships; a single-zone token can't — unconfirmed; the founder's dashboard UI attempt is diagnostic: if their UI fails to list zones with the zone-scoped token, confirmed); (b) undocumented feature/eligibility gate.

**Support ticket (ready to send):** "Cloudflare-connect returns 400 `{\"message\":\"domain is not allowed\"}` for dmhadvisor.com — a bare CF zone (0 DNS records) on our Cloudflare Registrar account, domain entity already created in-workspace via `/domains/nameservers` (NS assigned; workspace shows domains:1), `banned:false` per your availability endpoint, zone-scoped CF token verified working (Zone:Read+DNS:Edit) directly against Cloudflare's API. Plan: Professional. What specifically gates 'not allowed' — token scope (account vs zone), plan tier, or domain eligibility — and the exact fix?"

## Question 2 — industry answer for Cloudflare-registered customer domains

**Cloudflare's constraint (verbatim, developers.cloudflare.com/registrar/faq/):** "No, all domains on Cloudflare Registrar use Cloudflare nameservers…" Official escape hatches: (1) SUBDOMAIN NS delegation (zone-level NS records for a child — the Registrar lock is registry-level, doesn't apply; CDN/security not applied to delegated subdomains; ≤10 NS per name), (2) custom nameservers (Biz/Ent, still CF — irrelevant), (3) transfer away.

**Key vendor precedent — Maildoso** (same full-NS-delegation model; dedicated article intercom.help/maildoso/…/15421649): their CF-Registrar options are transfer-away / use-a-domain-registered-elsewhere-with-CF-as-DNS-only / register-new-through-us / contact-support. **Subdomain delegation conspicuously absent.** Their BYO requirement (…/14166520, verbatim): "set only our 2 nameservers at your registrar — nothing else"; customers "do not (and cannot) add MX/SPF/DKIM/DMARC or CNAME records by hand" — NO manual-records fallback exists anywhere in the surveyed market (DKIM rotation + lifecycle needs live zone write access).

**Incumbent table:** Maildoso = NS-delegation-only (primary-source docs) · InboxKit = NS delegation OR CF-token zone connect ("without changing nameservers") · Instantly = only tracking-domain CNAME confirmed; core sending-domain doc not found · Mailforge/Salesforge = "no technical setup" marketing only (weak source) · Smartlead/Mission Inbox/Inframail = not found this pass.

## Ratified product policy (matches the already-decided lookalike default)

1. **Lookalike-domains-we-register = primary onboarding path** (zero customer DNS; Maildoso's own options 2-3 equivalent).
2. **Fix/pursue the CF-token zone-connect path** for bring-your-own CF-registered domains (Cloudflare-sanctioned, already InboxKit-supported in principle) — via the founder UI attempt → support ticket above.
3. **Do NOT build subdomain-NS-delegation as a first-class path** — technically valid, zero incumbent precedent, forfeits the lookalike isolation argument; at most an unadvertised support-case option. Deliverability equivalence of delegated-subdomain sending = OPEN question (no practitioner sources found).
4. **Never require registrar transfer as the first ask.**
5. External-registrar BYO domains: one-time NS change remains the standard, honest ask.

Sources: developers.cloudflare.com/registrar/faq/ · /dns/manage-dns-records/how-to/subdomains-outside-cloudflare/ · /dns/zone-setups/subdomain-setup/setup/ · /dns/nameservers/nameserver-options/ · intercom.help/maildoso articles 15421649, 14166520 · inboxkit.com/learn/inboxkit-api-integration-guide · docs.inboxkit.com · help.instantly.ai/en/articles/7889099.
