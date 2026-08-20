---
name: capacity-counter-inside-a-failure-signal-pins-the-check
description: CLASS — a BY-DESIGN counter (rotation skips, budget expiries, deferrals) folded into the same observation as error counts pins the check permanently unhealthy at scale, and once an episode is announced every later tick is suppressed, so a genuinely dying leg then produces NO new alert at all.
metadata:
  type: project
---

ColdStart scale audit S4, confirmed at HEAD in `admin/sweep-signals.ts`:

```ts
const LEG_COUNTERS = ["errors", "budgetExpiries", "skippedForLegDeadline"];
const observedUnhealthy = signals.legsThrew.length > 0 || signals.counted > 0;
```

`skippedForLegDeadline` is set every cycle the rotation cannot reach every
tenant — the bounded sweep working exactly as designed. At scale it is non-zero
on EVERY tick, permanently. So:

1. the check pins unhealthy forever;
2. `decideAlert` suppresses every subsequent tick inside the backoff;
3. a leg that starts erroring on every tenant changes only the `detail` STRING
   on an already-suppressed row — **no new alert is emitted at all.**

The guard built to stop cry-wolf re-armed it, and then blinded the thing it was
guarding. Note the second-order damage is the real one: it is not "one noisy
email", it is that the failure channel is now spent.

**How to apply:** before adding a counter to any composite health observation,
ask whether it can be non-zero while nothing is wrong. If yes it is CAPACITY,
not failure — give it its own check name (a permanently-true capacity condition
is a legitimate standing alert that backs off to daily; a permanently-true
FAILURE flag is a dead channel). Same discipline as
[[staleness-exclusion-needs-severity-scope-not-just-kind]] and
[[two-valued-grade-for-a-three-valued-refusal]]: the grade needs as many values
as the world has states.

**Sibling trap when you split it:** the new capacity check must publish the
ARITHMETIC (rotation length, what was deferred), or you have moved the blind
spot rather than closed it — see
[[bounded-read-must-publish-its-coverage-latency]].
