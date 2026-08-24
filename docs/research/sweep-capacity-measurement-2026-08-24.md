# Sweep capacity — bounded-concurrency fan-out, measured

Lane `feat/sweep-capacity-2026-08-24` · 2026-08-24 UTC · base `main@fbd4168`

> **STATUS: MEASURED, THEN BUILT.** This document is the measurement, frozen as
> written before any production code changed. The orchestrator ratified the §6
> recommendation and the build followed in the same lane: bounded-concurrency
> fan-out at C=6, the verified subrequest budget, the `opsSummary` dedupe, the
> send pipeline off the slice, and paying-tenant-first.
>
> Where the SHIPPED numbers differ from §1's table, the shipped ones are more
> conservative and the reason is recorded in the code:
> * the slice at C=6 is **19**, not 16 or 21 — §6's rule plus the mean-completion
>   ceiling, which was folded into the derivation rather than left as a test
>   assertion, and the dedupe's 9→7 fan-out RPCs;
> * `sweepTenantSliceFor(1)` is **4**, not 3 — the dedupe lowers the per-tenant
>   cost independently of the concurrency, so the rollback lever restores the
>   serial LOOP, not the pre-lane slice;
> * paying-tenant-first shipped as a bounded PREPEND that reallocates the slice,
>   not as the separate priority pass §9 sketched — §9 flagged it as a design
>   question because sorting the slice breaks the keyset cursor, and the prepend
>   is what avoids that.
>
> Rotation at the live 66 tenants: **110 min → 20 min.**

Answers the ruling in `docs/adversarial/sweep-calibration-gate-2026-08-20.md:201-212`
(finding 6): the shipped remedy prose tells the operator "the read-model is DUE",
while the same lane's own capture put DO `cpuTime` at 1-3% of `wallTime` — the
signature of a dispatch-bound workload that parallelises. The orchestrator's
ruling was: **measure bounded concurrency before committing to the read-model.**

---

## 1 · The answer

**Yes. Bounded-concurrency fan-out brings `sweep_coverage` healthy at the current
tenant count with a large margin, and holds through 150 tenants. The
D1/Analytics read-model is NOT needed for this problem at this scale.**

| | slice | rotation @66 | @150 | @300 | healthy @66 / @150 / @300 |
|---|---|---|---|---|---|
| today (serial) | 3 | 22 ticks (110 min) | 50 | 100 | ✗ / ✗ / ✗ |
| **C=6 (recommended)** | **16** | **5 ticks (25 min)** | **10** | 19 | **✓ / ✓ / ✗** |
| C=6 + `opsSummary` dedupe | 21 | 4 ticks (20 min) | 8 | 15 | ✓ / ✓ / ✗ |
| C=8 + dedupe | 28 | 3 ticks (15 min) | 6 | 11 | ✓ / ✓ / ✓ |

(Threshold: `COVERAGE_TICKS_ALERT_AFTER = 12`, i.e. a full pass must take one hour
or less. Slices above are the CONSERVATIVE derived values of §6, not the raw
measured maxima of §4 — the derivation under-shoots every measured cell.)

Three findings decide it, and two of them are cheaper than the concurrency work:

1. **The recommended concurrency is 6 — the documented ceiling itself.** Cloudflare
   documents six simultaneous connections per invocation, so a fan-out bounded at
   6 can never be clamped by it. The design then does not depend on the question
   nobody can answer from the docs (whether DO stub RPCs count at all).
2. **`SWEEP_SUBREQUEST_BUDGET = 1000` is 10x too conservative.** The documented
   Workers Paid limit is **10,000 subrequests per invocation** (§2). At 1,000 the
   subrequest ceiling caps the slice at 37; at the documented figure it caps it at
   528. Subrequests do not bind anywhere in the useful concurrency range either
   way — but the constant should stop claiming a limit that is not the limit.
3. **Concurrency is worth ~0.70 of linear, not linear.** The naive
   `deadline x C / (p75 x rpcs)` overstates the sustainable slice by 25-30% at
   every C ≥ 4, because the leg is paced by its stragglers, not by its p75. A
   build that sizes the slice off the naive formula re-commits the 2026-08-20
   defect in a new coordinate: a plan reported as an observation.

**One correctness constraint the build MUST honour** (§5): `commitSweepCursor`
does `slice.ids[covered - 1]`, which silently assumes the covered set is a
CONTIGUOUS PREFIX. Sequentially that is free. Concurrently it is only true for
one of the two obvious deadline disciplines, and the harness demonstrates the
other one leaving a hole.

---

## 2 · Platform facts, from primary sources

All quotes from <https://developers.cloudflare.com/workers/platform/limits/>
("Last updated Jul 28, 2026") and
<https://developers.cloudflare.com/durable-objects/platform/limits/>
("Last updated Jun 1, 2026"), fetched 2026-08-24.

### 2.1 Simultaneous open connections — 6, and exceeding it QUEUES

> **Simultaneous open connections** — Each Worker invocation can have up to six
> connections simultaneously waiting for response headers. The following API
> calls count toward this limit while the initial connection is being established
> and the server has not yet responded:
> `fetch()` method of the Fetch API / `get()`, `put()`, `list()`, and `delete()`
> methods of Workers KV namespace objects / `put()`, `match()`, and `delete()`
> methods of Cache objects / `list()`, `get()`, `put()`, `delete()`, and `head()`
> methods of R2 / `send()` and `sendBatch()` methods of Queues / Opening a TCP
> socket using the `connect()` API. Outbound WebSocket connections also count
> toward this limit.

> Once response headers arrive for a connection, it no longer counts toward the
> six-connection limit. **[...] If a seventh connection is attempted while six are
> already waiting for headers, it is queued until one of the existing connections
> receives its response headers.**

Two things follow, and the second is the one that de-risks the whole build:

- **Durable Object stub RPCs are not on that list. Neither is D1.** The list is
  presented as exhaustive ("The following API calls count toward this limit") and
  omits both. That is evidence, not proof: the docs nowhere state that DO RPCs are
  exempt. **Treat it as UNRESOLVED.** The same table on the Durable Objects limits
  page repeats "Simultaneous outgoing connections/request — 6 (same as Workers)"
  for connections made *from inside* a DO, which is a different direction and does
  not settle it either.
- **Exceeding the ceiling is not an error.** It queues. So the worst case for a
  fan-out set to C > 6 is that its effective concurrency saturates at 6 — the tick
  clips, `leastVisited < handed`, and the shipped `sweep_coverage` check reports
  the CLIPPED number honestly (it already distinguishes `covered < handed`). The
  failure mode of guessing wrong is a truthful alert, not a broken tick. §4 Table 4
  quantifies it: even fully clamped to 6, the slice is 18 and @66 stays healthy.

### 2.2 Subrequests — 10,000 per invocation on Paid, not 1,000

> **Subrequests** — A subrequest is any request a Worker makes using the Fetch API
> or to Cloudflare services like R2, KV, or D1.
>
> | Limit | Workers Free | Workers Paid |
> |---|---|---|
> | Subrequests per invocation | 50 | **10,000 (up to 10M)** |
> | Subrequests to internal services | 1,000 | **Matches configured limit (default 10,000)** |
>
> You can change the subrequest limit per Worker using the `limits` configuration
> in your Wrangler configuration file.

`sweep-budget.ts:70` sets `SWEEP_SUBREQUEST_BUDGET = 1000` and its docstring
correctly labels it UNVERIFIED. It is verified now, and it is low by 10x. The 1,000
figure is the **Free-plan** internal-services row.

### 2.3 Per-object throughput — not a constraint for THIS fan-out

> An individual Object has a soft limit of 1,000 requests per second. [...] A
> Durable Object that receives too many requests will, after attempting to queue
> them, return an overloaded error to the caller.

The fan-out issues **one RPC per tenant per leg to that tenant's OWN object** —
66 distinct objects, at most one in-flight request each. Per-object overload is
not reachable by this change. (It would be by a fan-out that hammered one shared
object; nothing here does.)

### 2.4 Local dev cannot enforce either ceiling — from the workerd source

`sweep-budget.ts:63` already records that miniflare does not enforce the
subrequest cap. Confirmed at source, and the same holds for the connection
ceiling, which is the stronger claim:

- `cloudflare/workerd` `src/workerd/io/limit-enforcer.h:152` declares the hook
  (`virtual void newSubrequest(bool isInHouse) = 0;`) and
  `src/workerd/server/server.c++:4560` implements it as **`void newSubrequest(bool
  isInHouse) override {}`** — a no-op.
- `LimitEnforcer` declares **no connection-concurrency method at all**, and the
  string `simultaneous` does not occur in `server.c++`. There is no code path in
  the OSS runtime that could enforce the six-connection ceiling.

**Consequence for this lane:** running the experiment under `wrangler dev` /
miniflare would have produced a clean result that means nothing — it cannot
reproduce the one ceiling in question. The measurement is therefore a validated
model (§3) bounded by the documented limits, plus a live client-side probe (§7).
That is stated as a limitation, not papered over.

---

## 3 · The harness, and why its numbers can be trusted

`apps/platform/test/sweepcap-experiment/` — test-only, imported by nothing in
`src/`.

| file | what it is |
|---|---|
| `latency-model.ts` | the DO-RPC latency distribution, fitted to `MEASURED_DO_RPC_MS` |
| `tick-model.ts` | discrete-event model of one tick's fan-out phase |
| `concurrent-candidate.ts` | the bounded-concurrency primitive under evaluation, in both deadline disciplines |
| `sweepcap.test.ts` | the assertions (7 tests) |
| `report.ts` | the matrix printer (standalone Node — see below) |

**Why a fitted distribution rather than the p75.** Overlapping C round trips is an
order-statistic question: a worker pool is paced by the draws it actually gets. A
single point estimate cannot express that, and sizing a concurrent fan-out off p75
alone would be the same category of error the 2026-08-20 calibration removed. The
inverse CDF is anchored on the three measured quantiles (p50 350 / p75 450 /
p90 531); its two free parameters (floor, tail max) were solved so the mean comes
out at the measured 414ms. The gap between 414 and the ~369 a plain lognormal
through p50/p90 would give is itself the evidence that a tail beyond p90 exists
and matters.

```
--- latency fixture vs the production capture it is fitted to ---
  fitted   mean=413.6 p50=350 p75=450 p90=531 p95=1039
  measured mean=414   p50=350 p75=450 p90=531  (n=77, 2026-08-20)
```

**Three independent checks that the model is modelling the real thing:**

1. **The fixture reproduces its own source.** 200k draws land within 6ms of all
   four measured statistics (asserted, `sweepcap.test.ts`).
2. **The simulator is pinned to the shipped `sweepTenants`.** Rather than trusting
   that the model's deadline semantics match, the test RUNS the real
   `sweepTenants` (and the concurrent candidate) against real timers, records each
   tenant's OBSERVED duration, replays exactly those durations through the model,
   and asserts identical `visited` / `deferred` / `prefix` / `leastVisited`. Both
   cases carry a positive control (`expect(real.deferred).toBeGreaterThan(0)`) so
   the equality cannot pass vacuously by both sides sweeping everything.
3. **The baseline cell reproduces production.** Model at C=1, slice 3, 66 tenants
   → rotation **22 ticks**. Live `GET /admin/ops/checks?unhealthy=1`, same day:

   > `sweep_coverage` — "The ops sweep is not keeping up with the tenant count.
   > **66 tenant(s), and this tick's least-covered leg reached 3 of the 3 it was
   > handed = a full pass every 22 tick(s) (~110 min).**"

   The model was not tuned to this; it is the cell the matrix happened to contain.

**A test-env gotcha found on the way.** `@cloudflare/vitest-pool-workers` in this
repo swallows `console.log` from inside the worker completely — a probe test
logging a unique marker produced **0** occurrences in the run output. A harness
whose deliverable is a table therefore cannot emit it from a test. The assertions
stay in vitest; the tables come from `report.ts`, bundled with esbuild and run
under plain Node:

```
npx esbuild test/sweepcap-experiment/report.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/sweepcap-report.mjs && node /tmp/sweepcap-report.mjs
```

`report.ts` reads `COVERAGE_TICKS_ALERT_AFTER` out of `sweep-signals.ts` at
runtime and throws if it cannot find it, rather than restating the threshold — a
harness that hardcodes the number it grades against goes stale silently.

**What the model does NOT capture**, stated so the recommendation is not read as
more than it is: the six-connection ceiling (no OSS runtime enforces it — §2.4),
per-invocation CPU under concurrency (measured at 1-3% of wall serially; at C=6
that is ~6-18%, still far from binding, but it is inferred rather than measured),
and any queueing the Cloudflare edge does that is not documented.

---

## 4 · Results

`deadline 15000ms · 7 fan-out legs · 9 RPCs/tenant · p75 450ms · 400 trials/cell`
"adv p05" is the 5th-percentile achieved advance — a BAD tick, which is the number
the rotation actually lives on.

### Table 1 — concurrency x slice

```
  C | slice | wall p50 | wall p95 | slice completed | adv p50 | adv p05 | rot@66 | @150 | @300 | DO RPCs p95
----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------
  1 |     3 |    10987 |    13363 |           99.8% |       3 |       3 |     22 |   50 |  100 |          27
  1 |     6 |    16266 |    17387 |              0% |       1 |       1 |     66 |  150 |  300 |          44
  1 |    12 |    17395 |    18935 |              0% |       1 |       1 |     66 |  150 |  300 |          47
  1 |    24 |    17809 |    19200 |              0% |       1 |       1 |     66 |  150 |  300 |          48
  1 |    48 |    18544 |    19990 |              0% |       1 |       1 |     66 |  150 |  300 |          51
----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------
  2 |     3 |     6858 |     8347 |            100% |       3 |       3 |     22 |   50 |  100 |          27
  2 |     6 |    12261 |    14337 |           99.8% |       6 |       6 |     11 |   25 |   50 |          54
  2 |    12 |    16547 |    17874 |              0% |       1 |       1 |     66 |  150 |  300 |          80
  2 |    24 |    17731 |    19272 |              0% |       1 |       1 |     66 |  150 |  300 |          85
  2 |    48 |    18072 |    19491 |              0% |       1 |       1 |     66 |  150 |  300 |          88
----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------
  4 |     3 |     5219 |     7164 |            100% |       3 |       3 |     22 |   50 |  100 |          27
  4 |     6 |     7941 |     9730 |            100% |       6 |       6 |     11 |   25 |   50 |          54
  4 |    12 |    13435 |    15317 |           96.5% |      12 |      12 |      6 |   13 |   25 |         108
  4 |    24 |    16921 |    18028 |              0% |       1 |       1 |     66 |  150 |  300 |         150
  4 |    48 |    17978 |    19460 |              0% |       1 |       1 |     66 |  150 |  300 |         160
----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------
  6 |     3 |     5115 |     6812 |            100% |       3 |       3 |     22 |   50 |  100 |          27
  6 |     6 |     6444 |     8158 |            100% |       6 |       6 |     11 |   25 |   50 |          54
  6 |    12 |    10366 |    12354 |            100% |      12 |      12 |      6 |   13 |   25 |         108
  6 |    24 |    15891 |    16837 |            1.5% |       1 |       1 |     66 |  150 |  300 |         206
  6 |    48 |    17373 |    18518 |              0% |       1 |       1 |     66 |  150 |  300 |         227
----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------
  8 |     3 |     5207 |     6844 |            100% |       3 |       3 |     22 |   50 |  100 |          27
  8 |     6 |     6552 |     8290 |            100% |       6 |       6 |     11 |   25 |   50 |          54
  8 |    12 |     9217 |    10897 |            100% |      12 |      12 |      6 |   13 |   25 |         108
  8 |    24 |    14721 |    15940 |             85% |      24 |      10 |      7 |   15 |   30 |         216
  8 |    48 |    17294 |    18510 |              0% |       1 |       1 |     66 |  150 |  300 |         291
----+-------+----------+----------+-----------------+---------+---------+--------+------+------+------------
 12 |     3 |     5069 |     6722 |            100% |       3 |       3 |     22 |   50 |  100 |          27
 12 |     6 |     6469 |     8332 |            100% |       6 |       6 |     11 |   25 |   50 |          54
 12 |    12 |     7960 |     9652 |            100% |      12 |      12 |      6 |   13 |   25 |         108
 12 |    24 |    11930 |    13280 |            100% |      24 |      24 |      3 |    7 |   13 |         216
 12 |    48 |    16242 |    17052 |              0% |       1 |       1 |     66 |  150 |  300 |         385
```

**Read the cliff, not the averages.** Every `0%` row collapses to an achieved
advance of **1**, not to something proportionally smaller. That is the shipped
"index 0 is always attempted" rule interacting with `leastVisited` being a
MINIMUM: once the deadline binds before the trailing legs start, they each sweep
exactly one tenant and the rotation moves one tenant per tick — the identical
pathology the 2026-08-20 calibration diagnosed, reachable again from the other
direction by over-sizing the slice. **An over-sized slice is far worse than an
under-sized one**, so the build must size conservatively and let the coverage
check ask for more, never the reverse.

### Table 2 — max sustainable slice per concurrency (≥95% of ticks cover the whole slice)

```
subrequest ceiling on the slice: 37 at the repo's assumed budget 1000; 528 at the DOCUMENTED Workers-Paid 10,000
  C | max slice (wall clock) | binding ceiling | effective | rot@66 | @150 | @300 | healthy@66 | @150 | @300
----+------------------------+-----------------+-----------+--------+------+------+------------+------+------
  1 |                      3 |      wall clock |         3 |     22 |   50 |  100 |      false | false | false
  2 |                      6 |      wall clock |         6 |     11 |   25 |   50 |       true | false | false
  3 |                      9 |      wall clock |         9 |      8 |   17 |   34 |       true | false | false
  4 |                     12 |      wall clock |        12 |      6 |   13 |   25 |       true | false | false
  6 |                     17 |      wall clock |        17 |      4 |    9 |   18 |       true | true | false
  8 |                     22 |      wall clock |        22 |      3 |    7 |   14 |       true | true | false
 12 |                     32 |      wall clock |        32 |      3 |    5 |   10 |       true | true | true
```

The wall clock stays the binding ceiling throughout. Subrequests never bind, at
either the assumed 1,000 or the documented 10,000.

### Table 3 — with the `opsSummary` dedupe (3 identical-tenant RPCs → 1)

```
fan-out rpcs/tenant 9 -> 7 and tick rpcs/tenant 11 -> 9.
  C | max slice (wall clock) | effective | rot@66 | @150 | @300 | healthy@66 | @150 | @300
----+------------------------+-----------+--------+------+------+------------+------+------
  1 |                      4 |         4 |     17 |   38 |   75 |      false | false | false
  2 |                      8 |         8 |      9 |   19 |   38 |       true | false | false
  4 |                     16 |        16 |      5 |   10 |   19 |       true | true | false
  6 |                     23 |        23 |      3 |    7 |   14 |       true | true | false
  8 |                     29 |        29 |      3 |    6 |   11 |       true | true | true
```

**The dedupe alone does not fix it** (C=1 goes 3 → 4, rotation 22 → 17 ticks, still
unhealthy). It is a ~35% multiplier on top of concurrency, and it is what carries
300 tenants at C=8. Its own hazard is in §8.

### Table 4 — if the six-connection ceiling DOES bind DO RPCs

```
  requested C=8:  slice 22 if unbound, 18 if the ceiling clamps to 6 (rot@66 4 ticks — still healthy)
  requested C=12: slice 32 if unbound, 18 if the ceiling clamps to 6 (rot@66 4 ticks — still healthy)
```

The unresolved question in §2.1 costs at most the difference between slice 32 and
slice 18, and @66 both are healthy. It is not a blocker for shipping at C=6; it is
the reason not to ship at C=12 without a live measurement.

### Table 5 — sensitivity to a latency regression

```
  latency x | C=1 slice | C=6 slice | rot@66 C=1 | rot@66 C=6 | C=6 healthy@66
------------+-----------+-----------+------------+------------+---------------
         1x |         3 |        17 |         22 |          4 |           true
       1.5x |         2 |         9 |         33 |          8 |           true
         2x |         1 |         6 |         66 |         11 |           true
         3x |         1 |         1 |         66 |         66 |          false
```

Today's serial fan-out is already past its own cliff: a 1.5x latency regression
takes it to slice 2, and 2x to slice 1. **C=6 absorbs a 2x regression and stays
healthy at 66 tenants** (11 ticks against a threshold of 12 — thin, and worth
saying out loud). At 3x both collapse; nothing in this remedy is a substitute for
the read-model at a large enough scale or a bad enough latency regime.

---

## 5 · The correctness constraint concurrency introduces

`tenant-slice.ts:208`:

```ts
const next = covered === 0 || complete ? null : (slice.ids[covered - 1] ?? null);
```

`commitSweepCursor` indexes the slice by the covered COUNT. That is only sound if
the covered set is a contiguous prefix — free sequentially, a live constraint
concurrently. The two obvious deadline disciplines differ on exactly it:

- **`claim`** — the deadline stops handing out NEW tenants; whatever is already in
  flight is awaited. Because workers claim indices in order and every claimed
  index completes, the covered set is always `{0..k-1}`. The harness asserts this
  as a property over 300 randomized ticks (slice 1-40, C 1-12): for every leg,
  `prefix === visited`.
- **`abandon`** — each tenant races the deadline and unfinished work is dropped.
  Tighter wall clock, and it leaves a hole. The harness demonstrates it rather than
  arguing it: one slow tenant at index 0 (900ms) behind five fast ones (20ms), C=3,
  deadline 300ms →

  ```
  visited > 0, prefix === 0, skipped = ["ten_00_slow"]
  ```

  A cursor advanced by the COUNT lands past a tenant that was never swept, and
  because the next tick reads `WHERE id > ?`, that tenant is skipped for the whole
  rotation — silently, and specifically the SLOW tenant, i.e. the one most likely
  to be the sick one the sweep exists to notice.

**Ruling for the build: `claim` discipline, and the primitive returns the PREFIX
as a distinct field from the count.** Do not let `visited` reach
`commitSweepCursor` under concurrency. This is the same shape as
`cursor-restart-on-full-page-pins-the-rotation` and the 2026-08-20 achieved-vs-
intended defect: a predicate reading one quantity as if it carried another.

---

## 6 · Recommendation

**Build bounded-concurrency fan-out at C=6. Do not build the read-model for this.**

**Why 6 and not 8 or 12.** 6 is the documented ceiling, so the design never
depends on the unresolved question of §2.1; the slice it sustains (16 derived / 17
measured) clears the threshold at 66 tenants by 2.4x and at 150 by 1.2x; and it
absorbs a 2x latency regression at the current count. C=8 and C=12 buy real
headroom (Table 2) but only under an assumption the docs do not support, and their
failure mode — clamped to 6, slice sized for 8, every tick clipping — degrades the
published coverage figure back toward the number this whole lane exists to fix.
Make C a constant with an env override so raising it later is a config change
gated on a live measurement, not a rebuild.

**Size the slice from a MEASURED efficiency, not from `deadline x C`.** The naive
formula overstates every cell by 25-30%. Proposed derivation, with each value
checked against Table 2:

```
effectiveConcurrency(C) = 1 + (C - 1) * SWEEP_CONCURRENCY_EFFICIENCY   // 0.70
slice_wall = max(1, floor(SWEEP_FANOUT_DEADLINE_MS * effectiveConcurrency(C)
                          / (ASSUMED_DO_RPC_MS * SWEEP_FANOUT_RPCS_PER_TENANT)))
```

### Table 6 — the proposed rule vs the measured maxima

Machine-generated by `report.ts`, and ASSERTED by `sweepcap.test.ts` (`derived <=
measured` at every C, plus `derived(1) === SWEEP_TENANT_SLICE`) — this table is
not hand-arithmetic.

```
slice = floor(deadline x (1 + (C-1) x 0.7) / (p75 x rpcsPerTenant))
  C | derived | measured max | conservative? | rot@66 | @150 | @300 || deduped derived | rot@66 | @150 | @300
----+---------+--------------+---------------+--------+------+------++-----------------+--------+------+------
  1 |       3 |            3 |          true |     22 |   50 |  100 ||               4 |     17 |   38 |   75
  2 |       6 |            6 |          true |     11 |   25 |   50 ||               8 |      9 |   19 |   38
  3 |       8 |            9 |          true |      9 |   19 |   38 ||              11 |      6 |   14 |   28
  4 |      11 |           12 |          true |      6 |   14 |   28 ||              14 |      5 |   11 |   22
  6 |      16 |           17 |          true |      5 |   10 |   19 ||              21 |      4 |    8 |   15
  8 |      21 |           22 |          true |      4 |    8 |   15 ||              28 |      3 |    6 |   11
 12 |      32 |           32 |          true |      3 |    5 |   10 ||              41 |      2 |    4 |    8
```

Conservative or exact at every measured point, and **it degenerates to the shipped
value at C=1** — so the change is provably a no-op with concurrency disabled,
which is the cleanest possible revert-proof and the safest arming story.

**The guard is capable of failing, proven rather than asserted.** Setting
`SWEEP_CONCURRENCY_EFFICIENCY = 1.0` (i.e. the naive `deadline x C` formula this
section exists to reject) reds the suite immediately, at the first concurrency
where the naive rule overshoots:

```
AssertionError: C=2: derived 7 must not exceed measured max 6: expected 7 to be less than or equal to 6
 Test Files  1 failed (1)      Tests  1 failed | 8 passed (9)
```

**Bundle the `opsSummary` dedupe** (§8) — a further ~35%, and the thing that
carries 300 tenants. ~~**Do not bundle a `SWEEP_SUBREQUEST_BUDGET` change into the
same commit**: it is a one-line correction of a now-verified constant with its own
citation, it does not bind anything at these slices, and folding it in makes the
concurrency diff harder to revert alone.~~

> ⚠️ **THAT ADVICE WAS WRONG AND THE BUILD CORRECTLY IGNORED IT** (gate NB-4).
> The budget correction is not separable and does not merely "not bind": taking
> the send pipeline off the slice moved `SWEEP_FIXED_SUBREQUESTS` 185 → 517 and
> `SWEEP_TICK_SUBREQUESTS` to 650, which EXCEEDS the old `1000 x 0.6 = 600`
> working ceiling. The two changes had to ship together, and they did
> (`b28e3d3`). The operational consequence is recorded in `admin/README.md`:
> `SWEEP_FANOUT_CONCURRENCY=1` restores the serial loop but not the pre-lane
> subrequest posture, so a true revert is a code revert.

**What would change this recommendation:** a live measurement showing DO RPCs
counted against the six-connection ceiling AND queueing behaving worse than
documented; or the tenant count passing ~300, where even C=8 + dedupe is at 11 of
12 ticks and the read-model becomes the honest answer. Both are observable — the
first from a `wrangler tail` of a concurrent tick, the second from the existing
check.

---

## 7 · The live datapoint, and what it is not

Read-only, ≤8 parallel, 3 rounds, against prod `api.coldrig.dev`
(`GET /admin/tenants/:id/provisioning-state?limit=1` — a 404-guarded D1 read plus
**one** `getProvisioningStateForOperator` DO RPC, a pure SELECT).

```
serial baseline (5x):   total 0.296 0.386 0.404 0.504 0.722 s   (connect ~0.04 s)

8 parallel, round 1:    0.376 0.395 0.475 0.538 0.562 0.562 1.063 1.067
8 parallel, round 2:    0.285 0.292 0.295 0.296 0.301 0.311 0.313 0.313
8 parallel, round 3:    0.319 0.343 0.345 0.348 0.350 0.351 0.370 0.456

8 parallel, D1-only control (/admin/ops/checks): 0.328 ... 0.623
```

**What it shows.** Warm (rounds 2-3), eight parallel round trips each complete in
~0.29-0.46s — indistinguishable from the serial baseline's 0.30-0.72s. Eight
requests took ~0.46s wall instead of ~8 x 0.45s ≈ 3.6s. The premise holds
end-to-end against production: the cost is dispatch and network, not work, exactly
as `cpuTime` at 1-3% of `wallTime` predicted.

**What it is not.** These are eight separate Worker INVOCATIONS in parallel, not
eight concurrent subrequests inside ONE invocation — **it does not exercise the
six-connection ceiling at all**, which is the ceiling the question is about. It is
also weaker than intended in one further respect: only ONE tenant id is reachable
through a read-only admin route on this deployment, so all eight requests hit the
SAME Durable Object, which is single-threaded. That it did not serialize visibly
is itself informative (the object's per-request work is far below one round trip),
but the production fan-out touches 66 DISTINCT objects and this probe cannot
stand in for that. Treat §7 as corroboration of the premise, not as a measurement
of the answer.

---

## 8 · Risks, and the bundled items

**R1 · `opsSummary` cannot be naively memoized — the three callers pass three
different windows.** `runDunningSweep` calls `opsSummary(nowMs)` (zero-width),
`buildOpsDigest` calls `opsSummary(nowMs - 24h)`, `runWatchtower` calls
`opsSummary(nowMs - FAILURE_SIGNAL_WINDOW_MS)` (1h). A memo on `tenantId` would
hand two of the three a window they did not ask for, and the fields are already
AGGREGATED at the DO (`actionsInWindow`, `failureSignalsInWindow`) so they cannot
be re-windowed by the caller. Silent, and in the reassuring direction: the
watchtower would grade a 24h failure count against a 1h threshold, or the digest
would report 1h of deliverability actions as a day's worth. **The dedupe must be a
single RPC that takes BOTH windows and returns both windowed field sets** — not a
cache in front of the existing one. Mitigating fact that makes the fold cheap:
dunning reads only window-independent fields (`billingState`,
`billingFailureCount`, `plan`, `brand`, `lastDeclineCode`), so it can consume any
window's result for free.

**R2 · Per-tenant callback ordering becomes non-deterministic.** Three fan-out
callbacks append to a shared array: `runDunningSweep` (`results.push`),
`buildOpsDigest` (`summaries.push`), `runWatchtower` (`results.push`). Every
downstream use found is an aggregation (sums, counts) and therefore
order-insensitive, and the `+=` accumulators in `runWarmupCancelSweepAllTenants`
and `runWatchtower` are safe (JS read-modify-write with no intervening await). The
exposure is list ORDER in the digest / dunning API responses and in any test that
happens to assert it. Sweep `toEqual` on collected-order arrays, not `rotationOffset`.

**R3 · Deadline interaction — an over-sized slice fails worse than an under-sized
one.** Table 1's `0%` rows collapse the achieved advance to 1, not to a
proportionally smaller number. The derivation in §6 is deliberately conservative
at every point for this reason, and the build should carry a test asserting the
derived slice never exceeds the harness's measured maximum.

**R4 · The dual-oracle guard from Wave B.1 will red, and should.**
`sweep-budget.test.ts` asserts three independent sources agree: `scheduled.ts`'s
leg bag, `LEG_SUBREQUEST_COSTS`, and the derived constants. The `opsSummary`
dedupe changes the per-leg `perTenant` column (dunning 2→1, digest 1→0 or a new
shared leg, watchtower 2→1) and `SWEEP_RPCS_PER_TENANT` 11→9. **Update the table
and the sum, never the assertion** — that guard exists because its predecessor was
a tautology (`A === A`) that a planted defect walked straight through.

**R5 · Peak concurrent subrequests rise ~6x, including D1.** The dunning callback
makes uncounted D1 calls (`hasDunningEventForCycle`, `insertDunningEventIfNew`)
that `LEG_SUBREQUEST_COSTS.dunning.perTenant = 2` does not model — pre-existing,
and only on `past_due` tenants, but concurrency multiplies the peak. Not a blocker
at the documented 10,000 ceiling; worth a line in the budget docstring.

**R6 · CPU under concurrency is inferred, not measured.** 1-3% of wall serially
implies ~6-18% at C=6 — comfortable, and consistent with §7 — but nothing here
measured a Worker doing six concurrent DO RPCs. First armed tick should be
`wrangler tail`ed for `cpuTime`.

**R7 · `sweep_coverage` will flip healthy, and that is the acceptance test.** It
is currently unhealthy TRUTHFULLY. The build is done when the live check reports
a rotation ≤ 12 ticks with `covered === handed` — not when the suite is green.

---

## 9 · Build brief for the next phase

**Authorised and BUILT** — see the header. Kept as written so the plan and the
outcome can be compared; the deltas are listed there.

### Files

| file | change |
|---|---|
| `apps/platform/src/admin/tenant-slice.ts` | add `sweepTenantsConcurrent` (claim discipline, returns `prefix` distinct from `visited`); `SweepFanout.leastVisited` fed the PREFIX; keep `sweepTenants` as the C=1 path or make it delegate |
| `apps/platform/src/admin/sweep-budget.ts` | `SWEEP_FANOUT_CONCURRENCY = 6`; `SWEEP_CONCURRENCY_EFFICIENCY = 0.70` with this doc as provenance; re-derive `SWEEP_TENANT_SLICE` per §6; update `LEG_SUBREQUEST_COSTS` + `SWEEP_RPCS_PER_TENANT` for the dedupe |
| `apps/platform/src/tenant-do.ts` | new dual-window ops-summary RPC (R1) |
| `apps/platform/src/admin/ops-sweep.ts`, `admin/watchtower.ts` | consume the shared summary; pass the concurrency to the loop |
| `apps/platform/src/env.ts` + `wrangler.toml` | `SWEEP_FANOUT_CONCURRENCY` override (bounded 1..12, default 6) |
| `apps/platform/src/admin/sweep-signals.ts`, `admin/README.md` | the remedy prose now says the opposite — see below |

### The concurrency primitive

Claim discipline, exactly as `concurrent-candidate.ts` (§5): workers pull the next
index; a worker that sees the deadline sets the shared cursor to the end so no
other worker claims; in-flight work is awaited; index 0 is always attempted, per
leg. Return `{ visited, deferred, errors, prefix }` and feed `prefix` — never
`visited` — into `fanout.leastVisited`.

### Config knob

`SWEEP_FANOUT_CONCURRENCY`, default 6, clamped to 1..12. At 1 the derivation
reproduces today's slice of 3 exactly, so the whole change is a verified no-op
when disabled.

### Tests (each must fail on the old code — prove by revert-fail-restore)

1. **Coverage improvement, by effect.** Seed N tenants, run one tick at C=1 and
   one at C=6, assert the C=6 tick's `leastVisited` is strictly greater AND that a
   full rotation completes in strictly fewer ticks. Drive the real scheduler and
   observe the cursor — do not reconstruct the arithmetic in the test.
2. **Prefix safety.** Port the §5 property test: over randomized slices and
   concurrencies, every leg's covered set is a contiguous prefix. Plus the
   abandon-mode counterexample kept as a NEGATIVE control so the constraint stays
   documented in executable form.
3. **The derived slice never exceeds what the deadline sustains.** Assert the §6
   derivation against the harness's measured maxima at each C.
4. **C=1 is a no-op.** `SWEEP_TENANT_SLICE` at concurrency 1 is still 3.
5. **Window integrity of the dedupe (R1).** Assert the digest gets 24h data and
   the watchtower gets 1h data from the SAME shared call — the test that a naive
   memo fails.
6. **Dual-oracle guard still holds** after the `LEG_SUBREQUEST_COSTS` edit (R4).
7. **Full platform suite**, not the touched slice. Changing a shared slice
   constant reds unrelated suites at their POSITIVE CONTROLS
   (`send-pipeline-driver`, `warmup-cancel` did exactly this at the last
   recalibration). Budget for it; the diagnosis will be test isolation, and the
   fix is to make those tests drive a full rotation, never to re-widen the bound.

### Bundled items from the ROADMAP order

- **`opsSummary` dedupe** — per R1, a dual-window RPC, not a cache.
- **Send-pipeline-off-slice** — the send pipeline already runs after the fan-out
  deadline on its own budget and is NOT in the 9 RPCs/tenant the slice is derived
  from, so this is independent of the concurrency change. Sequence it second.
- **Paying-tenant-first priority** — ORDERING within the slice, and it collides
  with the prefix constraint of §5: a keyset cursor advances by `id` order, so
  re-ordering the slice by plan breaks `slice.ids[covered - 1]`. It needs either a
  separate priority pass with its own cursor or a stable secondary ordering.
  **Flagged as a design question for the orchestrator, not a build item** — do not
  let it ride in on the concurrency commit.

### Prose that is now WRONG and must change in the same commit

`sweep-signals.ts:424-429` and `admin/README.md:~L202-211` both tell the operator
"raising the slice buys nothing" and "(1) BOUNDED-CONCURRENCY FAN-OUT ...
Unevaluated: nobody has measured this Worker against the simultaneous-connection
ceiling." Both statements become false the moment this ships. The alert body
should instead name the next remedy — the read-model — with the tenant count at
which it becomes due (~300 at C=8 + dedupe, per Table 3). A deleted mechanism that
leaves its prose behind is its own defect class.

### Bookkeeping

`ROADMAP.md:251` still carries `ASSUMED_DO_RPC_MS = 25` as UNVERIFIABLE with a
stale line reference; the `SWEEP_SUBREQUEST_BUDGET` docstring's "UNVERIFIED IN
PRODUCTION" paragraph is now answered by §2.2 and should cite it.
