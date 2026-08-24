---
name: bounded-concurrency-sizing-needs-a-measured-efficiency
description: sizing a concurrent fan-out as `deadline x C / (p75 x cost)` overshoots the sustainable batch by 25-30% at C>=4 (a leg is paced by its STRAGGLERS, not its p75) — and over-sizing collapses the achieved advance to 1, not to something proportionally smaller; also: ColdStart's SWEEP_SUBREQUEST_BUDGET=1000 was the FREE-plan row, Paid is 10,000.
metadata:
  type: project
---

From the ColdStart sweep-capacity measurement, 2026-08-24
(`docs/research/sweep-capacity-measurement-2026-08-24.md`, harness at
`apps/platform/test/sweepcap-experiment/`).

**(a) Concurrency is worth ~0.70 of linear, and the shortfall must be a named
constant.** Measured max sustainable slice (>=95% of ticks covering the whole
slice) vs the naive formula: C=2 6 (naive 7), C=4 12 (14), C=6 17 (22), C=8 22
(29), C=12 32 (44). The rule that reproduces or conservatively under-shoots every
point is

```
effectiveConcurrency(C) = 1 + (C - 1) * 0.70
```

which also DEGENERATES to the shipped serial value at C=1 — so a concurrency
change sized this way is a provable no-op when disabled, the cleanest revert-proof
available. Sizing off a single point estimate (p75) is the same category of error
as publishing an INTENDED batch as an ACHIEVED one; overlapping C round trips is
an order-statistic question, so model the fitted DISTRIBUTION and validate the
fit reproduces its own source statistics.

**(b) Over-sizing fails discontinuously.** Every over-sized cell collapsed the
achieved advance to **1**, not to a proportionally smaller number — because
"item 0 is always attempted" interacts with a MINIMUM-over-legs accumulator: once
the deadline binds before the trailing legs start, each sweeps exactly one. So
always size conservatively and let the coverage check ask for more.

**(c) A "conservative" platform constant was the wrong ROW of the limits table.**
`SWEEP_SUBREQUEST_BUDGET = 1000` was labelled UNVERIFIED for months; the real
Workers **Paid** limit is 10,000/invocation — 1,000 is the Free plan's
"subrequests to internal services" row. Also worth knowing: the 6
simultaneous-open-connections ceiling QUEUES past 6 rather than erroring, and
workerd OSS enforces NEITHER (`newSubrequest(bool) override {}` is a no-op in
`server.c++`, and `LimitEnforcer` declares no connection-concurrency hook at all)
— so no local/miniflare experiment can bound either one.

**How to apply.** When a docstring says a limit is UNVERIFIED, go read the vendor
limits page before deriving anything from it, and quote the plan column you took
it from. Related: [[concurrency-breaks-the-prefix-a-cursor-assumes]],
[[published-coverage-latency-must-use-the-achieved-advance]],
[[shrinking-a-global-bound-reds-other-suites-positive-controls]].
