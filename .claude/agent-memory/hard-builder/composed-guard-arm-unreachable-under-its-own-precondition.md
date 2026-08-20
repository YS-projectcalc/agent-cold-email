---
name: composed-guard-arm-unreachable-under-its-own-precondition
description: ⚠️ When you feed a 3-valued grader an input DERIVED from another grader's verdict, one of its return values can be unreachable given the guard's own precondition — the composed arm silently never fires and passes every positive test.
metadata:
  type: project
---

**Shape:** `holding = gradeStreak(prev, observedUnhealthy = (grade === null), ...)` then
`if (grade === null && holding) { ... }`. `gradeStreak`'s arms are disjoint BY INPUT: the
`observedUnhealthy` branch can only return `false | null`, and the other branch only
`true | null`. So under the guard's own precondition (`grade === null`, i.e. the input was
`true`), `holding === true` is **unreachable** — the arm never fires. Correct guard:
`holding === false` (`false` = the streak reached its threshold = UNHEALTHY).

Caught in the ColdStart alert-state design gate (2026-08-20, B1): 300 simulated ticks, the
composed arm fired **0 times**, byte-identical to the blindness it was written to fix.

**Why it survives testing:** every "it alerts on a real signal" test exercises the OTHER arm
(`grade === false`), which works. Only a test of the sub-threshold/hold path reds — and that
path is exactly the one nobody had, because its absence was the bug being fixed.

**How to apply:** whenever a guard's input is derived from another verdict, write out the
value table of (precondition × possible returns) before trusting the composition — a
3-valued grader composed with a 3-valued caller has 9 cells and usually only 4 are
reachable. Add a RED test that fails on the inverted polarity, not just one that passes on
the fixed one. Related: [[two-valued-grade-for-a-three-valued-refusal]],
[[polling-check-error-is-indistinguishable-from-negative]].
