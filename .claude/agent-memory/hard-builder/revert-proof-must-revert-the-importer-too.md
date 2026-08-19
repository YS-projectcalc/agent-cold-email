---
name: revert-proof-must-revert-the-importer-too
description: A revert-fail-restore proof of a fix that ADDED an export breaks the module graph unless the consumer that imports it is reverted in the same step — otherwise the test errors on import and proves nothing.
metadata:
  type: project
---

`git checkout HEAD -- <fix-file>` is only a valid RED leg if the resulting tree still LOADS.
Reverting `next-steps.ts` alone deleted `deriveNextStepsWithResolved` while the still-modified
`ops-summary.ts` imported it, so every test in the graph would have died on an import error —
an exit 1 that looks like a red proof and is worth nothing. The revert set is the fix file
PLUS every consumer of the symbols the fix introduced; here that was `next-steps.ts` +
`ops-summary.ts` (+ `tenant-do.ts` for the constructor wire), while the new PURE helper
(`mailbox-provisioning.ts`'s `personaSlugFromManagedAddress`) had to be KEPT so the new test's
own import still resolved.

**Why:** the proof's whole value is that the assertion fails on the OLD BEHAVIOUR. A failure
at module load is indistinguishable from a failure at assert in the exit code, so an unchecked
revert set silently downgrades the strongest evidence in the contract to noise.

**How to apply:** before the RED run, ask what the fix ADDED to a module's public surface and
grep its importers — revert those too. Back the whole working tree up with `cp` first
(`git status --porcelain | awk '{print $2}'` → copy each), restore by copying back, and prove
the restore by comparing `git diff | shasum -a 256` against the pre-proof hash: with untracked
new files in play, `git stash` is the wrong tool and `git checkout` cannot restore them at all.
Then read the RED log for the ASSERTION text, never just the exit code — the B1 leg here was
only trustworthy because it printed `expected 9 to be 5`, the gate's own executed numbers.
Related: [[insert-only-column-null-for-pre-column-population]].
