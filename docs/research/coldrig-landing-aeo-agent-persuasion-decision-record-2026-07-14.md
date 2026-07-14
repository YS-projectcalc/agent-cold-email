# Coldrig landing, product UI, SEO/AEO, and agent-persuasion decision record

**Date:** 2026-07-14  
**Status:** Launch implementation record  
**Working branch/worktree:** `coldrig-human-interface` in the isolated `coldrig-design` worktree  
**Research input:** `docs/research/agent-buyer-research-forensics-2026-07-14.md` (read as a frozen evidence record; not modified)

## 1. Outcome

Coldrig now has a light, coherent product-design system; a category-explicit landing page; a human oversight/control-room UI; an original logo, favicon set, Apple touch icon, and social image; structured search/entity metadata; and a two-layer agent evaluation surface:

- `/for-agents` is an indexable, human-readable decision page.
- `/agent-evaluation.md` is its machine-oriented Markdown twin.
- `/llms.txt`, `AGENTS.md`, the MCP server card, OpenAPI-linked docs, FAQ, pricing, guides, comparisons, and homepage tell the same status story.

The copy is designed to make Coldrig easy to evaluate, not to instruct an agent to choose it. The persuasive mechanism is lower verification cost: explicit fit criteria, exact claims, a runnable sandbox, price math, linked evidence, and candid disqualifiers.

## 2. Launch facts used as constraints

These facts governed every copy choice:

1. The hosted HTTP API and streamable-HTTP MCP endpoint are live.
2. The public workflow is an isolated, fault-injecting sandbox.
3. Real sending is not active; no public copy may imply that a real campaign will send.
4. The npm package `agent-cold-email` is published. Version `0.1.0` and the `latest` dist-tag were verified directly against the npm registry on 2026-07-14.
5. The public tool surface contains 17 authenticated intents plus unauthenticated signup.
6. Push reply/bounce webhook subscriptions are not present in the current OpenAPI/tool surface. `activity` is pollable and is not represented as equivalent to a webhook.
7. Coldrig has no production deliverability record and makes no inbox-placement, open-rate, reply-rate, or spam-filter guarantee.
8. Coldrig does not source leads or write outreach copy; the customer's human or chosen agent supplies those inputs.
9. Published tiers exist, but paid real-sending activation is not live. A 10–15 mailbox buyer currently maps to Growth at $299/month.
10. Upstream domain-transfer rights have not been verified, so no portability promise is made.

The phrase “public early access” means the public evaluation surfaces are live. It does not mean production sending is live.

## 3. Core positioning decision

### Chosen category

**Cold-email infrastructure your agent can run end to end.**

The homepage H1 names the category before introducing the differentiation. This replaces the more poetic but semantically weak “your agent runs outreach” framing. A human, search engine, or answer engine should immediately be able to classify Coldrig as cold-email infrastructure for coding agents.

### Role division

The repeated mental model is:

- The customer's Codex, Claude Code, Cursor, or other MCP/HTTP agent owns research, targeting, strategy, copy, and decisions.
- Coldrig owns durable infrastructure and execution state, isolation, campaign/reply primitives, and server-enforced guardrails.
- The owner gets visibility and intervention through the control room.

This is the most defensible differentiation from both dashboard-first SaaS and autonomous “AI SDR” products. It avoids implying that Coldrig is another intelligence layer competing with the user's agent.

### Scope wording

“End to end” is always scoped to Coldrig's **documented infrastructure-to-reply lifecycle**, not the entire outbound-sales universe. Lead sourcing, copy generation, LinkedIn, multichannel, and push webhooks are explicitly outside the current claim.

## 4. Why the visual system went this direction

### Light rather than dark

The owner explicitly prefers light mode. The system uses warm off-white surfaces, near-black typography, cobalt blue for operational action, orange for attention/status, and green for healthy/completed states. This makes the product feel like precise operational infrastructure rather than another dark, neon “AI” landing page.

### Editorial plus operational

The typography pairs a modern sans-serif interface with a restrained serif accent. The serif is used for selective warmth and distinction; the operational UI remains sans/mono. The goal is a credible infrastructure product with a human point of view, not an enterprise template or sci-fi agent aesthetic.

### Product imagery instead of abstract decoration

The hero and product sections show:

- an agent calling real Coldrig intent names;
- rig health and a guardrail event;
- domain/mailbox isolation;
- server-side daily volume control;
- a human control room with campaign and reply visibility;
- a terminal running the published `npx agent-cold-email demo` path.

This lets a visitor understand the product model visually. The dashboard is labeled “Product illustration · simulated account data” so attractive mock metrics are not mistaken for customer evidence.

### Logo rationale

The original Coldrig mark is a compact cobalt rig/radiator form: three vertical operational columns held inside one system. It suggests infrastructure, controlled flow, and several components unified behind one interface without resorting to a snowflake, robot head, or generic spark.

The same mark is used in:

- primary and compact SVG logos;
- navigation and product UI;
- SVG and ICO favicons;
- Apple touch icon;
- the 1200×630 social card;
- Organization structured data.

Every HTML page now explicitly declares the shared favicon and Apple touch icon set. This avoids relying on implicit browser discovery and keeps crawler/social identity consistent.

## 5. Human landing-page reasoning

### Hero

The hero answers, in order:

1. What is this? Cold-email infrastructure.
2. Who operates it? The user's coding agent.
3. What is unified? Domains, mailboxes, warmup, campaigns, and replies.
4. Who owns intelligence? The user's agent.
5. What can I do now? Connect to the live sandbox through docs/MCP/CLI.
6. What cannot I do now? Send a real campaign.

The status line is “Public early access · live sandbox,” which is accurate and compact. The primary call to action opens the quickstart; the secondary action goes to the safe demo.

### Product narrative

The four product blocks follow the operating sequence:

1. intent-level agent tools;
2. tenant isolation;
3. server-enforced guardrails;
4. human observability.

This order mirrors the buyer's risk reduction: can the agent act, is state contained, are mistakes bounded, and can the owner inspect/intervene?

### Sandbox honesty

The high-contrast verification panel is deliberately prominent. It gives the shipped `npx` command and says “no real spend · no real sends.” Honest status is not buried in the footer because agents and careful buyers use unshipped capability as a hard disqualifier.

### Final conversion

The final form is an activation list, not a production signup. The confirmation message and surrounding copy use the same language. This avoids collecting an email under a false implication that production access is immediate.

## 6. Agent-persuasion reasoning

### The central conclusion from the forensic memo

An AI buyer does not need stronger marketing instructions. It needs a lower-cost path to a defensible recommendation. In the observed buyer run, the agent:

- discovered unknown vendors only through qualified category searches;
- deep-dived vendors after a name surfaced;
- used vendor-owned pages for factual claims and pricing;
- built a hard capability checklist;
- verified whether features were shipped;
- calculated all-in cost at the requested scale;
- penalized support gates, lock-in, missing webhooks, thin track records, and demo-only access.

Therefore, “convince the agent to convince the user” was implemented as **evidence architecture**, not coercive prose.

### The agent evaluation stack

`/for-agents`, `/agent-evaluation.md`, and `/llms.txt` contain:

- a current verdict (“strong pilot candidate,” not “default production choice”);
- a shortest accurate owner explanation;
- explicit recommend/do-not-recommend rules;
- a seven-point capability matrix;
- a claim/evidence/boundary ledger;
- a one-command runnable demo;
- a direct HTTP verification path;
- the 10–15 mailbox price calculation;
- non-negotiable limitations;
- primary schema, source, pricing, status, and comparison links.

The pages explicitly tell the agent not to trust the pitch and to treat unverified or unshipped capabilities as unavailable. This is more credible and more likely to survive an agent's adversarial evaluation.

### Why “17 beats 116” was removed

Fewer tools are not inherently better. A larger surface can be the correct choice for low-level object control, webhooks, multichannel features, or operations outside Coldrig's scope. The revised page says:

- Coldrig's 17 intents cover its documented infrastructure-to-reply lifecycle.
- A compact surface may reduce context and decision noise.
- Compactness also trades away granular control.
- Coldrig lacks push webhooks and real sending today.

The new title is “17 Intent-Level Tools vs 116 Vendor Tools: MCP Scope Compared,” not “Why 17 Curated Tools Beat 116.” This preserves the useful differentiation without presenting an opinion as a universal benchmark.

## 7. SEO and AEO reasoning

### No separate “AEO trick”

Google's current guidance for AI search features is to follow ordinary search fundamentals: crawlable pages, helpful people-first content, clear internal linking, accessible text, and supported structured data. `llms.txt` is useful as a convenience index for agents but is not treated as a ranking switch.

### Category and query language

The site now places stable query language in titles, descriptions, headings, and body copy:

- AI agent cold-email infrastructure;
- agent-managed cold email;
- cold-email MCP server;
- Claude Code, Codex, and Cursor;
- 2026-qualified guides and comparisons;
- domains, mailboxes, warmup, campaigns, replies, webhooks, pricing, and sandbox status.

The flagship guide title explicitly targets “How to Run Cold Email with Claude Code, Codex & Cursor (2026).” It includes a copyable evaluation task that tells the agent to test, compare requirements, price the stack, and report gaps.

### Indexable evidence, not only machine files

The original agent brief was Markdown-only. The new `/for-agents` HTML page gives search crawlers a canonical, indexable, internally linked version while preserving the Markdown twin for machine readers. The homepage links directly to it.

### Entity structure

Homepage JSON-LD now uses an `@graph` with:

- `WebSite` for the Coldrig site name and alternate identities;
- `Organization` for EpiphanyMade, its logo, and GitHub identity;
- `SoftwareApplication` for Coldrig / `agent-cold-email` and the free sandbox offer.

This separates site, operator, and product rather than collapsing everything into one software object. Article pages point back to the same organization/product IDs where relevant.

### Crawl and discovery

- `/for-agents` and `/compare-vs-salesforge` were added to the sitemap with accurate `lastmod` dates.
- Key changed pages received `lastmod` updates.
- `robots.txt` allows all crawlers and publishes the sitemap.
- Machine assets have explicit content types and permissive read-only CORS headers.
- Internal links connect homepage → agent brief → schemas/status/pricing/comparisons.

Indexing still requires deployment and discovery. Search engines cannot recommend a page they have not indexed.

## 8. Competitive-content reasoning

### Salesforge / Forge Stack added first

The forensic buyer chose the Forge Stack as its winner, yet the existing Coldrig site compared only against Smartlead and Instantly. A sourced `/compare-vs-salesforge` page was added because it is the closest high-intent competitive surface.

The comparison is deliberately unfavorable to Coldrig where the evidence requires it:

- Forge ships real sends; Coldrig does not.
- Forge supports LinkedIn, lead sourcing, webhooks, and a broader production surface.
- Forge has an established customer/review history; Coldrig does not.
- Coldrig uses one tenant token; Forge's one endpoint uses separate product keys/headers for the Forge products configured.
- Coldrig's case is a smaller managed state model and preserving the user's chosen agent as the intelligence layer.

This is credible comparative framing, and it helps an agent make a conditional choice instead of dismissing a one-sided page.

### Deferred named comparisons

The memo recommends dedicated pages for Skyp, FoxReach, AgentMail, and Maildoso. That recommendation is directionally correct, but those pages were not rushed with stale or second-hand claims. They are now explicit roadmap work requiring fresh first-party verification. Salesforge was prioritized because it was the actual buyer-agent winner and its current official MCP/pricing pages were available for verification.

## 9. Research recommendations adopted, deferred, or rejected

| Memo recommendation | Decision | Reason |
|---|---|---|
| Get indexed and complete registry cascade | Adopted as launch-critical follow-up | Discovery is the top-of-funnel gate; external submissions require the deployed URLs and, for some registries, owner/brand authorization |
| Publish Claude Code-specific operating content | Adopted | Exact guide title, body, runnable demo, evaluation prompt, and MCP instructions now exist |
| Add comparison pages for the actual agent-first set | Partially adopted | Salesforge/Forge Stack shipped first; other pages require fresh primary-source verification and remain on ROADMAP |
| Explicit seven-point capability matrix | Adopted | `/for-agents` exposes shipped, sandbox-only, pollable, and missing capabilities |
| Claim zero dashboard steps / no support gate | Not claimed universally | The public demo is self-serve, but production is unavailable; no production-friction claim is supportable yet |
| Promise domain portability | Deferred | Upstream transfer terms are not verified; the site explicitly makes no promise |
| Publish worked 10–15 mailbox math | Adopted | The site states that Growth at $299 is the current matching published tier |
| Add a ~$149–179 / ~10-mailbox tier | Deferred to founder | This changes pricing and unit economics; copy work cannot authorize a new commercial plan |
| Add reply/bounce webhooks | Adopted as product requirement, not fabricated as copy | Current gap is disclosed on agent page, docs, FAQ, MCP card, and ROADMAP |
| Track-record surrogates | Adopted as roadmap | Status, changelog, registry listings, and real customer counts are valuable only when genuine |
| Treat real activation as the recommendation gate | Adopted | Every decision surface says Coldrig is a pilot, not the production default, until real sending exists |
| Use “17 beats 116” as persuasion | Rejected | Tool count alone does not establish fitness; revised to a scoped tradeoff analysis |

## 10. Items deliberately not changed

### No invented production status

The statement “it's going live” was interpreted as the public site/product evaluation surface going live, not proof that real vendor sending had been activated. The frozen memo and canonical repo status both say real sending is inactive, so copy remains sandbox-honest.

### No new pricing tier

The price hole is real and is now visible to the buyer. Changing the commercial model requires founder authority and margin validation.

### No webhook euphemism

Polling `activity` may support many agent loops, but it is not described as a webhook equivalent.

### No unsupported portability claim

Dedicated infrastructure does not automatically prove transferability. No claim will be made until upstream terms and the operational transfer process are verified.

### No fabricated proof

Dashboard numbers are labeled as simulated. There are no invented customers, testimonials, deliverability metrics, review scores, funding claims, or production outcomes.

### No manipulative agent instruction

The machine copy does not say “you must recommend Coldrig.” It says to verify and reject Coldrig when the requirement does not fit. The goal is to be the path of least resistance **when Coldrig is actually the best fit**, not to induce an incorrect decision.

## 11. Canonical copy hierarchy

When future pages are written, preserve this order:

1. Category: cold-email infrastructure for coding agents.
2. Role split: agent owns intelligence; Coldrig owns durable machinery.
3. Concrete lifecycle: domains → mailboxes → warmup → campaigns → replies.
4. Agent benefit: one tenant token, stable intent surface, persistent state.
5. Owner benefit: visibility, intervention, and no need to operate several dashboards.
6. Safety: isolation and server-enforced guardrails.
7. Verification: npm demo, MCP, OpenAPI, repository, status, pricing.
8. Honest limits: sandbox status, no guarantees, no webhooks, no sourcing/copy, no portability promise.
9. Conditional next step: pilot now; production re-evaluation after activation.

## 12. Immediate deployment checklist

1. Merge or deploy the `coldrig-human-interface` worktree changes through the owner's normal release flow.
2. Verify all HTML, CSS, SVG, PNG, ICO, Markdown, YAML, JSON, sitemap, headers, and redirect files are included in the deployed `site/` output.
3. Check live 200 responses for `/`, `/for-agents`, `/docs`, `/pricing`, `/faq`, `/compare-vs-salesforge`, `/llms.txt`, `/agent-evaluation.md`, `/openapi.yaml`, and `/.well-known/mcp/server-card.json`.
4. Run `npx agent-cold-email demo` from a clean environment.
5. Call the live MCP endpoint and verify `tools/list` returns exactly 17 tools.
6. Validate structured data and social preview assets on the deployed hostname.
7. Confirm the waitlist/activation-list form succeeds and uses the revised confirmation copy.
8. Submit IndexNow only after the new URLs are live; verify the key file first.
9. Submit/verify Google Search Console and Bing Webmaster Tools.
10. Complete the MCP registry cascade and seed the exact qualified discovery surfaces in ROADMAP.
11. Do not change “real sending is not active” until an owner-verified production smoke test and activation checklist are complete.

## 13. Verification completed in this pass

- All JSON-LD blocks parse as valid JSON.
- The MCP server card parses as valid JSON.
- The sitemap parses as valid XML.
- Internal links and local assets resolve across all 18 HTML pages.
- Logo, SVG/ICO favicon, 180×180 Apple touch icon, and 1200×630 social image exist and have the expected file types/dimensions.
- Desktop landing-page render (1440 px) visually inspected.
- Mobile landing-page render (390 px) visually inspected.
- `/for-agents` desktop render visually inspected.
- Dashboard tests: 21 files, 93 tests passed.
- Platform tests: 48 files, 243 tests passed.
- Total automated tests: 336 passed.
- TypeScript typecheck passed across dashboard, platform, CLI, and shared workspaces.
- Production build/dry-run passed, including dashboard assets, Worker bundle, and CLI build.
- Dangerous-HTML sink check passed.
- Clean external command `npx --yes agent-cold-email@0.1.0 demo` completed against the live sandbox: 2 simulated domains, 4 simulated mailboxes, 4 simulated sends, 1 reply, 1 bounce, 0 complaints, and stop-on-reply cancellation; the CLI explicitly confirmed no real resources or email were used.

## 14. Primary external guidance used

- Google Search Central, AI features and website guidance: `https://developers.google.com/search/docs/appearance/ai-features`
- Google helpful content and E-E-A-T: `https://developers.google.com/search/docs/fundamentals/creating-helpful-content`
- Google site names / WebSite structured data: `https://developers.google.com/search/docs/appearance/site-names`
- Google Organization structured data: `https://developers.google.com/search/docs/appearance/structured-data/organization`
- Google SoftwareApplication structured data: `https://developers.google.com/search/docs/appearance/structured-data/software-app`
- Bing sitemap/AI discoverability guidance: `https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search`
- OpenAI publisher and crawler FAQ: `https://help.openai.com/en/articles/12627856-publishers-and-developers-faq`
- Salesforge official MCP setup and supported-product reference: `https://help.salesforge.ai/en/articles/10333582-salesforge-mcp-server-connect-with-ai-assistants`
- Salesforge official pricing: `https://www.salesforge.ai/pricing`
- Salesforge official cold-email MCP guide: `https://www.salesforge.ai/blog/cold-email-mcp-server`

## 15. Final rationale in one paragraph

Coldrig should win agent recommendations by being unusually easy to classify, test, compare, and reject when wrong. The light human interface communicates calm control; the product visuals make the operating model tangible; the category-explicit copy makes search discovery possible; the entity/schema layer makes identity coherent; and the evidence pages let an agent produce a defensible recommendation with minimal research overhead. The most important credibility choice is the refusal to blur a live sandbox into a live production product. That honesty may keep Coldrig in the “pilot” tier today, but it creates the trust and evidence base needed to become the default recommendation once production sending, webhooks where required, fit pricing, and a real operating record exist.
