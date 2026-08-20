# Wave B.2 — alert-state increment, BUILD gate (2026-08-20)

## VERDICT: **FAIL — SHIP AFTER FIX**

**1 BLOCKING** (a materiality key that no producer input can vary, proven by execution) plus **1 BLOCKING-AT-FOLD** (the sibling `sweepcal` lane deletes the constant and the type B.2's `sweep_coverage` key is derived from). Both fixes are small. **Everything on the frozen checklist — all 18 constraints, §6's test floor items 1-17, §9 items 1-12 — is satisfied and was re-derived here by execution, not accepted from the build report.** The design gate's four rounds hold up: the machine behaves as designed.

The two findings are the same class, which is why the verdict is FAIL rather than a note: **the declared key spaces are never checked against what producers can actually emit.** `watchtower-families.test.ts` compares the table to itself (declared names ↔ rows, cap > max, no duplicates, the `customer_progress` map closed) and every test that exercises a key writes that key by hand. So a family whose producer can only ever emit one of its declared keys ships green — one already has, and the fold is about to produce a second.

---

## Grounding

| Item | Value |
|---|---|
| Target | worktree `.claude/worktrees/alertstate`, branch `feat/alert-state-2026-08-20`, HEAD **`53d4edd37ec0a9f1a4491df227b766fdff03831e`**, working tree CLEAN. Reviewed as the diff `b260bd0..53d4edd` (3 commits, 35 files, +3199/−186). |
| Canon | `docs/research/alert-state-design-2026-08-20.md` (v4-FINAL, 831 lines) + the ROUND-4 CONSOLIDATED BUILD BRIEF in `docs/adversarial/alert-state-design-gate-2026-08-20.md:900-941`. Both read in full. |
| Sibling lane | `.claude/worktrees/sweepcal`, HEAD `33c7916`, **working tree DIRTY** (10 modified files incl. `admin/sweep-signals.ts`, `admin/sweep-budget.ts`, `admin/README.md`), read 2026-08-20 ~18:00. It shares merge-base `b260bd0` with this lane. A lane that has not committed is a moving target; F1 below is stated against that read. |
| Mode | READ-ONLY git everywhere. All execution in two rsync sandboxes with hard-linked `node_modules`; source mutations for revert-proofs happened only in sandbox 2. |

### Battery, re-run independently at `53d4edd` (real exit codes, not piped)

| Leg | Result |
|---|---|
| `npm run typecheck` (all workspaces) | **exit 0** |
| platform | **238 files / 2324 passed / 1 skipped — exit 0** (786s) |
| dashboard | 31 files / 165 passed — exit 0 |
| engine | 18 files (+2 skipped) / 153 passed (+4 skipped) — exit 0 |
| shared | exit 0 |
| cli (dist prebuilt first) | 0 fail — exit 0 |

The build report's numbers reproduce exactly.

---

## BLOCKING

### B1 · lens 1 (spec-vs-code line-trace) + lens 2 (run it) · `alert_delivery`'s materiality key is a CONSTANT — 2 of its 3 declared keys are unreachable, and the key it does bank misclassifies a dark channel as a send failure

**Mechanism.** `alertDeliveryKey` (`apps/platform/src/admin/watchtower-families.ts:228-233`) tests membership with `reasons.includes("dark_channel")` / `reasons.includes("send_failed")` — **whole-element array equality**. The producer at `apps/platform/src/admin/sweep-signals.ts:397` hands it `signals.undeliveredAlerts.reasons`, which `collectLegSignals` builds at `apps/platform/src/admin/sweep-signals.ts:217` as rendered prose:

```
undeliveredReasons.push(`${outcome.name} (${outcome.why})`);
```

so the elements are `"engine (dark_channel)"`, never `"dark_channel"`. Both membership tests are false for every input, and the function falls through to its `send_failed` default.

The function's own docstring asserts the opposite of what is true — *"already a closed `DeliveryReason` subset at the producer"* — and design §1.1.1 forbids exactly this (*"Never the detail string... A key is a producer-stated classification over a CLOSED enumeration"*). The producer is feeding rendered prose to a classifier.

**Verification — executed**, `test/zzz-adversary-probe.test.ts` and `-probe2.test.ts` in sandbox 2:

```
REASONS ARRAY: ["engine (dark_channel)","d1 (send_failed)"]
KEY PRODUCED: send_failed          <- should be "both"
KEY IF FED RAW REASONS: both       <- the function is correct; its input is not

["engine (dark_channel)"]                     -> send_failed
["engine (send_failed)"]                      -> send_failed
["engine (dark_channel)","d1 (send_failed)"]  -> send_failed
["d1 (dark_channel)","engine (dark_channel)"] -> send_failed
DISTINCT KEYS PRODUCIBLE: ["send_failed"]
```

End-to-end through the real producer, 4 ticks of a pure `dark_channel` failure then 4 of `send_failed`:

```
AFTER dark_channel ticks: {"announced_keys":"{\"keys\":[\"send_failed\"],\"overflow\":0}","alert_count":1}
ACTIONS after switching reason: ["suppressed/suppressed_cooldown", x4]
AFTER send_failed ticks:  {"announced_keys":"{\"keys\":[\"send_failed\"],\"overflow\":0}"}
```

**Reachability, stated honestly.** The *wrong key is banked every single time `alert_delivery` alerts* — certain, not conditional. The *missed escalation* needs the ops mail channel to change failure mode mid-episode (dark → send_failed, or one arriving alongside the other), which is a narrower window. The banked key is not founder-visible (`GET /admin/ops/checks` names its columns explicitly and does not select `announced_keys`), and the email body still carries the true reasons in prose. So the damage is: the increment's headline capability — *tell a repeat from an escalation* — is **inert at this site**, on a family the design marks `✱` ("an escalation is a genuinely different, action-changing condition") and one of the six arriving families constraint 9 specifically required to be classified.

**Why blocking rather than a note:** the fix is one line, and the class is open. There is no test anywhere that compares a producer's emitted key against its family's declared space — see B1b.

**B1b · the missing class guard.** `watchtower-families.test.ts` checks the table against itself only. The illustration is one line of the build's own suite: `apps/platform/test/watchtower-budget.test.ts:295` hand-writes

```ts
{ name: "alert_delivery", healthy: false, materiality: "dark_channel", detail: "alerts owed and not delivered" },
```

— a fixture asserting on a key the real producer can never emit. Per CLAUDE.md's Bug Response step 4, the fix owes a systemic guard: drive each producer (or its key function with the producer's real input shape) and assert the emitted key ∈ `ALERT_FAMILIES[family].keys`, with the additional assertion that **every declared key is reachable from some producer input**. That second half is what reds on B1 and on F1.

---

### F1 · lens 4 (deploy/fold plumbing) + lens 7 (regression ring) · BLOCKING AT FOLD — the `sweepcal` lane deletes both the constant and the type B.2's `sweep_coverage` key is derived from, and kills two of its four declared keys

B.2 added, at `apps/platform/src/admin/sweep-signals.ts:366-370`:

```ts
materiality: sweepCoverageKey(
  coverage === null,
  coverage !== null && coverage.coverageTicks > COVERAGE_TICKS_ALERT_AFTER,
  signals.deferred >= DEFERRED_LEG_VISITS_ALERT_AFTER,
),
```

All three inputs are removed or invalidated by the sibling lane's uncommitted working tree:

| Input | What `sweepcal` does | Consequence for B.2 |
|---|---|---|
| `signals.deferred >= DEFERRED_LEG_VISITS_ALERT_AFTER` | **deletes the export** `DEFERRED_LEG_VISITS_ALERT_AFTER`; states plainly *"a wedged engine expiring every tenant's budget is now graded by NOTHING... no threshold reads it"* | compile error; and semantically the keys **`in_tick_deferral`** and **`both`** become unreachable |
| `coverage.coverageTicks` | replaces the `TenantSlice` parameter with a new `SweepCoverage {total, covered}` and computes ticks via `coverageTicks(total, covered)`. Its own docstring: *"This type does not typecheck against one."* | compile error |
| `coverage === null` | the new code **skips the observation entirely** when `coverage === null` (*"UNKNOWN IS NOT HEALTHY, and it is not unhealthy either"*) | **`slice_unreadable`** becomes unreachable by construction |

After a naive "make it compile" fold, `sweep_coverage`'s declared 4-key space collapses to exactly one reachable member (`rotation_behind`) — B1's class, reproduced, at a second family. The fold owner must re-derive this key from the sibling lane's new grading (rotation ticks) and re-declare the space to match, or the family's escalation is dead on arrival.

**Verification method:** `git -C .claude/worktrees/sweepcal diff -- apps/platform/src/admin/sweep-signals.ts`, read in full at HEAD `33c7916` + dirty tree. B.2 in isolation compiles and passes (typecheck exit 0 above); this fires only at the fold.

**B.2's complete `sweep-signals.ts` delta, for the fold** (17 lines, all additive — nothing removed, no logic changed):

1. `:62` — new import of `alertDeliveryKey, cronLegsKey, sweepCoverageKey, warmupGaveUpKey`.
2. `:324` — `cron_legs` gains `materiality: cronLegsKey(legsThrew.length > 0 || unknownLegs.length > 0, counted > 0)` + a 6-line comment.
3. `:366-370` — `sweep_coverage` gains the `sweepCoverageKey(...)` call above. **← the whole collision**
4. `:397` — `alert_delivery` gains `materiality: alertDeliveryKey(signals.undeliveredAlerts.reasons)`. **← B1 lives here**
5. `:434` — `warmup_cancel_gave_up`'s unhealthy arm gains `materiality: warmupGaveUpKey(gaveUp)`.
6. `:482` — `sweep_signals` gains the literal `materiality: "threw"`.

Items 1, 2, 5, 6 are collision-free against the sibling lane. Item 4 is untouched by it. Only item 3 conflicts. Both lanes also edit `apps/platform/src/admin/README.md` (+32/−9 here, +29/−6 there) — a prose conflict, no semantics.

---

## NON-BLOCKING

### N1 · A test whose title claims something the same commit refuted, resting on a vacuous arm

`apps/platform/test/watchtower-budget.test.ts:126` is titled **"reds at 0 on BOTH historical readings, on this exact fixture."** Commit `53d4edd` corrected exactly that claim in the design gate's table, but left this title and its v2 arm in place. The arm is:

```ts
// RED ARM (v2): the check budgeted like any other announcement.
expect(admits({ total: MAX_ANNOUNCEMENT_EMAILS_PER_DAY, perEntity: 0 }, false)).toBe(false);
```

— a hand-constructed hypothetical at `total = 20`, four lines after the same test asserts `expect(budget.total).toBeLessThan(MAX_ANNOUNCEMENT_EMAILS_PER_DAY)`. It is a tautology about `admits`, not an observation of the fixture, and it certifies nothing about the v2 defect. **Executed:** with `alert_budget_exceeded` flipped to `budget: "counted"`, this test stays **GREEN**. Fix is the title plus a pointer to the mixed-storm fixture that does discriminate it.

### N2 · The budget's fail-open is unpriced, correlated with the storm it bounds, and silent — measured at 200 announcements/24h against a ratified ≤20

`claimAnnouncementSlots` (`apps/platform/src/admin/watchtower.ts:1069-1081`) catches any error from `admitAnnouncements` and returns `FAIL_OPEN_CLAIM` for **every** candidate. The direction is right for a monitor and is stated. The cost is not.

**Verification — fault injection**, `admitAnnouncements` made to throw, 100 `tenant_do_wedged:` instances over 288 ticks (24h at the live cadence):

```
FAIL-OPEN announcements in 24h: 200   (budget cap is 20)
```

Nothing new bounds it: volume reverts to the per-episode cap + ladder, i.e. the pre-B.2 rate (~1 email/instance/day → the design's own ~1,400/day pathological figure at full instance count). Three things make this worth stating rather than accepting:

- **It is correlated, not independent.** The WatchtowerDO also holds `gradeSweepStreak` and `d1_alert_state`; a DO-platform incident is precisely when a 100-instance `tenant_do_wedged:` storm happens.
- **It is silent.** `reportAlertBudgetHealth` returns `[]` on the same error (`watchtower.ts:1145-1148`), so `alert_budget_exceeded` is UNREPORTED at exactly the moment the budget is not being applied. The founder gets the storm with no explanation.
- **A human is being asked to ratify the bound.** §9.13's ask says "up to ~20 announcement emails"; it needs the exception named.

Not blocking: it is a strict no-worse-than-HEAD degradation, no checklist item covers it, and the alternative (fail closed) would delete alerts in an outage. **Deploy requirement:** disclose it in the §9.13 RATIFY ask.

### N3 · Deviation 1's stated race is not reachable by any current caller — the deviation is still right, the rationale is over-stated

`admitAnnouncements`' docstring justifies DO-side atomicity with *"the cron tick and an event-driven `reportCheck` from a tenant DO can both read total = 19 and both send."* Grepped every `reportCheck` caller:

| Caller | Family raised | Budget |
|---|---|---|
| `engine/mailbox-acquisition.ts:200,233,250` | `mailbox_provisioning:` / `mailbox_rebuy:` | **exempt** |
| `engine/isolated-failure-alerts.ts:91` (via `lifecycle.ts:325`, `mailbox-provisioning.ts:232`, `provisioning.ts:723`) | the three `*_failed:` prefixes | **exempt** |
| `admin/sweep-signals.ts:469` | `sweep_signals` | counted, but runs sequentially in the same cron invocation |

Exempt candidates never reach `admitAnnouncements` at all (`isBudgetedAnnouncement`, `watchtower.ts:821`), so no tenant-DO-driven caller can contend. The atomicity remains correct for the reasons the code *doesn't* give: three `reconcileAlerts` entry points per tick, and overlapping cron invocations. Worth correcting so a future editor does not "simplify" it on a false premise.

### N4 · `failureSignalsKey` ignores its `complaints` argument whenever `failed > 0`

`watchtower-families.ts:203-207` returns `complaints` only when `failed === 0`. Executed: `failureSignalsKey(2, 5) = "failed_elevated"`, `failureSignalsKey(1, 0) = "failed_elevated"`. So a complaint condition arriving on top of an existing failure count can never escalate, and the design's cell reads `failed_elevated (3-99)` while the code branches at `failed > 0`. Within the design's stated latitude ("banded grade"), so a note, not a finding.

### N5 · `sweep_coverage`'s `slice_unreadable` can only fire when the deferral threshold also trips, and the key's third input silently deviates from §1.2

`coverageBad` (`sweep-signals.ts:346-347`) is not made true by `coverage === null` alone, so a slice-unreadable tick is only ever *graded* when `deferred >= DEFERRED_LEG_VISITS_ALERT_AFTER` — and then reports `slice_unreadable` while the actual trigger was deferral. Separately, §1.2's cell derives `in_tick_deferral` from `signals.deferred > 0`; the build uses `>= DEFERRED_LEG_VISITS_ALERT_AFTER`. The build's choice is **better** (it aligns the key with the alerting cause), but it is an undocumented deviation from frozen text. Both are moot after F1's fold reconciliation.

### N6 · The `healthyObs === 0` adoption gate closes the `holding` route into B6 but not the withheld-recovery route

`withheldAlertState`'s `recovered` arm returns the whole previous state (`watchtower-policy.ts:553`). On a `no_longer_applicable` clear the episode closes in one observation, so that previous state carries `status = 'unhealthy'` **and `healthyObs === 0`** — which passes `siblingCarriesStall` (`watchtower.ts:975`) and re-opens the stale-onset inheritance B6 exists to prevent. Requires an email-channel `customer_progress_operator:` recovery to be dark-channel-withheld. **Pre-existing at HEAD** (the old predicate had no `healthyObs` term at all), and B.2 strictly *narrows* the adoptable population, so this is a residual the new gate does not reach rather than a regression. Traced through the code, not executed.

### N7 · One more round-4 evidence claim looks to have the same flaw as the table the builder corrected

Round 4 item 3 reports *"0 ticks where a send was denied while `saturated` was false under v4, against **672** such ticks under **both** defective readings."* The two defective readings in round 3's table were total-only and any-withholding. Under an *any-withholding* reading, `saturated` is broader than denial, so `denial ⟹ saturated` holds trivially and the count should be 0, not 672. The invariant itself I re-derived directly from the shipped code and it is exact — `admits` (`watchtower-budget.ts:126-129`) denies iff `total ≥ 20 ∨ (perEntity ∧ pe ≥ 15)`; `isSaturated` (`:121-123`) is `total ≥ 20 ∨ pe ≥ 15`; denial implies saturation with no gap. So constraints 15 and 17 hold regardless. This is a note about the design gate's own model, carries no verdict weight, and I could not fully confirm which two readings "both" names.

### N8 · A cross-lane attribution that points at a section the frozen design does not contain

The `sweepcal` lane's new `sweep-signals.ts` header says the per-tenant staleness signal *"belongs to the per-tenant staleness signal in the alert-state increment, **where the frozen design already put it**."* Grepped `alert-state-design-2026-08-20.md` for `staleness` / `stale tenant` / `per-tenant stale`: **zero hits**. §7.5 states a *constraint* on rotation-skipped tenants; it declares no staleness family. Risk is that the item falls between the two lanes with each believing the other owns it.

---

## Rulings the brief asked for

### The builder's correction of the design gate's ROUND-4 table — **CORRECT**, and I verified it in both directions

The gate's round-4 table (`alert-state-design-gate-2026-08-20.md:822-829`) reports arm 15b's pure per-entity fixture as delivering **0 on both** historical defects. The builder claims only v3 does, because the shipped 15/5 sub-cap holds the total at 15/20 and thereby *rescues* a budgeted global check through the 5 reserved slots. **Executed, sandbox 2, one file mutated at a time:**

| Mutation (the historical defect) | §6.15b pure per-entity arm (asserts 8) | the new mixed-storm arm |
|---|---|---|
| `alert_budget_exceeded` → `budget: "counted"` (v2) | **GREEN at 8** — does not catch it | **RED at 0** |
| `isSaturated` → total counter alone (v3) | **RED**, 0 delivered | GREEN |
| shipped code | GREEN at 8 | GREEN |

The builder is right, plainly: **arm 15b does not red on the v2 defect**, the gate's table was wrong, and the mixed-family fixture the builder added is the one that discriminates the exemption. Each defect now has the fixture that catches *it*. The one thing left undone is N1 — the test whose title still asserts the refuted claim.

Checked the other three round-4 evidence claims for the same flaw: item 1 (8 delivered on the pure storm) reproduces exactly; item 4 (§9.13's 42/30/2 arithmetic) re-derived and matches, and the constants' docstring carries the honest inbox arithmetic (`watchtower-budget.ts:29-42`: "~20 announcements plus up to the same number of recoveries plus exempt traffic, ~30/day measured, ~42/day theoretical" — **not** the bare 20). Item 3 is N7.

### Deviation 1 — atomic `admitAnnouncements` / `releaseAnnouncements` in the DO: **SOUND**

The alternative (read-then-decide in the Worker) genuinely does leave a gap across the three `reconcileAlerts` entry points per tick and across overlapping cron invocations; DO storage serialization closes it. The stated justification names a race no current caller can produce (N3), but the deviation stands.

**Does release-on-failure open a re-announce storm on a flapping dark channel? No — attack failed.** Traced the whole loop: a claimed slot whose send does not land is released (`watchtower.ts:937, 1044`) *and* `withheldAlertState` reverts `lastAlertTs` / `alertCount` / `realertCount` / `announcedKeys`, so the next tick recomputes the identical transition. Net effect per tick is one send *attempt* and zero delivered emails, with the ring returning to its prior state — byte-identical in volume to HEAD's withheld-retry behaviour. When the channel returns, the backlog is admitted under the (empty) budget, i.e. ≤20. The one residual is bounded and disclosed in the code: if `releaseAnnouncements` itself throws, slots stay banked for their 24h window — an over-count, never a lost alert.

### Deviation 2 — budget consultation fails OPEN: right direction, unpriced. See N2.

### The 9 rewritten tests — **all legitimate spec changes**, none an assertion weakening

Audited each diff hunk. The one the brief singled out is the strongest case: `watchtower-debounce.test.ts`'s *"the debounce counts CONSECUTIVE observations — a good sweep in between resets it"* asserted `mailer.sent` was **empty** across six sweeps of a fault unhealthy half the time — it encoded IN-9, the defect. Its replacement **strengthens** the assertion from "no emails" to an exact action sequence plus an exact subject list:

```ts
expect(actions).toEqual(["pending","holding","alerted","holding","suppressed","holding"]);
expect(mailer.sent.map((m) => m.subject)).toEqual(["[coldrig] Durable Object storage: UNHEALTHY"]);
```

The `["pending","healthy"]` → `["pending","holding","holding","healthy"]` change in `watchtower-policy.test.ts` is the same shape: the timeline is extended to the new closure point and the assertion is exact, not loosened. Every other rewrite (channel-routing, d1-outage, flap, retention, tenant-visibility, admin-ops-checks, send-pipeline-alerts, sweep-signals) is the mechanical "one clean observation → three" extension, with the file's own property re-asserted afterwards. Each carries in-place reasoning. `watchtower-policy.test.ts`'s `sustained()` expectations are **unedited** — §9.5 / constraint 10 confirmed by reading the diff.

### `isSteadyState` completeness — **COMPLETE**, verified field by field

`AlertState` has 8 fields. `isSteadyState` (`watchtower.ts:1452-1472`) compares `detail` plus all 8: `status`, `sinceTs`, `lastAlertTs`, `unhealthyObs`, `alertCount`, `healthyObs`, `realertCount`, and `announcedKeys` both by `overflow` and by deep key-array equality. Nothing is omitted. The builder's own what-would-catch-this holds.

### The two STOP-AND-REPORT items — honestly out of scope, and **not worsened** by this diff

- **Immortal one-shot rows.** The design's §7.4 requires only that the GC exclude `status = 'unhealthy'`; it specifies no clearing path, and grep confirms the design contains none. B.2 adds three columns of bytes per row (already priced in the retention docstring) and gives those families exempt budget + `recoverAfter: 1`. A one-shot is observed once, so no ladder can fire; a *second* failure at the same address with a different key now escalates once, budget-exempt — new behaviour, and the correct direction for money-bearing checks.
- **Single-wedged-tenant staleness.** Not in the design (N8). B.2 makes the adjacent hazard **better, not worse**: §7.5's binding requirement is that a rotation-skipped tenant emit no `CheckResult`, and it holds — `scanTenants` iterates `resolveSweepTenants(env, scope)` and `sendPipelineChecks` is called per visited tenant with that tenant's own summary and a tenant-scoped `reported` set. Had healthy-by-absence existed, HEAD would have closed an episode on **one** such result; B.2 requires **three**.

---

## Attacks that FAILED (what makes the green meaningful)

- **Lens 2 — the design gate's flagship alternation, on the real machine, not a model.** 13 ticks / 2 alternating modes on an announced episode: `["escalated", "suppressed" x12]`, **exactly 1 email**. Three rotating modes: **exactly 2**. Matches §5.3 and the gate's numbers.
- **Lens 6 — cap-vs-ladder over 30 simulated days** with a brand-new key every tick (8,640 ticks): **35 emails, 8,604 `key_cap` suppressions, `announced_keys` = 5 keys / overflow 8604, `realert_count` 30**. Ladder-first survives the cap; row 3 is a fall-through, never terminal. Constraint 2 holds.
- **The overflow disclosure actually reaches a human.** The next ladder email's body contains "further distinct condition(s) on this check were not announced separately". A cap that silently drops information would have been a finding; it does not.
- **Recovery drain / constraint 12.** 100 announced-then-simultaneously-recovering instances: rows still unhealthy went 100 → 100 → **0** at the third clean observation (exactly `recoverAfterObservations`), **15 recoveries ≤ 15 announcements**, zero episodes blocked from closing by any budget decision. No check ever read `unhealthy` while healthy beyond the designed hold.
- **Lens 7 — mid-episode deploy on a live-shaped row.** Seeded the exact post-0021 shape for an announced, in-cooldown episode (`alert_count 4`, `realert_count 1`, `healthy_obs 0`, `announced_keys` at the column DEFAULT): three ticks produced `["suppressed/suppressed_cooldown" x3]`, **0 emails**, ledger silently adopted `pending`. **No mass re-alert.** Then the 24h rung came due and the ladder fired exactly once — **no mass silence** either. Control arm (same row, ledger holding a *different* key) → `escalated` + 1 email, so the adopt rule is load-bearing, not decorative.
- **DO-storage compat.** A legacy `d1_alert_state` value written without `healthyObs`/`realertCount`/`announcedKeys` normalized and produced **0 D1 emails** on the deploy tick (`action: "holding"`).
- **A corrupt ledger blob does not become a storm.** Seeded `announced_keys = "{not json"`: the first tick took the legacy branch silently (`suppressed`), and subsequent genuinely-novel keys escalated normally — bounded by the cap at ≤4, not one email per condition. My assertion here was wrong and the code was right; reported as a failed attack.
- **Constraint 1 (U-2 polarity).** `holdGrade === false` at `watchtower.ts:373-378`, fed `observed === null` — not `grade`, correctly, since `grade` is nulled for a second unrelated reason (`holdWouldHideRecovery`). `gradeStreak` returns `false` only from its `observedUnhealthy` branch, so the arm is reachable and the v1 inversion is gone.
- **`cronLegsKey`'s (false,false) fallback is unreachable.** `grade === false` implies `observedUnhealthy`, which is the disjunction of exactly the two key inputs. Verified by construction; the fallback would have been a mislabel.
- **The `alert_delivery` filter cannot false-count the new `DeliveryReason`s (design §7.2).** `sweep-signals.ts:215` is an allow-list (`why !== "send_failed" && why !== "dark_channel"` → skip), so `suppressed_daily_budget` / `suppressed_key_cap` / `pending_recovery` can never register as delivery failures. Constraint carried.
- **Migration numbering.** `0021` picked correctly — `0019_sweep_cursor` and `0020_sdn_entries_name_index` are both taken on `main`; no collision; wired into `test/setup.ts`. The design's own re-pick-at-build-time rule was followed and the reason is documented in the SQL header.
- **Constraint 9 (six arriving families).** `policyFor` already routes `sweep_coverage` and `alert_delivery` to `IMMEDIATE` and the three `*_failed:` prefixes to `IMMEDIATE`, with `sweep_signals` deliberately DEBOUNCED. All six have `ALERT_FAMILIES` rows.
- **Constraint 3.** All 26 families declared; widest space is 4 (`failure_signals`, `vendor_wallet`, `tenant_do_wedged:`, `sweep_coverage`, `customer_progress_*`); cap 5 > 4 strictly.
- **Constraints 15 + 17 re-derived from the shipped code**, not from the doc: denial ⟺ `total ≥ 20 ∨ (perEntity ∧ pe ≥ 15)`; `isSaturated` = `total ≥ 20 ∨ pe ≥ 15`; denial ⟹ saturation exactly. Exempt sends never reach the ring (`isBudgetedAnnouncement` filters before `candidates.push`).
- **Regression floor / constraint 17.** `git diff --name-only b260bd0..53d4edd` touches neither `watchtower-deadman.test.ts` nor `continuity-nudge.test.ts` — **unedited**, and both pass in the 238-file run.
- **Nothing is flag-gated.** Grepped the whole diff for flag/env-gating patterns: no feature flag, no dark path. Constants ship as designed: 20 / 15 / 5, `SUSTAINED_HOLD_TICKS` 144, `WATCHTOWER_RECOVER_OBSERVATIONS` 3.
- **`announcementOrder`'s round-robin loop cannot spin.** Every candidate lands in exactly one family queue, so `ordered.length` reaches `candidates.length`; `pruneRing` additionally trims to the ring bound so a corrupted value cannot make the counters unbounded.
- **The legacy-adopt predicate is unreachable for state the new code writes.** Walked every writer including the withheld paths: `alerted` writes `alertCount` and the first key together; `escalated`/`realerted` only append; `withheldAlertState` copies the previous ledger; `healthyState` zeroes both. The design's claim survives an independent walk.

---

## UNVERIFIABLE

- **The live Mordy baseline** (2 stuck `domain_dns_aging` checks, ~2 emails/day). No prod access. *Resolves with:* `GET /admin/ops/checks?unhealthy=1` at the deployed commit.
- **`tenant_do_wedged:`'s real production duty cycle.** Mechanism and multiplier are proven; the rate is not observed. Carried unchanged from all four design rounds.
- **F1 against the sibling lane's FINAL state.** `sweepcal` is uncommitted and moved during this review's window. F1 is stated against HEAD `33c7916` + dirty tree as read 2026-08-20 ~18:00. *Resolves with:* re-running the F1 trace against the lane's merge commit.
- **N7's "both defective readings."** I could not determine which two readings the design gate's round-4 item 3 names, so I could not reproduce or refute the 672 figure. The invariant it supports is independently verified, so nothing rests on it.

---

## Deploy requirements

1. **Fix B1** — `alertDeliveryKey` must receive the raw `DeliveryReason` values, not the rendered `"<name> (<why>)"` strings (carry the reasons as structured data alongside the prose, or classify at the push site in `collectLegSignals`). One line at the producer or in the reducer.
2. **Add the class guard (B1b)** — a test that, for every family, (a) drives the producer or its key function with the producer's real input shape and asserts the emitted key ∈ the declared space, and (b) asserts **every declared key is reachable**. Prove it by revert-fail on B1 *and* on F1's post-fold `sweep_coverage`.
3. **Reconcile F1 at the fold** before merging with `feat/sweep-calibration-2026-08-20`: re-derive `sweep_coverage`'s key from the sibling lane's rotation-tick grading and re-declare its key space to match what the merged producer can emit. Do not resolve the compile error mechanically. Also reconcile `admin/README.md` (both lanes edit it).
4. **Fix N1's test title** and point it at the mixed-storm fixture that actually discriminates the exemption defect.
5. **Disclose N2 in the §9.13 [RATIFY:founder] ask** — the ≤20/day bound does not hold while the WatchtowerDO is unreachable (measured: 200/24h at 100 instances), the condition is correlated with the storms the budget exists for, and `alert_budget_exceeded` is silent in exactly that state.
6. **Re-run the full battery on the MERGED tree**, per §9.12 — a lane worktree is not the post-merge tree, and F1 guarantees the merged tree differs from both lanes.
7. **After the fold, apply migration `0021_watchtower_alert_state.sql` remotely** and confirm with `wrangler d1 migrations list --remote`. Re-pick the number one more time if any lane lands a migration first — the SQL header states the rule.
