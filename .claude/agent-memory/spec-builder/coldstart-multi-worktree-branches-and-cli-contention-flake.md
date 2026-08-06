---
name: coldstart-multi-worktree-branches-and-cli-contention-flake
description: msgchannel/dunning/wave1 fix lanes each live in their OWN sibling worktree (coldstart-wt-<name>, not nested under .claude/worktrees/) on their own branch — `git status` in the main repo can look clean while real uncommitted work sits in a sibling worktree; also, packages/cli's mcp-bridge tests time out (15s) under concurrent sibling-worktree vitest load without any real regression.
metadata:
  type: project
---

Two related findings from verifying msgchannel Increment 1's post-gate fixes (2026-08-06):

1. **Branch topology:** after a wave closes, the orchestrator commits each lane's work to its OWN branch in its OWN sibling worktree — `coldstart-wt-msgchannel` (branch `msgchannel-inc1`), `coldstart-wt-dunning` (branch `fix/dunning-p0`), `coldstart-wt-wave1` (branch `fix/provisioning-wave1`) — siblings of the main `~/dev/coldstart` checkout, NOT nested under `.claude/worktrees/` like a single-agent dispatch. The main worktree can be on a totally different branch/HEAD doing unrelated work while a gated fix (e.g. an adversary "SHIP-AFTER-FIXES" verdict) is being resolved in its own worktree. `git log --oneline --all -- <file>` + `git branch --all --contains <sha>` + `git worktree list` is how to relocate the actual branch/worktree a commit lives on when a file you expect to exist is missing from the current checkout.

2. **CLI contention flake:** `packages/cli`'s `mcp bridge` tests (`test/mcp.test.mjs`, `test/mcp-lifecycle.test.mjs`) spawn a real child process and wait up to 15s for a JSON-RPC `initialize` response over stdio. With 3-4 concurrent full Cloudflare-Workers `vitest run` suites active across sibling worktrees (each spinning up its own `workerd` instance), the spawn+response round trip can blow that timeout with NO code change — confirmed by re-running the identical CLI suite alone (`ps aux | grep -i "vitest run"` showed zero contention) and getting a clean 12/12.

**Why:** shared machine, shared OS process table, multiple concurrent agent lanes each running their own full battery — none of it a `pkill` (see [[coldstart-sibling-agent-pkill-vitest-collision]], the harder failure mode) but plain CPU/scheduler starvation on a short, real-timing-dependent test.

**How to apply:** before waiting on a background test run, poll the run's OWN log file for its trailing sentinel (e.g. an appended `EXIT:$?` line) rather than a generic `ps aux | grep "vitest run"` — the latter false-positives/false-negatives across sibling worktrees' unrelated processes. If a CLI mcp-bridge test times out and nothing in `packages/cli` is in your diff, check `ps aux` for sibling `coldstart-wt-*` vitest/workerd processes before treating it as a regression — just re-run alone once.
