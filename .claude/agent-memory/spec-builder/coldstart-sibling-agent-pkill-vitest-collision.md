---
name: coldstart-sibling-agent-pkill-vitest-collision
description: a concurrent agent in a DIFFERENT `.claude/worktrees/*` worktree running `pkill -f vitest` (seen in worktree agent-af7e6ba4ef61f14ca) kills YOUR in-flight `npm test`/vitest run system-wide (exit 143), producing spurious platform-suite failures and CLI mcp-lifecycle timing flakes that look like real regressions but aren't.
metadata:
  type: project
---

While verifying a ColdStart platform fix (2026-07-27, sdn-ingest weekend-storm round 2), a full `npm test` run failed with `npm error code 143` on `@coldstart/platform` (SIGTERM) and 4/9 CLI `mcp-lifecycle`/`mcp` tests timed out that had passed cleanly minutes earlier with the identical code. `ps aux` showed a sibling agent's Bash command running from a DIFFERENT worktree (`/Users/yaakovscher/dev/coldstart/.claude/worktrees/agent-af7e6ba4ef61f14ca`) that literally ran `pkill -f vitest 2>/dev/null; npm run test --workspace apps/engine` — `pkill -f vitest` matches by process name/args across the WHOLE machine, not scoped to that worktree, so it killed my platform's vitest process mid-run.

**Why:** multiple agents can be working this repo concurrently in separate worktrees (stated in my own system prompt), sharing one OS process table. A `pkill`/`killall` pattern-matched by any of them is a machine-wide blast radius, not worktree-scoped.

**How to apply:** if a `npm test`/vitest run fails with exit 143 (SIGTERM) or otherwise-passing tests suddenly time out with no code change, before treating it as a real regression: `ps aux | grep -i vitest` (or `pkill`/`node --test`) to check for a sibling agent's process, and just re-run the battery once cleanly. Don't chase a phantom regression from environmental noise — re-verify before concluding a defect. See also [[gotcha-worktree-sandbox-compound-commands]] for the polling workaround used while waiting these out.
