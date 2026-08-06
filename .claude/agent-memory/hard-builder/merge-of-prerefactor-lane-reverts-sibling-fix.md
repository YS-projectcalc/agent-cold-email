---
name: merge-of-prerefactor-lane-reverts-sibling-fix
description: CLASS - merging a lane written against a PRE-refactor file; taking the incoming side of a moved-function conflict silently reverts the refactor lane's fix inside that same function, and textual auto-merge leaves unimported/dead symbols
metadata:
  type: project
---

CLASS: when lane B was written against a file that lane A later REFACTORED, a
three-lane integration hits two distinct traps that a green targeted suite does
not catch.

**Trap 1 — the modify/delete conflict that reverts a sibling fix.** Lane A moved
`getInfrastructureStatus` out of `provisioning.ts` into `infrastructure-status.ts`
AND fixed a vendor leak inside it (`vendorHealthError = err.message` -> abstract
sentence). Lane B (pre-refactor) edited the SAME function in place to add a
field. Git presents this as `<<<<<<< HEAD` (empty, the deletion) vs the whole
incoming function. Resolving it the intuitive way — "take the side that has the
new feature" — reinstates lane B's STALE COPY of the function, silently
reverting lane A's leak fix and re-adding a file that should no longer exist.
Correct resolution: take the deletion, then re-home ONLY the new field into the
function's new home.

**Trap 2 — textual auto-merge leaves a broken import surface.** The regions that
auto-merged cleanly still produced non-compiling code, because each lane's
import edits were correct alone and wrong together:
- lane A dropped `VendorError` from the import (its last use moved out) while
  lane B's merged-in catch re-introduced `err instanceof VendorError`;
- lane B's import of `listSurfacedTenantMessages`/`TenantMessage` became dead
  once its only consumer moved to another module;
- lane A made `connectionType` REQUIRED on `PurchasedDomain`, so lane B's
  pre-existing test fixtures (`buy()` returning no `connectionType`) stopped
  typechecking.

**How to apply:** after ANY merge whose lanes overlap a refactored file, treat
`git merge` reporting success as meaning nothing. Run typecheck FIRST (it is the
cheapest detector of both traps), then run the incoming lane's OWN tests against
the refactored code, then prove the re-wiring is load-bearing with a revert-proof
(delete the re-wired line, confirm the incoming lane's test goes RED). Reconcile
final test COUNTS against each lane's own reported counts — main + per-lane
deltas must add up exactly, or a test was silently lost in a conflict resolution.

Related: [[adapter-selected-from-column-before-same-request-update]],
[[code-with-no-production-driver-passes-every-test]].
