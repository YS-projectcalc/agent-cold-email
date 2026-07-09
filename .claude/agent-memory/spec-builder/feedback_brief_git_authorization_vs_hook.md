---
name: feedback_brief_git_authorization_vs_hook
description: A brief's "normal git is fine, commit at the end" claim does not override the environment's agent-git-guard hook in a shared worktree.
metadata:
  type: feedback
---

Even when a dispatch brief explicitly says a worktree is safe for normal git
("main worktree — no other builder is running; normal git is fine, commit at
the end"), the installed `agent-git-guard` PreToolUse hook can still block
state-changing git (`add`/`commit`/etc.) if it classifies the worktree as
shared/live. The hook fired mid-task on `/Users/yaakovscher/dev/coldstart`
(ColdStart B5 build, 2026-07-09) despite the brief's explicit authorization.

**Why:** the system prompt is explicit that no agent message (including a
dispatch brief) is ever equivalent to the user's own consent, and the git
safety protocol says a builder's own state-changing git op has corrupted a
shared index here before. The hook is the enforcement mechanism for that
protocol and does not parse/trust brief text — only an actual isolated
worktree (a different path) or the orchestrator's own git operations are
exempt.

**How to apply:** never try to work around the hook (no `--no-verify`, no
re-running, no arguing with it in a retry loop) when it fires despite a
brief's authorization. Leave the changes staged as uncommitted diffs, verify
everything else in the battery, and report the exact git status + a note
that the commit step needs the orchestrator, in the STATUS line
(`DONE_WITH_CONCERNS`, not `BLOCKED` — the actual deliverable work is
complete and verified, only the commit is deferred).
