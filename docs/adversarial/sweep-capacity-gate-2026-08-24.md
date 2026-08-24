# Adversary gate — sweep-capacity lane

Ref: worktree `/Users/yaakovscher/dev/coldstart-wt-sweepcap`, branch
`feat/sweep-capacity-2026-08-24`, **HEAD `d8bac9cb90fbc56ed785df1d9c3175ea16024f63`**
(`git status` clean at review time; re-verified clean after the run).
Base `fbd4168`; ⚠️ `main` has since moved to `89caa67` (two docs/README commits —
`8d58f1e`, `89caa67` — no code overlap, but the lane is 2 commits behind main).
Date 2026-08-24. Reviewer: fresh-context adversary.

## VERDICT: **SHIP-AFTER-FIX** — 0 BLOCKING, 8 NON-BLOCKING, 1 fold blocker (cross-lane)

Nothing found that should stop the deploy of THIS lane. One item (**NB-1**) is a
regression in the founder's only per-tenant DO-health alert and should be fixed
before merge or booked as an `## Open` [ORDER]; one (**X-1**) MUST be resolved at
the Inc4 fold, not after it.

Everything in the brief's checklist was attacked. The derivation, the vendor
limits and the guard-failure proofs all held under re-derivation and planted
defects. Findings are concentrated where the lane's *own* guards look at the
classifier instead of the producer, and in prose that outlived its mechanism.

---

## 1 · Ground truth re-derived (not taken from the report)

`npx esbuild src/admin/sweep-budget.ts --bundle | node` — every shipped number
reproduced exactly:

```
SWEEP_FANOUT_DEADLINE_MS       15000     = 300000 - 150000 - 135000
SEND_PIPELINE_TENANT_CAP       166       = floor(150000 / (450*2))
SEND_PIPELINE_SUBREQUESTS      332
SWEEP_FIXED_SUBREQUESTS        517       = 60 + 50 + 75 + 332
SWEEP_RPCS_PER_TENANT          7
ceilings at C=6 (effective 4.5): subrequest 783 | p75 21 | mean 19  -> SLICE 19 ✓
SWEEP_TICK_SUBREQUESTS         650       = 7*19 + 517 ✓
slices by C: 1→4  2→7  3→10  4→13  6→19  8→25  12→38
coverage @19: n=66→4  n=150→8  n=228→12  n=229→13  n=300→16
```

**Cloudflare limits fetched live** (`developers.cloudflare.com/workers/platform/limits/`,
"Last updated Jul 28, 2026"). Every §2 claim verbatim-confirmed:
Subrequests/invocation Free 50 / **Paid 10,000 (up to 10M)**; internal services
Free **1,000** / Paid "Matches configured limit (default 10,000)" — so 1,000 *is*
the Free row, exactly as the lane says; Simultaneous outgoing connections 6/6;
the enumerated list (fetch, KV, Cache, R2, Queues, TCP `connect`, outbound
WebSocket) **omits DO stubs and D1**; and *"If a seventh connection is attempted
while six are already waiting for headers, **it is queued** until one of the
existing connections receives its response headers."* The safety story holds.

## 2 · Guards graded by PLANTED DEFECTS (sandbox copy, live worktree untouched)

Sandbox at `…/scratchpad/sb` (rsync of the worktree, `node_modules` symlinked);
`src/` diffed byte-identical to the worktree afterwards; live worktree `git status`
clean at `d8bac9c`.

| # | plant | result |
|---|---|---|
| 1 | `SWEEP_CONCURRENCY_EFFICIENCY = 1.0` (the naive rule) | **RED** — `C=3: shipped slice 13 must not exceed the simulated max 12`, 3 failures. The simulation oracle is genuinely independent (imports no efficiency constant from `sweep-budget.ts`) and grades the real exported `sweepTenantSliceFor`. |
| 2 | `SWEEP_MEAN_COMPLETION_FRACTION = 1.0` (deletes the ceiling this lane added) | **RED** — `sweep-budget.test.ts` "the completion ceiling is what BINDS the slice": `expected 23 to be less than or equal to 21`. The constant is load-bearing, not decorative. (The sweepcap oracle alone would NOT have caught this — the belt-and-braces pairing is what works.) |
| 3 | `prefix := visited` in `sweepConcurrently` | **GREEN, 22/22 — and correctly so.** SELF-REFUTED, not a finding: under `claim` discipline every claimed index completes in ascending order, so the two expressions are provably equal. See NB-7 for what this *does* mean. |
| 4 | drop `- priorityCount` from the rotation accumulator | **RED** — `tenant-slice-priority.test.ts`, 2 failures. |
| 5 | `mustAttempt` reverted to `index === 0` | **RED** — the priority block eats the whole must-attempt budget, `swept` = `["y1"]` not `["y1","y2","z1"]`. |
| 6 | new per-tenant leg in `scheduled.ts`, unpriced in `LEG_SUBREQUEST_COSTS` (B1's exact class) | **RED**, 3 failures. NB: the *retired* headcount guard (`SWEEP_RPCS_PER_TENANT >= scoped.length + 1`) would have passed this — the replacement is strictly stronger. |
| 7 | `windows` metadata reports 1h while the query uses 24h | **RED** — `ops-summary-dedupe.test.ts` asserts the DATA, not just the metadata. |

## 3 · Suites executed at HEAD (real worktree)

- `typecheck` — exit 0.
- lane-touched, 8 files: **100 passed**.
- regression ring (`scheduled`, 4× `send-pipeline-*`, `warmup-cancel`,
  `watchtower-key-reachability`, `watchtower-policy`): **108 passed**.
- `sweepcap-experiment`: **9 passed**.

---

## Findings

### NB-1 · The wedged-DO alert's diagnostic payload is destroyed on the cron path — **PROVEN BY EXECUTION**
`src/admin/watchtower.ts:281-282`, `src/admin/ops-sweep.ts:60-61`

`runWatchtower` has exactly **one** production caller (`scheduled.ts:125`) and it
always passes `scopeWithSummaries`. On that path the real `opsSummary` throw is
consumed by `runOpsSummaryPrefetch`'s `onError` (a bare `console.error`), and the
watchtower fabricates `new Error("watchtower: the shared ops-summary prefetch did
not supply tenant …")`. Pre-lane the catch received the REAL error.

Drove the real `runWatchtower` with a present-but-empty summaries map and read the
banked `watchtower_state` row:

```
status:      "unhealthy"          <- detection INTACT
last_detail: "Tenant ten_3626c746…'s Durable Object threw instead of answering
              opsSummary: watchtower: the shared ops-summary prefetch did not
              supply tenant ten_3626c746…. While it stays this way …"
```

The founder's alert body now carries a **tautology** where the real failure
message used to be ("no such table: scheduled_sends", "Durable Object is
overloaded", …). That message now exists only in a `wrangler tail` log line.

Second half: `tenantDoWedgedKey` reads `err.name`. A synthetic `new Error` is
always `"Error"` → always `rpc_unreachable`. `constructor_throw` /
`storage_throw` / `other` become **unreachable from the cron producer** (they
survive only in the sub-case where the whole prefetch leg threw and `sweptSummary`
fell back to a direct fetch). Materiality drives re-alert, so a tenant whose
failure mode changes no longer re-alerts.

**And the guard built to catch exactly this is blind to it.**
`test/watchtower-key-reachability.test.ts:82-89` probes `tenant_do_wedged:` at the
FUNCTION level — `tenantDoWedgedKey(new TypeError(...))` — never through the
producer. Its own file header says: *"A guard for 'the producer feeds its
classifier the wrong thing' must observe the PRODUCER."* Its `note` ("from the
throw shapes the opsSummary RPC actually produces") is now false.

**Fix.** `runOpsSummaryPrefetch` returns `failures: ReadonlyMap<string, unknown>`
beside `summaries`; `SweepScope` carries it; `sweptSummary` rethrows the ORIGINAL
error for a tenant in that map. Then move `tenant_do_wedged:` into the END-TO-END
`describe` of `watchtower-key-reachability.test.ts`, driving a real sweep against
DOs that throw each of the three shapes.

### NB-2 · "Read-model due at ~300 tenants" is wrong at the shipped config — it is 229
`src/admin/README.md:~L215-216`, `src/admin/sweep-signals.ts:~L509-511`

Both the operator README and the `sweep_coverage` alert body tell the founder the
read-model is *"Due at roughly 300 tenants."* At the shipped slice of 19 and
`COVERAGE_TICKS_ALERT_AFTER = 12`, the alert fires at **229** tenants
(`coverageTicks(228,19)=12`, `coverageTicks(229,19)=13` — executed above). 300 is
Table 3's **C=8** row. The lane's own test asserts
`coverageTicks(300, sweepTenantSliceFor(6)) > COVERAGE_TICKS_ALERT_AFTER`
(`sweepcap.test.ts:353`) — the code knows; the prose does not. An operator at 250
tenants reads "not due yet" while the alert is already firing. This is the same
defect class commit `f6dee19` exists to close, one line below the lines it fixed.
**Fix:** say "roughly 230 tenants at the shipped concurrency of 6 (~300 at C=8)",
or derive it: `SWEEP_TENANT_SLICE * COVERAGE_TICKS_ALERT_AFTER`.

### NB-3 · `ROADMAP.md:138` still records `SWEEP_SUBREQUEST_BUDGET = 1000` as a live UNVERIFIABLE
`ROADMAP.md:138`

*"`SWEEP_SUBREQUEST_BUDGET = 1000` (`:70`) unchanged."* — false as of this lane
(10,000 at `sweep-budget.ts:87`, verified against the vendor page above). The
lane's own research doc §9 "Bookkeeping" named this item; it was not done. The
value AND the line reference are both stale. `HANDOFF.md:34/49/81` still describe
the sweep-capacity lane as "queued / not yet dispatched".

### NB-4 · The budget correction is load-bearing, contradicting the doc's own "do not bundle it" rationale
`docs/research/sweep-capacity-measurement-2026-08-24.md` §6; `sweep-budget.ts:87`

§6 says the budget change *"does not bind anything at these slices"* and
*"Do not bundle a `SWEEP_SUBREQUEST_BUDGET` change into the same commit."* It was
bundled (`b28e3d3`) — **correctly, because it had to be**: moving the send
pipeline off the slice took `SWEEP_FIXED_SUBREQUESTS` 185 → 517 and
`SWEEP_TICK_SUBREQUESTS` to 650, which exceeds the OLD `1000 × 0.6 = 600`. So the
two changes are not separable and the stated rationale is now false. Operational
consequence: the documented rollback (`SWEEP_FANOUT_CONCURRENCY=1`) restores the
serial loop but **not** the pre-lane subrequest posture — a true revert needs the
code revert. Worth one line in the arming record so nobody reaches for the env
lever expecting a full rollback.

### NB-5 · The new send-pipeline count cap has no behavioural test and mislabels its signal
`src/admin/ops-sweep.ts:512-518`

`if (i >= SEND_PIPELINE_TENANT_CAP) break;` is a brand-new break in a hot-path
send loop. Grep shows the only coverage is arithmetic on the constant
(`sweep-budget.test.ts:276-281`); nothing drives >166 tenants through the loop.
Separately it reuses `summary.skippedForLegDeadline` for a *different* cause, so
`cron_legs` reports a count-cap break as a leg-deadline skip — the same
"capacity and error must not share a counter" principle this module's own
comments invoke, one level down (two capacity causes sharing one counter). Only
binds at >166 tenants (2.5× current scale). **Fix:** a `skippedForTenantCap`
field + one test seeding `SEND_PIPELINE_TENANT_CAP + 2` tenants.

### NB-6 · The `mustAttempt` overrun scales with the paying population — and the S6 invariant has zero margin
`src/admin/tenant-slice.ts:479-481`; `sweep-budget.ts:443`

`SWEEP_FANOUT_DEADLINE_MS` is derived as *exactly* what the 300s period has left
after the send pipeline's 150s + 135s. That leaves zero slack for the
must-attempt overrun, which is pre-existing (each of ~7 legs always attempts index
0 past the deadline: ~7 × 450ms ≈ 3.2s, worst-tail ~10.9s → 303-311s vs a 300s
period). This lane widens the must-attempt set from 1 to `priorityCount + 1`.
**At C=6 that is free** — the extra tenants run concurrently, one round trip. **At
C=1 (the rollback lever) they are serial**: with 5 paying tenants, 6 × 450ms × 7
legs ≈ **18.9s** of overrun, i.e. 15 + 18.9 + 285 ≈ **319s against a 300s period**
— overlapping sweeps, the exact condition S6 exists to prevent. Not reachable
today (~1 paying tenant → ~6.3s), needs the rollback lever AND ≥5 paying tenants
simultaneously. Nothing tests it. **Fix:** either cap the priority prepend's
must-attempt set at C=1, or state the composed worst case in `sweep-budget.ts`
and assert it.

### NB-7 · The prefix property tests restate the implementation rather than checking it
`test/tenant-slice-concurrency.test.ts:102,153`; `sweepcap.test.ts:209`

PLANT 3 (`prefix := visited`) left **22/22 green**. Self-refuted as a defect —
under `claim` the two are provably equal — but the consequence stands: every
"`prefix === visited`" assertion is a tautology of the current pool and cannot
fail. The only executable oracle for the constraint is the ABANDON negative
control, and that runs the *experiment's* `sweepTenantsConcurrentCandidate`, not
shipped code. So the day someone adds a per-item timeout or a race to
`sweepConcurrently`, the hole reopens with the suite green. **Fix:** make the
abandon control run the SHIPPED function through an injected discipline, or add a
test that fakes a non-completing claim and asserts `prefix < visited`.

### NB-8 · Paying-tenant priority is `ORDER BY id LIMIT 5` — the 6th paying tenant never gets priority, deterministically
`src/admin/tenant-slice.ts:269-277`; `test/tenant-slice-priority.test.ts:74-76`

With >5 paying tenants the same lowest-5 ids win every tick, forever; there is no
rotation among the paying population. The test asserts only the LENGTH is capped,
never *which*. The docstring says the cap is "sized for the paying population this
platform actually has" — true today (~1), and the degradation is bounded (the
starved payer still rotates in ≤4 ticks). Flagged so the constraint is a decision
rather than an accident: at 6+ paying customers this needs its own rotation
offset. **Fix (cheap):** `ORDER BY (id > :lastPriorityCursor) DESC, id` or reuse
`rotationOffset`.

---

## Cross-lane collision report — Inc4 (`feat/msgchannel-inc4-2026-08-24` @ `47de55a`, base `8d58f1e`)

Read-only. Shared files: `sweep-budget.ts`, `scheduled.ts`, `ops-sweep.ts`,
`sweep-signals.ts`, `tenant-do.ts`, `env.ts`, `spend-armed-env-coverage.test.ts`.
Mechanical conflicts (imports, the legs bag, env entries, the
`LEG_SUBREQUEST_COSTS` type gaining `sharedSummary?`) are expected. Two are NOT
mechanical:

### X-1 · **FOLD BLOCKER** — the two lanes redefine the same three constants with incompatible reasoning, and the dual-oracle guard is blind to the mirror

| constant | Inc4 | sweepcap | correct fold |
|---|---|---|---|
| `SWEEP_RPCS_PER_TENANT` | `11 + 2` = 13 | 7 | **9** (7 + `MIRROR_SUBREQUESTS_PER_TENANT`) |
| `SWEEP_FANOUT_RPCS_PER_TENANT` | `RPCS - 2 - MIRROR` = 9 | `= RPCS` (identity) = 7 | **`RPCS - MIRROR`** = 7 |
| `LEG_SUBREQUEST_COSTS.deliverability.perTenant` | `1 + MIRROR` = 3 | 1 | **3** |

The two `SWEEP_FANOUT_RPCS_PER_TENANT` formulas both encode a `- 2` for the send
pipeline — Inc4 subtracts it explicitly, sweepcap has already removed it from
`SWEEP_RPCS_PER_TENANT` by moving the leg off the slice. A mechanical
"take both sides" merge yields `9 - 2 - 2 = 5`, which derives **slice 27** — an
**over-sized** slice, and the research doc's own Table 1 / §8 R3 is that an
over-sized slice collapses the achieved advance to **1**, i.e. worse than doing
nothing. Taking sweepcap's identity verbatim yields 9 and slice 15 (safe, but a
silent 21% coverage regression against the number this lane published).

**The guard will not catch either.** `sweep-signal-coverage.test.ts` keys on leg
NAMES in `scheduled.ts`'s bag; the mirror adds no leg (it rides
`deliverabilitySweep`). Inc4's own docstring says so: *"there is no new key in
scheduled.ts's leg bag for it to price against."* Verified by PLANT 6 — the guard
only fires on a new NAME. So the fold must be done by hand and re-derived, not
resolved by the suite going green.

Also stale-at-fold: Inc4's docstring says the mirror's 2 subrequests *"count
against the shared **1000**-subrequest tick budget"* — false after this lane's
1000→10,000 correction.

### X-2 · Non-blocking, arming-time: the slice's latency basis predates the mirror
`MEASURED_DO_RPC_MS` (p75 450ms) was captured 2026-08-20, before Inc4 added a
contact-email D1 read + a `mailer.send` **inside** `deliverabilitySweep`. Inc4
excludes the mirror from the wall-clock arm by argument, noting that charging it
moved the mean-completion estimate from 11,178ms to **13,662ms against a
12,750ms ceiling** — i.e. Inc4 already found it reds S6 and chose exclusion. That
argument was made against the pre-sweepcap slice; at slice 19 × C=6 it is
untested. The mirror is dark (`MESSAGE_EMAIL_MIRROR_ENABLED`, verified at
`message-mirror.ts:92-102`), so this is an **arming-gate** item: re-capture
`MEASURED_DO_RPC_MS` on the first armed mirror tick before trusting slice 19.

**No collision found** in: drain ordering (Inc4's `mirror.sent += …` accumulators
sit after the single `await`, so they are atomic under sweepcap's C=6 pool — no
double-counting); the `scopedLegNames` substring trap (Inc4's
`mirrorDeliverySelfReport` call contains no `"scope"`, so it will not be
misclassified as a slice leg); watchtower families/roster (sweepcap adds no check
names — `watchtower-policy` and `watchtower-key-reachability` both green at HEAD).

---

## Attacks that FAILED (why the verdict means something)

1. **Recompute the derivation by hand, then by execution.** slice 19, tick
   subrequests 650, cap 166, rotation@66 = 4 — all exact. HELD.
2. **Fetch the vendor limits page live.** All five §2 claims verbatim, including
   "queued, not errored" past six. HELD.
3. **Is the simulation oracle independent?** Grepped every import in
   `test/sweepcap-experiment/`; it pulls no efficiency constant from the budget
   file and grades the real exported function. PLANT 1 confirms it can fail. HELD.
4. **Prefix under a mid-claim THROW.** `done[index] = true` is set in the common
   path after the catch, so an errored tenant is covered, not a hole. Traced +
   test at `tenant-slice-concurrency.test.ts:158-174`. HELD.
5. **Prefix under a deadline hit mid-flight.** Claim is atomic (no `await`
   between reading and advancing `next`); a deadline-hitting worker sets
   `next = n`; every claimed index completes → covered is always `{0..k-1}`. HELD.
6. **Rotation stall at prefix 0.** `mustAttempt(index <= priorityCount)`
   guarantees ≥1 rotation tenant per leg per tick; PLANT 5 proves the guard
   binds. `slice === null` skips the commit entirely; `slice.ids === []` cannot
   reach a bad cursor. HELD.
7. **Last/partial slice and slice-of-1.** Traced: `covered = min(v, ids.length)`,
   `complete` requires `slice.complete`, and the `ids.length === 0 && cursor !== null`
   restart branch handles the wrap. HELD.
8. **Can a paying tenant be swept twice?** Filtered at `scheduled.ts:102` and
   again in `resolveSweepTenants`, dropping from the PREPEND never the page. HELD.
9. **Does the priority prepend enlarge the tick?** `touched = slice(p) + p = 19`
   for all p ≤ 5, executed. HELD.
10. **Ops-summary field parity.** Grepped every consumer: watchtower reads only
    `failureSignalsInWindow` (1h), digest only `actionsInWindow` (24h), dunning
    neither. No third windowed group exists in `getOpsSummary`. HELD.
11. **Naive-memo mis-window.** PLANT 7 reds on the DATA, not just the metadata. HELD.
12. **Prefetch leg-level failure.** `summaries` undefined → `sweptSummary` falls
    back to a real per-consumer fetch at each consumer's OWN window. Correct
    degradation. HELD.
13. **Auto-send widening.** The `~55×` reach widening (3 → 166 tenants/tick) is
    bounded per-tenant by `readSendDriverGate` (paid plan + `clock_mode='real'` +
    activated + `realSendPathLive`) at `engine/activation.ts:136-146`, and sends
    are bounded by the per-mailbox `sent_today < daily_cap` (`tick.ts:343-344`),
    not by a per-tick batch — so 22× more ticks is 22× lower latency, **not** 22×
    more mail. (⚠️ `AUTOSEND_DISABLED` is a kill switch, NOT a dark gate — it is
    unset in `wrangler.toml` and auto-send is LIVE per founder ruling.) HELD.
14. **IN-9 fairness on `rotationOffset`.** Untouched by this lane; both
    fairness tests (`send-pipeline-budget.test.ts:133-158`) green at HEAD. HELD.
15. **Dual-oracle leg guard.** PLANT 6 reds; the retired headcount guard would
    NOT have. Strictly stronger. HELD.
16. **Are the re-stated guards weaker?** Compared each replacement to what it
    replaced: `sweep-fanout-bound` split into two properties, both stronger than
    the single total (which would now be false); `sweep-signal-coverage`'s
    per-leg pricing beats the headcount; `sweep-signals`' prose assertion now
    checks for the ABSENCE of the retired claims, not just the presence of a word
    the new text also contains. None weakened. HELD.
17. **Cross-tick `+=` accumulator races under the pool.** Every accumulator in
    `ops-sweep.ts` / `watchtower.ts` sits after the single `await` with no
    interleaving point. HELD.
18. **Watchtower roster / check-name coherence.** The lane adds leg names inside
    `cron_legs`, not check names; `watchtower-alerts.ts` / `watchtower-families.ts`
    untouched; both roster guards green. HELD.

## UNVERIFIABLE

1. **Whether DO stub RPCs count toward the 6-connection ceiling.** Docs omit them
   from an enumerated list; absence ≠ exemption. Resolves with a `wrangler tail`
   of the first armed C=6 tick (also gives R6's `cpuTime`).
2. **The workerd source citations** (`limit-enforcer.h:152`, `server.c++:4560`
   as `override {}`). No workerd checkout here; not load-bearing for the ship
   decision. Resolves by cloning `cloudflare/workerd` at the pinned rev.
3. **R7's acceptance test — `sweep_coverage` flipping healthy in production.**
   Requires the deploy. `GET /admin/ops/checks?unhealthy=1` should report
   `covered === handed` and ≤4 ticks at 66 tenants. Until then the lane is
   verified in simulation only.
4. **`MEASURED_DO_RPC_MS` under actual C=6 concurrency.** The fitted model
   reproduces the SERIAL capture; nothing measured six overlapping DO RPCs from
   one invocation.

## NEW (out of scope, no verdict weight)

- `sweepcap.test.ts:280` logs a hardcoded `[baseline C=1 slice=3]` label while
  `sweepTenantSliceFor(1)` is now 4.
- `runLeg("tenantPriority", [] as string[], …)` uses `[]` as its fallback, so
  `collectLegSignals` cannot distinguish "this leg threw" from "no paying
  tenants". Reasoned deliberately in `LEG_SHAPES` and benign (a correlated D1
  failure is caught by `tenantSlice`'s `null`), but it means a paying tenant
  silently losing every-tick priority has no signal.
- `commitSweepCursor`'s `fanout.leastVisited ?? slice.ids.length` fallback
  (`scheduled.ts:180`) advances the FULL slice when every fan-out leg threw at
  leg level — pre-existing, unchanged by this lane, but now advances 19 tenants
  instead of 3.
- The lane is 2 commits behind `main` (`8d58f1e`, `89caa67` — README/outreach
  ledger only, no code overlap).

---

# Combined gate — folded tree

Ref: worktree `/Users/yaakovscher/dev/coldstart-wt-integ2`, branch
`integ/perf-mirror-2026-08-24`, **HEAD `baa697784161ce5fa12ef342c794e16ca2d76c10`**,
`git status` clean. Ancestry verified read-only: `main@89caa67`, sweepcap `d8bac9c`
and Inc4 `47de55a` are ALL ancestors of HEAD. Date 2026-08-24, round 2.

## VERDICT: **SHIP** — 0 BLOCKING, 5 NEW non-blocking

The wave deploys sweep-capacity LIVE + Inc4 dark. X-1 is resolved correctly and is
now defended by three independent tripwire families, not one. Both lanes' gate
fixes survived the fold and each was re-proved by planting its own defect. The
flagged residual is arming-gated-acceptable — ruled below, with the arithmetic.

## 1 · X-1 re-derived by execution, then attacked

`npx esbuild src/admin/sweep-budget.ts --bundle | node` on THIS tree:

```
SWEEP_RPCS_PER_TENANT          9      perTenant column sums to 9 ✓
SWEEP_FANOUT_RPCS_PER_TENANT   7
MIRROR_SUBREQUESTS_PER_TENANT  2      deliverability row {perTenant:3, ownFanout:0} ✓
SWEEP_FIXED_SUBREQUESTS        517    SWEEP_TICK_SUBREQUESTS 688 = 9*19 + 517 ✓
ceilings at C=6 (effective 4.5):  sub 609 | p75 21 | mean 19   -> SLICE 19 ✓
slices: 1→4  2→7  3→10  4→13  6→19  8→25  12→38
```

Every figure in the brief confirmed. The only ceiling the fold moved is the
SUBREQUEST one (783 → 609), which is not binding — it is 32x the slice.

**PLANT A — the naive fold** (`FANOUT = RPCS - 2 - MIRROR` → 5, slice **27**,
the 42%-over-sized value). The fixer's claim was that all prior guards stay green
and only the new dispatch guard reds. **That is understated in the safe direction —
it is caught 7 times across 4 files, in 3 independent families:**

- **NEW dispatch guard** — `expected 7 to be 5`, with the diagnostic message telling
  the next author which kind of cost they added. **It bites.**
- **the simulation oracle** — 3 more: `C=1: shipped slice 6 must not exceed the
  simulated max 4`; `C=1 at its derived slice 6: expected 11.3 to be >= 95`.
- **`tenant-slice-concurrency.test.ts`** — `sweepTenantSliceFor(1)` is 6, not 4.
- plus `ops-summary-dedupe`'s new `FANOUT === 7` pin and the NB-6 overrun test.

**The core of the fixer's claim is nonetheless correct and worth recording:**
`sweep-budget.test.ts` and `sweep-signal-coverage.test.ts` — the two files whose
job is the budget arithmetic — **stay entirely GREEN** under PLANT A. They check
`SWEEP_RPCS_PER_TENANT` and internal self-consistency, never that term. A fold
resolved by "the budget suite is green" would have shipped slice 27.

## 2 · The oracle repair is still independent

The repair subtracts `MIRROR_SUBREQUESTS_PER_TENANT` from the deliverability leg
so the model counts DISPATCHES, and asserts `modelled === SWEEP_FANOUT_RPCS_PER_TENANT`.
That assertion is a tripwire, not a coupling: `maxSustainableSlice` still depends
only on `FANOUT_LEGS`, `SWEEP_FANOUT_DEADLINE_MS` and the fitted latency — it reads
neither efficiency constant, so `derived <= measured` is NOT true by construction.

Proved on THIS tree rather than argued:

- **PLANT B — `SWEEP_CONCURRENCY_EFFICIENCY = 1.0`** → **RED**,
  `C=3: shipped slice 13 must not exceed the simulated max 12` (3 failures).
- **PLANT C — `SWEEP_MEAN_COMPLETION_FRACTION = 1.0`** → **RED**,
  `expected 23 to be less than or equal to 21`.

Both halves of the belt-and-braces pairing survive the fold, and each still catches
what the other misses.

## 3 · Both lanes' gate fixes, re-proved by planting

Named suites on the live worktree: `watchtower-key-reachability`,
`send-pipeline-tenant-cap`, `mirror-optout-route` → **3 files / 49 tests**;
`message-mirror`, `monitoring-denominators`, `ops-summary-dedupe` → **3 files /
43 tests**. All green, exit 0. Green is not the evidence; these are:

- **PLANT D — revert NB-1** (drop `if (original !== undefined) throw original;` at
  `tenant-slice.ts:219`) → **RED**:
  `expected 'Tenant ten_wedged_0\'s Durable Object…' to contain 'Durable Object is
  overloaded'`. The replacement guard is at
  `watchtower-key-reachability.test.ts:328` — *"every declared key is reachable
  THROUGH THE CRON PRODUCER, with the original message"* — i.e. it moved to the
  end-to-end tier and checks the message, exactly as NB-1 specified.
- **PLANT E — revert the cursor HOLD** to the old wrap/restart → **RED**,
  `expected null to be 'ten_hold_01'`.
- **PLANT F — move Inc4's arming check after one `ctx.sql.exec`** → **RED**,
  `expected 1 to be +0`. The T11 dark guard spies BOTH `env.DB.prepare` and the real
  `state.storage.sql.exec` and bites on a single extra call.

NB-2 is fixed by DERIVATION, not by a new literal:
`sweep-signals.ts:517` emits `${SWEEP_TENANT_SLICE * COVERAGE_TICKS_ALERT_AFTER + 1}`
= 229, and `README.md:222` shows the arithmetic. NB-3 is closed in place at
`ROADMAP.md:144`. NB-5's counter split landed (`skippedForTenantCap`) — but see N-1.

## 4 · NB-6 / cursor-hold coupling — no reintroduced pin

`priorityWindowSize(c) = min(c, PAYING_TENANT_PRIORITY_CAP)`: at C=1 the window is
**1**, so the must-attempt set is 2 tenants and the overrun is `2 x 450 x 7 =
6,300ms`, not the 18.9s I derived for the unclamped version. At C=6 it is exactly
the pre-lane baseline, and `tenant-slice-priority.test.ts` asserts the composed
period cost honestly (`composed - CRON_PERIOD_MS === PRE_LANE_MUST_ATTEMPT_OVERRUN_MS`)
rather than hiding it. NB-8's rotation strides by the window, so consecutive ticks
serve disjoint groups.

No pin, and no new one: `mustAttempt(index <= priorityCount)` always attempts the
FIRST ROTATION tenant, so any leg that ran contributes `rotationPrefix >= 1`; the
all-legs-threw case still takes the pre-existing `?? slice.ids.length` fallback.
The hold branch writes `ON CONFLICT DO UPDATE SET updated_at` only — it genuinely
holds `last_tenant_id` — and stamps freshness unconditionally. See N-5.

## 5 · RULING on the residual: **arming-gated-acceptable. No code-side bound needed before deploy.**

Three legs, each verified:

1. **Dark is provably zero work.** `drainMessageMirror`'s first line is the arming
   check (`message-mirror.ts:346`), and the T11 pair proves ZERO D1 `prepare` calls
   AND ZERO DO `sql.exec` calls with the flag unset. PLANT F shows the guard bites
   on one extra call.
2. **With the mirror dark the folded tree's wall-clock model IS the sweepcap
   lane's, exactly.** Both binding arms use `SWEEP_FANOUT_RPCS_PER_TENANT = 7`,
   `SWEEP_FANOUT_DEADLINE_MS = 15000`, `ASSUMED_DO_RPC_MS = 450`, mean 414, the
   same 0.7/0.85 — producing the identical p75 21 / mean 19 / slice 19. The mirror
   changed only `SWEEP_RPCS_PER_TENANT` (subrequests), which moves only the
   non-binding subrequest ceiling. **Zero delta at deploy.**
3. **The arm gate measures the thing.** `ROADMAP.md:21` step (3a) requires
   `wrangler tail --format json` filtered to `deliverabilitySweep`, comparing
   `wallTime` against the pre-mirror `MEASURED_DO_RPC_MS` baseline, and names the
   reason. Step (3) narrows `MESSAGE_MIRROR_TENANT_ALLOWLIST` to ONE pilot tenant
   BEFORE arming the flag, so first exposure is 1 tenant, not 19.

A code-side bound now would be sized against an unmeasured number. Measure first,
on one tenant, as the gate already says.

## 6 · Ledgers — accurate on substance, three staleness items (N-2, N-3)

`ROADMAP.md:14` states X-1 correctly including the `9-2-2=5` trap, the 42%
over-sizing, the hand-checked ceilings, the oracle mis-feed, and the residual.
`ROADMAP.md:18` carries **[dark-unarmed]** on Inc4 with the flag UNSET at merge and
the T13/T14 overclaim corrected. `ROADMAP.md:20` records the Inc4 gate with
revert-fail-restore proofs. `ROADMAP.md:144` closes my NB-3 in place.

## NEW findings (this round) — none blocking

### N-1 · The tenant-cap's on-call log line reports a provable ZERO — PROVEN BY EXECUTION
`src/admin/ops-sweep.ts:566-569`

The NB-5 counter split landed in the STRUCT and not in the STRING. Line 566 sets
`summary.skippedForTenantCap`, but line 568 still interpolates
`${summary.skippedForLegDeadline}` — which in that branch is provably 0 (the two
branches are mutually exclusive and both `break`; the deadline branch is the only
writer). Captured the real emission by spying `console.warn` through the shipped
path:

```
capCounter: 2
warnLines: ["send pipeline: per-tick tenant cap (166) reached — 0 deferred to a
            later cycle (rotation reaches them)"]
```

On-call reads "0 deferred" at exactly the moment 2 were. The suite's own assertion
`expect(summary.skippedForLegDeadline).toBe(0)` is what makes it provable. Only
binds above 166 tenants and `cron_legs` reads the correct structured counter, so
NON-BLOCKING. **Fix:** one word — `${summary.skippedForTenantCap}`.

### N-2 · Contradictory duplicate ledger lines about this very lane
`ROADMAP.md:17`, `HANDOFF.md:34` vs `HANDOFF.md:81`

`ROADMAP.md:17` is still an unchecked, present-tense `[ORDER] **Queued next:
sweep-capacity follow-up increment**` — describing, in the future tense, the lane
that `ROADMAP.md:14` records as built, gated and folded. `HANDOFF.md:34` says
"**PENDING FOLD (not merged)**" while `HANDOFF.md:81` says "folded together on
`integ/perf-mirror-2026-08-24`". Per the ROADMAP Contract line 17 should be checked
off with an evidence pointer (moving to `archive/ROADMAP-done.md` at the next
handoff). Same class at `ROADMAP.md:129`, `HANDOFF.md:49`, `HANDOFF.md:66`
("the queued sweep-capacity lane").

### N-3 · `ROADMAP.md:144` states a tick cost the fold superseded
Says the lane "took `SWEEP_TICK_SUBREQUESTS` to **650**". On the folded tree it is
**688**. True of the sweepcap lane in isolation; stale on the tree the line now
lives on. The load-bearing argument is unaffected (688 > 600 as well).

### N-4 · The oracle's mirror subtraction is keyed to the leg NAMED "deliverability"
`test/sweepcap-experiment/sweepcap.test.ts:32-35`

`name === "deliverability" ? c.perTenant - MIRROR_SUBREQUESTS_PER_TENANT : c.perTenant`.
The new dispatch guard checks the SUM, so a future ride-along cost added to a
different leg is caught — unless it is paired with a compensating change that keeps
the sum at 7 while mis-distributing per leg. Legs run sequentially, so a wrong
distribution changes where the deadline bites within a leg. Low: needs a future
edit AND a compensating one.

### N-5 · The cursor-hold branch may be unreachable through the real path
`src/admin/tenant-slice.ts:419-437`, `test/tenant-slice-priority.test.ts:288`

The justification is "a tick whose deadline is already spent can cover only priority
tenants, so the netted advance is 0". But `mustAttempt(index <= priorityCount)`
always attempts index `priorityCount` — the FIRST ROTATION tenant — so any leg that
ran yields `rotationPrefix >= 1`; and the empty-page case takes the `complete`
branch instead. The test synthesizes `covered = 0` by passing it directly rather
than driving a tick that produces it. Holding is strictly safer than restarting
either way, so this is a note on the STATED trigger, not on the code. If it is
genuinely unreachable, say so in the comment rather than describing a scenario.

## Attacks that failed (round 2)

1. **Is X-1 resolved in the dangerous direction?** Executed: FANOUT=7, slice 19. HELD.
2. **Does the new dispatch guard actually bite?** PLANT A: `expected 7 to be 5`. HELD.
3. **Did the oracle repair make `derived <= measured` true by construction?** Traced
   every import, then PLANT B reds at C=3. HELD.
4. **Did the fold silently weaken the mean-completion ceiling?** PLANT C reds. HELD.
5. **Did NB-1's fix survive the fold as a real end-to-end guard?** PLANT D reds on
   the original message. HELD.
6. **Did the cursor hold survive?** PLANT E reds. HELD.
7. **Is Inc4 really dark — no I/O at all?** PLANT F reds on ONE `sql.exec`. HELD.
8. **Is the wall-clock model perturbed at deploy?** Both binding arms identical to
   the sweepcap lane; only the non-binding subrequest ceiling moved. HELD.
9. **Did the NB-6 clamp reintroduce a pin?** No: `rotationPrefix >= 1` for any leg
   that ran; the all-legs-threw fallback is unchanged. HELD.
10. **Is `[dark-unarmed]` actually on the Inc4 ledger line, and the flag unset?**
    `ROADMAP.md:18`, and `wrangler.toml` binds no mirror flag. HELD.
11. **Does the arm gate contain the measurement my ruling defers to?** `ROADMAP.md:21`
    step (3a), naming the tool, the filter and the baseline. HELD.

## UNVERIFIABLE (carried, unchanged)

1. Whether DO stub RPCs count toward the 6-connection ceiling — resolves on the
   first armed C=6 tick via `wrangler tail` (which also gives R6's `cpuTime`).
2. The workerd source citations (no checkout here).
3. **R7's real acceptance test — `sweep_coverage` flipping healthy in production**
   (`covered === handed`, ≤4 ticks at 66 tenants). Requires the deploy.
4. `MEASURED_DO_RPC_MS` under six genuinely concurrent DO RPCs from one invocation.
5. The full-platform battery — the verifier owns it; I ran targeted suites only.
