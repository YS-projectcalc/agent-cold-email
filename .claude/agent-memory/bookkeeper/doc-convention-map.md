---
name: coldstart-doc-convention-map
description: ColdStart's canonical doc set and where each kind of content routes
metadata:
  type: reference
---

ColdStart (`~/dev/coldstart/`) canonical living docs, per its `CLAUDE.md`: `README.md` (per level), `SPEC.md` (architecture), `ROADMAP.md` (build order/status + session log — the ledger), `ARCHITECTURE.md`, `HANDOFF.md` (resume-here state), `MEMORY.md` (repo build lessons), `ACTIVATION.md` (owner go-live checklist, once created). NEVER create new status/audit/critique/handoff-vN docs. One exception: adversarial panel verdicts are frozen records under `docs/adversarial/panel-NN/` (allowed — not living docs, don't route new content there). Research/decision provenance also gets frozen dated files under `docs/research/*-YYYY-MM-DD.md` — these are write-once, never edited after landing (even to fix a noted error — corrections get a pointer note elsewhere, e.g. ROADMAP session log, not an edit to the frozen file).

Routing: ROADMAP.md phase checklist items are one-line status; the session log (append-only, dated bullets) is where verified findings/checklists/detail go — nested `- [ ]` sub-bullets under a dated entry are an accepted pattern for a findings checklist. HANDOFF.md's "Where we are right now" is a snapshot (facts), "In flight / next" is action-oriented (what's running/blocked/next); "Resume" section is the founder-facing script — a bookkeeping brief that says "surgical edits to those sections only" should NOT touch Resume/Landmines/Key files even if related content would fit, unless explicitly told to.

Git in this repo: routinely a shared/live worktree across concurrent agent sessions (see ROADMAP 07-09 note re: a concurrent `git add -A` sweeping up in-progress files) — bookkeeper briefs here have consistently been git-read-only, leaving commit to the orchestrator.
