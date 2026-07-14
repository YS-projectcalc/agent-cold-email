# Agent-Buyer Research Forensics — 2026-07-14 (FROZEN research record)

**What this is:** A real, unprompted-by-us buyer simulation. In an unrelated session, Yaakov asked "I want to set up cold email completely managed by you — what service can I get?" and a Sonnet research agent (WebSearch + WebFetch, 22 searches, 7 fetches, 3m45s) surveyed the category and produced a vendor recommendation. This doc is the forensic reconstruction of that run — the transcript was parsed tool-call-by-tool-call — plus the ColdRig comparison and the ranking playbook derived from it. **ColdRig scored zero appearances.** This is the highest-fidelity ground truth we have on how an AI agent actually shops this category.

Companion frozen records: `agent-search-queries-2026-07-12.md` (8-probe panel), `traffic-channels-selfserve-2026-07-13.md` (13 ranked channels). This run CONFIRMS the panel's findings with a real buyer-intent task.

---

## 1. The verdict the buyer-agent produced

- **#1: Salesforge "Forge Stack"** (Salesforge + Mailforge + Warmforge), ~$175/mo at 3–5 domains / 15 mailboxes — i.e. **our own upstream vendor, assembled DIY**. Deciding sentence: *"the only candidate whose vendor is actively marketing full-loop Claude Code automation as the primary use case."*
- **#2: Smartlead Pro** ($94/mo) + SmartSenders mailboxes (~$168/mo total) — biggest MCP surface (116+ tools), best deliverability diagnostics, dinged for a support-email-gated provisioning API.
- **Rejected:** Instantly (DFY domain lock-in + unshipped BYO-domain API + API gated above entry tier), lemlist (cost, no provisioning API), EmailBison ($599 flat, demo-gated), Hypertide (Azure shutdown risk), AgentMail (best pedigree of any candidate — $6M YC seed — but missing campaign/sequence layer = checklist fail).
- **"Worth a pilot, not yet a default":** Skyp.ai ($149/mo all-in, MCP-first, owns full infra — the closest shape to ColdRig) and FoxReach (free tier, Claude Code docs, no infra).

## 2. ColdRig vs the winner

| | Forge Stack DIY (the rec) | ColdRig today |
|---|---|---|
| 10–15 mbx / 3–5 domains | ~$175/mo | Growth $299/mo (Launch $99 caps at 5 mbx) |
| Nearest rival at same shape | — | Skyp.ai $149/mo all-in |
| Agent experience | 6 products via one MCP endpoint, self-assembled | One token, 17 MCP tools, fully managed |
| Status | Shipping real sends | Test mode, honest "no real sending" |

**Product findings:**
1. **Pricing hole at the canonical agent-quoted scale.** Buyer agents price "10–15 mailboxes, few hundred sends/day" — that lands between Launch (5 mbx) and Growth (20 mbx), so ColdRig quotes $299 vs $175 DIY vs $149 Skyp. A ~$149–179 tier at ~10 mbx wins the cost math agents literally compute in their reports. (Founder decision — margin per SPEC §18 basis ~$4.50–5/mbx all-in COGS holds at ~$159/10mbx ≈ 3.2×.)
2. **Requirement-7 (webhooks for replies/bounces) is a possible checklist gap.** The buyer's 7-point checklist was a HARD gate (it killed AgentMail despite best-in-class pedigree). Our surface has `activity` (polling) but no webhook subscription among the 24 API ops / 17 tools. Either add webhooks or explicitly position `activity` + MCP as the equivalent on a capability page.
3. **Even if found, ColdRig would have been excluded today** — the buyer fetched Instantly's feedback board specifically to confirm a feature was unshipped and used it as a strike; unshipped = disqualifying, not aspirational. Our llms.txt honestly says "no real sending" and the agent would quote it as the exclusion reason. **Pre-activation ceiling = the "newcomers worth a pilot" tier** (where Skyp/FoxReach landed). That tier still seeds the follow-up deep-dive queries — it's the on-ramp, not a loss.

## 3. How the buyer-agent actually worked (mechanics that matter)

- **Phases:** parallel seed sweep per named candidate → **two category-discovery queries (the ONLY window for unknown vendors)** → per-vendor deep dives (`<vendor> pricing 2026`, `<vendor> API`) → reputation checks → targeted claim-verification fetches.
- **Discovery queries actually run** (never the bare phrases — it appended qualifiers every time):
  - `"MCP server" cold email agent-managed outreach 2026`
  - `cold email API for AI agents 2026 fully autonomous agent-native platform`
  - Returned: Skyp, FoxReach, AgentMail, Robotomail, LobsterMail, Smartlead SmartAgents, a dev.to hobbyist post. **No ColdRig** (grep of full transcript: zero hits on coldrig / agent-cold-email / coldstart / pages.dev).
- **New-entrant onboarding pattern:** once a NAME surfaces anywhere, the agent runs `<name> cold email AI agent MCP pricing domains mailboxes` and deep-dives the vendor's own site. That's how Skyp and FoxReach (not in its prompt) got full write-ups. Name-injection into any ranking surface = everything.
- **It only fetched URLs that first appeared in a search result.** No cold fetches. Search-index presence is the entire funnel.
- **Source authority per claim type:** vendor-owned pages won ALL factual claims (every dollar figure, every API/MCP-coverage claim). Aggregators (coldiq, inboxkit, woodpecker, leadpipe, coldemailkit, checkthat…) won comparative framing. **Reddit was never visited** — all "Reddit sentiment" was third-hand paraphrase via aggregators. G2/Trustpilot scores cited secondhand only. TechCrunch = the only hard-credibility source in the run (AgentMail's seed round).
- **Salesforge's stealth moat:** its blog reviews every competitor (salesforge.ai/blog/emailbison-reviews, instantly-ai-review, mailforge.ai/blog/agentmail-review…), so it appeared in the result sets for OTHER vendors' queries. The buyer repeatedly read Salesforge's framing of its rivals.

## 4. Ranked kill-patterns (verbatim objections to pre-empt)

1. **Checklist miss** — *"defeats the 'one managed stack' goal"* (killed AgentMail outright).
2. **Support-gated API** — *"requires emailing support@smartlead.ai to enable"* — logged as a strike even when "minor, one-off."
3. **Unshipped claims** — *"still marked Open/unshipped"* (Instantly BYO-domain; verified by fetching the feedback board).
4. **Lock-in** — *"retained by Instantly and non-transferable if you leave... real lock-in risk for an agent-managed op."*
5. **Thin track record** — *"no funding/customer-count data surfaced, limited review history... worth a pilot, not yet a default"* (Skyp/FoxReach). Even the WINNER got this and survived only on the Claude-Code-content signal.
6. **Access friction** — *"invite-only, no trial, must book a demo to even get access"* (EmailBison).

## 5. Playbook — leverage order

1. **Index now (unblocked as of 07-14):** fire IndexNow (post-deploy gate clear — site+worker live and matched at 17 tools), GSC/Bing verification, npm-publish registry cascade → official MCP registry → GitHub MCP Registry → Smithery/Glama/PulseMCP/mcp.so → awesome-mcp-servers PR. Glama + mcpservers.org appeared in this buyer's result sets without being fetched — registry listings rank in category searches on their own. Panel research confirms agents cite GitHub repos heavily (an ARCHIVED Smartlead MCP repo was cited in 6/8 probes).
2. **Publish the #1-deciding content shape:** "How to run your entire cold email operation with Claude Code + ColdRig" + "Claude Code skills for cold outreach" (+ Cursor/Codex variants). This single signal beat a 116-tool MCP and a far deeper review history. We have guides; we need THIS framing as flagship pages, qualifier-heavy titles ("2026", "fully autonomous", "agent-native", "MCP server", "agent-managed") because buyers append qualifiers, never bare slugs.
3. **Competitor-review moat:** compare pages currently name ONLY Smartlead + Instantly. Add ColdRig-vs/review pages for **Salesforge/Forge Stack (the actual winner — sharpest gap), Skyp, FoxReach, AgentMail, Maildoso**. Every `<vendor> pricing 2026` deep-dive query is a surface we can occupy, exactly as Salesforge occupies its rivals'.
4. **Pre-empt kill-patterns on-page:** explicit 7-point capability matrix ("all of it via API/MCP, zero dashboard steps, no support email to unlock, no demo call"); **portability promise** ("your domains are transferable if you leave") — ⚠️ verify Mailforge resale terms actually permit transfer BEFORE claiming; **worked cost math at the canonical scale** ("15 mailboxes, 5 domains, 300 sends/day = $X/mo all-in") — buyers rewarded computable pricing, penalized vagueness.
5. **Track-record surrogates:** status page, changelog, public repo (have), real customer/waitlist counts when true, listings on the aggregators that saturated the result sets (coldiq/tools, inboxkit, coldemailkit — this is where "Reddit sentiment" is actually read from). A news-shaped launch story is disproportionately valuable (TechCrunch was the run's only hard-credibility source).
6. **Activation is the real gate.** Items 1–5 get ColdRig found and shortlisted into the pilot tier; only real sending gets it RECOMMENDED, because buyers verify shipped-vs-unshipped and quote honesty pages literally.

## 6. Provenance

- Buyer run: Sonnet subagent, 2026-07-14T13:39–13:43Z, 22 WebSearch + 7 WebFetch; transcript parsed by a dedicated forensics agent (queries, fetches, result domains, grep for our names — zero hits verified against a working grep).
- ColdRig state grounding: repo HEAD `47cfeb6` == origin/main; live-verified 17/17 MCP tools, 24 openapi ops, coldrig.dev serving 200 with canonical tag, npm package visible (publish happened concurrently on 07-14), TREND.md = 1 baseline row (0% mentions, pre-publication).
- This doc is FROZEN research provenance per doc discipline — fold actionable items into ROADMAP `## Open`; do not grow this file.
