# ChatGPT-side manual protocol

For the manual (Yaakov's account) side of the buyer-CHOICE panel. Companion to `run-claude-side.md` (the automated Claude side) — same briefs, same forensics template, different execution mechanics, because ChatGPT has no equivalent of dispatching a fresh sub-agent with an inspectable tool-call transcript.

## Before pasting anything

1. **Start a genuinely fresh conversation** — new chat, not a continuation of any prior thread.
2. **Check/disable ChatGPT's cross-chat memory for this account before the run, or use Temporary Chat mode.** Yaakov's account almost certainly has memory of building ColdRig from other conversations; if that memory leaks into this chat's context, the "blind shopping" premise is broken and the run is void before it starts. Temporary Chat mode (no memory read, nothing saved to history) is the safer default — use it unless there's a specific reason not to.
3. Confirm web browsing/search is actually active in the chat (model + toggle, whichever the current ChatGPT UI uses).

## The message to paste

Open the relevant brief file — `briefs/starter-scale.md`, `briefs/canonical-scale.md`, or `briefs/agency-scale.md` — and paste its buyer-facing prompt body verbatim (the text below the `---` divider). Skip the dispatch-instructions preamble at the top of the brief file; that's written for whoever is running the brief, not for ChatGPT itself. Do not add anything before or after the pasted text, do not mention ColdRig, do not hint at an expected answer.

## If it doesn't show its working

Unlike the Claude side (where the orchestrator can inspect the actual tool-call trace), ChatGPT's consumer UI may not spontaneously narrate every search query or expose a clean kill-list. If the first response doesn't already contain everything `forensics-template.md` needs, send this exact follow-up in the same chat:

> Before I act on that — show me your full working: every search query you ran to research this (as close to verbatim as you can reconstruct), the criteria/checklist you used to judge candidates, every vendor you considered and ruled out with the specific reason each one was ruled out, and the one sentence that made you pick the winner over any other finalist.

## Known fidelity gap

ChatGPT typically shows some citations/sources (a clickable list or inline chips) but does not reliably expose literal search-query strings the way an agentic tool-call transcript does. When the model can't reconstruct its exact queries, record whatever it does report and mark the "Queries run" section of the run record `PARTIAL — model could not fully reconstruct verbatim queries` rather than inventing precision that isn't there.

## What to capture back

- The full response text (the initial answer, plus the follow-up if one was needed).
- The source/citation list ChatGPT displays — copy it as text if possible; screenshot it if it isn't copyable, and save the screenshot alongside the run record.
- The model/version ChatGPT used for the run (visible in the UI) and whether web browsing was on.
- Timestamp of the run.

## After the chat

Apply `forensics-template.md` to what was captured, save the filled-in template as `runs/YYYY-MM-DD-chatgpt-<brief>.md` (brief = `starter` | `canonical` | `agency`), append one row to `CHOICE-TREND.md`, and file any fix-list items into `ROADMAP.md`'s `## Open` section — same closing steps as the Claude side (`run-claude-side.md`, "After the agent returns").

## OpenAI API variant — not authorized, gated

An alternative to the manual paste protocol: call the OpenAI API directly (Responses API with a `web_search` tool, or equivalent) from an automated script, giving the ChatGPT side the same "fresh context, inspectable transcript" mechanics the Claude side already has via `run-claude-side.md`. This would remove both the manual-paste bottleneck and the memory-leak risk described above.

**This is not built and should not be run without Yaakov's explicit go-ahead**, because it needs:

- An OpenAI API key — not currently provisioned for this project.
- Spend approval — every run costs real API tokens plus the `web_search` tool's per-call fee, and a biweekly × 3-briefs cadence multiplies that indefinitely without a ceiling.

If/when authorized: a thin script under this directory would replace the manual-paste steps above with a scripted call, reusing the same `briefs/*.md` prompt bodies and the same `forensics-template.md` output — the forensics half of this harness doesn't change either way. Do not build this speculatively before the founder-word gate clears.
