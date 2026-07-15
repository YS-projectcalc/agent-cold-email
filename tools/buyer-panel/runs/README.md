# `runs/` — frozen run records

One file per completed (non-void) buyer-panel run: `runs/YYYY-MM-DD-<side>-<brief>.md`.

- **`<side>`** — `claude` (automated, see `../run-claude-side.md`) or `chatgpt` (manual, see `../chatgpt-protocol.md`).
- **`<brief>`** — `starter` | `canonical` | `agency`, matching `../briefs/<brief>-scale.md`.

Example: `2026-07-20-claude-canonical.md` = a Claude-side run of the canonical-scale brief on 2026-07-20.

Each file is `../forensics-template.md`, filled in from a real transcript. A run that errors, times out, or never reaches a final recommendation is **void** — the attempt and void reason may be noted in a file here if useful for debugging, but do NOT append a `../CHOICE-TREND.md` row for it (same discipline as `tools/aeo-panel`'s void-cycle rule).

**Frozen once written.** A run record is a point-in-time forensic record, like an `tools/aeo-panel/runs/<date>.json` file — don't edit it after the fact to "fix" a finding. A new interpretation of the same underlying transcript gets a new note in a later run's "diff vs prior run" section, not a silent edit here.

This directory is empty until the first real run executes. No placeholder run files ship with the harness.
