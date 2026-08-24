---
name: fold-splits-two-columns-that-were-one-number
description: ⚠️ when two lanes merge, a table column that was incidentally EQUAL to another (subrequests == round trips) can split — every consumer that picked the wrong one was correct until the fold and is silently wrong after; and a mechanical merge of two edits to the same derived term keeps BOTH subtractions.
metadata:
  type: project
---

ColdStart fold `integ/perf-mirror-2026-08-24` (sweep-capacity + msgchannel Inc4),
2026-08-24. Two defects, same root: quantities that had always been the same
number stopped being the same number.

**(a) THE DERIVED TERM BOTH LANES EDITED.** `SWEEP_FANOUT_RPCS_PER_TENANT` was
`RPCS - 2` (excluding the send pipeline). Lane A dropped the `- 2` because that
leg moved off the slice; lane B added `- MIRROR` because its cost rides an
existing dispatch. The mechanical merge keeps both: `9 - 2 - 2 = 5`, which
UNDER-states per-tenant deadline cost and OVER-sizes the batch 19 -> 27 (42%).
**Every guard in both lanes stays green**, because the cost-table sum checks the
TOTAL (`RPCS`), not the derived sub-term. Correct answer: `RPCS - MIRROR = 7`.

**(b) THE ORACLE THAT GRADES (a) WAS ITSELF MIS-FED BY THE FOLD.** The simulation
built its leg model from the cost table's `perTenant` column — SUBREQUESTS — and
fed it to the simulator as ROUND TRIPS. Identical numbers in every prior tree; off
by exactly the mirror after the fold. It charged one leg three dispatches instead
of one and **reddened against a CORRECT fold** (`shipped slice 4 must not exceed
the simulated max 3`). A mis-fed oracle is worse than no oracle: the natural
reaction to it reddening is to "fix" the code it is grading.

**How to apply.**
- At any fold, list the DERIVED terms both sides touched and re-derive each by
  hand from first principles; do not diff-resolve them. A sum guard over the
  total cannot see a wrong sub-term.
- Then ask which consumers read a column whose meaning just split. Grep for every
  reader of the table, not just the constant. Add an assertion tying the model to
  the constant it is supposed to be grading (`sum(model) === DERIVED_TERM`) so the
  next split reds at the seam instead of at the subject.
- Execute the module and print the derived values; hand-check every ceiling.
  "Typecheck + tests green" is exactly the state a wrong fold produces here.

Related: [[bounded-concurrency-sizing-needs-a-measured-efficiency]],
[[merge-of-prerefactor-lane-reverts-sibling-fix]],
[[property-test-that-restates-the-implementation]].
