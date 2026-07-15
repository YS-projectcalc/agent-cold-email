---
name: coldstart-doc-conventions
description: Canonical doc map for the ColdStart repo (~/dev/coldstart) — where ledger/status/resume content routes.
metadata:
  type: project
---

Canonical living docs for this repo live at the REPO ROOT (`~/dev/coldstart/`), not under `apps/platform/`, even when the session's work was scoped to `apps/platform/`:
- `ROADMAP.md` — build order/status. Actual structure (corrected 2026-07-15, superseding an earlier wrong note about `## Phases`/`## Session log`): `## Now` (small, actively-worked items — 2 items as of 07-15) + `## Open` (the bulk — dense, dated, checkbox `[ ]`/`[x]` lines, each a full paragraph not a one-liner, tagged `[ORDER]`/`[ASK]`/`[gated:founder]` etc., updated IN PLACE as state changes — no separate append-only session log exists in this file). `[x]` items stay in `## Now`/`## Open` until a handoff self-drains them into `archive/ROADMAP-done.md` (mechanical, sometimes deferred — check the `[x]` count matches between sessions to confirm nothing silently changed).
- `HANDOFF.md` — resume doc; "Where we are right now" (dated header) + "In flight / next" (per-lane bullets, rewritten in place, not appended) + "Landmines / gotchas" + "Resume" (Kind A execute / Kind B present-decisions).
- `SPEC.md` — canonical design (numbered `§` sections).
- Adversarial panel verdicts are the one exception to "no new docs": frozen, dated files under `docs/adversarial/`.
- Per-project `CLAUDE.md` (repo root) states this explicitly: "NEVER create new status/audit/critique/handoff-vN docs — fold conclusions into these."

Style notes: `## Open` entries are one dense paragraph per lane, dated, bold lead phrases for state flips (e.g. `**NOW DEPLOYED LIVE 2026-07-15**`); inline verification citations (`confirmed via \`command\`` / `doctl-confirmed:` / `live-verified:`) are the norm, not footnotes — this repo's bookkeeper convention leans heavily on citing the actual command output inline. HANDOFF's "In flight / next" bullets get REWRITTEN when a lane's state changes (not stacked as history). **The same fact should not be asserted in both docs' bodies without one linking to the other** (HANDOFF bullets say "full detail: `ROADMAP.md` <date> entry (`## Now`/`## Open`)").
This repo runs multi-agent swarms with many concurrently-active named subagents editing the same working tree in one session (confirmed 2026-07-15: 50+ named agents in one session's addressable roster). ROADMAP.md/HANDOFF.md are pre-existing TRACKED files, so no `git add`-for-safety concern applies to them even under the "sibling-active repo" invariant — only genuinely untracked new files need that. When a brief says "Git READ-ONLY (no commits)", read that as no `git add`/commit at all, not just no commit — leave edits unstaged and report the diff stat.

Repo-root `git` has a remote (`origin` → `YS-projectcalc/agent-cold-email`); `apps/platform/` and other subdirs do not have their own git roots.
