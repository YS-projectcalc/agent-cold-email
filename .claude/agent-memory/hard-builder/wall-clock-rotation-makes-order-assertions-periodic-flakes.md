---
name: wall-clock-rotation-makes-order-assertions-periodic-flakes
description: ColdStart — IN-9's cycle-derived rotationOffset(clock.now(), CRON_PERIOD_MS, n) flips list order every 5 minutes, so any fixed-order test assertion becomes a wall-clock flake; paid tenants run on RealClock (no advanceClock), so pin the clock via the ctx spread
metadata:
  type: project
---

A cycle-derived rotation (`rotationOffset(ctx.clock.now(), CRON_PERIOD_MS, n)` in `src/isolated-loop.ts`, used by `runPollInbox` and `ops-sweep`) makes list order a function of the **wall-clock 5-minute period**. Any test asserting a fixed order (`expect(polled).toEqual(["a","b"])`) passes or fails depending on the minute the suite runs — it looks like a code regression and reruns "confirm" it for the next 5 minutes.

**Why:** the fairness property IN-9 ships is "every item is reached across cycles", not "item A leads". Order is incidental; asserting it encodes the wall clock into the test.

**How to apply:**
- `advanceClock` (the lever `poll-stall-rotation.test.ts` uses) only works for a VIRTUAL clock. A tenant that went through `activatePaidPlan` has `clock_mode='real'` → `helpers.ts` hands it a `RealClock` and `advanceClock` is unavailable. Inject instead, matching the existing spread idiom: `runPollInbox({ ...base, clock: { now: () => pinnedMs } })`.
- Pin to an instant whose offset is a chosen constant AND stays near real now (other writes on the path stamp `last_polled_at` from the same clock): `period = floor(Date.now()/CRON_PERIOD_MS); aligned = period - (period % length) + offset`.
- Assert the invariant, then the rotation separately: loop both offsets, `expect([...polled].sort()).toEqual([A, B])` per cycle (the isolation property), plus `expect(leadPerRotation).toEqual([A, B])` (rotation genuinely rotates).
- Sweep sibling tests by grepping `toEqual` on any collected-order array for the same feature, not by grepping `rotationOffset` (the tests never name it).

Related: [[coldstart-vitest-binding-and-d1-isolation-gotchas]], [[polling-check-error-is-indistinguishable-from-negative]].
