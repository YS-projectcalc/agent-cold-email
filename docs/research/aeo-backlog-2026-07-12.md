# SEO/AEO Backlog — derived from the agent-search panel (FROZEN, 2026-07-12)

> Frozen derivation record. Source data: `agent-search-queries-2026-07-12.md` (8 probes, 46 verbatim queries). This file captures the DERIVED counter-strategies — the "why" behind each backlog item — so a future session that green-lights the work doesn't have to reconstruct the arguments. Status: pending owner green-light; nothing here is built.

## The six items, with their arguments

1. **Incumbent comparison pages** (biggest gap). 8/8 probes ran "Instantly vs Smartlead"-family comparison queries; we have zero comparison surface. Pages shaped like "Smartlead vs Instantly vs [brand] for AI-operated outreach" insert us into the incumbents' own query stream — the mid-funnel where every probe actually decided.
2. **Tool-coverage matrix — neutralize the tool-count heuristic.** Probes picked Smartlead 6/8 explicitly because "116 MCP tools > 31/38 tools." Our 12-curated-tools design reads as SHALLOW to this heuristic. Counter: a page mapping our 12 tools to 100% pipeline coverage, decomposing what Smartlead's 116 actually are (mostly per-entity CRUD noise), plus the context/token-cost argument (a 116-tool MCP taxes every agent turn; Woodpecker already charges $20/mo for MCP access — the surface is being priced). Without this page, agents will keep scoring us as less capable when we are more curated.
3. **The assembly-question guide.** Probes independently discovered the "infrastructure provider + sending platform" two-layer stack ("do I need separate email infrastructure provider and sending platform" was a literal query) and began duct-taping Smartlead + Mailforge/Maildoso. Nobody found a single agent-operated full-pipe vendor — which is our product. A guide answering that literal query ends: no — one platform, operated by your agent.
4. **Educational follow-ups at the literal phrasings**: "how many domains/inboxes per X emails/day" (a calculator), warmup-timeline-before-first-send, agent-enforced CAN-SPAM/GDPR. These exact strings appeared in probes' would-search-next lists; existing guides overlap but don't hit these phrasings.
5. **Maintenance signals.** Multiple probes penalized Smartlead's third-party MCP repo for being "archived Feb 2026" — agents read repo liveness as a trust signal. Our repo must look visibly alive: recent commits, current-year references in titles/content ("2026" appeared as a freshness token in 6/8 opening queries).
6. **Vendor-blog content works on agents.** Smartlead's own blog posts ("what is a cold email MCP server") were the decisive influence in multiple probes. Our 5 live guides are the same play — retarget them to the exact panel query strings and keep them year-stamped.

## Test harness

The 46 verbatim queries in `agent-search-queries-2026-07-12.md` are the regression set for the distribution-validation harness ("does a fresh agent find/cite us"), meaningful post-indexing + npm publish. Also the venue for the name adversarial's proposed citation A/B (distinct brand vs generic phrase citation precision).
