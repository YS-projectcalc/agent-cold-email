# Review-site listing packs — G2, Capterra, AlternativeTo (2026-07-27)

Scope: free tiers only, no paid spend, no incentivized reviews — per the founder-ratified 2026-07-21 decision recorded in `docs/research/reviewsites-dogfood-2026-07-21.md` ("Decision 1"). **That file already did the deep cost/requirements/review-solicitation-policy research** (G2 acquired Capterra/GetApp/Software Advice from Gartner, Jan–Feb 2026; free-tier terms; solicitation rules; ranking mechanics). This file is complementary: **paste-ready field content** for the actual listing forms, plus what changed or was newly confirmed live between 2026-07-21 and today.

**Tool count: use 25, not 24.** I counted the live `MCP_TOOLS` array in `apps/platform/src/mcp/tools.ts` directly (`apps/platform/src/mcp/tools.ts:64-328`) and it has 25 entries — the 25th is a new `remove_mailboxes` downgrade tool that isn't yet reflected in `README.md`, `site/.well-known/mcp/server-card.json`, or `site/for-agents.html` (all still say 24; those look mid-sweep from another lane in this session). **Before submitting any of these three packs, confirm the live coldrig.dev site and server-card actually show 25** — otherwise a reviewer who checks the live site against a "25 tools" G2/Capterra listing sees a mismatch, which is a worse first impression than a stale "24" everywhere. If the sweep hasn't landed site-wide yet, either wait or use "25 tools (including the new mailbox-downgrade tool)" consistently across whichever copy you paste today.

**Do not check or claim SOC 2, ISO 27001, penetration-test attestation, or a formal uptime SLA anywhere in these forms** — `site/security.html:7` states explicitly Coldrig does not currently claim any of these. If a form has checkboxes for security certifications, leave them unchecked.

**Signup/contact email:** recommend `legal@epiphanymade.com` (the confirmed, human-monitored notices address in `site/terms.html:91`) for all three vendor-account signups, not `support@coldrig.dev` — that address is wired to the platform's own support-ticket Worker (`ACTIVATION.md`), which parses inbound mail into tickets rather than acting as a plain forwarding inbox, so a G2/Capterra confirmation or claim-verification email risks being mangled rather than delivered. If a coldrig.dev-domain email is specifically required (some vendor forms prefer a domain-matched address), set one up first rather than using `support@`.

---

## G2

### What Yaakov does, in order (~5 min)

1. Go to **`sell.g2.com/create-a-profile`** (confirmed live today) and use the request form (anchor `#form` on that page).
2. Fill: Business Email, Product Name, Product Website — see field content below. There's no visible category picker at this step; G2's research team places the profile "in the right category" during their own review.
3. Submit. G2's own copy: your product is "conditionally approved" immediately, then their research team verifies it in **3-5 business days** and the profile goes live, unclaimed.
4. Once live, go claim it: log in at `my.g2.com` (LinkedIn, Facebook, Google, or Business Email) and claim the listing. Claim review is **1-3 business days**.
5. Once claimed, you're in the real profile editor (`my.g2.com`) — that's where the long description, features, pricing block, screenshots, and alternatives get pasted. I could not reach this editor live (see "What I could not verify" below), so paste the content below and adjust to whatever fields it actually shows.

### Verified process (live-checked 2026-07-27)

`sell.g2.com/create-a-profile` is reachable and unprotected (unlike `www.g2.com` itself, which is behind DataDome bot detection and rendered nothing to a live headless-browser check today). Confirmed page copy: *"We have one of those request forms everyone loves... After submitting yours, your product or service will be conditionally approved... Our G2 research team verifies your product or service — in about 3-5 business days — before placing it in the right category."* Free to claim: *"you can claim your profile for free."* Guideline questions route to `listings@g2digitalmarkets.com`.

### Field content

**Product Name:** `Coldrig`

**Product Website:** `https://coldrig.dev`

**Tagline / one-liner** (character-limited variants, exact counts verified):
- **≤60 chars (53):** `Cold-email infrastructure your coding agent operates.`
- **≤120 chars (112):** `Agent-run cold-email infra: 25 tools for domains, mailboxes, warmup, campaigns & replies. Free sandbox, no card.`
- **≤160 chars (160):** `Coldrig: 25 MCP/HTTP tools for cold-email domains, mailboxes, warmup, campaigns & replies, for Codex, Claude Code & Cursor. Not a sequencer, no AI-written copy.`

**Short description (~180 chars, G2-style, first person allowed):**
`Coldrig is agent-run cold-email infrastructure: one bearer token and 25 focused tools for domains, mailboxes, warmup, campaigns, and replies — for Codex, Claude Code, Cursor, or any MCP/HTTP agent.`

**Long description:**
"Coldrig gives an AI coding agent one tenant-scoped bearer token and 25 focused tools, instead of a 100+ tool vendor re-export, to run cold outreach end to end: buy branded lookalike domains, provision and warm mailboxes, launch and pause sequenced campaigns, manage a unified reply inbox, track lead disposition, and receive HMAC-signed outbound webhooks for replies, bounces, and complaints. Every tenant's domains, mailboxes, and data are isolated — never shared with other customers. Suppression and one-click unsubscribe (RFC 8058) are enforced automatically; per-mailbox daily send caps and complaint-rate auto-pause are enforced server-side, not left to the calling agent's discipline. The agent still writes the outreach copy and picks the strategy — Coldrig does not generate content or run an opaque AI SDR. Pricing starts at $99/month for 5 provisioned mailboxes, then $10/month per additional mailbox, with no separate send-quota fee. Real sending runs live in production (Gmail API); new accounts activate real sending through a short concierge step while self-serve activation continues rolling out. A free sandboxed demo — no signup, no card, no waitlist — runs the entire pipeline (`npx agent-cold-email demo` or `POST /signup`) with no real domains, mailboxes, or spend, so an agent or a human can evaluate it before anyone pays."

**Category (unverified live taxonomy — see caveat):** G2's own team places the final category during their 3-5 day review, so exact self-selection may not apply. If a category picker does appear, suggest in this order of fit: **Cold Email Software** (if offered) → **Sales Engagement Software** → **Email Deliverability Software**. G2 has active AI-agent-facing initiatives (a "G2 MCP" solutions page and an "LLM era" brand-building guide were visible on `sell.g2.com` today), so an AI-agent-tooling category may also exist — ask G2 support (`listings@g2digitalmarkets.com`) which category best fits an "MCP/API infrastructure operated by a coding agent" product if none of the above look right.

**Feature checklist** (real capabilities — map to whatever checkbox vocabulary G2's editor uses):
- Branded lookalike-domain provisioning + DNS automation
- Mailbox provisioning + automated warmup with per-mailbox health scoring
- Campaign sequencing (multi-step, scheduled, stop-on-reply)
- Unified reply inbox across mailboxes, with triage labels and read/archive state
- Outbound webhooks (HMAC-signed) for reply/bounce/soft-bounce/complaint events
- Contact-level lead disposition tracking + suppression + JSON export
- Bring-your-own-domain intake with consent tracking and pre-flight abuse scanning
- Agent-configurable dashboard + unified inbox (human-facing, agent-controlled layout)
- Server-enforced CAN-SPAM opt-out, per-tenant physical address + sender identity in every footer
- Per-tenant isolation (no shared domains/mailboxes/reputation across customers)
- MCP (streamable HTTP), REST/OpenAPI, and CLI — one bearer token across all three

**Pricing section:**
- Plan name: `Managed`
- Starting price: `$99.00 / month`
- Free plan: Yes — free sandboxed demo (no card, no time limit on the sandbox tier itself)
- Free trial (time-boxed trial of the paid/real-sending tier): No — new paid accounts activate through a concierge step, not a self-serve trial
- Pricing notes (free text): `$49/mo platform fee + $10/mailbox/mo, 5-mailbox minimum ($99 total). Domains included. No per-send fee. Full curve (5–60 mailboxes) at coldrig.dev/pricing; 61+ by custom quote.`

**Alternatives / competitor tags:** Smartlead, Instantly, Salesforge, Maildoso, AgentMail

**Screenshots to capture fresh** (don't reuse `pw-shots/` — those are stale from the 07-15 era, pre-dating the 25-tool build):
1. `https://coldrig.dev/` — hero/positioning
2. `https://coldrig.dev/pricing` — pricing calculator (shows the real formula)
3. `https://coldrig.dev/app` — the dashboard + unified inbox, **logged into a real sandbox tenant** (run `npx agent-cold-email demo` or `POST /signup` first to get a token) — this is the one "real product UI" shot, most valuable for a review site
4. `https://coldrig.dev/docs` — tool/API reference table showing the 25-tool surface
5. `https://coldrig.dev/connect` — MCP/CLI install snippet

### Readiness summary — G2
**Ready to submit today**, pending: (a) picking/confirming the signup email, (b) the 24→25 tool-count consistency check above. Steps 4-5 (claim + full profile edit) can't be dry-run further without actually submitting — the editor's exact field layout is genuinely unverified.

---

## Capterra (Gartner Digital Markets)

### What Yaakov does, in order (~5 min)

1. Go to `capterra.com/vendors/`, click **"Get Your Product Listed"** — this now routes to `app.g2digitalmarkets.com/get-listed/start` (confirmed live: Capterra's own vendor page literally links there, under the banner "Capterra, powered by G2 Digital Markets").
2. Step 1 form (confirmed live, exact fields): **Business Email**, **Product Name**, **Product Website**, plus a checkbox *"I want to be contacted to learn about brand building and lead generation"* — leave that unchecked unless you want a sales call.
3. Continue through the wizard's next steps (a "fit" assessment, then either an automatic or manual claim-confirmation branch, then an "access-request/information" step) — these are stateful and couldn't be observed without a real submission; answer honestly (company size, category, etc. — likely FOUNDER-FILL on the spot).
4. Once in the vendor dashboard, paste the Capterra-compliant description below verbatim — **do not loosen it**, their content team enforces specific rules (see below) and rewrites non-compliant copy anyway.
5. Request categories: **Email Marketing Software** (primary), **Lead Generation Software** + **Sales Intelligence Software** (alternates) — all three confirmed as real, live Capterra category pages today; there is no dedicated "cold email," "sales engagement," "email deliverability," or "outbound sales" category on Capterra as of today (all four slugs 404 on live check).
6. Upload at least one real UI screenshot (the `/app` dashboard, logged into a sandbox tenant) — Capterra's guidelines explicitly ban stock images.

### Verified process + compliance rules (live-checked 2026-07-27, `capterra.com/legal/listing-guidelines/`, last updated 2026-05-04)

Eligibility (all satisfied by Coldrig): a genuine packaged B2B/B2C product (not custom/bespoke) that fits an existing category, publicly available with a real call to action (trial/demo/request-info — **not** just a waitlist; Coldrig's free sandbox signup qualifies), listed under the product's real name on a vendor-controlled site. **Beta products are explicitly allowed with only 1 review required within the first calendar year** — Coldrig currently has zero reviews and is still eligible today.

**Content rules for the description field (binding — quoted from the guidelines page):**
- Do NOT write in first person (no "we/our/us")
- Do NOT use the product name, service name, or company name inside the description body (the name is already shown as the listing title)
- Do NOT use superlatives or comparative language ("best," "most," "fastest") — this already matches Coldrig's own no-deliverability-guarantee, honest-marketing posture, so no conflict
- Do NOT include calls to action or PII (no "click here," no phone/email/URL) in the description
- Do NOT include company suffixes ("Inc," "LLC," etc.)
- Do NOT use line breaks, special characters, or HTML tags
- Screenshots must show the real UI — no stock images or marketing jargon; video must be English and hosted on YouTube/Vimeo/Wistia

### Field content (Capterra-compliant — third person, no self-naming, no superlatives, no CTA/PII)

**Product Name:** `Coldrig`

**Product Website:** `https://coldrig.dev`

**Short description (~190 chars, compliant):**
`Cold-email infrastructure for coding agents: isolated domains and mailboxes, automated warmup, campaign sequencing, unified replies, and server-enforced compliance guardrails over MCP or HTTP.`

**Long description (compliant — no first person, no self-name repetition, no superlatives, no CTA/PII):**
"Cold-email infrastructure operated by a coding agent through MCP or HTTP instead of a dashboard. One tenant-scoped token exposes tools that provision isolated branded domains and mailboxes, run automated warmup, launch and pause sequenced campaigns, manage a unified reply inbox, track contact-level lead disposition, and push outbound webhooks for replies, bounces, and complaints. Per-tenant isolation, automatic suppression-list enforcement with one-click unsubscribe, per-mailbox daily send caps, and complaint-rate auto-pause are enforced server-side rather than left to the calling agent. Pricing starts at $99 per month for five provisioned mailboxes, then $10 per month for each additional mailbox, with no separate send-quota fee; domains are included. Real sending runs in production; a free sandboxed demo requiring no signup or card is available for evaluation before any spend. Sequencing, replies, and safety guardrails are server-enforced; content and outreach strategy remain the responsibility of the operating agent."

**Categories:**
- Primary: `Email Marketing Software` (confirmed live: `capterra.com/email-marketing-software/`)
- Alternates: `Lead Generation Software`, `Sales Intelligence Software` (both confirmed live)
- Note for whoever fills the category-fit field: this is an imperfect fit — Coldrig is infrastructure, not a marketing-blast tool — but it's the closest verified real Capterra taxonomy today; Capterra's content team has final discretion on placement regardless.

**Feature checklist:** same real-capability list as the G2 section above.

**Pricing section:** same structure as G2's pricing block above (Managed plan, $99/mo starting, free sandbox, no time-boxed paid trial, same pricing-notes free text).

**Alternatives / competitor tags:** Smartlead, Instantly, Salesforge, Maildoso, AgentMail

**Screenshots:** same five URLs as the G2 section; the `/app` dashboard shot is the one that satisfies Capterra's "real UI, no stock" rule most directly.

### Readiness summary — Capterra
**Ready to submit today.** Same 24→25 tool-count check applies (though the compliant description above never states a tool count, so it's not at risk from that specific mismatch — only a G2/site-copy pairing would be). The multi-step wizard past step 1 (fit questions, claim confirmation branch) is genuinely unverified without a real submission.

---

## AlternativeTo

### What Yaakov does, in order (~5 min active work, but plan for a 1-week clock)

1. **Today:** create a free AlternativeTo account (email/password or a social login) at `alternativeto.net`. Do this now even if you're not ready to submit — the clock below only starts once the account exists.
2. **Wait one full week from account-creation date.** Confirmed in their own FAQ: *"New users must wait a week after the creation of their account to submit a new app page. Unfortunately, we had to add this security policy to discourage spammers and bots."* There is no way around this for a first submission.
3. Before creating a new entry, search AlternativeTo for an existing "Coldrig" or "agent-cold-email" page first — directories sometimes have placeholder/unclaimed entries. If one exists, use "Contribute to this page" → "Edit/Update Information" instead of creating a duplicate.
4. On day 7+: click the user icon (top right) → **"Suggest new application"**.
5. Fill: app name, official URL, Platforms, License, Description, Tags (content below) → click **"Submit the application"**.
6. Review takes "usually... a couple of days and up to a week" per their FAQ.

### Verified process (live-checked 2026-07-27, `alternativeto.net/faq/`)

Confirmed verbatim: *"You can add your software by using the option 'Suggest new application' that you can find clicking on the User icon in the top right corner. Then you have to fill the fields Platforms, License, Descriptions, Tags, etc. and click the button 'Submit the application.'"* Entirely free — no vendor tier exists (monetizes via ads). Ranking is an organic Rank+Likes score; the category norm is single-digit likes even for established competitors (a spot-check in the prior 2026-07-21 research found Instantly.ai at 1 like, Apollo.io at 5, Snov.io at 9) — a fresh, low-like Coldrig listing will look unremarkable, not weak. **"Become a Partner"** (`mailto:partners@alternativeto.com`) is a separate program — not the free listing path, out of scope here.

### Field content

**App name:** `Coldrig`

**Official URL:** `https://coldrig.dev`

**Platforms:** `Web` — Coldrig is an HTTPS/MCP service with no native desktop/mobile client; if AlternativeTo's picker offers an API/developer-tool platform tag, add it too (unverified which exact platform tags their picker currently offers).

**License:** `Freemium` — accurate given a genuinely free, permanent sandbox tier alongside paid real-sending tiers.

**Description (their field allows first person/brand voice; reuse the G2 long description above, or this trimmed version):**
"Coldrig is agent-run cold-email infrastructure for Codex, Claude Code, Cursor, or any MCP/HTTP-capable coding agent. One bearer token and 25 focused tools provision isolated branded domains and mailboxes, run automated warmup, launch sequenced campaigns, manage a unified reply inbox, and enforce suppression, one-click unsubscribe, and complaint-rate safety guardrails server-side. The agent still writes the outreach copy — this is not an AI SDR or content generator. Pricing starts at $99/month for 5 mailboxes, then $10/month per additional mailbox. A free sandboxed demo (no signup, no card) runs the full pipeline before any spend."

**Tags (free-form — this is where category/competitor discovery signal lives on AlternativeTo):** `cold email`, `email marketing`, `AI agent`, `MCP`, `sales automation`, `outreach`, `email deliverability`, `developer tools`

**Screenshots:** same as above; AlternativeTo listings typically show 2-4 screenshots, so prioritize the homepage hero and the `/app` dashboard shot.

### Readiness summary — AlternativeTo
**Start the account today — that's the only time-sensitive step.** The actual submission (step 4-6) is fully blocked by the 1-week account-age gate regardless of anything else being ready, so there's no reason to delay account creation even if the G2/Capterra packs go up first.

---

## What I could not verify live this session (be aware, don't treat as confirmed)

- **G2.com itself (as opposed to `sell.g2.com`) is behind DataDome bot detection** — a real headless-Chromium fetch of `www.g2.com`, its category pages, and its own product-submission page all rendered blank today. G2's exact live category-taxonomy names, and the my.g2.com profile editor's actual field layout/character limits, were **not** independently verified this session — the category suggestions above are best-available naming, cross-referenced against real historical G2 category conventions, not a live-confirmed picker.
- **The Capterra/G2-Digital-Markets vendor wizard (`app.g2digitalmarkets.com/get-listed/start`) is a stateful multi-step SPA.** Only step 1's exact 3 fields + 1 checkbox were directly observable; the subsequent "fit," claim-confirmation, and "access-request/information" steps require a real form submission to progress and were not observed.
- **AlternativeTo's actual submission form** (behind login + the 1-week account-age gate) was not reached directly — the field set (Platforms, License, Description, Tags) is confirmed from their own FAQ page text, but exact character limits per field were not observable live.
- **Company founding year / employee-count fields**, if any of these forms ask for them: not stated anywhere in the repo. EpiphanyMade predates this build (only the ColdStart repo's own first commit, 2026-07-09, was found, which is the *product's* build start, not the *company's* founding) — mark these **FOUNDER-FILL** if a form requires them.
