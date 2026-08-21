---
name: lane-worktree-cli-tests-need-a-build-first
description: packages/cli's test script exercises the BUILT dist/, which a fresh coldstart worktree does not have — the MCP bridge tests time out at 15s and look like a real regression.
metadata:
  type: project
---

`packages/cli`'s `test` script is `node --test test/*.test.mjs`, and
`test/mcp.test.mjs` spawns the built binary (`dist/index.js`) as a real
subprocess. It does **not** build first.

A `.claude/worktrees/<lane>/` checkout has no `packages/cli/dist/` (gitignored,
never copied by `git worktree add`), so the child process fails to start and the
RPC harness reports `timed out waiting for response to initialize (id 1)` after
15s — twice. It reads exactly like a hang the lane caused.

**How to apply:** before quoting the CLI leg of the battery from a lane
worktree, run `npm run build` in `packages/cli` (plain `tsc -p tsconfig.json`,
emits to the gitignored `dist/`, does NOT dirty the tree). ⚠️ Do NOT reach for
the ROOT `npm run build` instead — that one rewrites committed dashboard asset
hashes ([[root-build-dirties-committed-dashboard-assets]]). Sibling of
[[worktree-without-node-modules-resolves-to-main]].
