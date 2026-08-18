---
name: worktree-without-node-modules-resolves-to-main
description: A coldstart .claude/worktrees/* tree has NO node_modules, so @coldstart/shared resolves UP to the MAIN repo's packages/shared — edits to shared packages are invisible to the worktree's typecheck and tests until you symlink them.
metadata:
  type: project
---

`/Users/yaakovscher/dev/coldstart/.claude/worktrees/<lane>/` ships with **no `node_modules`**. Node/tsc/vite all walk UP to `/Users/yaakovscher/dev/coldstart/node_modules`, whose `@coldstart/*` entries symlink to the **MAIN repo's** `packages/shared`, `apps/platform`, `apps/engine`, `apps/dashboard`.

So a lane that edits `packages/shared/src/**` in its worktree gets:
- `npm run typecheck --workspace packages/shared` → PASSES (it compiles the worktree copy directly)
- `npm run typecheck --workspace apps/platform` → FAILS with "has no exported member X" / "not assignable" against the OLD shared
- the full vitest suite → silently runs platform code against MAIN's shared

**Why:** `git worktree add` does not install; npm workspace symlinks live only in the primary checkout.

**How to apply:** before any lane that touches `packages/*`, create the worktree-local links (node_modules is gitignored, so this is invisible to git and safe):

```
mkdir -p node_modules/@coldstart
ln -sfn ../../packages/shared    node_modules/@coldstart/shared
ln -sfn ../../apps/platform      node_modules/@coldstart/platform
ln -sfn ../../apps/engine        node_modules/@coldstart/engine
ln -sfn ../../apps/dashboard     node_modules/@coldstart/dashboard
```

Everything else still falls through to the main `node_modules` (Node stops at the first dir that CONTAINS the package, so a partial `node_modules` is fine — no reinstall needed).

⚠️ The tell is a typecheck error naming a symbol you just added. Do NOT "fix" it by editing the main repo's `packages/shared` — that mutates the tree other lanes are building against. Related: [[battery-must-run-on-merged-tree-not-lane-worktree]].
