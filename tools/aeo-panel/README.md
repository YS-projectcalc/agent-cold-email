# AEO citation-tracking panel

## What this is

A versioned instrument for measuring whether AI answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot, etc.) mention, cite, or link to Coldrig (formerly ColdStart) when a user or agent searches for cold-email infrastructure.

**Brand terms tracked:** `mentioned` counts a hit on either **Coldrig** (current name) or **ColdStart** (retired name — pre-rebrand runs, and any lingering post-rebrand indexed content, still count). This is a single field, not a per-term series — adding Coldrig broadens what counts as a hit going forward without changing the field shape or resetting `TREND.md`'s trend line. Historical rows recorded under the ColdStart-only definition are not restated.

The panel is the same 46 verbatim queries every time it runs — `panel.v1.json`. Those queries were extracted, unmodified, from the frozen agent search-behavior research: `docs/research/agent-search-queries-2026-07-12.md` (8 fresh-context Claude probes, real web searches, 6+5+7+6+6+5+5+6 = 46 issued queries; see `ROADMAP.md`'s 2026-07-12 "later" entry for the count-correction pointer — the frozen doc's own body says "44" in one summary line, which undercounts; 46 is the verified total and is what this panel uses).

**This is trend-only instrumentation.** AI answer-engine citations churn 40-60%/month industry-wide (engines re-crawl, re-rank, and change source-selection logic on their own schedule, unrelated to anything we do). A single snapshot — "we got cited 3 times this week" — is meaningless. The only signal that matters is the trend line across repeated runs of the *same, unchanged* panel: `TREND.md`.

## Discovery-panel integrity rule

None of the 46 queries may contain our own brand terms (`coldrig`, `agent-cold-email`, `agentcoldemail`). These are *discovery* queries — they simulate someone who doesn't already know we exist searching for the category. A query that already names us isn't testing discoverability, it's testing whether we show up for our own name, which is a different (much easier) problem.

Verified 2026-07-12: zero brand-term leaks across all 46 `query` field values in `panel.v1.json` (checked programmatically against the literal query strings, not the file as a whole — the measurement contract's field *descriptions* legitimately name `agent-cold-email` because that's the entity being measured for mentions). No queries were excluded.

## How to run a cycle

1. Open a **fresh agent/search context per query** — no shared conversation history, no prior turns that could bias results toward us. Use the same engine surface consistently within a cycle (e.g. "Claude web search," "ChatGPT web," "Perplexity") and record which one in the `engine` field.
2. For each of the 46 queries in `panel.v1.json`, run it exactly as written (verbatim — do not paraphrase) and record one measurement per the `measurement_contract.record_shape` in that file:
   - `mentioned` — is Coldrig/ColdStart/agent-cold-email named anywhere in the response, even without a link.
   - `cited` — does our URL appear as an actual source/citation (not just a mention).
   - `clickable` — is that citation a working, clickable link (some engines render citations as plain text).
   - `position` — ordinal rank among cited sources, if the engine exposes one; else `null`.
   - `winner` — who got recommended instead (usually Smartlead or Instantly per the baseline).
   - `sources_cited` — every source URL the engine surfaced for that query.
3. **A query that errors or times out is `status: "unavailable"` — never `mentioned: false`.** Missing data is not the same as a negative result; recording it as `false` would silently inflate the "we're invisible" signal with searches that never actually ran. Skip it, mark it, move on.
4. **≥70% of the 46 queries must return live (`status: "ok"`) results for the cycle to count.** If fewer than ~33 queries came back live (engine outage, rate-limited, etc.), the cycle is **void** — do not append it to `TREND.md`; note the attempt and the reason in the cycle's own run file instead, and re-run later.
5. Save the full set of per-query records for the cycle to `runs/<ISO-date>.json`, same shape as the measurement contract (array of records, one per query per engine).
6. Compute the three headline rates for the cycle (mention%, cite%, clickable% — each is `count / queries-live`, not `count / 46`, so a partial-live cycle isn't penalized twice) plus share-of-voice, and append one row to `TREND.md`.

## The 3-metric split — never blend these

Report **mention / citation / clickable-citation as three separate numbers**, always. They measure different things and collapsing them hides the story:

- **Mentioned** — the engine knows we exist and said our name. Weakest signal; easiest to move.
- **Cited** — our URL was listed as a source. Stronger; means the engine's retrieval layer picked us up, not just its training data.
- **Clickable-citation** — the citation is an actual link a user could follow. Strongest; some engines cite a domain as plain text with no link, which reads well in a screenshot but drives zero traffic.

A run that shows "mentioned: 40%" and nothing else is not a report — it's the easiest number cherry-picked. Always show all three.

## Share-of-voice vs the incumbents

Alongside our own three metrics, track share-of-voice against the vendors this panel's queries actually contend with: **Smartlead**, **Instantly**, and **Woodpecker** (the three baseline-doc names that recur as final recommendations or shortlisted alternatives across the 8 source probes — see `panel.v1.json`'s `competitors` field per query for the full per-query vendor list, which is wider than these three). SOV per vendor per cycle = (queries where that vendor was cited or named `winner`) / (queries live). Report SOV-us alongside SOV-smartlead / SOV-instantly / SOV-woodpecker in the same `TREND.md` row — the point isn't our number in isolation, it's whether we're closing the gap to them over time.

## Results storage

- `runs/<ISO-date>.json` — the full per-query, per-engine record set for that cycle, same shape as `measurement_contract.record_shape` in `panel.v1.json`.
- `TREND.md` — one row appended per completed (non-void) cycle: `date | queries live | mention% | cite% | clickable% | SOV-us | SOV-smartlead | SOV-instantly | notes`.

## The causality rule

The panel (`panel.v1.json`) stays byte-for-byte constant across runs. If a query needs to change — reworded, added, removed — that is a **new panel version** (`panel.v2.json`), and the trend line resets; do not silently edit `panel.v1.json` and keep appending to the same `TREND.md`, or every future comparison becomes uninterpretable (you can no longer tell whether a metric moved because we did something, because the panel changed, or because the engine changed).

Before crediting any metric movement to something we did (a new page, a schema change, a backlink), first check whether the *engine itself* changed its citation format or ranking logic in that window — engine-format changes move everyone's numbers, us included, and get noted in the `notes` column rather than claimed as our win.

## Baseline (row 1 of TREND.md)

The frozen 2026-07-12 agent search-behavior research **is** the pre-ship baseline for this panel, because its 46 issued queries are exactly `panel.v1.json`'s query set (that's *where* the panel came from). Per that research's own findings summary: **0/8 probes discovered agent-cold-email / ColdStart** across all 46 queries — the site was unindexed and unpublished at panel time. That is baseline row 1: `mention 0%`, `cite 0%`, `clickable 0%`, `SOV-us 0%`. Source: `docs/research/agent-search-queries-2026-07-12.md`, "Findings summary" section (final bullet).

Note: the baseline row's SOV-smartlead / SOV-instantly cells are marked `n/a` rather than computed, because the frozen doc measured a different metric for competitors — *final-recommendation share* (Smartlead 6/8, Instantly 2/8, per the doc's findings summary) — not the per-query citation/clickable-link share this panel's measurement contract defines. The two aren't the same number and shouldn't be conflated in the trend table; the doc is linked from the `notes` column instead.
