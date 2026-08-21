---
name: published-coverage-latency-must-use-the-achieved-advance
description: A monitor that publishes coverage/rotation latency from the INTENDED batch size rather than the ACHIEVED cursor advance reports a reassuring number inside the very alert whose subject is degraded latency — ColdStart sweep_coverage said "~10 min" while the real rotation was ~315 min.
metadata:
  type: project
---

ColdStart `sweep_coverage`, live 2026-08-20 (prod worker `133fc911`, 63 tenants).
The bounded cron sweep reported `coverageTicks = ceil(total / SWEEP_TENANT_SLICE)`
— computed from the slice it INTENDED to sweep. The rotation cursor, correctly,
advances by `fanout.leastVisited` (the least-covered leg), which the shared 15s
fan-out deadline was driving to **1**. Three consecutive ticks captured whole:
the cursor landed on `ids[0]`, `ids[1]`, `ids[2]`. True rotation 63 ticks
(~315 min); published "a full pass every 2 tick(s) (~10 min)". **31x optimistic,
inside the alert that exists to say detection latency has degraded.**

**The mechanism, generalised:** any bounded/batched worker has a PLANNED batch
and an ACHIEVED advance, and a deadline or budget can separate them silently.
Every monitor, log line and remedy string must read the achieved one. The
planned one is fine to show BESIDE it — the gap is the diagnosis (deadline
binding mid-batch vs. population growth) — but never instead of it.

**Two sibling defects found in the same check, both worth checking for:**

- **A cross-leg SUM as a threshold against a per-leg quantity.** `signals.deferred`
  summed deferral counters over legs, so ONE shared deadline landing at one item
  counted once PER LEG: `1 + 36 + 36 + 36 = 109` against a threshold of 37. It
  pinned the check permanently, and in-episode suppression then stopped the
  sibling arm (the one that means "go build the read-model") from ever alerting.
  Fix: grade in ONE unit, and prefer a unit the system already computes for
  another purpose (here the cursor advance) over a sum you assemble yourself.
- **The sum was not even complete.** Of six legs iterating the slice, only four
  could report a deferral: one returned `scanned`/`complete` instead of a
  counter, one returned an `AlertOutcome[]` with no counters at all. Both
  deferred 36 and contributed 0. Sibling of
  [[shared-primitive-caveat-wired-to-one-consumer]] — the accumulator inside the
  shared loop primitive sees every leg; per-leg self-reporting does not.

**How to apply:** when a check's detail string quotes a number, trace that
number to the variable the SYSTEM acts on (the cursor, the offset, the committed
watermark). If it comes from a config constant instead, it is a plan, not an
observation. Related: [[bounded-read-must-publish-its-coverage-latency]],
[[total-count-assertion-proxies-per-resource-invariant]],
[[anchor-stamped-before-the-read-defeats-its-own-bound]].
