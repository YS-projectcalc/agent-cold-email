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
