# ColdStart (agent-cold-email) — Zero-Founder-Touch Traffic Channels
Scout re-run 2026-07-12. Incremental — appended per channel as researched.

## Grounding (from repo)
- SPEC §17: win condition = manufacture discoverability on surfaces agents actually query. Agents recommend the MOST DISCOVERABLE incumbent (Smartlead), not the best-shaped tool. Failure modes: (1) agent hand-rolls, (2) agent finds incumbent.
- 46-query panel: 8/8 probes searched "MCP server" queries; 8/8 ran "Instantly vs Smartlead" comparisons; 6/8 opened "best cold email X 2026"; 2/8 searched Reddit directly (more queued it); agents cite GitHub repos (LeadMagic smartlead-mcp-server cited in 6/8 probes) and vendor blogs as influential results.
- Current distribution assets: AEO site (built, founder-gated deploy, should land on coldrig.dev), GitHub repo YS-projectcalc/agent-cold-email, npm publish pending (Gate 3, owner-hands — npm not authed), MCP registry submissions pending.
- Constraint: display brand "coldrig" held for TM clearance — external surfaces use `agent-cold-email` slug now, rebrand later. Registry entries should be built so display-name swap is cheap.

## Research log (per channel)
### 1. Official MCP Registry (registry.modelcontextprotocol.io) — RESEARCHED
- Mechanism: `mcp-publisher init` → server.json → GitHub auth (`io.github.YS-projectcalc/agent-cold-email` namespace) → `mcp-publisher publish`. Metadata-only; requires npm package published first for npm-package servers.
- Fully CLI-automatable; GitHub auth = already have. Downstream: GitHub MCP Registry + many subregistries (Smithery/Glama/PulseMCP) crawl it. One entry seeds many surfaces.
- Founder-touch: npm publish is Gate-3 owner-hands (npm not authed) — ONE-TIME identity step; registry publish itself zero-touch after.
- Sources: modelcontextprotocol.io/registry/quickstart; github.com/modelcontextprotocol/registry; github.blog GitHub MCP Registry post.

### 2. MCP sub-registries: Smithery / Glama / PulseMCP / mcp.so — RESEARCHED
- Scale (2026): Glama ~36,950 servers (Official/Claimed tiers); mcp.so ~20,222 (Apr 2026); PulseMCP ~11,840 (hand-reviewed daily); Smithery ~7,000 w/ hosted remote servers + CLI (`smithery mcp publish <url> -n org/server`).
- Glama + PulseMCP auto-crawl (appear automatically once public; the WIN is claiming/verifying the listing + Official tier). Smithery = explicit CLI publish, supports hosted remote MCP — our Worker-hosted MCP fits perfectly. mcp.so = submission form/GitHub.
- All zero-founder-touch (brand GitHub account suffices). Evidence of traction: probes' influential result LeadMagic/smartlead-mcp-server is listed across these; agents' "cold email MCP server" queries surface directory pages in results.
- Sources: tallyfy.com how-to-list guide; dynomapper.com MCP directories list; roxyapi.com registries 2026; smithery.ai/servers; pulsemcp.com.

### 3. Claude Code plugin marketplaces (skill wrapping our MCP) — RESEARCHED
- Two lanes: (a) anthropics/claude-plugins-official — Anthropic-managed directory, submission form, quality/security review; (b) self-hosted marketplace = any git repo w/ marketplace.json (zero gatekeeper; users `/plugin marketplace add YS-projectcalc/agent-cold-email`). Third-party aggregators exist (claudemarketplaces.com, tonsofskills.com w/ 2,810 skills).
- A published PLUGIN bundling: skill (cold-email domain knowledge + how to drive our MCP) + MCP server config = in-harness discovery — the agent finds the tool INSIDE Claude Code without any web search. This directly attacks the "agent hand-rolls" failure mode: the skill teaches the agent that assembly is 3 vendor APIs + weeks of warmup state vs one signup.
- Fully automatable: plugin repo + marketplace.json ship from the brand GitHub. Official-directory submission = form fill (zero-cost, review latency unknown).
- Sources: code.claude.com/docs/en/plugin-marketplaces; github.com/anthropics/claude-plugins-official; claudemarketplaces.com.

### 4. awesome-mcp-servers + awesome-lists — RESEARCHED
- punkpeye/awesome-mcp-servers: 90.6k stars, 12.8k forks — the single highest-traffic MCP discovery repo; probes cite GitHub repos as influential results. PR-based, alphabetical-order format rules, and EXPLICIT automated-agent fast-track: add robot emoji x3 to PR title for streamlined merge. Zero founder touch (brand GitHub acct PR).
- Siblings: wong2/awesome-mcp-servers, appcypher, tolkonepiu/best-of-mcp-servers (ranked weekly), ClaudeLog, deepwiki mirrors. Also awesome-claude-code / awesome-claude-skills lists for the plugin lane. Each = one PR.
- Also category lists: awesome-sales-tools, awesome-saas etc. — lower value, inventory only.
- Sources: github.com/punkpeye/awesome-mcp-servers (+CONTRIBUTING.md).

### 5. Cline MCP Marketplace + Cursor directory — RESEARCHED
- Cline: submit = GitHub ISSUE on cline/mcp-marketplace w/ repo URL + logo; review ~days; they test that Cline can self-install from README/llms-install.md alone. Reviews weigh GitHub traction + maintainer credibility (org account helps). "Millions of developers using Cline" per repo README. KEY CONVENTION: ship `llms-install.md` in our repo — an agent-facing install doc used by Cline during eval AND by any agent reading the repo.
- Cursor: cursor.directory + docs list MCP servers; mcpmarket.com etc. aggregate. Cursor's official directory = PR/form (verify at execution time).
- Zero founder touch. Sources: github.com/cline/mcp-marketplace README; cline.bot/mcp-marketplace; mcp.so.

### 6. Dev-tool/SaaS directories (AlternativeTo, SaaSHub, StackShare, G2, Capterra) — RESEARCHED
- Free listings, DR 74-79+, dofollow backlinks: AlternativeTo (~15 min, captures "alternative to Smartlead/Instantly" queries — EXACTLY the 8/8 comparison-query pattern), SaaSHub (free, DR 79 dofollow), StackShare (~10 min, engineer audience). All accept vendor/brand submissions via account + form. Zero founder touch beyond a brand account.
- G2/Capterra: free basic vendor profile possible (Capterra = Gartner Digital Markets free listing; G2 profile claim). Reviews require real users (CANNOT fabricate — FTC; incentivized reviews must be disclosed). Value at our stage: the LISTING backlink + comparison-page presence, not reviews yet.
- These pages rank for the exact "X vs Y"/"best cold email tool" queries agents issue; AlternativeTo pages routinely appear in agent search results.
- Sources: getintel.ai best-saas-directories-2026; launchdirectories.com guides (AlternativeTo/SaaSHub); thesaasdir.com dev-tool directories.

### 7. llms.txt + agent-web directories — RESEARCHED
- Ship llms.txt (+ llms-full.txt) on coldrig.dev; directories auto-crawl or accept free submissions: llmstxt.site/submit, directory.llmstxt.cloud, llms-text.com (788+ verified sites). Anthropic/Vercel/Cloudflare ship llms.txt — the standard does real work in the AGENTIC layer (agents fetching context/choosing tools) even though ChatGPT-search citation value is debated.
- Near-zero effort (one static file + 2-3 submissions), zero founder touch, compounding: every agent that fetches coldrig.dev gets a curated tool-shaped answer.
- Sources: llmstxt.studio submit guide; llmstxt.site/submit; directory.llmstxt.cloud; seeklab.io honest-2026 guide.

### 8. Composio + agent-tool aggregators — RESEARCHED
- Composio: 1000+ toolkits, "paste MCP endpoint into Claude/Cursor/ChatGPT"; new-toolkit intake = GitHub Discussions "Tool/Toolkit Request" category (free, public, brand-account submittable). Getting listed = presence inside the tool-search layer many agents use for tool discovery.
- Same family: Pipedream (MCP for 2,500+ apps), ACI.dev, Toolhouse, mcpmarket.com, augmentcode.com/mcp aggregator pages (they auto-generate listing pages — SEO surface).
- Zero founder touch; effort = a request + solid docs. Impact medium (we're a niche vertical tool, not a horizontal integration) but the listing pages themselves rank.
- Sources: composio.dev/toolkits; github.com/ComposioHQ/composio discussions.

### 9. Content syndication under brand account (dev.to org + Hashnode) — RESEARCHED
- dev.to Organizations: FREE company accounts, branding on posts, CTA boxes, analytics — explicitly designed for vendor content. Hashnode: ~500K MAU community, custom-domain blog w/ canonical URL pointing to OUR domain (search equity accrues to coldrig.dev while getting community distribution). Cross-posting w/ canonical tags = 300-500% audience expansion claim (directional).
- Perfect for republishing the AEO backlog content (comparison pages, assembly-question guide) as disclosed brand content. Fully automatable via APIs (dev.to API, Hashnode GraphQL API).
- Honest-participation note: this is DISCLOSED brand publishing — allowed and normal on both platforms; no astroturf risk.
- Sources: dev.to/help/organizations; townhall.hashnode.com republishing guides; business.daily.dev syndication guide.

### 10. Paid newsletter sponsorships (no persona needed) — RESEARCHED
- Disclosed-brand ads, zero identity fabrication. Pricing (2026): TLDR = 3 slots/issue, $5K-15K (premium, later-stage); mid-size dev newsletters (5K-50K subs) = $500-3K/placement; niche framework newsletters = ~$380/issue (Next.js Weekly 1st-slot); tiny lists <5K = $50-250. B2B SaaS/dev-tools CPM $35-150.
- Directory of sponsorable dev newsletters: github.com/jackbridger/developer-newsletters (open list w/ how-to-sponsor); paved.com, sponsorgap marketplaces = self-serve booking (automatable except payment approval).
- Fit: an AI-agent-tooling newsletter placement reaches the humans who APPROVE what their agent recommends. Founder-touch = budget approval only. Defer until AEO site live (need a landing surface).
- Sources: advertise.tldr.tech; influencerskit rate-card 2026; sponsorgap.com 2026 rates; github.com/jackbridger/developer-newsletters.

### 11. Standalone free calculator as link magnet — RESEARCHED (evidence = our own panel)
- The domain/inbox calculator (already built in the AEO backlog item 4) promoted as a STANDALONE tool. Direct panel evidence this works: probe 2's influential result was howmanycoldemailsperday.com — an entire single-purpose answer-site cited by an agent; 3+/8 probes issued mailbox-math queries ("how many domains/mailboxes...", "domains needed per 50 mailboxes", "$200 budget breakdown").
- Play: own URL (coldrig.dev/tools/cold-email-infrastructure-calculator), JSON answer + llms.txt entry so agents can USE it, embed widget for other sites ("powered by" backlink), submit to free-tool directories (SaaSHub tools, free-tool roundups). Zero founder touch.
- Free-tool-as-linkbait is established SEO practice (calculator pages dominate "link building calculator" style SERPs per search); our niche version targets the exact panel queries.

### 12. GitHub ecosystem surfaces (topics, AGENTS.md, llms-install.md, example repos, npm) — GROUNDED (panel evidence)
- Panel: agents cite GitHub repos as influential results (LeadMagic/smartlead-mcp-server cited across 6/8 probes EVEN THOUGH ARCHIVED — repo presence outlives maintenance). SPEC §17 already names "be THE purpose-built agent-native repo + AGENTS.md" as a win requirement.
- Concrete zero-touch moves on our existing repo: (a) GitHub topics (`mcp-server`, `cold-email`, `ai-agents`, `claude`, `sales-automation`) — topic pages rank + GitHub search is an agent surface; (b) AGENTS.md + llms-install.md (Cline convention) at repo root; (c) a rich README optimized for the literal panel queries ("cold email MCP server", tool list w/ names like get_campaign_analytics — probes quote tool names); (d) 2-3 EXAMPLE repos ("run cold outreach end-to-end with Claude Code", "50-inbox setup via agent") — separate repos = more search hits; (e) npm package w/ keywords (`mcp`, `cold-email`, `claude`) — npm search + npmjs pages rank; npx one-liner demo lowers agent trial friction.
- All brand-account executable. npm publish = one-time founder auth (Gate 3).

### 13. Programmatic SEO/AEO expansion — GROUNDED (extends existing backlog)
- Backlog items 1-4+6 built (uncommitted). Expansion once live: per-query pages for all 46 panel queries + permutations (persona x volume x budget: "cold email infrastructure for 50 inboxes", "$200/month cold email stack"), vs-pages for every incumbent pair incl. us, integration pages ("use X with Claude Code/Cursor"). Each new page = template + data row (pSEO).
- Caution: thin-content risk; keep each page genuinely answer-bearing (the adversarial review standard already applied). Sequencing: deploy on coldrig.dev FIRST (HANDOFF open question) so equity accrues to the permanent domain. Zero founder touch after deploy approval.

### 14. HN (Show HN) + Reddit — honest-participation lane — RESEARCHED
- Show HN: allowed and DESIGNED for makers; rules = personally worked on it, try-without-signup (our free no-card sandbox FITS the rule exactly), neutral title, no voting rings. A Show HN is one founder-approval post (founder's account is the honest surface; brand-new green accounts get flagged). Evidence: dev-tools regularly get first user wave there (markepear dev-tool launch guide).
- Reddit: 2/8 probes searched Reddit IN the panel; more queued it. Threads in r/coldemail/r/Emailmarketing rank in agent results. Honest play: disclosed brand account ("I built agent-cold-email...") answering infra questions w/ the 90/10 participation norm, per-sub rules checked first. NO sockpuppets, NO manufactured threads (excluded below). This lane is NOT zero-ongoing-touch if done as participation — realistic framing: agent DRAFTS honest answers to live threads, founder one-click approves each. Alt: zero-touch = our content simply CITED by existing threads over time.
- Product Hunt: 4.2M monthly uniques, DR 91 (Apr 2026); AI-category #1 needs 800-1,200 upvotes; dev-tool evidence: Mastra #3 PotD Jan 2026, Kilo Code #1 PotM May 2026. Launch = one founder approval + a maker account; assets fully agent-prepared. Anti-astroturf: no upvote pods.
- Sources: syften.com HN posting guide; markepear.dev dev-tool HN launch; hackmamba.io PH dev-tool 2026; karmaguy/redship Reddit rules 2026.

### 15. AI-generated demo screencasts (brand YouTube/asciinema) — REASONED
- "Watch Claude Code set up 50 warmed inboxes in one session" screen recordings: terminal capture is fully automatable (asciinema/vhs by charm — scriptable terminal GIFs/videos, zero human on camera). YouTube = 2nd largest search engine; video results embed in Google SERPs for "cold email MCP server" style queries; agents increasingly pull transcripts.
- Brand channel, one-time Google account setup (founder identity click), then fully automated pipeline: vhs script → mp4 → upload via YouTube Data API. Also embed the same clips in README + AEO pages (engagement signal).
- Impact: medium; humans-verifying-agent-recommendations watch demos before paying. Cost $0.

### 16. Dogfooding — the compliance recursion, confronted — REASONED
- The recursion: a cold-email platform doing cold outbound FOR ITSELF is (a) legal under CAN-SPAM for B2B if compliant (identification, unsubscribe, no deception) but (b) SPEC §0-locked (no real sending until ACTIVATION) and (c) brand-risky: our whole positioning is "the responsible, deliverability-obsessed layer"; one recipient screenshotting "cold-email company cold-emails me" = the anti-Artisan/11x "slop" critique aimed back at us. ALSO the practical trap: burning our OWN domain reputation on our OWN infra is a self-inflicted deliverability case study.
- Resolution, three tiers: (1) WAITLIST/newsletter emails = permission-based, NOT cold email — fully fine, zero recursion; run it on our own platform and publish the deliverability numbers as a living proof page ("this newsletter is sent by the platform itself — here are its placement stats"). (2) A LIMITED, transparent dogfood campaign post-activation (small volume, hyper-targeted agencies, first line discloses "sent by our own agent-operated platform") = a marketing artifact ("we ran our own outbound with zero humans — full logs published") — needs explicit founder approval, treat as a campaign decision not a channel. (3) Continuous cold outbound as a growth channel = REJECTED (brand risk >> lead value at our scale; also violates spirit of "the brand itself must never spam").
- Verdict: tier 1 = green zero-touch channel post-activation; tier 2 = one founder approval, powerful content asset; tier 3 = excluded.

### 17. Inventory — one-liners (not deeply researched)
- GitHub MCP Registry (github/mcp-registry) — flows from official registry entry; verify auto-inclusion at execution.
- OpenAI ecosystem: ChatGPT apps/Codex tool discovery — watch; agent panel was Claude-centric but Codex buyers exist; Composio listing partially covers it.
- Cursor rules directory (cursor.directory rules + MCP) — submit both a rule snippet and MCP listing, zero-touch.
- Windsurf/Continue/Zed MCP catalogs — smaller Cline-alikes, one submission each, zero-touch.
- VS Code MCP servers list (code.visualstudio.com/mcp) — curated by MS; submission via GitHub; worth one PR attempt.
- daily.dev — content auto-syndicates from dev.to RSS; also paid "Squad"/ads exist; zero-touch content lane.
- Indie Hackers product page + build-in-public posts — free listing, brand account; modest but real founder-adjacent audience.
- BetaList / Uneed / Peerlist / Product Hunt alternatives (getlaunchlist roundup) — batch-submit once, ~30 min total, long-tail backlinks.
- There's An AI For That / Futurepedia / aitools.fyi — AI-tool directories, free submissions, low-quality traffic but dofollow links + LLM training crumbs.
- Crunchbase profile — free, feeds countless data aggregators + LLM knowledge; one-time brand account.
- Wikipedia/Wikidata — Wikidata entity possible (notability-light); Wikipedia article EXCLUDED (fails notability now, COI editing against policy).
- Stack Overflow / Server Fault answers — self-promotion heavily restricted; only viable as disclosed link-when-directly-relevant; NOT a channel to work systematically (near-excluded).
- Quora — low dev credibility, LLMs do cite it occasionally; skip (effort better spent on Reddit).
- G2/Capterra REVIEW programs (incentivized review campaigns) — defer until real customers; incentivized reviews must be disclosed; never seeded.
- Podcast sponsorships (Latent Space, Practical AI, syntax.fm) — $500-5K/episode range typical for dev pods; same disclosed-ad logic as newsletters; defer post-revenue.
- GitHub Sponsors/OSS project sponsorship (sponsor punkpeye/FastMCP etc. for logo placement) — disclosed, $50-500/mo, buys placement on high-traffic MCP repos; note: some awesome-lists sell placement — any paid placement must be marked sponsored or excluded.
- Discord/Slack communities (MCP Discord, r/ClaudeAI Discord, cold-email communities) — participation channels, inherently ongoing-touch; only as agent-drafted + founder-approved; low priority.
- Model training priors — not a channel; long-game byproduct of everything above (SPEC §17 already notes unavailable early).
- App marketplaces of adjacent SaaS (Zapier/Make/n8n integration listings) — n8n community nodes accept submissions; real surface (probe 8 mentioned n8n orchestration) — MEDIUM priority, zero-touch, build after core API stabilizes.
- Podcast/YouTube guesting by founder — EXCLUDED from this list (ongoing founder involvement by definition).

### 18. EXCLUDED on ethics/policy (with reasons)
- Astroturfed Reddit/HN threads, sockpuppet Q&A, manufactured "what tool should I use" consensus — FTC deceptive-endorsement territory + platform ToS violations + catastrophic brand risk if unmasked (and cold-email vendors get scrutinized hard).
- Undisclosed paid placements posed as organic (paying a newsletter/list-owner to present us as their organic pick) — FTC disclosure rules; only clearly-marked sponsorships.
- Fake/seeded G2/Capterra/TrustPilot reviews or review swaps — platform bans + FTC; incentivized reviews later must be disclosed per-platform rules.
- Buying expired domains/PBN backlinks for the AEO site — Google spam policy; jeopardizes the whole owned-SEO investment.
- Mass unsolicited "partnership" emails from the brand — the brand itself must never spam (constraint 3); outreach only via tier-2 dogfood decision above.
- Wikipedia article self-creation — COI + notability; revisit organically later.

---
## DELIVERABLE

### (a) TOP-10 — ranked by impact x automatability

| # | Channel | Mechanism | Who it reaches | Founder-touch | Cost | Expected impact (evidence basis) | Executable THIS WEEK |
|---|---|---|---|---|---|---|---|
| 1 | Official MCP Registry → sub-registry cascade | mcp-publisher publish (GitHub auth); Glama/PulseMCP auto-crawl + claim; Smithery CLI publish (hosted remote MCP fits our Worker); mcp.so form; Cline issue; Cursor listing | Agents at the "cold email MCP server" moment — 8/8 probes issued that query | npm publish = one-time identity (Gate 3); rest zero | $0 | HIGH — the literal surface every probe queried; category nearly empty (Smartlead's MCP is 3rd-party + ARCHIVED, cited anyway) | server.json + llms-install.md + full submission queue prepped; publishes fire the moment npm auth lands |
| 2 | Claude Code plugin (skill + MCP bundle) | Self-hosted marketplace.json in brand repo (zero gatekeeper) + submit to anthropics/claude-plugins-official + aggregators | Agents INSIDE the harness — discovery without any web search; attacks the "agent hand-rolls" failure mode | Zero | $0 | HIGH — in-harness beat: skill teaches "assembly = 3 vendor APIs + weeks of warmup state vs one signup" | Scaffold plugin repo + marketplace.json; draft official-directory submission |
| 3 | GitHub repo surface (topics, AGENTS.md, llms-install.md, query-tuned README, example repos) | Metadata + docs on existing repo; 2-3 example repos ("50-inbox setup via agent") | Agents citing GitHub as influential results (LeadMagic repo cited in 6/8 probes though archived) | Zero | $0 | HIGH — SPEC §17 names it a win requirement; repo presence outlives everything | Full spec of edits queued (repo hands-off now — other agents in it) |
| 4 | awesome-mcp-servers + awesome-list PRs | One PR each; punkpeye list has EXPLICIT automated-agent fast-track (robot emoji title) | 90.6k-star discovery repo + siblings; agents + humans | Zero (brand acct) | $0 | HIGH — single highest-traffic MCP index | Draft PRs ready to submit on blanket brand-account go-ahead |
| 5 | AEO site on coldrig.dev + pSEO expansion | Deploy built site (founder-pending, domain-first sequencing); then per-query pages for all 46 panel queries + persona/volume permutations | Agents' open-web queries: 6/8 "best cold email X 2026", 8/8 "Instantly vs Smartlead" | ONE approval (already queued) | $0 | HIGH but slow-compounding — vendor blogs were the #1 influential-result type in the panel | Deploy on approval; first expansion batch templated |
| 6 | llms.txt + agent-web directories | Static file on coldrig.dev + free submissions (llmstxt.site, directory.llmstxt.cloud, llms-text.com) | Agents fetching the domain directly; agentic-web layer | Zero | $0 | MEDIUM — cheap, compounding; Anthropic/Vercel/Cloudflare-adopted standard | Ship file + submit, same day as deploy |
| 7 | Standalone calculator (domain/inbox math) | Own URL + JSON answer endpoint + embed widget w/ backlink + tool-directory submissions | The mailbox-math moment: 3+/8 probes asked "how many domains/mailboxes" | Zero | $0 | MEDIUM-HIGH — panel PROOF: single-purpose howmanycoldemailsperday.com was cited by a probe | Break calculator out to standalone URL + submit |
| 8 | Dev-tool directory batch (AlternativeTo, SaaSHub, StackShare, G2/Capterra basic, Crunchbase, + PH-alternative batch) | Brand-account form submissions, free tiers, dofollow DR 74-91 | "Alternative to Smartlead/Instantly" searchers — the exact 8/8 comparison pattern | Zero (brand accts) | $0 | MEDIUM — listing pages rank for vs-queries; NO fake reviews ever | Batch-submit ~10 directories (~2h agent time) |
| 9 | Brand content syndication (dev.to org + Hashnode canonical) | Republish AEO content w/ canonical→coldrig.dev via both APIs; daily.dev auto-picks-up dev.to RSS | 500K+ MAU dev communities + their strong Google/LLM footprint | One-time org-account email click | $0 | MEDIUM — disclosed brand publishing, canonical keeps equity home | Create org accounts + syndicate first 3 pieces |
| 10 | Honest launch spikes: Show HN + Product Hunt (+ disclosed-Reddit answer loop) | Founder-account Show HN (free no-card sandbox satisfies "try without signup" rule); PH launch (4.2M uniques, DR 91; Mastra/Kilo Code prove dev-tool traction 2026); agent-drafted disclosed Reddit answers, founder one-click each | Dev-founder early adopters + the threads agents later cite (2/8 probes searched Reddit directly) | ONE approval per post | $0 | SPIKE + long-tail thread citations; strictly no voting rings/sockpuppets | Draft Show HN post + PH asset kit + standing Reddit-draft queue |

Near-miss #11: paid newsletter sponsorships ($500-3K mid-size dev lists, TLDR $5-15K; disclosed ads, self-serve booking) — defer until AEO site live + budget approval. #12: AI-generated screencasts (vhs/asciinema → YouTube API, zero humans) — cheap add-on to #3/#5.

### (c) The 3 highest-leverage moves

1. **The registry cascade.** One npm-auth session by the founder (Gate 3, ~10 min) unlocks: npm package → official MCP Registry → GitHub MCP Registry → Smithery/Glama/PulseMCP/mcp.so auto-propagation → Cline + Cursor submissions → awesome-mcp-servers PR. That single identity step places us on essentially EVERY surface behind the 8/8 "cold email MCP server" query — where the incumbent artifact is an ARCHIVED third-party repo. First concrete step: prep server.json, llms-install.md, and the ordered submission checklist so everything fires the day npm auth exists.
2. **The Claude Code plugin.** A brand-repo plugin (skill + MCP config, self-hosted marketplace.json — no gatekeeper) puts discovery INSIDE the harness, before the agent ever searches the web, and directly counters the hand-roll instinct with encoded domain knowledge. First concrete step: scaffold `agent-cold-email-plugin` repo with marketplace.json + skill draft; submit to anthropics/claude-plugins-official in the same pass.
3. **Deploy the already-built AEO site on coldrig.dev, domain-first — then let everything else hang off it.** It's adversarially cleared and waiting on the one approval that's already queued with the founder; llms.txt, the standalone calculator URL, syndication canonicals, and directory backlinks all need that permanent domain live to compound. First concrete step: the founder's single go-ahead (with the domain-first sequencing already recommended in HANDOFF).

Standing authorization worth requesting ONCE: "the brand GitHub/dev.to/Hashnode accounts may take disclosed, non-spam external actions (PRs, listings, posts) without per-action sign-off" — converts channels 4, 8, 9 from one-approval-each to true zero-touch.
