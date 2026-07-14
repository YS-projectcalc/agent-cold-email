---
name: coldstart-doc-conventions
description: Canonical doc map for the ColdStart repo (~/dev/coldstart) — where ledger/status/resume content routes.
metadata:
  type: project
---

Canonical living docs for this repo live at the REPO ROOT (`~/dev/coldstart/`), not under `apps/platform/`, even when the session's work was scoped to `apps/platform/`:
- `ROADMAP.md` — build order/status (checklist lanes under `## Phases`) + append-only `## Session log` (reverse-none, chronological, dated bullets like `- 2026-07-13 (deploy): ...`).
- `HANDOFF.md` — resume doc; "Where we are right now" (dated header) + "In flight / next" (per-lane bullets, rewritten in place, not appended) + "Landmines / gotchas" + "Resume" (Kind A execute / Kind B present-decisions).
- `SPEC.md` — canonical design (numbered `§` sections).
- Adversarial panel verdicts are the one exception to "no new docs": frozen, dated files under `docs/adversarial/`.
- Per-project `CLAUDE.md` (repo root) states this explicitly: "NEVER create new status/audit/critique/handoff-vN docs — fold conclusions into these."

Style notes: ROADMAP session-log entries are one dense paragraph per session/event, dated, with a bold lead phrase (e.g. `**MERGED + DEPLOYED LIVE.**`); inline verification citations (`confirmed via \`command\``) are the norm, not footnotes. HANDOFF's "In flight / next" bullets get REWRITTEN when a lane's state changes (not stacked as history) — the history lives in ROADMAP's session log instead. **The same fact should not be asserted in both docs' bodies without one linking to the other** (HANDOFF bullets typically say "full detail: `ROADMAP.md` <date> session-log entry").

Repo-root `git` has a remote (`origin` → `YS-projectcalc/agent-cold-email`); `apps/platform/` and other subdirs do not have their own git roots.
