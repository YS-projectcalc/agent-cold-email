# Adversarial Review — Brand Name "agentcoldemail" (FROZEN record, 2026-07-12)

> Frozen adversarial record. Reviewer: fresh-context opus adversary agent. Target: proposal to adopt "agentcoldemail / Agent Cold Email" as the brand (superseding the distinct-brand candidates coldrig/coldpipe/coldloop) on the strength of the agent-search panel (docs/research/agent-search-queries-2026-07-12.md). Ground ref at review time: repo HEAD 73e88ffe on main.

## VERDICT: NO-SHIP

Do **not** adopt "agentcoldemail / Agent Cold Email" as the brand. Keep the distinct-brand-plus-keyword-slug structure the repo **already ships** (slug `agent-cold-email` everywhere, distinct display brand TBD). The pure-keyword brand is a *dominated* choice: it takes on every downside (untrademarkable, uncitable, spam-optics, double lock-in) in exchange for a keyword-discovery benefit the slug already banks in full.

Decisive verified fact: **every keyword surface an agent actually queries already contains the exact keyword and is unchanged by this decision** — repo `github.com/YS-projectcalc/agent-cold-email`, npm `agent-cold-email` (verified available), CLI, site `agent-cold-email.pages.dev`, API host, AEO content. Collapsing the *display brand* into the same string adds zero incremental keyword match; retrieval keys off slug/repo/domain/content, not the legal entity name. What it subtracts is the one thing the display brand is for: a distinct, citable proper noun.

## Ranked findings

1. **Citability / disambiguation failure — BLOCKING.** An agent's recommendation moment emits a proper noun ("I recommend Smartlead") — the panel's own data shows this in every probe. "Use agent cold email" collapses into the sentence as a generic phrase; a follow-up search returns the category, not the product. Verified live: GitHub search "agent cold email" → **397 repos**. A generic name makes us one of 397 lexically-identical results, contradicting SPEC's "be THE purpose-built agent-native repo" win condition (SPEC.md:262).
2. **Untrademarkable / undefendable — BLOCKING.** "Agent Cold Email" for an agent-operated cold-email platform is descriptive-to-generic (§2(e)(1) refusal territory, no secondary meaning). Competitors could ship "AgentColdEmail Pro" freely, diluting the citation surface — forfeiting part of the distribution moat the SPEC bets on.
3. **Occupied namespace — NON-BLOCKING but real.** AgentMail (agentmail.to, YC S25, $6M seed) owns agent+email with a ~1yr head start; verified live: npm `agentmail` v0.5.14, GitHub org `agentmail-to` incl. `agentmail-mcp`. Entering the crowded namespace with a generic descriptor is the worst possible entry.
4. **Payment/compliance optics — NON-BLOCKING but real.** "Cold Email" as the literal legal/Stripe/KYC/registrar entity name is a self-inflicted spam flag amid Feb-2026 Google/MS tightening. Degree-not-kind vs "coldrig" (also contains "cold"), but a coined mark ≠ a literal activity declaration on a KYC field.
5. **Double strategic lock-in — NON-BLOCKING, slow-burn.** Name hard-codes channel (cold email) + operator (agent); SPEC.md:272 frames durable value as channel-agnostic stateful backend. Expansion (LinkedIn, warm nurture, general agent GTM) breaks it.
6. **Human surfaces — NON-BLOCKING.** Spoken/pitched/referred, the name parses as a description, not a company. Word-of-mouth needs a proper noun.

## Steelmen

- **FOR pure-keyword:** lexical exact-match helps at retrieval margin; verified `agentcoldemail.com` + `agent-cold-email.com` AVAILABLE (RDAP 404) while `coldrig.com` is PARKED (RDAP 200). → Fails: the retrieval benefit is already fully captured by the unchanged slug layer; the decision only moves the display brand, where keyword-match is worthless and citability is everything. Dominated.
- **FOR distinct brand + slug:** the recommendation moment needs a proper noun resolving to one entity; the slug keeps banking every keyword hit. Strictly the current shipped state; pure-keyword is a regression from it.

## Recommended structure

- **Company/display/domain/Stripe entity:** distinct suggestive-coined brand — coldrig / coldpipe / coldloop all work structurally (verdict is the structure, not the word). `coldrig.com` parked (verified); `coldrig.dev` AVAILABLE (verified) — `.dev` fits an agent/dev-native product. Trademark clearance search on the chosen word before commit.
- **Keyword surface (unchanged):** repo/npm/CLI/registry/site stay `agent-cold-email`; AEO keeps targeting literal panel queries.
- **Positioning line doing both jobs:** "**Coldrig** — the agent-operated cold-email platform."

## Attacks that failed (held NO-SHIP)

- ".com availability favors keyword name" — conceded facts, weak lever for a .dev-native product; core findings untouched.
- "Keyword genuinely wins agent retrieval" — traced; win is real but fully banked by the slug; collapsed into confirming the hybrid dominates.
- "AgentMail confusion overblown" — partly conceded; demoted to namespace-occupation evidence, not standalone blocker.
- "Descriptive-with-secondary-meaning rescue" — no secondary meaning exists or is buildable on an unownable string.

## UNVERIFIABLE (verdict does not depend on these)

- Live USPTO/TESS clearance search (run via attorney for whichever distinct brand is picked).
- Controlled LLM-citation A/B (distinct brand vs generic phrase citation precision) — resolvable post-indexing via the 46-query fresh-agent harness before domain money is spent.

## Out-of-scope observations (no verdict weight)

- SPEC §17's "THE repo" win condition is in tension with 397 existing lexical matches regardless of naming — owning the canonical result needs a distinct handle + authority signals, not just a good README.
- Running the discovery harness against distinct-brand vs keyword-brand builds would convert the citation question into hard data.
