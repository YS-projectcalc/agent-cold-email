# Buyer-CHOICE panel

## What this is

A repeatable "watch an AI shopping agent pick cold-email infrastructure, then do forensics on why it chose what it chose" loop for ColdRig. It complements — does not replace — `tools/aeo-panel/`.

## CHOICE vs findability (aeo-panel)

- **`tools/aeo-panel`** measures **findability**: across 46 frozen category-discovery queries, does an AI answer engine mention/cite/link ColdRig at all? It's a citation instrument — no purchase task, no comparison, no elimination reasoning.
- **`tools/buyer-panel`** (this tool) measures **CHOICE**: given a realistic buying task ("set up cold-email infra, fully agent-managed, at scale X"), does a shopping agent that runs its own searches, builds its own comparison, and eliminates candidates with its own reasoning, end up recommending ColdRig? Findability is necessary but not sufficient — the frozen 2026-07-14 forensics run (`docs/research/agent-buyer-research-forensics-2026-07-14.md`) shows a buyer agent can run 22 searches, discover a dozen real vendors, and never surface us at all. A citation panel wouldn't catch that failure mode, because it never tests end-to-end purchase reasoning — only whether we show up for a bare query.

## How a run works, end to end

1. Pick a brief from `briefs/` — `starter-scale.md`, `canonical-scale.md`, or `agency-scale.md`.
2. Run it blind, on one side:
   - **Claude side** (automated) — dispatch one fresh sonnet research agent per the exact procedure in `run-claude-side.md`.
   - **ChatGPT side** (manual) — paste the brief into Yaakov's ChatGPT account per `chatgpt-protocol.md`.
3. Apply `forensics-template.md` to the returned transcript: extract every query run, the criteria the agent formed, the kill-list (vendor + verbatim disqualifying sentence), the deciding sentence, and whether ColdRig surfaced / shortlisted / won.
4. Save the filled-in template as a frozen run record: `runs/YYYY-MM-DD-<side>-<brief>.md` (format defined in `runs/README.md`).
5. Append one row to `CHOICE-TREND.md`.
6. File any fix-list items the run surfaces into `ROADMAP.md`'s `## Open` section.

## The three briefs

Parameterized on the canonical scales in `docs/research/agent-buyer-research-forensics-2026-07-14.md` §2 ("ColdRig vs the winner"):

| brief | scale | persona |
|---|---|---|
| `briefs/starter-scale.md` | 5 mailboxes / 1-2 domains, ~50-100 sends/day | solo consultant, tight budget — also ColdRig's own Launch-tier cap, so this brief probes the entry edge |
| `briefs/canonical-scale.md` | 10-15 mailboxes / 3-5 domains, few hundred sends/day | the scale §2 identifies as what buyer agents actually compute cost math against — the documented "pricing hole" between ColdRig's Launch and Growth tiers |
| `briefs/agency-scale.md` | ~50 mailboxes / 10+ domains, multi-client | agency running several clients' outreach in parallel — matches `tools/aeo-panel/panel.v1.json` queries `p4-q1`/`p4-q3` ("50 inboxes", "50 mailboxes agency") |

**None of the three briefs may name ColdRig / coldrig / agent-cold-email / coldstart anywhere in the buyer-facing prompt text.** Blind shopping is the entire point — same integrity rule as `tools/aeo-panel/README.md`'s "Discovery-panel integrity rule," extended from citation queries to full buying tasks. Verified at authoring time: zero brand-term occurrences in any `briefs/*.md` buyer-facing body.

## Cadence

- **Post-deploy** — run all 3 briefs on the Claude side after any change plausibly relevant to buyer-facing outcomes (new content, pricing change, new vendor comparison page, webhooks shipped, etc.).
- **Biweekly** — run all 3 briefs on the Claude side as a standing cadence regardless of deploys, to catch drift caused by vendor-side moves (competitor content, competitor pricing changes) rather than anything we did.
- **ChatGPT side** — opportunistic (manual, Yaakov's time): run when there's a specific reason to think the surface differs, since ChatGPT is a different index/citation engine from Claude's.

## Method template

Same shape as the frozen 2026-07-14 forensics run itself (`docs/research/agent-buyer-research-forensics-2026-07-14.md` §6, provenance): a fresh-context Sonnet agent with real web search/fetch tools runs an undirected buying task, its full transcript (every query, every fetch) is parsed by a dedicated forensics pass afterward, and any claim that ColdRig wasn't surfaced is verified with a literal grep of the transcript for our brand terms — never asserted from memory or inferred.

## No fabricated data

This harness ships with `runs/` empty and `CHOICE-TREND.md` as a header-only table. Every field in every template is a clearly-marked placeholder until a real run fills it in. The frozen 2026-07-14 forensics doc is essential prior-art grounding for this harness's design (see "Method template" above) — it is NOT a run record of this harness, and does not seed a `CHOICE-TREND.md` baseline row. See `CHOICE-TREND.md` for why.
