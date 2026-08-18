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
