# Adversarial gate — sweep calibration (measured DO latency + achieved-coverage grading)

**Target.** Worktree `.claude/worktrees/sweepcal`, branch `fix/sweep-calibration-2026-08-20`,
HEAD **`a046805`** on base `33c7916` (2 commits, 10 files, +456/−113). Ground re-derived inside the
worktree at the top of the round (`git rev-parse HEAD` → `a046805…`, `git status --porcelain` → 0
modified files) and again at the end — unchanged, so nothing in this review is graded against a
sibling lane's drift. Git was READ-ONLY throughout; every execution ran in two rsync sandboxes with
`node_modules` symlinked, both diffed byte-identical against the worktree before and after use.

---

## 1. VERDICT: **PASS (SHIP)** — 0 blocking, 7 non-blocking

The lane does what it says: the slice is now derived from a measured distribution instead of a
miniflare floor, and the published coverage figure is computed from the rotation's ACHIEVED advance
at every call site. I attacked the derivation chain, the coverage semantics, the guard, the
fixtures, and the design, and re-derived every number independently. Nothing I proved rises to
blocking.

Two things the orchestrator must carry into the deploy note, because the builder's report states
them incorrectly:

1. **The "send-cadence non-regression" claim is false as stated.** Simulated against the real
   no-refill wrap: **36 of 63 tenants get a WORSE expected due→send delay** (the platform-wide mean
   improves 12.02 → 10.00 ticks only because the pre-fix tail was catastrophic). The ship decision
   survives on corrected numbers; the claim does not. Details in finding 1.
2. **The pre-fix baseline in the report (a "26-tick out-of-window gap") is wrong** — the true
   pre-fix worst case was **62 ticks (~310 min)**, because `readTenantSlice` restarts rather than
   refills. The fix is better than the builder claims on the worst case and worse than claimed on
   the median.

---

## 2. Battery (re-run in sandbox, real exit codes)

| Suite | Result |
|---|---|
| `typecheck` (all 4 workspaces) | **exit 0**, zero `error TS` |
| `apps/platform` vitest | **233 files / 2274 passed / 1 skipped**, `EXIT=0`, 803s |
| `apps/engine` vitest | 18 files / **153 passed** / 4 skipped |
| `apps/dashboard` vitest | 31 files / **165 passed** |
| `packages/cli` (`node --test`, after `npm run build`) | **12/12 pass**, exit 0 |

**Delta reconciles to the diff:** 2268 → **2274** = +6, exactly the 3 new `sweep-budget.test.ts`
cases plus the 3 new `sweep-signals.test.ts` cases. No test was deleted; the two removed imports are
symbol renames, not dropped assertions.

⚠️ `packages/cli` uses `node --test`, NOT vitest — `npx vitest run` there reports
`4 failed / no tests` and means nothing. Run `npm test` after `npm run build`.

---

## 3. Numbers re-derived independently (all confirmed)

```
SWEEP_FANOUT_DEADLINE_MS  = 300000 − 150000 − 135000        = 15000     ✓ (= period exactly)
SWEEP_FANOUT_RPCS_PER_TENANT = 11 − 2                       = 9         ✓
wall-clock ceiling  floor(15000 / (450 × 9))                = 3         ✓ binds
subrequest ceiling  floor((1000×0.6 − 185) / 11)            = 37        ✓ slack by 12×
SWEEP_TENANT_SLICE  = min(37, 3)                            = 3         ✓
SWEEP_TICK_SUBREQUESTS = 11×3 + 185                         = 218       ✓ (was 592)
rotation @63  ceil(63/3) = 21 ticks                         = 105 min   ✓
rotation @500 ceil(500/3) = 167 ticks                       = 13.9 h    ✓
1-hour bound = 12 × 3 tenants                               = 36        ✓ (the retired "~590" is gone from src)
```

Invariant hierarchy holds (`15000 + 150000 + 135000 = 300000`, asserted by the suite). The
dual-oracle budget guard (`LEG_SUBREQUEST_COSTS` vs the scheduler's own leg bag vs the derived
constants) is untouched and green — the diff adds no leg and removes none. Dead-man headroom
improves: the tick's worst-case subrequest cost drops 592 → 218 against the same 1000 ceiling.

**Ruling on the statistic (p75).** Defensible, and for a better reason than the docstring gives.
The fan-out is a SUM of 27 sequential draws, so what matters is the sum's distribution, not any
per-draw quantile: expected cost is `27 × 414 = 11,178 ms` (74.5% of the deadline), and a clip needs
the 27-draw sample mean to reach 555 ms — a ~34% excursion, roughly 3σ at a plausible σ≈250 ms.
The brief's p90 check (`531×9×3 = 14,337`) is the wrong test — a per-draw quantile does not compose
across a sum, and treating it as if it does would reject slices that are in fact safe — but its
conclusion is right either way. The suite's own new guard uses the correct form (expected cost at
the MEAN ≤ 85% of the deadline). Residual: the samples are pooled over two ticks in one hour, so
diurnal/load correlation is unmeasured and the tail beyond p90 is unrecorded; a correlated slow
period lifts the whole distribution and the clip becomes likely — which the new check now REPORTS
rather than hides, which is the point.

---

## 4. Findings (most severe first — all NON-BLOCKING)

### 1 · NON-BLOCKING · lens 6 — the send-cadence "non-regression" is a REDISTRIBUTION; 36 of 63 tenants get slower, and the report's pre-fix baseline is wrong

**Scenario.** 63 tenants. Pre-fix the slice was 37 ids and the cursor advanced by `leastVisited = 1`,
so the send-pipeline window slid by one tenant per tick; `readTenantSlice` RESTARTS rather than
refills (`tenant-slice.ts:139-143`), so the head tenants were reached only on the wrap tick.

**Verification.** JS model with the verbatim `readTenantSlice` + `commitSweepCursor` arithmetic,
4000 ticks, measuring the wait from a uniformly-random due moment to the next send-pipeline visit:

| regime | max visit gap | mean wait | per-tenant mean wait (best / median / worst) |
|---|---|---|---|
| PRE-FIX slice 37, cursor +1 | **63 ticks** | 12.02 | 5.5 / 7.8 / **31.0** |
| POST-FIX slice 3, cursor +3 | 21 ticks | **10.00** | 10.0 / 10.0 / 10.0 |
| POST-FIX degraded, cursor +2 | 32 ticks | 15.02 | — |
| POST-FIX degraded, cursor +1 | 63 ticks | 29.09 | — |

**36/63 tenants worse, 27/63 better.** The fix EQUALISES (every tenant now waits exactly 10 ticks
≈ 50 min on average) — it removes a 155-min-average starvation tail and costs the median tenant
39 → 50 min. The report's "26-tick gap" describes a refilling window this code does not implement.
Also note the sensitivity the report omits: if latency degrades enough to clip the fan-out at 1
tenant, the new regime's mean wait (29.09 ticks) is **worse than the pre-fix regime's** (12.02) —
the improvement is conditional on the slice completing, which the p75 sizing buys and the new check
now measures.

**Why non-blocking:** the ship decision survives on the corrected numbers (platform mean improves,
worst case improves 3×). The CLAIM does not. `apps/platform/src/admin/sweep-budget.ts:296-317`,
`apps/platform/src/admin/ops-sweep.ts` (`runSendPipelineAllTenants`, driven by `scope.tenantIds`).

### 2 · NON-BLOCKING · lens 2/5 — the rewritten `runCron()` helper does not deliver the rotation guarantee its own docstring asserts, and its coverage is nondeterministic

**Scenario.** `runCron()` now drives `ceil(countTenants / SWEEP_TENANT_SLICE)` ticks and documents
"reaching every tenant across ceil(total/slice) ticks IS the bounded sweep's guarantee". That budget
is one tick short whenever the persisted cursor is off-phase — and it always is, because D1 state
ACCUMULATES across `it`s in a file (probed directly: `tenants_index=2`, `sweep_cursor='probe-a'` at
the start of the next test) while tenant ids are `crypto.randomUUID()`, so the sort order changes
every run.

**Verification (executed, on the real file).** Instrumented `runCron` in a sandbox copy to
reconstruct each tick's window from the REAL persisted cursor and diff it against the index:

```
run A: 27 calls, 5 left a tenant unswept   (total=5,6,11,12,14 → MISSED=1)
run B: 27 calls, 4 left a tenant unswept   (total=8,9,11,12)
run C: 27 calls, 1 left TWO tenants unswept (total=6 → MISSED=2)
run D: 27 calls, 0 misses
```

Exhaustive model over `total ∈ [1,120] × slice ∈ {1,2,3,5,37} ×` every starting phase:
**11,430 configurations miss a tenant at `ceil(total/slice)`; `+ 1` misses ZERO** (`+2` likewise).

**Self-refutation:** I ran the unmodified file **10 times: 10 green**, and in every observed miss the
NEWEST tenant (the one under assertion) was not the missed one. So the guarantee is provably absent,
but the harm — a red positive control (`proveSendCapableThenQueueAnother`'s "fixture must be
send-capable... or the zero below proves nothing") or a vacuous negative assertion — is a per-run
lottery at roughly 1-in-`total` odds per affected call and did not draw in 14 runs. That is why this
is not blocking. It is still the top item: the control this rewrite exists to protect is now
probabilistic, and the remedy is one character.
`apps/platform/test/send-pipeline-driver.test.ts:119-145`, `apps/platform/test/warmup-cancel.test.ts:272-283`.

### 3 · NON-BLOCKING · lens 2 — a SHORT-TAIL tick publishes a rotation figure up to 3× wrong and asserts a cause that is false

**Scenario.** When the tenant count is not a multiple of the slice, one tick per rotation sweeps a
short tail. `covered` is then small *because the tail is small*, not because anything clipped, and
`ceil(total/covered)` extrapolates from it.

**Verification (executed against the real `reportSweepSignals`).** `{total: 30, covered: 1}`:

> "30 tenant(s), and this tick's least-covered leg reached 1 of them = **a full pass every 30
> tick(s) (~150 min)**. The slice is sized at 3 tenant(s) per tick, so **the shared fan-out deadline
> is stopping the trailing legs partway through it**"

The truth on that tick is 10 ticks / 50 min, and no deadline was involved. Today 63 % 3 = 0 so no
tail exists; tenant #64 creates one every rotation. This cannot cause a false page — I proved the
two conditions are mutually exclusive (a tail tick only grades bad when `total > 12`, which forces a
rotation ≥ 5 ticks, which leaves ≥ 3 consecutive good ticks, which is exactly
`LEG_RECOVER_AFTER_SWEEPS`; executed: 4 rotations of [9 full + 1 tail] at 30 tenants → **no alert**).
It does mean 1 tick in ~22 overwrites `last_detail` with a 3×-pessimistic number, and whichever tick
the 24 h re-alert lands on decides what the founder reads. The fix is to compare against the tick's
own `slice.ids.length` rather than the `SWEEP_TENANT_SLICE` constant.
`apps/platform/src/admin/sweep-signals.ts:395-407`.

### 4 · NON-BLOCKING · lens 2 — `covered = 0` publishes HEALTHY: "a full pass every 0 tick(s) (~0 min)"

`coverageTicks` returns 0 when `slice <= 0` (`sweep-budget.ts:358-361`), so zero coverage grades as
`0 > 12 === false` → healthy. **Executed** — persisted row read straight out of `watchtower_state`:

```
status = healthy
detail = The ops sweep is reaching every tenant on schedule — 63 tenant(s), and this tick's
         least-covered leg reached 0 of them = a full pass every 0 tick(s) (~0 min). …
```

`scheduled.ts:195` guards `leastVisited !== null` but not `> 0`. Reachability is narrow: `sweepTenants`
always attempts its first tenant, so `visited = 0` needs an EMPTY id list while `slice !== null` —
i.e. a zero-tenant platform (harmless, but it also emits the false "the deadline is stopping the
trailing legs" clause), or a D1 race where `countTenants()` returns > 0 and the id read returns none.
Narrow, but it is the lane's own class (publishing a number the rotation did not achieve) at its
maximum, and the guard is `covered > 0` on the same line.

### 5 · NON-BLOCKING · lens 5 — the measurement oracle is only as strong as the record, and a casual re-measure restores the old slice silently

**Plant A (the defect the guard names):** `ASSUMED_DO_RPC_MS = MEASURED.p75Ms` → `25`. **RED**, 2 of 3
new guards, with the intended message (`expected 25 to be greater than or equal to 450`). The guard
is real.

**Plant B (falsify the record itself):** `MEASURED_DO_RPC_MS = {mean 22, p50 20, p75 25, p90 30,
samples: 1, capturedAt: "2026-08-21"}` → **20/20 GREEN**, slice silently back to 37. The provenance
test only checks a date FORMAT, `samples > 0`, and `p75 ≥ mean × 0.5`. Nothing pins the slice itself
or floors the sample count. Not a false claim in the docstring (it says the guards are *capable* of
failing, which is true), but the next re-calibration is the obvious attack surface: a `samples ≥ 20`
floor and an explicit slice pin would cost two lines.
`apps/platform/test/sweep-budget.test.ts:93-121`.

### 6 · NON-BLOCKING · lens 6 — the shipped remedy prose forecloses the cheaper fix the lane's OWN measurement points at

Both the alert body and `admin/README.md` now tell the operator: *"widening it does not buy coverage,
it just moves the deadline's cut further up the leg order"* and *"The read-model is DUE."* That is
true **only because the fan-out is sequential** — `sweepTenants` awaits one tenant at a time and the
legs run one after another. The same docstring records `cpuTime` at **1-3% of `wallTime`**, which is
the textbook signature of a dispatch-bound workload that parallelises. A bounded-concurrency fan-out
(subject to Workers' simultaneous-connection ceiling, which nobody in this repo has measured) would
raise the slice several-fold against the same 15 s deadline. I grepped the wave-B.1 gate and
`ARCHITECTURE.md`: **the option has never been considered or rejected on the record.** The code is
not wrong; the ADVICE is, and the advice commits the founder to the expensive path.
`apps/platform/src/admin/sweep-signals.ts:424-429`, `apps/platform/src/admin/README.md:180-188`.

### 7 · NON-BLOCKING · lens 1 — bookkeeping the lane owes (the constant moved; its prose dependents did not)

- `ROADMAP.md:251` still carries `ASSUMED_DO_RPC_MS = 25` as UNVERIFIABLE, citing `:264` — this lane
  is exactly the verification that item asked for; the line number is also stale (now `:319`).
- `ROADMAP.md:242` (NEW-4 ORDER) describes `DEFERRED_LEG_VISITS_ALERT_AFTER`, which this lane
  DELETES; the underlying order (per-tenant staleness signal) is now strictly wider — see ruling C.
- `apps/platform/src/engine/spend-ceiling.ts:567` and `test/spend-ceiling.test.ts:485` narrate
  "against a budgeted tick of **592** and a tail reserve of 408" — historically true (that was the
  slice-37 tick), present-tense misleading (it is now 218/782). Low severity precisely because both
  are past-tense citations of a gate finding.
- `ROADMAP.md` / `HANDOFF.md` are untouched by the 2 commits (CLAUDE.md update discipline) — a
  bookkeeper task at fold, not a code defect.

---

## 5. Rulings requested by the brief

**A · The statistic (p75).** Sound — see §3. The p90 arithmetic in the brief is the wrong test
(quantiles don't compose across a sum); the correct test is the sum's expectation, which the new
guard uses. Robust to the measured distribution; NOT robust to a correlated latency excursion, which
is now reported instead of hidden.

**B · Coverage semantics (one arm, `ceil(total/covered) > 12`, deferral counters demoted).**
Correct, and the reasoning survives attack. Verified by grep and execution: `coverageTicks` has
exactly two call sites (`sweep-signals.ts:395` grading/reporting on ACHIEVEMENT, `tenant-slice.ts:163`
producing the renamed `plannedCoverageTicks` INTENT), and all six slice legs pass `scope.fanout` so
`leastVisited` really does fold in the two legs that report no counters (`digest`, `watchtower`),
while the two own-population legs correctly strip the accumulator via `sweepDeadlineOf`. Rejecting a
per-leg-max arm is right — at slice 3 it is unreachable by construction. **End-to-end wiring proved,
not inferred:** 40 seeded tenants through the real `runScheduledOpsSweep` × 4 ticks →
`sweep_coverage` persists *"least-covered leg reached 3 of them = a full pass every 14 tick(s)
(~70 min)"* with the cursor at index 11 (= 4 × 3 − 1). The published number IS the achieved rotation.

**C · The disclosed `budgetExpiries` regression.** **Acceptable with the ledger entry, and the
disclosure is accurate** — I verified every leg of it. `signals.deferred` now feeds only the detail
string, and only inside the UNHEALTHY branch (`sweep-signals.ts:421`), so a wedged engine on a
healthy rotation surfaces nowhere but the console. `runSendPipelineAllTenants` does not use
`sweepTenants` at all, so `leastVisited` structurally cannot see budget expiries — the replacement
metric could not have kept the old arm. Keeping `deferred >= SWEEP_TENANT_SLICE` at slice 3 would
fire on three deferred leg-visits, which is the pinned-check defect one size smaller. The owed work
is the per-tenant staleness signal already on the ROADMAP; note it is now WIDER than ROADMAP:242
describes (that line still assumes the deferral arm exists).

**D · The test-fixture rewrites.** Legitimate in intent — driving a full rotation is the honest unit
once the slice is smaller than what a test file seeds, and the alternative (asserting which tick) was
never the property under test. But the implementation does not drive a full rotation from an
arbitrary phase (finding 2). Not weakening in the "delete the assertion" sense: no assertion was
removed, and the file's own non-vacuity follow-ups (`arm it and the very same row goes out`) convert
most misses into a loud red rather than silent rot.

---

## 6. Attacks that FAILED (this is what makes the PASS mean something)

- **Guard-is-a-tautology (the wave-B.1 round-2 class).** Planted the exact defect the new guard
  names (`ASSUMED_DO_RPC_MS = 25`): **RED**. Not a tautology — the oracle is a separate recorded
  distribution.
- **Renamed field with a stale reader.** `coverageTicks:` → `plannedCoverageTicks:`; grepped both
  names across `apps/`, `packages/`, `docs/`, `*.md`. Every consumer moved (2 in src, 3 in tests);
  the only surviving hits are in FROZEN adversarial records, which is correct. Typecheck exit 0.
- **A leg that iterates the slice but hides from `leastVisited`.** Opened all 9 `sweepTenants` call
  sites: 6 slice legs pass `scope.fanout`, the 2 own-population legs (`screening-recovery`,
  `reapStaleReservations`) pass `sweepDeadlineOf(...)`, which strips the accumulator by construction.
  The comment's claim ("folds EVERY slice leg's count in, including the two that cannot describe
  themselves") is exactly true.
- **A filtered id list making `visited = 0` reachable.** Every slice leg calls
  `resolveSweepTenants(env, scope)` → `[...scope.tenantIds]` and filters INSIDE `fn`, and
  `sweepTenants` always attempts its first tenant. `covered = 0` is therefore unreachable for a
  non-empty slice (finding 4 is the empty-slice residual only).
- **A permanently-unhealthy check suppressing a sibling.** `policyFor` gives `sweep_coverage`
  `IMMEDIATE_ALERT_POLICY`; `decideAlert`'s in-episode suppression is per check name, and the second
  arm that N6 said it was suppressing no longer exists. Nothing else is muted.
- **A short-tail tick paging falsely.** Proved impossible (finding 3) and executed the control:
  4 rotations of [9 full + 1 tail] at 30 tenants → zero emails.
- **The new `SweepCoverage` shape being inert (the envelope class).** Traced the value from
  `sweepTenants`'s accumulator through `scheduled.ts:195` into the published string, then executed it
  end-to-end against a 40-tenant index — the number in `watchtower_state.last_detail` is the achieved
  one.
- **A second `runCron()` in one test starting off-phase.** Modelled: a call that follows a COMPLETE
  rotation is phase-aligned and covers. Only a mid-rotation phase (i.e. an index that grew) breaks
  it — which is finding 2, not a separate defect.
- **`ceil(total/slice)` mis-modelling the wrap.** Verified the short-tail/restart path wastes no tick
  and skips no tenant when the phase is aligned (0 misses from a null cursor across totals 1-80).
- **Deploy/arm-time plumbing.** No migration, no env var, no flag, no new package, no Dockerfile/
  wrangler surface in the diff. Nothing to arm; nothing can land dark.
- **Budget-guard regression from the constant move.** `LEG_SUBREQUEST_COSTS` and the three-way
  agreement (scheduler bag / table / derived constants) are byte-unchanged and green at slice 3;
  the subrequest ceiling is now slack by 12×, so the S1 derivation is dormant rather than violated.

---

## 7. UNVERIFIABLE (never folded into the verdict)

1. **The production measurement itself** — `MEASURED_DO_RPC_MS` {mean 414, p50 350, p75 450, p90 531,
   n=77} from `wrangler tail` against worker `133fc911`. A gate cannot re-run prod tail; I audited
   the derivation chain instead (§3) and it is internally consistent, including the corroboration
   that the cursor advanced by exactly one tenant on all three ticks. *Resolution: a second capture
   at a different hour would also settle the diurnal-correlation residual.*
2. **The 1-3% `cpuTime`/`wallTime` claim** — same source, same limitation. It is load-bearing for
   both "the cost will not optimise away" and (against the lane's own advice) finding 6.
3. **The pre-deploy alert state in prod.** The lane reports `sweep_coverage` is already pinned
   unhealthy by the old deferral arm (109 ≥ 37). If so the deploy does NOT open a new episode, it
   corrects the detail of a running one, and the founder sees the corrected number at the next 24 h
   re-alert rather than immediately. *Resolution: read `watchtower_state` for `sweep_coverage` in
   prod before deploying.*
4. **Workers' simultaneous-connection ceiling for DO RPC**, which bounds the concurrency option in
   finding 6. Not measured anywhere in this repo.

---

## 8. Deploy requirements

1. **Tell the ops watch what `sweep_coverage` will do.** At 63 tenants it grades UNHEALTHY by
   design: `ceil(63/3) = 21 > 12`. Executed, verbatim: *"63 tenant(s), and this tick's least-covered
   leg reached 3 of them = a full pass every 21 tick(s) (~105 min)."* Policy is `IMMEDIATE`
   (`confirmAfterObservations: 1`) behind 3 damped ticks, so the first email lands ~15-20 min after
   deploy if the episode is not already open, then `firstRealert` at 6 h and **every 24 h until the
   read-model ships**. This is deliberate and correct; it must not be "fixed" by raising
   `COVERAGE_TICKS_ALERT_AFTER`.
2. **Correct the send-cadence line in the ship note** (finding 1): every tenant now waits ~50 min on
   average between send-pipeline visits, uniformly; 36 of 63 get slower, 27 faster, and the worst
   case improves from ~155 min to 50 min. Do not ship on "no cadence regression".
3. **Before the read-model is scoped, rule explicitly on bounded-concurrency fan-out** (finding 6) —
   the alert is currently telling the founder to build the expensive thing.
4. Bookkeeping at fold (finding 7): `ROADMAP.md:251` (this lane resolves it), `ROADMAP.md:242` (the
   owed staleness signal is now wider), `ROADMAP.md`/`HANDOFF.md` session update.
5. Recommended one-character hardening before merge, not gating: `+ 1` on the two `runCron` budgets
   (finding 2). Verified to close every configuration.

---

*Gate run 2026-08-20 against `a046805`. Battery, plants and probes executed in
`scratchpad/sbA` and `scratchpad/sbB`; both restored byte-identical to the worktree afterwards, and
the worktree's git state was never mutated.*
