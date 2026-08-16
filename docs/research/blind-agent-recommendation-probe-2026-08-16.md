# Blind agent recommendation probe — 2026-08-16 (founder-ordered)

**Question:** if a FRESH Claude agent (no context) is told "set up and run cold email end-to-end yourself, no dashboards," does it find and recommend coldrig? **Method:** two independent blind agents (one Opus, one Sonnet), identical unbiased brief scoring candidates on agent-operability (API/MCP/CLI across signup → domain buy → mailboxes → warmup → send → replies), each required to report verbatim queries + every service encountered. Neither brief mentioned coldrig.

## Headline result

**Coldrig appeared ZERO times.** 51 search queries between the two agents (21 Sonnet + 30 Opus), 12 direct page fetches (Opus), ~140 distinct service names surfaced across sequencers, infra providers, agent-mail APIs, and glue tooling — coldrig.dev / agent-cold-email absent from every list, including the instant-reject lists. Opus even ran the near-name query `Coldr cold email API agent-native platform review` (a different product) and coldrig still did not surface.

**Both agents independently picked the same winner: the Salesforge "Forge" stack** (Salesforge + Mailforge/Infraforge + Warmforge, one MCP endpoint `mcp.salesforge.ai/mcp` + official `forge` CLI). Runner-up both times: Instantly.ai (official hosted MCP; the only vendor with VERIFIED one-credential provisioning via `/dfy-email-account-orders`). Sonnet's shortlist added Smartlead (116-tool but third-party MCP) and AgentMail; Opus's added FoxReach (BYO-inbox, best pure-code surface) and Skyp (MCP-native, too expensive).

## Why the winner won — the decision criteria ARE coldrig's pitch

Stated decisive signals, per agent:
- ONE first-party integration surface spanning the FULL lifecycle (domain purchase → mailboxes → warmup → send → replies) — "no other vendor puts infrastructure provisioning and campaign execution behind the same agent surface" (both agents; neither had seen coldrig, which does exactly this).
- **`llms.txt`** (`developer.salesforge.ai/llms.txt`) — Opus: "the single strongest agent-readiness signal I found in this market."
- **Official CLI with a self-describing command registry** (`forge commands list --available --names`) — "a discovery mechanism built for a machine."
- Programmatic deliverability MEASUREMENT (Warmforge placement tests) vs. unverifiable vendor "health scores" (the exact failure Instantly is being hit for — Q1-2026 r/coldemail cluster: heat scores 90+ while real placement collapsed to 30-40%).
- Transparent self-serve pricing; a demo-call gate was a hard disqualifier (killed Mailscale, Mailreef).
- Vendor-first-party MCP over community wrappers (why Smartlead's 116-tool third-party MCP lost to smaller first-party surfaces).
- Trust signals mattered: Sonnet said a first-party full-stack MCP from a "higher-trust" vendor (independent G2/Trustpilot presence) would have FLIPPED its pick; it also flagged that Salesforge partly won via its own self-citing blog network (salesforge/mailforge/warmforge/infraforge/primeforge.ai ranking each other) — i.e., flooding the content surfaces agents search works on agents.

## The two UNIVERSAL gaps both agents named (= open lanes)

1. **Programmatic signup/billing.** "Nobody offers programmatic signup or billing... Stripe now publishes agent-billing workflows; no cold-email vendor has adopted it" (Opus). Both agents said whoever closes this gets weighted heavily. Coldrig's agent-driven signup + Stripe checkout link is already close to the market minimum.
2. **Deliverability REMEDIATION as an API.** "When a domain's reputation degrades, every remedy — pausing sends, rotating a domain out — is a manual dashboard action" (Opus). **Coldrig already HAS this** (automated burn/replace + deliverability loop + spend-capped rotation) — a differentiator no probe candidate offered, and completely invisible to the market.

## Why coldrig lost (it never got seen)

Discoverability, not capability. The queries that decided the market — "cold email platform MCP server AI agent", "cold email software with public API for agents 2026", "API to buy domains and provision mailboxes automatically cold email infrastructure", "best cold email platform for AI agents 2026 head to head API coverage full lifecycle autonomous", Reddit sweeps, infra-provider comparisons (Maildoso/ScaledMail/Zapmail/InboxKit... — InboxKit itself surfaced; the platform built ON it did not) — return listicles, vendor blog networks, comparison guides (salestools.club), help-center MCP articles, and GitHub MCP repos. Coldrig ranks in none of these surfaces. The July site work (AGENTS.md, IndexNow) did not move it into any of the 51 queries.

## Follow-up option space (founder ruling needed — nothing authorized)

A. **Agent-facing SEO/content for the exact query patterns above** — MCP-announcement help article, "for AI agents" page, head-to-head comparison content, presence in the guides/listicles agents fetch (salestools.club-class surfaces), GitHub MCP visibility.
B. **`llms.txt` + machine-readable API spec at coldrig.dev/developer surface** — the highest-signal cheap artifact per Opus.
C. **Reddit/community presence** (r/coldemail) — both agents ran Reddit sweeps; complaint clusters there materially moved rankings (it's what wounded Instantly).
D. **Lead with the two universal gaps:** agentic signup/billing story (Stripe agent-billing adoption) + "deliverability remediation is an API here" — both are differentiators coldrig substantially has and nobody markets.
E. **Trust floor:** G2/Trustpilot/independent-review presence — load-bearing in Sonnet's pick.

Full raw reports (both agents' complete query lists + encountered-service lists) preserved in the session transcript of 2026-08-16; this doc is the frozen synthesis.

## CORRECTION (same day, founder challenge: "didn't we do all this already")

He was right — options A/B above were ALREADY BUILT before the probe: coldrig.dev serves `llms.txt` (200), `/for-agents`, `/agent-evaluation.md`, `AGENTS.md`, guide pages targeting the exact probe queries (`guide-mcp-cold-email`, `guide-cold-email-with-ai-agent`, `guide-cold-email-operation-{claude-code,cursor,codex}`), and comparison pages against the precise probe winners (`compare-vs-salesforge`, `compare-vs-smartlead-instantly`, `compare-vs-agentmail`, `compare-vs-skyp`, `compare-vs-foxreach`, `compare-vs-maildoso`, `compare-vs-diy`) — with clean crawlability (robots.txt allows, no noindex meta/header, Googlebot/GPTBot/ClaudeBot UAs all answered 200; verified live).

**The real failure is one level below content: coldrig.dev has ZERO pages in the search index.** Verified live 2026-08-16: the branded query "coldrig cold email" returns only competitors (Salesforge/Instantly/Smartlead/Saleshandy blogs), and a domain-restricted search on coldrig.dev returns "No links found." A no-backlink domain doesn't get indexed, and unindexed content cannot appear for ANY of the 51 queries regardless of quality. The on-site layer is necessary but was never sufficient; every surface that decided the probes is third-party. The follow-up space is therefore OFF-SITE only — see the corrected ROADMAP [ASK] entry (index-triggering citations incl. public GitHub + MCP registries, guide/listicle placement, Reddit, review-site trust floor, Stripe agent-billing moonshot).
