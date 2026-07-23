---
name: coldstart-fresh-worktree-missing-dev-vars
description: A freshly `git worktree add`-ed ColdStart worktree has NO apps/platform/.dev.vars (gitignored, never copied) — this alone makes ~73 platform tests fail with a misleading "Imported HMAC key length (0)" error that looks like a real regression.
metadata:
  type: project
---

Hit 2026-07-23 during the ColdStart brand-sweep build: after making a
two-file change (`stripe-client.ts` + `demo-seed.ts`) in a brand-new
`git worktree add .claude/worktrees/<name>`, `npm run test` reported 24
failed test files / 73 failed tests in `@coldstart/platform`, ALL with
`DataError: Imported HMAC key length (0) must be a non-zero value...` from
`unsubscribe-token.ts`'s `crypto.subtle.importKey`. This looked like a
change-caused regression but wasn't — `apps/platform/.dev.vars` is
gitignored (`.gitignore:5`) so a fresh worktree checkout never gets one,
`TOKEN_HASH_PEPPER` is then `""`, and the HMAC key derivation fails on the
empty pepper for every test that exercises the tick/unsubscribe path.

**Why:** `git worktree add` only checks out tracked files; `.dev.vars` is
deliberately untracked (CLAUDE.md rule g: secrets never in git) and was
copied into the main checkout by hand at some earlier point, so only the
main checkout — never a new worktree — has it.

**How to apply:** in ANY brand-new ColdStart worktree, before trusting a
"go run the full test suite" verification step, check
`ls apps/platform/.dev.vars` — if absent, `cp apps/platform/.dev.vars.example
apps/platform/.dev.vars` (placeholder values are explicitly fine for
local/test per the example file's own comments; this is not a real secret).
Separately, `packages/cli` (`agent-cold-email`) tests fail with
`MODULE_NOT_FOUND .../packages/cli/dist/index.js` in a fresh worktree until
`npm run build -w agent-cold-email` has been run once — same "fresh
worktree missing a build/config artifact" class, not a code defect. Always
re-run the failing package's suite standalone after fixing the env gap to
confirm the failure was environmental, not caused by your diff, before
reporting a battery result.
