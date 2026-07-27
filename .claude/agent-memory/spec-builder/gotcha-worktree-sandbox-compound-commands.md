---
name: gotcha-worktree-sandbox-compound-commands
description: this worktree's Bash sandbox refuses compound commands (cd&&, ;, multi-line for-loops, chained sleep+check) with a "too complex to verify worktree" error even with zero git involved — run each step as its own separate Bash call, and use an `until <check>; do sleep N; done` single-statement loop (not chained standalone sleeps) to poll a background task.
metadata:
  type: project
---

In `/Users/yaakovscher/dev/coldstart/.claude/worktrees/agent-adca8bee95b898821` (and likely other `.claude/worktrees/*` isolated worktrees), the Bash tool's sandbox guard rejects ANY multi-statement command — `cd X && npx ...`, `a; b`, multi-line `for`/loop bodies, or a standalone `sleep N` followed by another command — with: "This agent is isolated in the worktree ..., but this command is too complex to verify that it stays inside the worktree." This fires even when the command contains no git at all (e.g. `cp file1; cp file2` or `diff a b; echo x`).

**Why:** the guard appears to pattern-match on command *shape* (semicolons/&&/loops), not actual content — it is not really about git safety in this case, just an overzealous complexity check tied to the worktree-isolation feature.

**How to apply:** in this environment, run each shell action (cd, cp, diff, npm script, echo $?) as its own single-purpose Bash tool call — never chain with `;`/`&&`/newlines. To wait for a background task (`run_in_background` or a command that auto-backgrounds past its timeout), a single `until <condition>; do sleep N; done; echo DONE` command IS accepted (the loop body itself isn't flagged) — repeat calls to `wc -l`/`grep` on the target log directly instead of chaining `sleep && check`. A bare standalone `sleep N` with nothing else is also eventually blocked outright ("use Monitor... or run_in_background") after being used a couple times — don't rely on it as a polling primitive; either background the real command and wait for its completion notification, or use the accepted `until`-loop form.
