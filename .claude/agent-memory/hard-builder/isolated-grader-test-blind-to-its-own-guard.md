---
name: isolated-grader-test-blind-to-its-own-guard
description: A test that RECONSTRUCTS a composition (grader, or producer+classifier) passes on a defect living in the real wiring — only driving the actual producer and observing its EFFECT reds. Hit twice in two rounds.
metadata:
  type: project
---

⚠️ I shipped this and caught it in the revert-proof. Writing the §4/U-2 test as
"call `gradeSweepStreak` 149 times and assert `true` never appears" PROVES the
mechanism (the arms are disjoint by input, so `true` is unreachable on the
dead-band arm) — and it **passed unchanged** when I reverted the production
guard from `holdGrade === false` to the defective `if (holdGrade)`.

**Why:** the isolated test asserts a property OF THE GRADER. The defect lives in
the CALLER's comparison against the grader's return. Nothing in the isolated
test executes that comparison, so the highest-value RED in the whole increment
was decorative.

⚠️ **I MADE THE SAME MISTAKE A SECOND TIME, one round later**, writing the class
guard the build gate ordered for exactly this shape. The guard probed
`alertDeliveryKey(collectLegSignals(...).whys)` — it REBUILT the composition
instead of observing what the producer emitted, so it passed with the defect
re-introduced. Fixed by driving the real producer (`reportSweepSignals`) and
reading the key the machine BANKED out of `watchtower_state.announced_keys`.
That version reds. **Two occurrences in two rounds: assume this is my default
error and check for it before claiming any red-before-green.**

**How to apply:** when a fix is "the guard reads the wrong value of a 3-valued
helper", the red-before-green test MUST drive the composed producer path
(`evaluateHealthChecks` / `runWatchtower`, not the DO RPC). Keep the isolated
arm as documentation of the mechanism; add the composed one as the proof.
Sibling of [[recommendation-must-be-executed-not-shape-checked]] and
[[composed-guard-arm-unreachable-under-its-own-precondition]].

**Fixture gotcha found while building it:** `opsSummary(sinceMs)` counts events
with `ts >= sinceMs` and **no upper bound**, so a fixture that inserts the whole
timeline up front reads as a burst on tick 0 (`failed_elevated` instead of the
dead band). Insert tick-by-tick at `now - 60_000`, the way
`watchtower-flap.test.ts` already does.
