# Buyer-CHOICE forensics extraction template

Apply this to every transcript (Claude-side agent return, or ChatGPT-side pasted conversation) before it becomes a run record under `runs/`. Copy this whole template into the new `runs/YYYY-MM-DD-<side>-<brief>.md` file and fill in every field. Where the transcript genuinely doesn't contain something, write `UNVERIFIED` — never fill a gap with an inference presented as fact.

## Run metadata

- **Date:** YYYY-MM-DD
- **Side:** claude | chatgpt
- **Brief:** starter | canonical | agency (`../briefs/<brief>-scale.md`)
- **Engine/model:** e.g. "sonnet research agent (Claude Code Task tool)" or "ChatGPT [version], web browsing on"
- **Run status:** ok | void — a run that errors, times out, or never reaches a final recommendation is **void**, not a loss. Note the void reason and stop there; do not fill in the rest of this template for a void run, and do not append a `../CHOICE-TREND.md` row for it (same discipline as `tools/aeo-panel`'s `status: "unavailable"` rule — missing data is not a negative result).

## 1. Queries run

Verbatim, in order, exactly as the transcript shows them — not reconstructed or paraphrased from memory. Number them. If the side is ChatGPT and the UI doesn't expose literal query strings, say so explicitly (see `../chatgpt-protocol.md`'s "known fidelity gap") rather than inventing precision that isn't there.

1. ...
2. ...

## 2. Criteria the agent formed

The checklist/requirements the agent decided mattered for this job, quoted in its own words wherever it stated them explicitly. If the agent never states criteria separately and only reveals them through its kill-list reasoning, reconstruct the checklist from section 3's sentences and mark it `(inferred from kill-list, not separately stated)`.

## 3. Kill-list

Every candidate the agent eliminated, with the exact sentence that disqualified it:

| vendor | verbatim disqualifying sentence |
|---|---|
| ... | "..." |

## 4. Survivors

Everything still standing after the kill-list, before the final pick.

## 5. Deciding sentence

The single verbatim sentence (or shortest verbatim span) that explains why the agent picked the winner over the other survivors. Quote it exactly — this is the highest-value line in the whole record.

## 6. Winner

- **Name:**
- **Quoted price at this brief's scale:**

## 7. ColdRig outcome

Cumulative tiers — mark only the highest one actually reached:

- [ ] **SURFACED** — coldrig / agent-cold-email / coldstart appears anywhere in the transcript (a search-result snippet, a fetched page, a passing mention), even if never compared or chosen.
- [ ] **SHORTLISTED** — appeared in the agent's own comparison table, or survived at least one kill-list round.
- [ ] **WON** — chosen as the final #1 recommendation.
- If none of the above: **NOT SURFACED.**

**Grep verification:** literal grep of the full transcript text for `coldrig`, `agent-cold-email`, `coldstart`, `agentcoldemail` — hit count: `N`. Quote any hits verbatim. A "not surfaced" claim without this grep quoted is not verified — do not write it.

## 8. What single change would most likely have flipped the choice

One sentence, tied directly to evidence already quoted above (the deciding sentence, or the sharpest kill-list line) — not speculation disconnected from the transcript. If nothing in the transcript supports a specific fix, say so rather than inventing one.

## 9. Diff vs prior run (same side + same brief)

If a prior run record exists at `../runs/<earlier-date>-<side>-<brief>.md`, note what changed: same winner or different, same kill reasons or different, ColdRig outcome moved up/down/unchanged. If this is the first run of this side+brief combination, write "first run — no prior record."
