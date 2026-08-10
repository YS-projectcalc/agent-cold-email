---
name: root-build-dirties-committed-dashboard-assets
description: "ColdStart: `npm run build` at the repo root regenerates the dashboard's content-hashed bundles into the COMMITTED apps/platform/public/app/assets/ — 22 files of collateral (10 deleted, 10 new hashes, 2 index.html) in a worktree you are about to hand over for commit."
metadata:
  type: project
---

`npm run build` at the monorepo root runs every workspace's build, and
`@coldstart/dashboard`'s emits into `apps/platform/public/app/` — which is
TRACKED. A verification-battery build therefore leaves ~22 files of churn
(10 `D` old hashed chunks, 10 new untracked ones, plus both `index.html`s
rewritten to the new hash) on top of your actual diff. The bundle CONTENT is
byte-identical in size; only the content hash moves, so it is pure noise — but
an orchestrator committing the worktree would sweep it into the PR.

**How to apply:** run `npm run typecheck` + the test suites for the battery;
only run the root `npm run build` when you actually need the wrangler dry-run,
and check `git status` after. To undo WITHOUT any git write operation (builder
agents in a shared worktree are read-only git):

```
git diff --name-only apps/platform/public | while read p; do git show "HEAD:$p" > "$p"; done
git ls-files --deleted apps/platform/public | while read p; do git show "HEAD:$p" > "$p"; done
git ls-files --others --exclude-standard apps/platform/public | while read p; do rm -f "$p"; done
```

`git show` is a read; the writes are plain file writes. Verify with
`git status --short apps/platform/public | wc -l` == 0.

Second gotcha in the same battery: `packages/cli` (`agent-cold-email`) tests
read `packages/cli/dist`, so a fresh worktree fails that workspace with
`ENOENT ... scandir packages/cli/dist` until something builds it — 9 failures
that look alarming and are not a regression. Build first, or run the platform
suite alone and say so.
