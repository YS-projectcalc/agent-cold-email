# Claude-side operator runbook

The automated half of the buyer-CHOICE panel. One fresh sonnet research agent per brief, per run.

## Preconditions

- Dispatch from a genuinely fresh context. The risk isn't the sub-agent's own context (dispatching via the Agent/Task tool already gives it a clean slate) — it's the dispatch call itself: the orchestrating session must not embed anything biasing beyond the brief text below (no naming ColdRig, no hinting at an expected winner, no prior-turn residue about this harness's own existence bleeding into the task description).
- Model: **sonnet**, set explicitly on the dispatch — this is a research/comparison sweep, not adversarial judgment, so sonnet is the correct tier per the project's model-tiering table. Subagents are opus/sonnet only, always explicit, never inherited.
- Tools: the dispatch must grant live web search + page fetch (WebSearch/WebFetch or equivalent) — confirm before dispatching, since a sub-agent without live web access can't run this brief at all (that's a void run, not a bad result).
- **Cwd/context isolation (added 2026-07-15 after runs #2-#3):** Claude-side shoppers inherit the operator's environment — two leaks observed in cycle 1: (a) operator identity (the account/email let a shopper connect the surfaced vendor to "this account's own company"); (b) repo cwd (a shopper read CHOICE-TREND.md/ROADMAP.md late in its run — post-research, disclosed, verdict uncontaminated, but only by luck of timing). Mitigate: instruct the shopper it is a web-research-only task that must not read local files, and record any leak the shopper discloses as a fidelity caveat in the run record. Full blinding of OPERATOR identity is structurally impossible Claude-side; the ChatGPT side is the clean-room control.

## The dispatch prompt (use verbatim)

Take the buyer-facing body of the chosen brief (`briefs/starter-scale.md`, `canonical-scale.md`, or `agency-scale.md` — the text below the `---` divider, unchanged) and wrap it exactly like this in the Agent/Task dispatch:

```
You are a buyer researching cold-email infrastructure. You have live web search and page-fetch tools. Complete the task below exactly as a real, careful buyer would — run real searches, read real pages, form your own judgment. Do not assume you already know the answer; actually search.

<PASTE THE CHOSEN BRIEF'S BUYER-FACING BODY HERE, VERBATIM, UNCHANGED>

When you have your final recommendation, append a section titled exactly "FORENSICS APPENDIX" with these six parts, using ONLY searches/fetches you actually ran — do not reconstruct or backfill anything you didn't really do:

1. QUERIES RUN — every search query you issued, verbatim, in order.
2. PAGES FETCHED — every URL you actually opened/read, in order.
3. CRITERIA — the checklist/requirements you judged candidates against, in your own words.
4. KILL LIST — every candidate you eliminated, each as "Vendor: <verbatim sentence that disqualified it>".
5. DECIDING SENTENCE — the single sentence that explains why you picked the winner over every other candidate that survived the kill list.
6. WINNER — name and the price you quoted at this brief's scale.
```

## After the agent returns

1. **Cross-check, don't just trust the self-report.** The dispatching session can see the sub-agent's actual tool-call trace (its real WebSearch/WebFetch calls). Spot-check the FORENSICS APPENDIX's "QUERIES RUN" and "PAGES FETCHED" lists against that trace — they should match. If they diverge (the appendix claims a query that isn't in the trace, or omits one that is), note the discrepancy in the run record and prefer the actual trace over the self-report for `forensics-template.md` §1.
2. **Grep the full returned transcript** — not just the appendix, the whole response including any raw tool output visible to the dispatcher — for `coldrig`, `agent-cold-email`, `coldstart`, `agentcoldemail`. This is the SURFACED / NOT-SURFACED call in `forensics-template.md` §7. Never assert "not surfaced" without having actually run this grep.
3. Fill in `forensics-template.md` using the appendix, the cross-check, and the grep result, and save it as `runs/YYYY-MM-DD-claude-<brief>.md` (brief = `starter` | `canonical` | `agency`).
4. Append one row to `CHOICE-TREND.md`.
5. **File fix-list items into `ROADMAP.md`'s `## Open` section** — one line per actionable finding, following the roadmap contract's format: `- [ ] YYYY-MM-DD [ORDER|ASK|IDEA] <item>`. Use `[IDEA]` for anything a run surfaces that hasn't been explicitly ordered by Yaakov yet (most findings land here); reserve `[ORDER]`/`[ASK]` for items that restate an existing standing order/ask this run provides new evidence for. Cross-reference the run record's file path in the roadmap line so the evidence trail is one hop away.
6. Repeat for the other two briefs. A "cycle" is all 3 briefs run on the same day, on the same side.

## Void runs

If the sub-agent errors, times out, or returns without a FORENSICS APPENDIX (or without a clear final recommendation), the run is **void** — same discipline as `tools/aeo-panel`'s `status: "unavailable"` rule. Do not write a `runs/` file with fabricated fields, do not append a `CHOICE-TREND.md` row. Re-dispatch instead.
