---
name: coldstart-cli-tests-need-dist-build-first
description: packages/cli's test suite imports from dist/, not src/ — a fresh worktree without a prior build fails ~5 tests with MODULE_NOT_FOUND + the mcp-bridge tests time out at 15s; `npm run build -w packages/cli` first, always.
metadata:
  type: project
---

`npm test -w packages/cli` (`node --test test/*.test.mjs`) imports the CLI's own
compiled output (`dist/index.js`, `dist/claude-code-hint.js`), never `src/`. A
fresh worktree or a clean checkout with no prior build fails with
`Cannot find module '.../packages/cli/dist/index.js'` on the unit tests, AND
separately the `mcp-lifecycle`/`mcp` bridge tests time out at their 15s ceiling
waiting for an `initialize` response that never arrives (the bridge process
itself can't start — same missing-dist root cause, different failure shape).

**Fix:** `npm run build -w packages/cli` (plain `tsc -p tsconfig.json`) before
trusting any `npm test -w packages/cli` result. This is on top of, not instead
of, [[coldstart-multi-worktree-branches-and-cli-contention-flake]]'s separate
concurrent-sibling-worktree flake — check dist/ exists FIRST; only treat a
still-failing mcp-bridge timeout as the contention flake after the build step
is confirmed present.
