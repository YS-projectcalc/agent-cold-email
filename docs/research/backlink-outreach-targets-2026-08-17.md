# Coldrig authority and editorial outreach playbook — 2026-08-17

**PREP-ONLY. Nothing in this file has been sent or queued.**

> **Standing rule:** every email, DM, form submission, comment, issue, or PR is an external action and requires the founder's approval for that specific send. One send, one approval. Stop outreach immediately if the recipient asks not to be contacted.

This replaces the first-pass draft with a repeatable system for earning legitimate citations, listings, and links. It is not a link-exchange plan, a mass-mail merge, or a request for unearned endorsement.

## Executive verdict

The goal is directionally right, but **“get backlinks so AI agents recommend us” is too simple a model**.

Backlinks can help search engines discover and assign authority to Coldrig. They do not force an AI assistant to recommend it. Recommendations become more likely when independent, crawlable sources say something specific and verifiable about Coldrig in the same context as a buyer's question, and when those claims are consistent with Coldrig's own public evidence.

The campaign therefore has four jobs:

1. **Discovery:** earn clean links from relevant MCP and sales-tool directories so the domain and product are repeatedly discoverable.
2. **Category definition:** earn editorial mentions that describe Coldrig accurately as agent-operated cold-email infrastructure, not an AI copywriter or persona-style SDR.
3. **Independent trust:** create places where evaluators can verify what is live, what is limited, and how Coldrig compares without relying on marketing claims.
4. **Recommendation evidence:** eventually add real user reviews, case studies, and community discussion. A directory footprint without usage evidence may get Coldrig found, but not chosen.

The two outreach motions are different:

- **Directory submissions** optimize for completeness, correct metadata, and low effort.
- **Editorial outreach** optimizes for a useful correction or missing category on a page that already ranks for the buyer's question.

Do not pitch either group with “please backlink to us.” The strongest ask is: **“Would you evaluate this as a missing option for the specific reader problem your page already covers?”**

## What was wrong with the original drafts

The first drafts were honest and admirably short, but they left conversion on the table:

- They led with **28 tools** rather than the reader outcome: one agent-operated control plane spanning infrastructure, sending, replies, and health guardrails.
- “Nothing that actually sends cold email” was too broad and easy to dispute. Apollo and other tools can trigger sequences. Coldrig's more defensible distinction is the **combined infrastructure lifecycle**: domains, mailboxes, warmup state, campaigns, replies, and remediation behind one agent-facing surface.
- Most messages went to support or generic inboxes instead of the author, editor, curator, or maintainer who owns the page.
- Every message used the same soft ending (“no worries if not”), which made the drafts feel templated and reduced confidence.
- The ask was vague (“Would it fit?”) and made the recipient do all the editorial work.
- Pricing appeared in first-touch emails where pricing was not the subject. It adds cognitive load and can turn an editorial correction into a sales pitch.
- The drafts did not offer a neutral, ready-to-check fact block or a one-command sandbox test.
- Directories, articles, founder DMs, forms, and GitHub PRs were treated as the same motion.
- There was no follow-up sequence, stop rule, or placement-quality measurement.

The rewrite below fixes those problems while keeping the copy brief.

## Pre-send credibility gate

Do not begin editorial outreach until these checks pass on the day of send. An editor who finds contradictory public facts is less likely to trust any future pitch.

### Product facts allowed in outreach

Use only claims that can be verified from current public sources:

- Brand: **Coldrig**; registry/package handle: **`agent-cold-email`**.
- Product category: agent-operated cold-email infrastructure; **not** a lead database, copy generator, or autonomous SDR persona.
- Interfaces: official hosted MCP server, HTTP API, and npm CLI.
- Surface: **28 high-level authenticated intents** as currently documented.
- Lifecycle: domain/mailbox provisioning, warmup state, campaign execution, reply handling, health actions, and push webhooks.
- Evaluation path: `npx agent-cold-email demo` runs a free simulated pipeline with no real spend or sends.
- Live status: real sending exists for activated tenants, while public demo tenants remain sandboxed.
- Honest limits: no inbox-placement guarantee and no established multi-year production track record.
- Pricing, when relevant: starts at $99/month for five provisioned mailboxes, then $10/month per additional mailbox; do not call sends “unlimited.”

### Fix or confirm before Wave 1

- Confirm the live website, GitHub README, GitHub repository description, MCP registry record, npm page, pricing page, and `/for-agents` page all agree on **28 tools**, live-vs-sandbox status, CLI version, and pricing.
- The GitHub search metadata observed on 2026-08-17 still described **17 MCP tools** even though the current README describes 28. Update the repository's short description if it is still stale.
- A search snapshot of the pricing page observed on 2026-08-17 still said paid activation was not live, while the current repository says live sending and billing are live. Confirm the live page is current and request recrawling after any correction.
- The public evaluation page contains an older “twenty-five intent-level tools” line alongside a 28-intent table. Correct that inconsistency before using the page as the main proof link.
- Run the demo from a clean environment and record the date. If it fails, pause every draft that calls it a one-command evaluation.

### Proof links

Keep first-touch emails to one or two links. Choose the link that best fits the recipient:

- Human overview: <https://coldrig.dev/for-agents>
- Machine-readable evaluation: <https://coldrig.dev/agent-evaluation.md>
- Public source and operating contract: <https://github.com/YS-projectcalc/agent-cold-email>
- Documentation: <https://coldrig.dev/docs>
- Pricing: <https://coldrig.dev/pricing>

Do not make the homepage the only link in an editorial pitch. Send the recipient to the evidence they would need to verify the proposed addition.

## Positioning kit

These blocks keep submissions consistent. Re-verify the facts before every wave.

### Category

**Agent-operated cold-email infrastructure**

### 100-character directory description

> Agent-operated cold-email infrastructure over MCP, HTTP, and CLI.

### Short directory description

> Coldrig gives AI agents one MCP, HTTP, or CLI surface for cold-email infrastructure, campaigns, and replies, with a free no-send sandbox for evaluation.

### Neutral editorial description

> Coldrig is cold-email infrastructure designed to be operated by an AI agent. Its official MCP, HTTP, and CLI surfaces expose 28 high-level intents spanning domain and mailbox provisioning, warmup state, campaign execution, reply handling, health actions, and webhooks. A free sandbox lets evaluators run a simulated pipeline without spending or sending. Coldrig does not generate outreach copy or guarantee inbox placement.

### Why an editor's reader would care

> Most sales MCPs expose an existing CRM, database, or sequencer. Coldrig addresses the infrastructure layer an agent otherwise has to assemble across a registrar, mailbox/warmup provider, and sending/reply system.

### One-command verification

> `npx agent-cold-email demo`

### Suggested link destinations

- For a product name in a roundup: <https://coldrig.dev/for-agents>
- For a technical claim: <https://coldrig.dev/agent-evaluation.md>
- For an MCP directory or open-source list: <https://github.com/YS-projectcalc/agent-cold-email>

Do not prescribe anchor text to an editor. Let the publisher choose natural wording.

## Who to contact

Use the person who can actually change the page:

1. Named author or reviewer of the article.
2. Founder/curator of a small hand-maintained directory.
3. Content lead, managing editor, SEO editor, or partnerships lead.
4. Maintainer for a GitHub list.
5. Generic support or `info@` only when no editorial route exists; ask them to forward the note to the page owner.

Do not email multiple people at one company simultaneously. Start with the owner most likely to care, then route through the generic address only if the first path is unavailable.

## Target scoring and waves

Score candidates before adding them to a wave:

- **Query fit (0–3):** does the page answer the same question a buyer asks?
- **Editorial value (0–3):** would mentioning Coldrig make the page more complete or correct?
- **Independent trust (0–2):** is this a credible third party rather than a self-serving competitor page?
- **Reachability (0–1):** is the author/curator or an explicit submission route available?
- **Effort (0–1):** can the placement be pursued with a clean submission or concise email?

### Ranked list

| Rank | Target | Owner to reach | Route | Score | Motion | Decision |
|---:|---|---|---|---:|---|---|
| 1 | [Fastio sales MCP guide](https://fast.io/resources/best-mcp-servers-for-sales-teams/) | Editorial team / page owner | [Contact](https://fast.io/contact/); ask `help@fast.io` to route to the article owner | 10 | Editorial correction | Wave 1 |
| 2 | [Crustdata sales MCP guide](https://crustdata.com/blog/best-mcp-servers-for-sales-teams-in-2026) | Chris P. (author), then Nithish A. (reviewer) | Author route if found; otherwise `info@crustdata.com` with a forwarding request | 10 | Editorial addition | Wave 1 |
| 3 | [Salestools Club](https://salestools.club/) | Akhil, founder/curator | [Submit form](https://salestools.club/submit); direct note only if a current email is verified | 10 | Curated directory | Wave 1 |
| 4 | [Noded verified MCP tracker](https://www.getnoded.ai/post/which-sales-and-cs-tools-actually-have-mcp-servers/) | Steve Wood, author | The article's correction route: `hello@getnoded.ai` or [contact](https://www.getnoded.ai/contact-us/) | 9 | Verified tracker update | Wave 1 |
| 5 | [ColdIQ cold-outreach agents](https://coldiq.com/category/cold-outreach-ai-agents) | Michel Lieben / directory curator | LinkedIn, X, or [contact](https://booking.coldiq.com/) | 9 | Category placement | Wave 1 |
| 6 | [Directory for AI cold-email guide](https://directoryforai.com/tool-guides/best-ai-tools-for-cold-email-outreach/) | manunallapaiyan (author) / guide editor | [Submit Tool](https://directoryforai.com/submit-tool/) first; contact second | 9 | Guide + listing | Wave 1 |
| 7 | [mcpservers.org](https://mcpservers.org/submit) | Directory review team | Submission form | 8 | Directory | Wave 1 |
| 8 | [MCP.Directory](https://mcp.directory/submit) | Directory review team | Search first; claim existing auto-listing or submit once | 8 | Directory | Wave 1 |
| 9 | [best-of-mcp-servers](https://github.com/tolkonepiu/best-of-mcp-servers) | Repository maintainers | PR following `CONTRIBUTING.md` | 8 | GitHub list | Wave 1 |
| 10 | [Oryndex cold email & outreach](https://oryndex.co/discover) | Matic Pogladič, curator | “Submit a Tool” route | 8 | Curated outcome directory | Wave 2 |
| 11 | [mcp-server-directory.com](https://www.mcp-server-directory.com/) | Directory review team | Submission form, after confirming site works | 6 | Directory | Wave 2 |
| 12 | [Trumpet sales MCP guide](https://www.sendtrumpet.com/blog-posts/best-mcp-servers-for-sales-teams-2026) | Article owner/content team | Editorial contact if found; `support@sendtrumpet.com` only as a forwarding route | 6 | Editorial addition | Wave 2 |
| 13 | [Catchr sales MCP guide](https://www.catchr.io/post/best-mcp-servers-sales-teams) | Article owner/content team | [Contact](https://www.catchr.io/contact-us) | 5 | Editorial addition | Wave 2 |
| 14 | [O-mega AI sales agents guide](https://o-mega.ai/articles/top-10-ai-sales-agents-for-cold-email-outreach-2026-ranked-list) | O-mega editorial team | Contact/support | 3 | Category mismatch | Hold |

### Why the ranking changed

- **Fastio moved to the top** because its article explicitly says domain warming and deliverability remain manual. Coldrig is directly relevant to that stated reader gap.
- **Crustdata remains high** because its page already assembles a sales MCP stack and has a named author/reviewer. The ask should be about the missing infrastructure layer, not the inaccurate claim that no listed tool sends.
- **Salestools Club remains high** because it explicitly accepts submissions and promises a niche do-follow link. It already lists a different product called `coldr`; the pitch must prevent name confusion.
- **Noded is a strong new target** because the author explicitly invites corrections to a source-verified revenue MCP tracker.
- **ColdIQ is a fit only with honest category framing.** Coldrig is not an AI SDR. Ask the curator whether it belongs in “MCPs for Sales AI Agents” or as infrastructure for the cold-outreach category.
- **Generic MCP directories are useful for discovery but weaker recommendation evidence** than an editorial inclusion.
- **O-mega is on hold** because its list is explicitly for autonomous SDR personas. Asking for a ranked slot would miscategorize Coldrig and weaken trust.

## Master editorial email

Use this structure for new editorial targets. Keep the final email between roughly 70 and 120 words.

### Subject options

1. `A missing layer in “[article title]”`
2. `Source for your [specific section]`
3. `[Specific correction] in your [topic] guide`

Avoid “quick question,” “collaboration,” “partnership,” “backlink request,” “guest post,” and hype-heavy subjects.

### Body

> Hi [first name] —
>
> Your [article/guide] makes a useful distinction between [specific point from the page]. One layer your reader still has to solve is [precise missing job].
>
> I’m building Coldrig, agent-operated cold-email infrastructure across MCP, HTTP, and CLI. It covers [two or three capabilities that close that exact gap], and the free sandbox can be checked without spending or sending.
>
> Would you be open to evaluating it for [specific section/use case]? Here’s the fact-checked source page: [best proof URL]. I can also send a neutral 60-word entry in your format.
>
> — [name], founder of Coldrig

Personalize the first paragraph from the page. Never use a compliment that could have been written without reading it.

## Tailored Wave 1 drafts

### 1. Fastio

**Best subject:** `Source for the manual-warmup gap in your MCP guide`

**Alternates:** `A missing infrastructure option in your sales MCP stack` · `Your Smartlead/Outreach “cons” section`

**Email:**

> Hi Fastio editorial team —
>
> Your sales MCP guide says the Smartlead/Outreach layer still leaves domain warming and deliverability setup manual. Coldrig may be a useful option for readers who want that layer agent-operated too: its official MCP, HTTP, and CLI surfaces cover domain/mailbox provisioning, warmup state, campaign execution, replies, and health guardrails.
>
> Would you be open to testing it for that section? The free sandbox runs without spending or sending: `npx agent-cold-email demo`. The verification page is https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

**Why this works:** it attaches Coldrig to a specific gap the article already names. It does not ask Fastio to accept an unsupported superlative.

**Routing note:** send to `help@fast.io` with the subject above and ask for the editor who owns the sales MCP guide. Do not send the same note simultaneously to the product and partnerships contacts.

### 2. Crustdata

**Best subject:** `A missing layer in your sales MCP stack`

**Alternates:** `Source for the outreach section of your MCP guide` · `One addition for “Programmatic Outbound at Scale”`

**Email:**

> Hi Chris —
>
> Your MCP guide separates data, CRM, and sequence enrollment well. The remaining layer in the workflow is the sending infrastructure itself: domains, mailboxes, warmup state, health actions, and replies behind one agent-facing surface.
>
> That’s what we built Coldrig to cover through an official MCP server, HTTP API, and CLI. Would you be open to evaluating it for the Sales Engagement section or the “Programmatic Outbound at Scale” stack? Here’s the fact-checked evaluation page and free sandbox path: https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

**Routing note:** if only `info@crustdata.com` is available, start with: `Could you forward this to Chris P. or the editor who owns the sales MCP guide?`

### 3. Salestools Club

**Best subject:** `Coldrig ≠ coldr — possible MCP-ready addition`

**Alternates:** `A separate cold-email MCP for Salestools Club` · `Submission: Coldrig / agent-cold-email`

**Email or founder DM:**

> Hi Akhil —
>
> You already list `coldr`, the terminal campaign tool. Coldrig is a separate project, so I wanted to prevent a name collision: it’s agent-operated cold-email infrastructure with an official MCP/HTTP/CLI surface spanning domains, mailboxes, warmup state, campaigns, replies, and webhooks.
>
> Would it earn a separate MCP Ready entry under Sales Engagement? The repo and one-command no-send sandbox are here: https://github.com/YS-projectcalc/agent-cold-email. I’m happy to use only the submission form if that’s your preferred route.
>
> — [name], founder of Coldrig

**Form fields:**

- Tool name: `Coldrig (agent-cold-email)`
- Website: `https://coldrig.dev/for-agents`
- API docs: `https://coldrig.dev/docs`
- Category: `Sales Engagement`
- One-liner: `Agent-operated cold-email infrastructure over MCP, HTTP, and CLI.`
- MCP Ready: `Yes`
- Agent Skills: select only if Coldrig currently ships a qualifying skill under the directory's definition

**Do not** add Salestools Club's badge merely to accelerate review. Add it later only if being listed is genuinely useful to Coldrig users; avoid a transactional reciprocal-link pattern.

### 4. Noded

**Best subject:** `One official revenue MCP for your verified tracker`

**Alternates:** `Source-verified addition to your July MCP table` · `Cold-email infrastructure MCP for your tracker`

**Email/contact note:**

> Hi Steve —
>
> Your revenue MCP tracker asks readers to flag shipped servers backed by primary sources. One possible addition is Coldrig: an official hosted MCP server for agent-operated cold-email infrastructure, listed in the official MCP Registry and backed by a public repository and live endpoint.
>
> It exposes 28 high-level intents across provisioning, warmup state, campaigns, replies, health actions, and webhooks. Would you be open to verifying it for a future tracker update if cold-email execution fits your scope? Primary sources: https://github.com/YS-projectcalc/agent-cold-email and https://coldrig.dev/agent-evaluation.md.
>
> — [name], founder of Coldrig

**Do not** ask to be called “GA,” mature, or proven. Let the author choose the shipped/status wording from the evidence.

**Routing note:** Steve's author page explicitly welcomes corrections through Noded's contact page. Use `hello@getnoded.ai` or that form and name Steve and the article in the first line.

### 5. ColdIQ

**Best subject:** `Infra category for your cold-outreach agents?`

**Alternates:** `Where would agent-operated email infrastructure fit?` · `Cold-outreach agents still need this layer`

**DM/email:**

> Hi Michel —
>
> Your Cold Outreach AI Agents page is mostly persona-style SDRs that research and write outreach. Coldrig is deliberately not one of those: it’s the infrastructure an agent can operate for domains, mailboxes, warmup state, campaigns, replies, and health controls through MCP/HTTP/CLI.
>
> Would you be open to evaluating it for your “MCPs for Sales AI Agents” category, or as an infrastructure callout on the cold-outreach page? The distinction and free sandbox are documented here: https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

**Why this works:** it states the category mismatch before Michel has to object to it and gives him two accurate placement options.

### 6. Directory for AI

**Best subject:** `Infrastructure gap in your cold-email tools guide`

**Alternates:** `A tool for your “technical non-negotiables” section` · `Submission: agent-operated cold-email infrastructure`

**Email/contact form:**

> Hi [first name] —
>
> Your cold-email guide says no AI tool can overcome broken sending infrastructure, then lays out authentication, warmup, and per-inbox controls. Coldrig is built specifically for that layer rather than copy generation: an agent can operate provisioning, warmup state, campaigns, replies, and health guardrails through MCP, HTTP, or CLI.
>
> Would you be open to evaluating it for an “infrastructure/control plane” entry instead of grouping it with AI writers? The free no-send sandbox and limitations are here: https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

**Submission note:** submit the product through the site's official tool form first. Use the editorial note only for the guide-specific ask; do not send both on the same day.

### 7. mcpservers.org

This is a form submission, not an email campaign.

- Server Name: `Coldrig (agent-cold-email)`
- Short Description: `Agent-operated cold-email infrastructure for provisioning, campaigns, replies, and health controls.`
- Link: `https://github.com/YS-projectcalc/agent-cold-email`
- Category: `Sales/Marketing`, `Communication`, or the closest available category
- Contact Email: founder's approved address
- Premium: use the free listing first; do not pay merely for a do-follow label without evidence that the placement drives relevant discovery

### 8. MCP.Directory

Because this directory auto-discovers from the official MCP Registry, **search before submitting**. If Coldrig already exists, claim the entry instead of creating a duplicate.

- GitHub Repository URL: `https://github.com/YS-projectcalc/agent-cold-email`
- npm Package: `agent-cold-email`
- Short Description (under 100 characters): `Agent-operated cold-email infrastructure over MCP, HTTP, and CLI.`
- Email: founder's approved address

After publication, verify the detected tool count, remote endpoint, package name, category, and description. Request correction if the auto-generated entry repeats stale metadata.

### 9. best-of-mcp-servers

Follow the repository's current `CONTRIBUTING.md` exactly. Do not open an issue and a PR for the same addition.

**PR title:**

> Add YS-projectcalc/agent-cold-email (Coldrig)

**PR body:**

> Adds `YS-projectcalc/agent-cold-email`, the open-source MCP/HTTP/CLI surface for agent-operated cold-email infrastructure. The public repository documents 28 high-level intents, the hosted endpoint, install paths, and a free sandbox demo. I followed the current `projects.yaml` schema and category conventions.

Keep the entry neutral and schema-compliant. Do not insert marketing superlatives into the project description.

## Wave 2 drafts

### Oryndex

**Best subject:** `Submission for “cold email & outreach”`

> Hi Matic —
>
> Oryndex organizes tools by the outcome buyers ask for, including “cold email & outreach.” Coldrig is a narrower infrastructure option for that outcome: it lets an AI agent operate domains, mailboxes, warmup state, campaigns, replies, and health controls through MCP, HTTP, or CLI.
>
> Would it fit your curated library as agent-operated infrastructure rather than an AI copywriter? The product evidence and no-send sandbox are here: https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

### mcp-server-directory.com

Use the same repository URL and short description as MCP.Directory. Submit only after the form, review process, and resulting link are manually verified. Do not spend founder time on a broken or opaque submission flow.

### Trumpet

**Best subject:** `An infrastructure layer for your Sales Engagement section`

> Hi Trumpet content team —
>
> Your sales MCP roundup covers engagement platforms such as Outreach and Salesloft. A separate reader need is the infrastructure underneath cold outreach: domains, mailboxes, warmup state, campaigns, replies, and health actions that an agent can operate directly.
>
> Coldrig covers that layer through an official MCP server, HTTP API, and CLI. Would the article owner be open to evaluating it for a future update? The fact-checked source page and free sandbox path are here: https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

If using `support@sendtrumpet.com`, begin with a forwarding request. Do not present support as the editorial owner.

### Catchr

**Best subject:** `A cold-email infrastructure category for your MCP guide`

> Hi Catchr content team —
>
> Your guide compares official sales MCPs across CRM, data, engagement, and analytics. It does not currently cover agent-operated cold-email infrastructure as its own category.
>
> Coldrig is one candidate for that layer: an official MCP/HTTP/CLI surface for provisioning, warmup state, campaign execution, replies, and health controls. Would the article owner be open to evaluating it for a future update? Primary evidence and a free sandbox are here: https://coldrig.dev/for-agents.
>
> — [name], founder of Coldrig

Acceptance odds are lower because Catchr's article is vendor content and the page already has a fixed “10 best” frame. Send only after Wave 1.

### O-mega — hold, do not send yet

The page ranks autonomous AI sales-agent personas. Coldrig is infrastructure, not a persona agent. A request for a ranked position would make the article less coherent and encourage the wrong market description. Revisit only if O-mega adds an infrastructure/MCP category or publishes a separate “stack behind AI SDRs” guide.

## Follow-up sequence

Use follow-ups for editorial emails and founder DMs, not for anonymous directory forms unless the site provides a tracking or correction route.

### Follow-up 1 — day 4 or 5

Keep it in the same thread.

> Hi [first name] — resurfacing this because [repeat the article-specific gap in one clause]. If useful, I can send a neutral 60-word entry with a source beside every claim, so your team can evaluate it without rewriting vendor copy.
>
> — [name]

### Follow-up 2 — day 11 or 12

> Last note from me on this. The one-command sandbox is `npx agent-cold-email demo`, and the verification page is [URL]. If [section/category] is closed to additions, I’ll mark it accordingly and won’t keep following up.
>
> — [name]

Then stop. A third chase is more likely to damage the brand than earn a citation.

### Positive-reply handling

If the recipient asks for copy, send the neutral editorial description from the positioning kit and say:

> Please edit freely and verify each claim independently. The important distinction is that Coldrig is infrastructure an agent operates; it is not a copy generator or an autonomous SDR persona.

If they ask for money, reciprocal links, a badge, or guaranteed placement, pause and evaluate the offer separately. Never disguise sponsored placement as an independent editorial recommendation.

## Personalization checklist

Before approval, every direct message must contain:

- The recipient's correct name and role.
- The exact article/category name.
- One observation that proves the page was read.
- One Coldrig capability tied to the page's missing reader job.
- One clear ask.
- One primary proof link, two at most.
- The sender's real identity and relationship to Coldrig.

Delete any sentence that would work unchanged for every target.

## Campaign operating rules

- Send in small waves: three editorial pitches plus directory/PR submissions, then learn from responses.
- Do not use open-tracking pixels. Measure replies and live placements; tracking pixels add privacy and deliverability cost without improving this decision.
- Keep first-touch emails plain text, without attachments, images, calendar links, or a large signature.
- Do not claim to be a reader/user unless that is true.
- Do not ask for a “do-follow” link in editorial outreach.
- Do not offer money, a testimonial, a badge, or a reciprocal link for an independent mention.
- Do not manufacture reviews, Reddit threads, or third-party endorsements.
- Do not pitch direct competitors' self-ranking articles unless they create an explicit, neutral submission process. Current competitor roundups from Amplemarket, Salesforge, Skyp, HotHawk, and similar vendors are research inputs, not realistic outreach targets.
- Re-check the page and contact route on the day of send. Articles, authors, forms, and product claims change.

## Tracking sheet schema

Track the outcome, not vanity opens:

| Field | Purpose |
|---|---|
| Target / URL | Exact page being changed |
| Page type | Editorial, curated directory, general directory, GitHub list, review/community |
| Owner | Author, editor, founder, maintainer, or review team |
| Route | Verified email, DM, form, or PR |
| Specific gap | Why the placement improves that page |
| Approval ID/date | Founder approval for this one external action |
| First touch / follow-ups | Dates and subject used |
| Response | Interested, routed, declined, no response, needs proof |
| Placement URL | Final live page |
| Link destination | Coldrig page the publisher chose |
| Claim accuracy | Tool count, status, category, pricing, and limits correct? |
| Indexed date | First date the placement appears in search |
| Referral/qualified traffic | Any meaningful visits or evaluations |
| Blind-probe result | Whether fresh agents discover or cite the placement |

## Success criteria

The campaign is not successful merely because 20 forms were submitted.

Wave 1 is successful when it produces:

- At least three live, relevant third-party placements from different domains.
- At least one editorial mention on a page that already ranks for sales MCP or cold-email-tool queries.
- Correct product categorization and facts on every live placement.
- A repeat blind-agent probe that reveals which sources are actually retrieved.

After five independent placements have been indexed, rerun the original blind queries and record:

1. Does Coldrig appear at all?
2. Which third-party source caused discovery?
3. Is Coldrig described correctly?
4. Is it shortlisted, rejected, or recommended—and why?
5. Which trust gap remains: track record, reviews, pricing, maturity, capabilities, or category confusion?

Use those answers to choose the next campaign. If agents find Coldrig but reject it for lack of independent usage proof, another 50 directories are not the solution; customer evidence is.

## Skip list and current status

- Official MCP Registry (`io.github.YS-projectcalc/agent-cold-email`) — published; verify current version and metadata before each wave.
- Glama — already live via registry auto-indexing.
- mcp.so — submission issue [#3602](https://github.com/chatmcp/mcpso/issues/3602) open; do not duplicate.
- PulseMCP — auto-indexes the registry; wait for intake availability.
- `punkpeye/awesome-mcp-servers` PR [#10106](https://github.com/punkpeye/awesome-mcp-servers/pull/10106) — open; do not create a second PR.
- GSC, Bing, and IndexNow — already handled; continue monitoring separately from outreach.

Previously dropped targets remain dropped until manually re-verified:

- `cursor.directory` and `mcpmarket.com` returned repeated 429 responses and had no independently verified submission path.
- `scrap.io` had no usable editorial or submission route.
- Paid generalist directories with no evidence of relevant discovery should not outrank free, exact-fit editorial opportunities.

## Next approved actions, in order

1. Resolve the public fact inconsistencies in the pre-send gate.
2. Verify the named page owner and contact route for Fastio, Crustdata, Noded, Directory for AI, and Trumpet.
3. Submit/claim the no-message directory entries one at a time: Salestools Club, mcpservers.org, MCP.Directory, and Oryndex.
4. ~~Open the schema-correct `best-of-mcp-servers` PR~~ — ALREADY DONE: [PR #366](https://github.com/tolkonepiu/best-of-mcp-servers/pull/366) is open and verified; do not file a second one.
5. Send only three personalized editorial emails in the first wave: Fastio, Crustdata, and Noded.
6. Review replies and live placement accuracy before sending ColdIQ, Directory for AI, or Wave 2.

This sequencing earns easy discovery links while testing the stronger editorial proposition with a small, learnable batch.

## Wave 3+ candidates — added 2026-08-23 (research only, nothing sent)

**Method:** 7 WebSearches + 8 WebFetches across four buckets (ranking listicles, skill hubs/directories, newsletters/video, review sites). Existing 14 targets and skip-list entries (MCP Registry, Glama, mcp.so, PulseMCP, punkpeye/awesome-mcp-servers, cursor.directory, scrap.io) excluded — see above. Same-day live checks (orchestrator, 2026-08-23): mcpservers.org SUBMITTED (free tier); mcp-server-directory.com now redirects to a parked ad domain → DROP; Oryndex real route is `/submit-a-tool`; PulseMCP bot-walls automation and says to contact hello@pulsemcp.com; best-of-mcp-servers requires ≥50 GitHub stars (PR #366 closed on that rule).

### Ranked table

| # | Target | Page type | Owner/author | Contact route | Specific gap Coldrig fills | Score | Wave |
|---:|---|---|---|---|---|---:|---|
| 1 | [GTM Bud — Cold Email Infrastructure Tools 2026](https://gtmbud.com/blog/cold-email-infrastructure-tools-2026) | Editorial listicle | Jorge Lewis, Co-Founder & AI Lead, GTM Bud | No direct email found; `/about` and `/contact` nav links exist — route via contact page | Ranks domain/mailbox/warmup/sending vendors (Mailforge, Instantly, Smartlead, Zapmail, Maildoso) with **zero** mention of MCP/AI-agent tooling despite the author's "AI Lead" title | 9 | 3 |
| 2 | [Snov.io — 17 Best Cold Email Infrastructure Tools](https://snov.io/blog/best-cold-email-infrastructure-tools/) | Editorial listicle (vendor blog, multi-tool roundup) | Alina Kalinina, Content Expert, Snov.io | Byline→Gravatar profile; footer "Contact us" link, no email surfaced in fetch — route via contact form | Article already names Mailforge as "wired into the Forge MCP server and CLI... provision and manage domains and mailboxes programmatically from Claude, Cursor" — precedent exists for listing an agent-operable infra tool; Coldrig is the independent alternative for the same job | 9 | 3 |
| 3 | [Data-Mania — Top 10 Claude MCP Servers for Marketing](https://www.data-mania.com/blog/top-10-claude-mcp-servers-for-marketing/) | Editorial listicle | Lillian Pierson, Fractional CMO & GTM Engineer | **VERIFIED email: communication@data-mania.com** | Ranks Smartlead (#8) narrowly as a "cold email marketing automation" sequencer; doesn't cover the underlying infra layer (domains/mailboxes/warmup/health) an agent still has to assemble | 9 | 3 |
| 4 | [Databar.ai — Best MCP Servers for Sales Teams in 2026](https://databar.ai/blog/article/best-mcp-servers-for-sales-teams-in-2026) | Editorial listicle | Not verified (not fetched) | Unconfirmed — verify before send | Same query cluster as Fastio/Crustdata/Trumpet (already Wave-1 winners); presumed same infra-layer gap | 7 | 3 (verify owner first) |
| 5 | [SyncGTM — Cold Email Marketing Tools: Everything to Know 2026](https://syncgtm.com/blog/cold-email-marketing-tools) | Editorial guide | Not verified | Unconfirmed | Explicitly frames a "four-layer cold email stack" — conceptual match for Coldrig's infra-layer pitch | 7 | 3 (verify owner first) |
| 6 | [Claude Skills Hub — claudeskills.info](https://claudeskills.info/submit/) | Skill hub (community, not Anthropic-affiliated) | Unnamed; `/about`, `/contact` exist | Submit form at `/submit/`: needs GitHub repo (per skill format guidelines) + name + description + repo URL; goes through quality/compatibility review | N/A — directory listing | 7 | 3 |
| 7 | [ColdEmailKit — warmup directory](https://coldemailkit.com/categories/warmup) | General directory (30+ warmup/outreach platforms) | Unnamed; X handle `@RiseWins_`; `/about`, `/contact` exist | "Add a Tool" footer link → `/submit` | N/A — directory listing | 7 | 3 |
| 8 | [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | GitHub curated list | hesreallyhim (maintainer) | PR per repo `CONTRIBUTING.md` (not independently fetched) | N/A — list submission | 7 | 3 |
| 9 | [Product Hunt](https://www.producthunt.com/products/submitting) | Launch/review site | N/A | Log in → click "Post" → submit product's direct URL (not blog/press link) | N/A — one-time launch, separate motion from editorial asks | 7 | 3 |
| 10 | [karanb192/awesome-claude-skills](https://github.com/karanb192/awesome-claude-skills) | GitHub curated list | karanb192 | PR/issue per `CONTRIBUTING.md` | N/A — list submission | 6 | 3 |
| 11 | [SaaSHub](https://www.saashub.com/services/submit) | General directory, free listing | N/A | **VERIFIED submit URL** | N/A — directory listing | 6 | 3 |
| 12 | [Explorium — Best Cold Email Skill for Claude 2026: Top 3 Ranked](https://www.explorium.ai/blog/building-ai-agents/best-cold-email-skill-for-claude-2026-top-3-ranked-for-revops/) | Editorial listicle (partly self-ranking — Explorium's own "Vibe Prospecting" is ranked #1) | Omer Har, published June 9, 2026 | No contact found — route via generic site contact | All 3 ranked tools (Vibe Prospecting, Apollo Outbound Copilot, Clay Claygent) are data/enrichment/copy tools; none covers sending infrastructure. Self-ranking dilutes independent-trust score | 5 | 4 |
| 13 | [ThynkGrowth — Ultimate Guide to GTM Tools for Cold Email Outreach](https://www.thynkgrowth.com/blogs/ultimate-guide-gtm-tools-cold-email-outreach-2025) | Editorial guide | Not verified | Unconfirmed | ⚠️ **Dated 2025** — outside ideal window, verify still live/current before pursuing | 4 | 4 |
| 14 | [Textforge — Best Email MCP Servers for Claude & Cursor (2026)](https://textforge.net/best/email-mcp-servers) | General directory/listicle | Not verified | Unconfirmed | Not yet fetched for gap specifics | 4 | 4 |
| 15 | [MailMCP — Best Email MCP Servers in 2026](https://mailmcp.io/en/best-email-mcp-servers-2026) | Directory/listicle | Not verified | Unconfirmed | ⚠️ MailMCP itself may be a competing managed-email-MCP product — verify before pitching | 3 | 4 |
| 16 | [Totalum — Best MCP Servers in 2026: 12 Ranked Picks](https://www.totalum.app/blog/best-mcp-servers-2026) | General MCP listicle (broad, not cold-email-specific) | Not verified | Unconfirmed | Broad list; ask for a sales/outreach category slot | 4 | 4 |
| 17 | [Claudefa.st — 50+ Best MCP Servers for Claude Code in 2026](https://claudefa.st/blog/tools/mcp-extensions/best-addons) | General MCP listicle | Not verified | Unconfirmed | Broad list; ask for a sales/outreach category slot | 4 | 4 |
| 18 | [ClaudeDirectory.org — Best Cold Email Skill for Claude Code](https://www.claudedirectory.org/skills/claude-skills-cold-email) | Skill directory/listicle | Not verified | Unconfirmed | Not yet fetched for gap specifics | 4 | 4 |
| 19 | claudemarketplaces.com (as a directory, distinct from the specific coreyhaines31 skill page already known) | Skill hub | Not verified | Submission route unconfirmed | N/A — directory listing | 4 | 4 |
| 20 | [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | GitHub curated list (company-backed) | ComposioHQ | PR/issue per `CONTRIBUTING.md` | N/A | 6 | 4 |
| 21 | [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) | GitHub curated list | travisvn | PR per `CONTRIBUTING.md` | N/A | 5 | 4 |
| 22 | [rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit) | GitHub mega-toolkit list (135 agents, 35 skills, etc.) | rohitg00 | PR per `CONTRIBUTING.md` | N/A | 5 | 4 |
| 23 | [mcpmarket.com](https://mcpmarket.com/tools/skills/cold-email-expert) | Skill hub / general directory | Not verified | Previously dropped in the 08-17 doc for repeated 429s; today's search returned live indexed pages again — **re-verify accessibility before treating as active** | N/A | 3 | 4 |
| 24 | [GTM Engineer newsletter](https://thegtmengineer.substack.com/) | Newsletter (features reader-submitted GTM hacks weekly) | Author not identified on fetched page | **No submission/contact route found in this pass** — needs a follow-up search | Covers "AI in GTM" broadly | 3 | 4 |
| 25 | [Cold Email Leverage newsletter](https://coldemail.substack.com/) | Newsletter, topic-exact match | Not verified (not fetched) | Unconfirmed | Not yet fetched | 4 | 4 |
| 26 | [AlternativeTo](https://alternativeto.net/) | General directory, "alternative to X" traffic | N/A | Submission exists per general knowledge but exact URL **not confirmed** in search results | N/A | 5 | 4 |
| 27 | [Capterra — For Vendors](https://www.capterra.com/vendors/) | Review site (Gartner-owned; one source claims recent G2 acquisition, unconfirmed) | N/A | **VERIFIED page URL**; but copy emphasizes a paid "lead-generation program" — ⚠️ **CAUTION: possibly paid-leaning**, confirm a genuine free tier still exists before spending effort | N/A | 4 | 4 |
| 28 | [G2](https://www.g2.com/) | Review site | N/A | Vendor portal referenced but exact submission URL not confirmed; review-gated, enterprise-skewed, slow payoff | N/A | 3 | 4 |
| 29 | SourceForge / Slashdot Media | Software directory | N/A | Exact submission URL not confirmed | N/A | 3 | 4 |
| 30 | [GTM Bud — Best Cold Email Software in 2026: 10 Ranked](https://gtmbud.com/blog/best-cold-email-software-2026) | Editorial listicle (same site/likely same author as #1) | GTM Bud | Same route as #1 — **do not message the same owner twice same day**; only pursue after #1's response | Software ranking, not infra-specific; secondary | 6 | 4 |
| 31 | [Saleshandy MCP](https://www.saleshandy.com/mcp) / [Saleshandy — What Is a Cold Email MCP Server?](https://www.saleshandy.com/blog/cold-email-mcp-server/) | Vendor's own blog + own product page | Saleshandy (competitor) | N/A | ⚠️ **HOLD** — Saleshandy's own promotional content for its own competing MCP product, not independent editorial. Fails the independent-trust bar (same reasoning as the O-mega hold) | 2 | Hold |
| 32 | [Woodpecker — Email Warmup API Guide](https://woodpecker.co/blog/email-warmup-api/) / [Woodpecker MCP docs](https://developers.woodpecker.co/docs/mcp/) | Vendor's own blog + docs | Woodpecker (competitor) | N/A | ⚠️ **HOLD** — Woodpecker's own promotion of its own warmup API and MCP server, a directly competing product | 2 | Hold |

### Could not verify (flag to founder, don't guess)
- **Reply.io**: no specific rankings page or MCP-tool page found in this search pass despite a dedicated query. Needs a follow-up search if this target matters.
- **usecarly**: zero search results found for this name — possibly renamed, defunct, or misspelled in the brief. Confirm exact name/URL before spending more search budget.
- **mcp.directory/skills/cold-email**: verified — this is alirezarezvani's own cold-email skill page (a copywriting-focused skill, not an infrastructure tool), not a category/editorial page with an owner to pitch. Evidence of the competitive landscape on mcp.directory, not a distinct outreach target (#8 MCP.Directory submission already covers that domain).
- **claudemarketplaces.com/skills/coreyhaines31/marketingskills/cold-email**: same situation — an existing competing skill listing, not an editorial contact. The directory itself is #19 above with an unconfirmed submission route.

### Bucket notes
- **(a) Listicles**: strongest new finds are GTM Bud's infra-specific article (author titled "AI Lead" yet zero agent-tooling coverage) and Data-Mania (verified direct email). Several broad MCP-server listicles (Textforge, MailMCP, Totalum, Claudefa.st) were found but not deep-fetched for owner/gap — Wave 4 pending verification; don't burn founder approval on unverified routes.
- **(b) Skill hubs/directories**: claudeskills.info has a clean, concrete submission mechanism (GitHub repo + form). Five GitHub "awesome-claude-skills/code" lists identified; prioritize the two with clearest maintainer activity (hesreallyhim, karanb192) and treat the rest as Wave 4 filler. mcpmarket.com may have come back online since the prior 429-based drop — re-verify, don't assume live.
- **(c) Newsletters/podcasts**: weakest yield. Generic "MCP + AI agent" newsletter searches returned nothing cold-email-specific with a clear submission route. Two Substack newsletters (GTM Engineer, Cold Email Leverage) surfaced but neither had a confirmed author name or contact route — both need a dedicated follow-up before any send.
- **(d) Review sites**: Product Hunt and SaaSHub have confirmed, free, low-friction submission routes. Capterra's vendor page emphasizes a paid lead-gen program — CAUTION rather than a hard PAID skip since a free basic tier may still exist; verify before treating as free. G2 and SourceForge/Slashdot lack confirmed free-submission URLs in this pass.
- **Two "known ranker" checks came back as vendor self-promotion, not editorial**: Saleshandy's and Woodpecker's own MCP/warmup pages are their own product marketing — HOLD, same logic as the O-mega entry.

## Send ledger — 2026-08-23

Every external action taken or prepared this session, one row each, per this doc's own tracking-sheet spec above. Verbatim from `archive/2026-08-23-roadmap-cleanup/send-ledger-2026-08-23.md`.

| Target | Route | Timing | Details | Status | Follow-up |
|---|---|---|---|---|---|
| mcpservers.org (wong2 list; target #7) | form https://mcpservers.org/submit | 2026-08-23 ~04:0xZ | name "Coldrig (agent-cold-email)", category Marketing, URL github repo, contact support@coldrig.dev, premium NOT selected | SUBMITTED — "reviewed within 12 hours", email notice on approval | check 2026-08-24 |
| salestools.club (target #3) | form https://salestools.club/submit (free, no login) | PREPARED 2026-08-23, NOT SENT (classifier blocked autonomous submit) | toolName "Coldrig (agent-cold-email)"; websiteUrl https://coldrig.dev; apiDocsUrl https://coldrig.dev/docs; category: Sales Engagement (or an email/outreach option if present); description: "Agent-operated cold-email infrastructure: domains, mailboxes, warmup, campaigns, replies and server-enforced guardrails behind one bearer token (28 MCP/HTTP tools, hosted MCP server + npm CLI, free sandbox)."; email support@coldrig.dev; check "MCP READY" (leave "AGENT SKILLS" until the skill ships); tags "coldrig, cold email, mcp, agent-cold-email" | awaiting founder go | — |
| mcp.directory (target #8) | form https://mcp.directory/submit (no login; auto-pulls GitHub metadata, publishes ≤24h) | PREPARED 2026-08-23, NOT SENT | GitHub URL https://github.com/YS-projectcalc/agent-cold-email; npm "agent-cold-email"; name "agent-cold-email"; one-sentence (≤100 chars): "Agent-operated cold-email infrastructure: domains, mailboxes, warmup, campaigns, replies via MCP."; both email fields support@coldrig.dev. Also /submit-skill exists — use after the skill ships | awaiting founder go | — |
| directoryforai.com (target #6) | https://directoryforai.com/submit-tool/ — requires "Continue with Google" account creation | FOUNDER-PRESENT (account creation; not done by the agent) | — | — | — |
| PulseMCP | site blocks automation (403 "API-based access; contact hello@pulsemcp.com") | route = email hello@pulsemcp.com → add to the email campaign | — | — | — |
| Glama | listing exists (stale "~12 tools" blurb); claim/edit needs a Glama account (GitHub) | FOUNDER-PRESENT | — | — | — |
| cursor.directory | https://cursor.directory/plugins/new?type=mcp_server — "Auto (GitHub) → Scan repo", no login seen | DO AFTER the skill/plugin lands on main (scan picks up skills + MCP) | — | — | — |
| LobeHub | https://lobehub.com/mcp/submit returned HTTP 500 (their side) | RETRY later | — | — | — |
| mcp-server-directory.com (target #11) | domain now redirects to a parked ad page (cf.quickzone.store) | DROP from list | — | — | — |
| tolkonepiu/best-of-mcp-servers PR #366 | closed 2026-08-18: "does not meet the current threshold … at least 50 GitHub stars" (also: public, non-archived, updated within 180 days) | BLOCKED on star count → trust-floor item | — | re-file when ≥50 stars | — |
| oryndex.co (target #10) | real route = https://oryndex.co/submit-a-tool (the /submit path 404s; /discover only has a newsletter form) | PREPARED route only — recon fields next | — | awaiting founder go | — |
| mcpservers.org Agent Skills + mcp.directory /submit-skill | skill submission forms (GitHub URL to SKILL.md, name, description, category, email) | DO AFTER the skill lands on main | — | — | — |
| YuzeHao2023/Awesome-MCP-Servers (1.06K★) | PR from fork YS-projectcalc/Awesome-MCP-Servers-1 branch add-coldrig | 2026-08-23 ~06:1xZ | line "- Coldrig (⭐) — https://github.com/YS-projectcalc/agent-cold-email" under Communication, after ntfy | OPENED https://github.com/YuzeHao2023/Awesome-MCP-Servers/pull/433 | check 2026-08-30 |
| punkpeye/awesome-mcp-servers (92.7K★) | existing PR #10106 (opened 2026-07-14) | — | — | OPEN since 07-14 — monitor/rebase only, never duplicate | see status check below |
| wong2/awesome-mcp-servers | README: no PRs; submissions via mcpservers.org form | covered by the mcpservers.org submission above | — | — | — |
| hesreallyhim/awesome-claude-code | issue-form only; rule: signup/payment = blocker | NOT PURSUING | — | — | — |
| chatmcp/mcpso | issue #3602 open since 2026-08-17 | monitor | — | — | check 2026-08-30 |
| punkpeye PR #10106 | comment on our own PR | 2026-08-23 | noted Glama score now evaluated (83%, grade A) — the maintainer's 07-22 blocker | POSTED | check 2026-08-30 |
| (side effect) skill-gate r1 probe | prod, demo plan | 2026-08-23 | created 1 demo-plan tenant + campaign camp_2c1f6918-2270-4183-8ebb-a86ebc522a3b + 1 suppression row to prove B3 (suppressed leads silently skipped at launch) | no spend, no real sends; purge only if demo-tenant hygiene matters | — |
| (side effect) skill-gate r2 probe | prod, demo plan | 2026-08-23 | minted demo tenant "Adversary R2 Probe" to capture a real bearer via a local capture server (proved ${user_config.token} substitution) | no spend, no sends; purge with the r1 probe tenant if hygiene matters | — |
| SHIP | main 7ffba30 (merge of integ/visibility-2026-08-23); Pages deploy 211d6cf7 → coldrig.dev (live-verified: compare table, style.css :has rules, llms.txt Option D bullet, connect plugin block, stale support line gone, refund line, sameAs x4) | 2026-08-23 ~07:57Z | gate 4 rounds → SHIP; battery GREEN (typecheck 5/5, platform 239f/2407t, dashboard 165, engine 157, CLI 12/12, guards 377) | DONE | — |
| GitHub release v0.2.3 | https://github.com/YS-projectcalc/agent-cold-email/releases/tag/v0.2.3 | 2026-08-23 07:56Z | first tagged release (Glama/directories read releases) | DONE | — |
| skills.sh | `npx skills add YS-projectcalc/agent-cold-email` from the public repo → "Found 1 skill" | 2026-08-23 | install path verified | DONE | — |
| cursor.directory | https://cursor.directory/plugins/new?type=mcp_server — "Auto (GitHub) → Scan repo" | 2026-08-23 ~07:58Z | scan of the public repo detected 2 components (MCP Server + Skill) and pre-filled name/description once; two publish retries never re-rendered the form (90s wait; site 429s automation — rate limit likely) | NOT PUBLISHED — founder: paste the repo URL, Scan, Publish (no login seen) | — |
| salestools.club (target #3) | form (id-selectors — site changed name→id attrs 08-24) | 2026-08-24 | name/URL/docs/category "Sales Engagement"/desc/support@coldrig.dev; MCP READY + AGENT SKILLS checked; tags | ✅ SUBMITTED — "review within 72 hours" | check 2026-08-27 |
| mcp.directory server (target #8) | form /submit | 2026-08-24 | repo URL, npm agent-cold-email, 97-char desc, support@ ×2 | ✅ SUBMITTED — "publish within 24 hours", email notice | check 2026-08-25 |
| mcp.directory SKILL | form /submit-skill | 2026-08-24 | SKILL.md GitHub URL, name, description, category Productivity, support@ ×2 | ✅ SUBMITTED — "publish within 24 hours" | check 2026-08-25 |
| cursor.directory | scan form | 2026-08-24 | — | ❌ post-scan form did not render (3rd attempt; their side) | retry later or founder browser |
| oryndex.co | form /submit-a-tool | 2026-08-24 | all fields filled | ⛔ CAPTCHA ("security check") — agent never completes CAPTCHAs | FOUNDER (~1 min) |
| claudeskills.info | /submit/ | 2026-08-24 | — | ⛔ redirects to Google OAuth sign-in (account grant) | FOUNDER (~2 min) |
| lobehub.com/mcp/submit | — | 2026-08-24 | — | ❌ HTTP 500 on their side (2nd day) | retry in a few days |
| mcpservers.org | — | 2026-08-23 23:22Z | — | ✅ APPROVED + LIVE: https://mcpservers.org/servers/ys-projectcalc/agent-cold-email (approval email → support@ → ticket sup_0c287eba; no reply owed; README badge added 8d58f1e) | Agent-Skills submission there still available |
