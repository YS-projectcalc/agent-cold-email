# Alert-state increment — design v2 (2026-08-20)

DESIGN ONLY. No source file was touched. v2 answers the design gate
(`docs/adversarial/alert-state-design-gate-2026-08-20.md`, SHIP-AFTER-FIXES, 6 blocking + 7
non-blocking). §-numbering is preserved so the gate's per-§ rulings still map.

## Grounding

| Item | Value |
|---|---|
| Ref | `fd8afca` (main) at v2 close. v1 was written at `69ec655`; gate ran at `f222afc`. `git diff 69ec655 fd8afca --stat` over `apps/`, `packages/` is **empty** — every code reference below still resolves. |
| Mode | READ-ONLY git. One file written: this one. |
| `scalemon` re-read | **The lane moved TWICE during this pass.** v1 recorded it clean; the gate read an uncommitted working tree; it has since **committed as `67f3535`** ("scale: bound the cron sweep's per-tick fan-out and split capacity from failure"), leaving one untracked test file. §3.3/§5/§7 are stated against **`67f3535`**, read directly — not from the gate's summary of the pre-commit tree. |
| Consequence for the gate's N2 | N2 was correct **at the ref it read** and is now **superseded**: the `*_FAILED` trio v1 named DID arrive, as per-entity prefixes with an `IMMEDIATE` classification (`engine/isolated-failure-alerts.ts`, new in `67f3535`). Six families arrive, not three. Detail in §7.3. |
| Line-reference policy (gate: the lane is moving) | Every reference below is anchored on a **function or exported constant name plus the behaviour asserted**, with the line number as a convenience only. A builder who finds the line moved should grep the name; if the *behaviour* moved, that is a finding, not a typo. |
| Verified against v1's own claims | 19 baseline families (`EXPECTED_CONFIRM_OBSERVATIONS`) + 3 arriving in `scalemon` = **22**; `NEXT_STEP_REASONS` = 12 (`packages/shared/src/next-steps.ts`); `waitingOn` = `"operator" \| "customer_billing" \| null`; `0019_sweep_cursor.sql` exists untracked in the lane. |

## POST-FREEZE CORRECTIONS (build round, 2026-08-20) — evidence only, no decision moved

The design is FROZEN; these are corrections to EVIDENCE CITED in the v4 block below, found by
executing it during the build. Every §-decision, constant and constraint is unchanged, and both
corrections make the design's own claims narrower rather than wider. Raised in
`docs/adversarial/alert-state-build-gate-2026-08-20.md` (build gate, ruling + N7).

1. **§6.15b / the v4 table's "reds at 0 on both defective readings" is true of ONE reading, not
   two.** On the pure per-entity fixture the shipped 15/5 sub-cap pins the total at 15/20, which
   *rescues* a budgeted global check through the 5 reserved slots — so the v2 defect (the check
   itself budgeted) leaves that arm **GREEN at 8**; only v3 (`saturated` reading the total counter
   alone) reds at 0. The conflation is between v2's machine, which had no sub-cap, and v4's fixture.
   The build carries BOTH fixtures, each discriminating its own defect: the pure per-entity storm for
   v3, and a TOTAL-saturating mixed storm for the exemption. Verified in both directions by the build
   gate.

2. **§5.5's round-4 item 3 — "672 such ticks under BOTH defective readings" cannot be true of the
   any-withholding reading.** Under any-withholding, `saturated` is broader than denial, so
   `denial ⟹ saturated` holds trivially and the violating count is **0 by construction**; 672 can
   only belong to the total-only reading. Same shape as correction 1. Nothing rests on it: the
   invariant it supports (`denial ⟹ saturated`, exactly) was re-derived from the shipped code and is
   pinned exhaustively over the whole counter space in `watchtower-budget.test.ts`.

### DESIGN DELTA (build round, 2026-08-20) — `alert_budget_exceeded` declares TWO keys

**NOT evidence-only.** This changes §1.2's key-space row for one family and states its §3.3
consequence. Made on an ORCHESTRATOR RULING (option (a) on build-gate N2); gate round 2 rules on the
delta itself, and the fallback if it is refused is option (b) — disclosure in §9.13 only — so the
change is kept in its own commit and reverts cleanly.

| | Frozen (§1.2) | Delta |
|---|---|---|
| `alert_budget_exceeded` key space | `saturated` | `saturated` \| **`unreadable`** |

**Why.** The gate measured the budget's fail-open at 200 announcements/24h against a ratified ≤20,
and named three costs. Two are answered in code (the burst is now bounded at the reserved global
slice per tick, in the budget's own priority order). The third is that the condition is **silent**:
`reportAlertBudgetHealth` reads the same WatchtowerDO, so it returned nothing at exactly the moment
the ceiling was not being applied — *"the founder gets the storm with no explanation."* A check whose
subject is "the alerting channel is not behaving normally" could not say the one thing it most needed
to say. `saturated` and `unreadable` are opposite conditions with opposite founder expectations — the
ceiling IS being applied and mail is queued behind it, versus the ceiling is NOT being applied and
MORE mail is coming — so by §4's own rule (*a new family when the SUBJECT is new; a KEY when the
subject is the same and only the rung differs*) this is a key, not a family.

**§3.3 consequence: none — and that is the point.** The member inherits the family's DEBOUNCED
policy unchanged, which is already right for it: one unreachable tick is a transient RPC failure and
is worth zero emails; two consecutive (10 min) is a real outage. The escalation between the two
members is exactly the escape this increment exists for — an episode that opened `saturated` and then
loses the store escalates ONCE to `unreadable`.

**Invariants checked:** §9.3's `MAX_ANNOUNCED_KEYS_PER_EPISODE > max(|declared space|)` still holds
strictly (2 < 5, and the widest space in the table is unchanged at 4). Budget exemption unchanged —
the family is still group 3, which is what delivers the announcement during the outage it reports
(`isBudgetedAnnouncement` filters exempt families before any slot is requested, so it cannot be
denied one). Both members are pinned reachable END-TO-END through the real producer in
`test/watchtower-key-reachability.test.ts`, and the soundness half of that guard reds if the space is
narrowed back while the producer still emits two.

## What changed in v4 (gate round 3 — 1 blocking + 2 notes, all inside §5.5)

Round 3 accepted v3's NEW-2 refutation and closed NEW-2/3/4/5. It found that **v3's own NEW-5 fix
reopened NEW-1 by a new route** — the last fix was the prime suspect, and it had reopened the
adjacent fix's case. v4 is scoped to that clause and the two notes; nothing else moved.

| Gate item | Where | Shape of the answer |
|---|---|---|
| **BLOCKING** the per-entity sub-cap holds the total counter at 15/20, so `saturated` (keyed to "the rolling-window counter", singular) never fires in a pure per-entity storm — 0 sent over 7 days | §1.2 row, §5.5 counter + ordering (iii) | `saturated` reads **EITHER counter at its cap**; the sub-cap now carries a pointer to the coupling it creates |
| Arm 15b could not have caught it | §6.15b | Fixture pinned to a **PURE per-entity** storm, asserting **8 delivered**, reds at 0 on both defective readings |
| NB: exempt sends and ring slots undecided | §5.5 counter | **They do not consume and are not recorded** — reasoned from what an exemption is for, with both costs of that answer handled rather than accepted |
| NB: the constant bounds announcements while the founder counts emails (30.0/day measured against a constant named 20) | §5.5 throughout, §9.13 | Constant **renamed** `MAX_ALERT_EMAILS_PER_DAY` → `MAX_ANNOUNCEMENT_EMAILS_PER_DAY` (a name that overstates its guarantee is this repo's claim-drift class), and §9.13's ask restated in inbox units |

## What changed in v3 (gate round 2 — 2 blocking + 3 NB, all inside §5.5)

Round 2 verified all six round-1 fixes closed by re-simulation and retracted its own N2. The two new
blockers are defects in §5.5, the mechanism v2 added; everything below is scoped to it.

| Gate item | Where | Shape of the answer |
|---|---|---|
| **NEW-1** `alert_budget_exceeded` is budgeted by the budget it announces (0 sent / 2015 withheld) | §5.5 exemptions | Added as a third exemption GROUP with its own reason — the repo's "an alarm must not depend on what it monitors" class, the same reason `cron_sweep` is debounce-exempt |
| **NEW-2** `recovered` under the budget is undecided; both readings cost | §5.5 ruling | **Recoveries are EXEMPT, and the gate's cost estimate for that horn is refuted:** a recovery is owed only for an ANNOUNCED episode, and announcements are what the budget limits, so recoveries ≤ announcements (≤140, not 1,400). Yields **no budget decision can block an episode close** — the 4.0-day false-unhealthy window becomes zero ticks, with **no change to `withheldAlertState`'s recovery-arm semantics** (§5.4's extension for the three new fields still applies) |
| NEW-3 tumbling window sold as rolling (40 emails in 0.20 h) | §5.5 counter | Mechanism fixed, not the name: a bounded ring of ≤20 send timestamps |
| NEW-4 23rd family uncovered by §1.2/§3.3, and §4's reasoning inconsistent | §1.2, §3.3, §4 | Key space + policy row added; and a stated rule reconciles it — **new SUBJECT ⇒ family, same subject different rung ⇒ key** |
| NEW-5 round-robin cannot cross the three entry points | §5.5 ordering | Scope stated honestly, and the gap CLOSED rather than documented: a **reserved 15/5 split** so a per-entity storm cannot starve the monitor's own checks |

## What changed in v2

| Gate item | Where it is answered | Shape of the answer |
|---|---|---|
| **B1** U-2 arm unreachable | §4 | Polarity fixed to `holdGrade === false`; RED test added that fails on the v1 form |
| **B2** escape-vs-ladder precedence / cap deletes the ladder | §1.4 | **Ladder is evaluated FIRST, escape falls through**; cap-suppression is no longer terminal |
| **B3** cap calibration false | §1.2, §1.4 | Every declared space narrowed to **≤ 4**; cap 5; invariant tightened to `cap > max(space)` |
| **B4** `send_starved:` claim inverted | §3.2, §5.2, §8 | **IN-9 accepted as INERT there**, stated; the alternative is costed and rejected; root cause named as a producer-side non-goal |
| **B5** ~2/day not established (per-instance multiplier absent) | §5 (rewritten) + new **§5.5** | Honest per-inbox-per-day arithmetic (**~100/day realistic, ~1,400/day pathological, at 100 tenants**) + a **daily alert budget** with family round-robin as the binding mechanism |
| **B6** `holding` reopens the continuity nudge, silently | §3.1, §5.4 | Onset adoption gated on `healthyObs === 0`; four-step scenario is an acceptance test |
| N1 escalation deletes the 6h rung | §1.4 | Ladder rung split off `alertCount` into `realertCount`; escalations are rung-neutral |
| N2 wrong arriving families | §1.2, §3.3, §7.3 | **Superseded by the lane's commit — SIX families arrive, not three.** All six named, classified, key-spaced; the gate's "all three are streak-damped" corrected to two of three |
| N3 migration collision | §2.1 | `0020`; and the number is re-picked at build time, not trusted from this doc |
| N4 SDN has no delivery-outcome plumbing | §2.4, §8 | SDN ledger **deferred behind a stated prerequisite**; the gate's "§0 not upheld for SDN" is partially refuted, with reasons |
| N5 `AlertAction` consumers under-enumerated | §3.5 | All four enumerated; the silent `default` becomes an exhaustiveness check |
| N6 `/admin/ops/checks` self-contradictory during `holding` | §3.1 | `last_detail` is not overwritten by a healthy producer while holding |
| N7 cite error | §1.2 | Two call sites, one carrying a ternary |

---

## §0 The mechanism, and why the six are one increment

> **The suppression decides on a two-valued comparison, so it cannot tell a repeat from an
> escalation, nor an intermittent recurrence from a resolved flap.**

| Axis | The comparison today | What it cannot express | Members |
|---|---|---|---|
| **Entering an episode** | `status` healthy/unhealthy; `unhealthyObs` zeroed by ANY healthy observation (`healthyState`) | "unhealthy twice, not consecutively" | IN-9, U-2 |
| **Inside an episode** | `last_detail` overwritten; nothing compared at all (`decideAlert` phase 2, `reconcileSdnAlert`'s suppress branch) | "a different, worse condition under the same check name" | IN-10, IN-11, IN-12, IN-17, NB3 |

**The coupling (gate: UPHELD for the watchtower store).** §1's announced set is bounded only if
episodes do not churn, and episodes stop churning only because of §3's recovery confirmation. Ship
§1 alone and every flap opens a fresh episode with an empty ledger, so every key re-announces.

**Where the coupling does NOT bind — SDN (partial refutation of the gate's §0 ruling).** The gate
ruled §0 "NOT upheld for SDN" because §2.4 shipped §1 there without §3. The coupling argument is
about episodes churning on *ambiguous* clears — a clear that is a filter departure rather than a
measurement. SDN's clear is neither: `reconcileSdnAlert` closes the streak only on
`outcome.success`, which is a list that actually loaded and parsed. A recovery confirmation there
would delay a true recovery email for no gain, and SDN's episode boundary is already trustworthy.
So SDN needs §1 **without** §3 — but it does not get §1 in this increment either, for the different
reason N4 gives (§2.4).

---

## §1 Decision 1 — materiality keys and the per-episode announced ledger

### §1.1 What a materiality key is

A **materiality key** is a bounded, producer-stated classification of an UNHEALTHY observation,
derived from structured facts the producer already holds, never from rendered prose. (Gate: UPHELD,
unchanged in v2.)

1. **Never the detail string, never a count.** `tenant_do_wedged:`'s detail embeds `errMsg(err)`;
   `vendor_wallet`'s embeds `JSON.stringify(body)`; `failure_signals`' and `sweep_coverage`'s embed
   counts that move almost every tick. Keying on any of them means one email per variant.
2. **Declared per family, as a closed enumeration**, in one table beside `policyFor`. Undeclared ⇒
   cannot alert (enforced failing-by-construction, §6.9).
3. **Required, not optional** — on the `healthy: false` arm of `CheckResult`, exactly as `basis` is
   required on the healthy arm. That precedent is in-repo and load-bearing: it does not compile
   until each producer states which it is. An optional field with a default re-creates the
   silent-inherit failure that making `policy` a required argument was introduced to stop.

Cost: `grep -c 'healthy: false' apps/platform/src` = 23 in 6 files at `fd8afca`, one of which is the
type declaration in `watchtower-alerts.ts` ⇒ **22 producer expressions**; the `scalemon` lane adds 3
more.

### §1.2 The key table — every space narrowed to ≤ 4 (B3)

`✱` = a family where an escalation is a genuinely different, action-changing condition.

| Family | Key space (closed) | Derived from | Size |
|---|---|---|---|
| `domain_dns_aging:` ✱ | `pending` \| `gave_up` | `agingPendingDomains[].gaveUp` | 2 |
| `failure_signals` ✱ | `failed_elevated` (3-99) \| `failed_severe` (100+) \| `complaints` \| `sustained_subthreshold` (§4) | banded grade, never the raw count | **4** |
| `warmup_cancel_gave_up` ✱ | `gaveup_b1` (1) \| `gaveup_b2` (2-4) \| `gaveup_b3` (5+) | give-up count band | 3 |
| `cron_legs` ✱ | `counted` \| `threw` \| `both` | **the KIND of failure, not which leg** — `LegSignals.legsThrew.length > 0` × `counted > 0` | **3** |
| `vendor_wallet` ✱ | `unreachable` \| `shape_drift` \| `below_floor_autotopup_on` \| `below_floor_autotopup_off` | the four arms already branched in `evaluateVendorChecks` | 4 |
| `warmup_duplicates` ✱ | `dup_b1` (1) \| `dup_b2` (2+) | duplicate count band | 2 |
| `mailbox_provisioning:` ✱ | `lookup_failed` \| `too_recent` \| `rebuy_attempting` | the **two** `alertMailboxStuck` call sites, the first carrying a `lookup_failed`/`too_recent` ternary (N7 — v1 said three sites; there are two) | 3 |
| `mailbox_rebuy:` ✱ | `unusable_at_vendor` \| `budget_spent` \| `dispatch_failed` | the three `alertMailboxRebuyFailed` call sites | 3 |
| `tenant_do_wedged:` ✱ | `rpc_unreachable` \| `constructor_throw` \| `storage_throw` \| `other` | a CLOSED map over `err.name`, never `err.message` | 4 |
| `customer_progress_operator:` ✱ / `customer_progress_agent:` | `ours_to_fix` \| `capacity_or_money` \| `waiting_on_infra` \| `customer_side` | a closed map over the 12 `NEXT_STEP_REASONS`, applied to the highest-precedence owed step | **4** |
| `sweep_coverage` ✱ (arriving) | `slice_unreadable` \| `rotation_behind` \| `in_tick_deferral` \| `both` | `coverage === null`, `coverageTicks > COVERAGE_TICKS_ALERT_AFTER`, `signals.deferred > 0` | 4 |
| `alert_delivery` ✱ (arriving) | `dark_channel` \| `send_failed` \| `both` | `undeliveredAlerts.reasons`, already a closed `DeliveryReason` subset | 3 |
| `sweep_signals` (arriving) | `threw` | — | 1 |
| `mailbox_release_failed:` ✱ (arriving) | `vendor_threw` \| `still_slot_counted` | the `forEachIsolated` failure item's own outcome | 2 |
| `domain_ordinal_failed:` ✱ (arriving) | `setup_threw` \| `paid_no_infra` | as above | 2 |
| `mailbox_slot_failed:` ✱ (arriving) | `buy_threw` \| `paid_no_infra` | as above | 2 |
| `d1`, `engine`, `do_storage` | `down` | — | 1 |
| `send_starved:`, `cred_push_aging:`, `mailbox_orphan:`, `domain_orphan:` | `starved` / `aging` / `orphaned` / `orphaned` | — | 1 |
| `alert_budget_exceeded` (new, §5.5) | `saturated` | **EITHER counter at its cap** — total ≥ `MAX_ANNOUNCEMENT_EMAILS_PER_DAY` **or** per-entity ≥ `MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY`. Not the total alone: in a pure per-entity storm the sub-cap binds first and the total peaks at 15/20, so a total-only reading never fires (gate round 3, 0 sent over 7 days) | 1 |
| `cron_sweep` (dead-man) | `stale` | — | 1, **hard-exempt from the escape entirely** |

**max(\|declared space\|) = 4.** Three v1 spaces were narrowed, each with a stated loss:

- **`cron_legs`: combinatorial → 3.** v1 keyed on the SET of failing legs. The escalation that
  actually changes the founder's action is *a leg that was counting errors is now THROWING* — that
  is the kind, not the identity. Which legs they are rides the body (zero emails). **Loss, stated:**
  leg A erroring and later leg B erroring is the same key and gets no escalation email; the body
  updates and the ladder still fires.
- **`customer_progress_*`: 12 → 4.** Keying on the reason gives 12; keying on `waitingOn` gives 3
  but is near-constant per name (the blame is already in the name). The action class is the fact the
  founder acts on. The map is over a closed array, so a 13th reason reds the guard (§6.9).
- **`failure_signals`: 5 → 4.** Three count bands collapse to two. **Loss, stated:** a 3 → 15 jump
  no longer escalates; a 3 → 120 jump does. IN-11's "genuinely new and larger burst" is preserved at
  the order-of-magnitude boundary only.

**SDN's key space is not in this table** — its ledger is deferred (§2.4/N4). When it lands, its 5
classes exceed 4 and force an explicit cap decision, which §6.9's guard will red rather than allow
silently.

### §1.3 The announced ledger

Per check, per episode: `{ keys: string[]; overflow: number }`.

- `keys` — every materiality key **actually announced** (a delivered email, or a digest-channel
  transition that genuinely fired).
- `overflow` — distinct keys suppressed by the cap, so the next ladder email can say so.
- Cleared where `healthyState` already zeroes the counters — on episode close only.

### §1.4 Precedence, the ladder, and the cap (B2, B3, N1)

**Phase-2 order is now stated, and it is LADDER-FIRST.** For an open, already-announced episode:

| # | Condition | Action | Ledger | Ladder |
|---|---|---|---|---|
| 1 | `nowMs - lastAlertTs >= gapMs` | `realerted` | append this tick's key if novel and under cap (the re-alert body carries it — no second email is owed) | `realertCount += 1` |
| 2 | else, key novel, `\|keys\| < cap` | **`escalated`** | append | **unchanged** |
| 3 | else, key novel, `\|keys\| >= cap` | `suppressed` | `overflow += 1`, `why: "suppressed_key_cap"` | unchanged |
| 4 | else | `suppressed` | — | unchanged |

Two consequences, both of which were gate blockers:

- **A cap-hit tick still gets its ladder email** (row 1 precedes row 3), so an episode at the cap
  that stays broken emits ~30 emails over 30 days, not 5 then silence. Row 3 is no longer a terminal
  outcome for the tick; it is the *fall-through* after the ladder declined.
- **An escalation is rung-neutral (N1).** Today `gapMs = alertCount >= 2 ? steady : first`, so any
  increment of `alertCount` promotes the check from the 6 h rung to the 24 h rung — an escalation
  would silently delete the "still broken" ping. `alertCount` is carrying two facts (was this
  episode announced × how many rungs climbed). **Split it:** `realertCount` (incremented only by
  `realerted`) drives `gapMs = realertCount >= 1 ? steady : first`; `alertCount` keeps counting every
  issued email for the `alertCount > 0` recovery gate. This is byte-identical to today's ladder —
  `realertCount >= 1` ⟺ today's `alertCount >= 2` — which `watchtower-policy.test.ts`'s existing
  `sustained()` expectations pin without edit. With the split, §1.4's sentence "the 24 h reminder is
  pushed out by exactly the email that just went out" becomes true, which it was not in v1.

**The cap: `MAX_ANNOUNCED_KEYS_PER_EPISODE = 5`, invariant `cap > max(|declared space|)`.** Strictly
greater, not `>=`: the cap then **can never bind on a correctly-declared family** and binds only on a
mis-derived or undeclared key. That is the safety argument — the anti-storm bound does not depend on
all 22 key derivations being right — and unlike v1's version it is satisfiable, because §1.2 now
tops out at 4.

Fields added to `AlertState`, total: `healthyObs`, `realertCount`, `announcedKeys`. Three.

---

## §2 Decision 2 — compat with stores that have no migration mechanism

(Gate: §2.1-§2.3 UPHELD by simulation — 0 deploy-day emails on a pre-migration row, and the
unreachability argument checked against every writer. Unchanged in v2 except the migration number
and the SDN deferral.)

### §2.1 D1 `watchtower_state` — migration 0020 (N3)

```
ALTER TABLE watchtower_state ADD COLUMN healthy_obs     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchtower_state ADD COLUMN realert_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchtower_state ADD COLUMN announced_keys  TEXT NOT NULL DEFAULT '{"keys":[],"overflow":0}';
```

`0019` is taken by `0019_sweep_cursor.sql`, untracked in the `scalemon` lane this design sequences
*behind* — so v1's number was wrong the moment the merge order is honored. **The rule, not the
number: re-pick from `ls apps/platform/migrations | tail -1` at build time.** A number written in a
design doc is stale by construction when another lane is in flight.

`realert_count` backfill: `UPDATE watchtower_state SET realert_count = 1 WHERE alert_count >= 2` —
preserves each in-flight episode's current rung exactly (0018's backfill credited `alert_count = 2`
to running episodes precisely so they sit on the 24 h step; without this line they would drop back to
the 6 h rung and emit one extra email each on deploy day).

No backfill for `announced_keys` — see §2.2.

### §2.2 The legacy-adopt rule

> An episode with `alertCount > 0` and an EMPTY ledger adopts its first observed key **silently** —
> no email, key appended, counters untouched.

Safe because the predicate is **unreachable for state the new code writes**: `alerted` writes
`alertCount` and the first key together; `escalated`/`realerted` only append; `withheldAlertState`
copies the previous ledger; `healthyState` zeroes both. (The gate walked every writer independently
and confirmed it.) One rule covers D1 *and* DO storage, which is the point — a backfill only reaches
one of them.

A `JSON.parse` failure on the blob takes the **legacy** branch and logs; never "empty". Empty here
means re-announce every key in the episode, i.e. a corrupt byte becomes a storm.

### §2.3 DO storage

`PersistedAlertState`'s Partial pick gains the three fields; `normalizeAlertState` supplies them. The
surface is **inert by construction**: the only DO-resident checks are `d1` and `cron_sweep`, both
single-valued key spaces, neither able to escalate. `commitD1Alert`'s accepted residual is not
worsened — a persistently failing commit already loses `unhealthyObs`; losing the ledger too costs a
duplicate escalation, the direction that catch block already accepts.

### §2.4 SDN — the ledger is DEFERRED behind a stated prerequisite (N4)

v1 put the ledger in `sdn_alert_state`. It cannot go there yet: `sendSdnAlertEmail` returns `void`,
returns silently when `OPS_ALERT_EMAIL` is unset, and swallows every send throw. A dark-channel
escalation would bank its key and be **permanently deleted** — the exact outcome §5.4 forbids.

**Ordered prerequisite, then the ledger:**

- **P0 (this increment or its immediate successor):** `sendSdnAlertEmail` returns `Notified`;
  `reconcileSdnAlert` threads it; its state write applies the same withheld rule the watchtower store
  applies. `SdnAlertAction` gains nothing yet.
- **P1 (only after P0):** the ledger column + the adopt predicate
  (`failure_streak > 0 && last_alert_ts IS NOT NULL && keys.length === 0`) + SDN's 5 failure classes,
  with the cap re-decided at that point (§1.2).

**Consequence, stated plainly: IN-17's own site is not closed by this increment** — only its
mechanism, its class-mates, and the prerequisite are. That is a deliberate scope cut, and it is the
gate's constraint 8.

### §2.5 Rejected: version rows

Unchanged (gate: UPHELD). `ADD COLUMN … DEFAULT` is what 0018 did and what the repo reviews; DO
storage cannot be migrated at all, so the normalize seam is mandatory regardless and a version field
there is one more thing to normalize.

---

## §3 Decision 3 — confirmation and recovery (IN-9)

### §3.1 The rule

| Observation | Today | After |
|---|---|---|
| unhealthy | `unhealthyObs += 1` | `unhealthyObs += 1; healthyObs = 0` |
| healthy, `reobserved`, `healthyObs + 1 < recoverAfter` | closes, all counters zeroed | **`holding`** — silent; status stays `unhealthy`; `unhealthyObs`, ledger and `realertCount` preserved |
| healthy, `reobserved`, `healthyObs + 1 >= recoverAfter` | as above | `recovered` (if `alertCount > 0`) else `healthy`; episode CLOSES |
| healthy, `no_longer_applicable` | closes | **unchanged — closes in ONE observation** |

The confirm gate becomes "N unhealthy observations not yet answered by a full recovery run" — the
exact wording the already-shipped sibling fix uses one layer down in `gradeStreak`.

Two rules `holding` drags with it, both of which were gate findings:

- **(B6) `holding` must be invisible to onset adoption.** The adoption in `reconcileAlerts` fires on
  `siblingState.status === "unhealthy"`, a population that now includes siblings whose *producer*
  said healthy. **Gate the predicate on `siblingState.healthyObs === 0`.** `healthyObs > 0` means the
  producer has already reported healthy at least once, so that sibling is not carrying a live stall
  and its onset must not be inherited. The legitimate same-tick blame flip is unaffected:
  `stateByName` is the pre-pass read, so on the flip tick the abandoned sibling still reads
  `healthyObs === 0`. *Rejected alternative:* a distinct `status = 'recovering'`. It would fix N6 too,
  but it ripples into `readAllCheckRows`, `readCheckStatus`'s two-value union, `reported`-set
  consumers, and the wire shape of `GET /admin/ops/checks` — which the 2-hourly watch cron parses
  with `?unhealthy=1`. Not worth it for a 15-minute display state.
- **(N6) `holding` must not overwrite `last_detail` with a healthy producer's prose.** Today the
  upsert writes `result.detail` unconditionally, so a holding row would read `status='unhealthy'`
  beside "Domain X now has working mail DNS". While holding, keep the last UNHEALTHY detail; the
  `healthy_obs` column is what tells an operator a recovery is in progress.

### §3.2 Why `no_longer_applicable` does NOT get a confirmation — and what that costs (B4)

It is not a measurement of the condition; it says the entity left the population. Requiring three of
them would break two shipped, gate-ratified properties: the continuity blame-flip cross-clear needs
one-tick closure (N-3), and a departed entity never produces another observation, so its episode
would stay open and re-alert on the 24 h ladder forever.

**v1's `send_starved:` sentence was inverted, and the correction is a real scope admission.** The
drain arm emits `no_longer_applicable` (its own shipped comment: *"Only the mailbox half is evidence
that capacity came back"*). Under §3.1 that **closes the episode in one tick and zeroes the count**,
which is strictly stronger than "does not count as recovery evidence". **Ruling: IN-9 is INERT for
`send_starved:`, and this design accepts that rather than special-casing it.**

The alternative — giving the drain arm episode-holding semantics — is rejected on three grounds:
it contradicts §3.1's departure rule; it puts a per-tenant family into B5's multiplier (100 instances
at 100 tenants); and it does not fix the root cause, which is that the unhealthy predicate conjoins a
**capacity** fact (`eligibleMailboxes === 0`) with a **demand** fact (`dueNonDemoPendingSends > 0`),
so a tenant with zero send capacity is "healthy" whenever its queue happens to be empty. That is a
producer-side predicate change with its own blast radius (it would fire for every newly-activated
tenant mid-provisioning) — named as a non-goal in §8, not smuggled in here.

### §3.3 Per-policy defaults — all 22 families

| Policy | `confirmAfter` | `recoverAfter` | Members | Reason |
|---|---|---|---|---|
| `DEBOUNCED` (+ digest twin) | 2 | **3** | `d1`, `do_storage`, `engine`, `failure_signals`, `warmup_cancel_gave_up`, `vendor_wallet`, `warmup_duplicates`, `cred_push_aging:`, `send_starved:`, `tenant_do_wedged:`, `domain_dns_aging:`, `mailbox_orphan:`, `domain_orphan:`, `customer_progress_operator:`, `customer_progress_agent:`, **`sweep_signals`**, **`alert_budget_exceeded`** | 3 clean 5-minute ticks = 15 min, matching the `LEG_RECOVER_AFTER_SWEEPS` hysteresis one layer down. `alert_budget_exceeded` is re-observed every tick from the counter, so the default applies — a single tick that touches the ceiling is a flap and should cost nothing; two consecutive (10 min) is a saturated channel |
| `IMMEDIATE` | 1 | **1** | `cron_legs`, `mailbox_provisioning:`, `mailbox_rebuy:`, **`sweep_coverage`**, **`alert_delivery`**, **`mailbox_release_failed:`**, **`domain_ordinal_failed:`**, **`mailbox_slot_failed:`** | The confirm-side exemption reason transfers verbatim: a one-shot is never re-observed (a confirmation would DELETE the recovery, not delay it), and a `gradeSweepStreak`-damped check already requires 3 consecutive clean ticks upstream — a second confirmation double-damps it to 30 min |
| `DEAD_MAN` | 1 | **1** | `cron_sweep` | Hard exemption. Timing byte-identical; `watchtower-deadman.test.ts` must pass unedited |

**N2, corrected — and the gate's own claim is one family too broad.** The three arriving families are
`sweep_coverage`, `sweep_signals`, `alert_delivery` (not the `*_FAILED` activity-row strings v1
named). The gate says all three are `gradeSweepStreak`-damped; **only two are.** Read directly from
the lane's working tree: `sweep_coverage` and `alert_delivery` each call
`watchtowerStub(env).gradeSweepStreak(...)` before pushing a result, but `sweep_signals` is produced
by `reportSweepSignalsHealth` from a per-tick boolean through `reportCheck`, and its own docstring
states the choice: *"Its policy is the DEBOUNCED default, so one flaky tick costs nothing and a
genuine outage pages within two cron periods."* So `sweep_signals` is correctly DEBOUNCED and the
other two must be reclassified to `IMMEDIATE` — which the lane has **not** done: `policyFor` in that
worktree has no branch for any of the three, so all three currently take the DEBOUNCED default. That
is a pre-existing double-damp on the confirm side in the lane, and §3.3's default would add a second
one on the recovery side.

### §3.4 Both failure modes, closed — and the residual

(Gate: UPHELD by simulation — first alert at minute 10; HEAD emits 0 over the same 24 ticks.)

- **Intermittent never confirms:** alternating bad/good now reads `pending`@0 → `holding`@5 →
  **`alerted`**@10 on any `reobserved`-clearing check, inside the founder's 10-15 min ceiling.
- **Once-a-month flake eventually pages:** a single bad tick then 3 clean ticks closes the episode at
  15 min and zeroes the counters — 0 emails, exact parity with today. A carried count *without*
  episode closure is what pages eventually; the carry and the closure are one decision.
- **Residual, a knob and not an oversight:** a fault is detectable iff two failures occur with fewer
  than `recoverAfter` clean observations between them — two failures within 20 minutes at today's
  5-minute per-check cadence (in observations, not minutes, if S1 rotates the scan — §7.5). A check
  failing once every 4+ ticks (≤25% duty) closes its episode between failures and stays silent.

### §3.5 Vocabulary — every consumer enumerated (N5)

- `AlertAction` gains **`holding`** and **`escalated`**.
- `DeliveryReason` gains **`pending_recovery`**, **`suppressed_key_cap`**, **`suppressed_daily_budget`**
  (§5.5). All additive.
- **The four read sites, all of which must be edited together:**
  1. `alertEmailFor`'s switch — its `default: return null` becomes an exhaustiveness check over
     `AlertAction` (the repo's existing `unhandled … verdict` idiom). A forgotten `escalated` case
     would otherwise drop the email *while the ledger records the key as announced* — a permanent
     deletion.
  2. `wouldEmail` in `reconcileAlerts` — a SECOND, independent enumeration of the email-owing
     actions; `escalated` must join it or the digest-channel `why` is wrong.
  3. `reasonForNoEmail` — falls through to `nothing_owed` for any unmapped action, so `holding`
     would report "there was nothing to tell". Map it to `pending_recovery`.
  4. `SdnAlertAction` — a separate union. Untouched this increment (§2.4), stated so the next editor
     knows it exists.

---

## §4 Decision 4 — U-2, with the polarity fixed (B1)

**The v1 composition was a no-op.** `gradeStreak`'s arms are disjoint by input: fed
`observedUnhealthy = (grade === null)`, a tick satisfying `grade === null` took the first branch,
which can only return `false` or `null`. `true` is unreachable there, so v1's `grade === null &&
holding` was always falsy — the gate ran 300 ticks and got 0 results, byte-identical to HEAD.

**Corrected composition** (`false` = the streak has reached its threshold = the dead band has been
occupied continuously):

```
grade     = gradeFailureSignals(failed, complaints)
holdGrade = await stub.gradeSweepStreak("failure_signals_hold", grade === null, SUSTAINED_HOLD_TICKS, 1)
  grade === false                  -> unhealthy, key = band(failed, complaints)
  grade === null && holdGrade === false -> unhealthy, key = "sustained_subthreshold"
  grade === true                   -> healthy, basis reobserved
```

`SUSTAINED_HOLD_TICKS` = 144 (12 h at the 5-min cadence); recover parameter 1, so one genuinely clean
window clears the hold streak. Reuses the DO's existing generic keyed streak store — **no new store
and no new grader**, only an explicit threshold parameter on that RPC (additive; DO and Worker deploy
together).

*Interaction, stated:* a tick where `grade === false` feeds `observedUnhealthy = false` and clears the
hold streak. So dead-band ⇄ over-threshold oscillation never accumulates 144 consecutive hold ticks —
acceptable, because the over-threshold ticks emit the real signal on their own arm.

The rejections stand (gate: sound, and they survive the fix):

- **(a) Lower `FAILURE_SIGNAL_FAILED_THRESHOLD` — REJECTED.** Destroys a still-correct product
  rationale ("three in an hour is a pattern, not an address") and does not close the class: whatever
  the threshold, there is a sustained rate just below it.
- **(b) Widen `Grade` — REJECTED as insufficient.** `Grade` is already three-valued. The missing
  information is **temporal**, not categorical, and the store it needs already exists.
- **(c) A separate `failure_signals_sustained` family — REJECTED, narrowly.** It spends a whole
  family, a second episode/cooldown pair and a permanent `watchtower_state` row to express **a rung
  of an existing check**. Under (c′) the sub-threshold → over-threshold escalation is exactly a
  materiality-key change, which is the mechanism this increment builds anyway.

  **The rule that makes this consistent with §5.5 adding `alert_budget_exceeded` (NEW-4).** The gate
  fairly noted that §4 rejects (c) partly for adding a family and §5.5 then adds one. The objection
  was never "a family is expensive" in the abstract:

  > **A new FAMILY is warranted when the SUBJECT is new. A materiality KEY is warranted when the
  > subject is the same and only the rung differs.**

  `failure_signals_sustained` has the same subject as `failure_signals` (terminal send failures) and
  differs only in severity rung ⇒ key. `alert_budget_exceeded`'s subject is **the alerting channel
  itself**, not any platform condition, and no existing check's key could carry it ⇒ family. The
  same rule explains why the lane's `sweep_coverage` is correctly its own family rather than a
  `cron_legs` key: capacity and failure are different subjects.

**Named boundary (NOT fixed here).** `failure_signals` is a global roll-up; at 100+ tenants the summed
count sits above threshold permanently, pinning the check unhealthy and blinding it — S4's disease at
a different site, belonging to the scale train. The key is a band over the **graded severity**, not
the raw count, so re-expressing the observation as a rate over a denominator changes the band inputs
and nothing else.

---

## §5 Decision 5 — blast radius, per inbox per day (B5, rewritten)

### §5.1 What v1 got wrong

v1 proved a **per-episode** ceiling and asserted a **per-inbox-per-day** property. Those are
different quantities, and the multiplier between them — instance count — is exactly what v1's own
Grounding row conceded is unbounded and then never applied. 12 of the 22 families are per-entity.

### §5.2 The honest arithmetic, uncapped

A family reaches the never-closing "flapper" state iff its clear arm is `reobserved` (a
`no_longer_applicable` clear closes in one tick) **and** it is re-observed every tick. Steady state
for one such instance is **1 email/day** (confirm, then the 24 h ladder; escalations are bounded per
episode, not per day).

Worst-case instance counts at 100 tenants (2 domains, 4 mailboxes each — Mordy's live shape):

| Family | Clear arm | Instances @100 tenants | Flapper-reachable |
|---|---|---|---|
| `tenant_do_wedged:` | `reobserved`, unconditional | **100** | **yes** — any throw from the `opsSummary` RPC |
| `customer_progress_operator:` | `reobserved` when in scope | **100** | **yes** |
| `domain_dns_aging:` | `reobserved` only if DNS ready | 200 | yes, needs DNS flapping |
| `cred_push_aging:` | `reobserved` only if pushed | 400 | yes, needs push status flapping |
| `mailbox_orphan:` / `domain_orphan:` | `reobserved` only if now live | 400 / 200 | rare |
| `send_starved:` | drain arm is `no_longer_applicable` | 100 | **no** (§3.2 / B4) |
| `mailbox_release_failed:` / `domain_ordinal_failed:` / `mailbox_slot_failed:` (arriving) | one-shot, event-driven | unbounded per batch | **no** — never re-observed, so they contribute BURST volume, not steady-state (§5.5) |
| 10 global families | mixed | 1 each | yes |

Summing the flapper-reachable per-entity rows: 100 + 100 + 200 + 400 + 400 + 200 = **1,400
instances**, each worth ~1 email/day in a never-closing episode, plus the 10 global families.
**Uncapped pathological worst case ≈ 1,400 emails/day**, and the *realistic* case is the correlated
one the scale
lane exists for: a transient cross-DO RPC failure at 50% duty across 100 tenants ⇒ 100 confirms then
**~100/day**, against a ratified ~2/day. v1 named `send_starved:` and `d1` as the flapper exemplars;
both were wrong — the first cannot reach the state, the second is a single global instance.

### §5.3 The alternation proof (gate: UPHELD, exactly — unchanged)

Two alternating modes, 13 ticks, episode already announced at key A: **1 email** (`escalated` at
tick 2; `suppressed` for the other 11). If both modes map to the same class — HTTP 525 and 503 both
`http_5xx` — the total is **exactly 1**, because the key is a class, not a string.

> **Emails per episode ≤ 1 + min(distinct keys − 1, cap) + ladder rungs + 1. Tick count does not
> appear.** Still true — and §5.5 is what turns it into a per-DAY bound.

### §5.4 What must NOT regress

- **Dead-man** — `recoverAfter: 1`, no escape, no constant touched, exempt from §5.5's budget.
- **Continuity N-3** (cross-clear) — holds; closure is one tick.
- **Continuity N-2** (exactly-once nudge) — v1 asserted this was "more exactly-once, never less" and
  walked only the duplicate direction. **The gate proved the silent direction:** `holding` leaves a
  cleared sibling readable as unhealthy, the onset adoption inherits an old `T0`, and
  `maybeEmitContinuityNudge`'s `>=` guard returns early — **zero nudges for the new episode's entire
  duration**. Closed by §3.1's `healthyObs === 0` gate; B6's four-step scenario is an acceptance test
  (§6.14), not a note.
- **Withheld sends** — `withheldAlertState` must revert `announcedKeys` and `realertCount` alongside
  `lastAlertTs`/`alertCount`. Missing it converts a dark-channel escalation into a permanent
  deletion.

### §5.5 The daily alert budget — the mechanism that makes the per-day property true

A per-episode cap cannot bound a per-day inbox count across an unbounded instance count. This is the
same reasoning §1.4 applies one level down, so it takes the same shape: **a mechanism that does the
right thing, plus a bound that holds regardless.**

**The governing principle, stated first because both round-2 blockers were violations of it:**

> **The budget may delay an ANNOUNCEMENT. It may never delay an episode CLOSE, and it may never
> suppress the report that it is itself suppressing.**

#### The counter

- **`MAX_ANNOUNCEMENT_EMAILS_PER_DAY = 20`**, held in WatchtowerDO storage — the right home:
  watchtower control state, strongly consistent, readable during a D1 outage (so the `d1` check's own
  alert is counted). One RPC per email actually sent, not per check. **Renamed from
  `MAX_ALERT_EMAILS_PER_DAY` (round-3 NB):** it bounds ANNOUNCEMENTS, and recoveries plus the exempt
  families are alert emails it does not bound — a constant whose name overstates its own guarantee is
  the claim-drift class this repo sweeps for, and the name is free to fix at design time.
- **A ring of send timestamps, not `{windowStartMs, count}` (NEW-3).** Two fields express a
  *tumbling* window that resets on a boundary, which permits 20 sends at T+23.9 h and 20 more at
  T+24.1 h — 40 emails in a 0.20 h span while every stated gate still passes. The counter is a
  bounded ring of at most `MAX_ANNOUNCEMENT_EMAILS_PER_DAY` timestamps; the count is "entries newer
  than `nowMs - 24 h`". 20 numbers, exact for arbitrary spans, and it makes §9.8's number true as
  written rather than true-per-window.
- **SATURATION IS EITHER COUNTER AT ITS CAP** — total ≥ 20 **or** per-entity ≥ 15. This is what
  `alert_budget_exceeded` observes, and it is not a detail: with the §5.5 ordering rule (iii)
  sub-cap in place, a *pure* per-entity storm (§5.5's own flagship row — 100 tenants, correlated DO
  flap, every contending family per-entity) pins the total at 15 of 20 forever, so a total-only
  reading of `saturated` never fires while 85 of 100 instances are being suppressed. Round 3
  simulated all three readings over 7 days: total-only **0 sent**, either-counter **8 sent**
  (one confirm plus the daily ladder, which is what this section claims), any-withholding **336**.
- **Exempt sends do NOT consume ring slots, and are not recorded in the ring.** Reasoned, not
  assumed: a send that consumed budget would not be exempt — it would convert un-suppressible
  traffic into suppression pressure on ordinary announcements, so a 100-item `mailbox_release_failed:`
  batch (group 2, deliberately unbounded) would silence every other announcement for the day, which
  inverts the exemptions' purpose. The two costs of "no" are both handled rather than accepted: the
  total counter under-reads real inbox volume, which (a) can no longer hide suppression, because
  `saturated` also reads the per-entity counter, and (b) is why the founder-facing figure is stated
  in EMAIL units as a formula (§9.13) rather than read off this constant.

#### Exemptions (three groups, each with its own reason)

1. **`cron_sweep`** — the check of last resort; when it fires every other alert is already silent.
2. **Every one-shot money-bearing family** — `mailbox_provisioning:`, `mailbox_rebuy:`, and the three
   `*_failed:` prefixes, whose producer notes that two of the three "name money that keeps being
   spent until a human intervenes". Suppressing one is a silent billable loss; suppressing a repeat
   reminder is not.
3. **`alert_budget_exceeded` itself (NEW-1)** — it goes unhealthy exactly when the budget is full, so
   budgeting it makes it self-suppressing: simulated over a 7-day storm, **0 sent / 2015 withheld**,
   and the founder is never told the channel is rate-limited. This is the repo's own recorded class
   — an alarm that depends on the thing it monitors — arriving through new machinery, and it is the
   same reason `cron_sweep` is exempt from the debounce. §5.5's entire argument for accepting
   withheld alerts is that the overflow stays visible, so this exemption is load-bearing, not
   cosmetic.

**Group 2's residual, stated:** a correlated BATCH — 100 tenants' mailbox releases failing in one
tick — is unbounded, because each item is deliberately its own check name and its own money. The
mitigation is one email per failed BATCH rather than per item, and it belongs at the producer, which
already holds the whole list (§7.8), not in the budget.

#### The ruling on `recovered` (NEW-2)

**Recovery emails are EXEMPT from the budget, and the exemption is self-bounding.** The gate framed
this as a choice between two costed readings; the second horn is not as expensive as it looks, and
that is what decides it.

- **Why not "budgeted":** `withheldAlertState`'s recovery arm returns the *whole* previous state, so
  a budget-withheld recovery reverts `healthyObs` and the episode never closes. Simulated: 100
  simultaneous recoveries at budget 20 drain over **4.0 days**, with up to 100 checks reading
  `status='unhealthy'` while actually healthy — on the exact surface the 2-hourly watch cron polls
  as `?unhealthy=1` against a two-row baseline. That converts a volume problem into a false-alarm
  problem on the operator's own detector, and it violates the principle above.
- **Why "exempt" is bounded, contra the gate's estimate of 1,400.** A recovery email is owed only
  when `alertCount > 0` — i.e. only for an episode that was actually ANNOUNCED. Under a saturated
  budget most episodes are never announced: a budget-withheld confirming alert leaves `alertCount`
  at 0, which the gate verified independently. So **recoveries over any window are bounded by
  announcements over that window**, and announcements are exactly what the budget limits. In the
  gate's own 7-day 100-instance storm, 140 alerts were sent, so **at most 140 episodes can ever owe
  a recovery** — not 1,400. In steady state the two rates are equal, so a platform announcing
  ≤20/day recovers ≤20/day.
- **What this buys:** with recoveries exempt, **no budget decision can block an episode close.**
  Episodes close on `recovered` (exempt) and on `healthy` (no email is owed at all), and neither
  `holding` nor `suppressed` closes anything. The 4.0-day false-unhealthy window becomes **zero
  ticks**, and `withheldAlertState`'s recovery arm keeps the semantics it shipped with — which stay
  exactly right for the case they were written for, a transient send failure retried within a tick
  or two. (§5.4's extension of that function to revert the three NEW fields is unaffected; what is
  untouched is its recovery-arm rule.)
- **Worst case, stated honestly:** the day a large storm clears, the founder receives one email per
  previously-announced episode — ≤140 in the gate's scenario, all of it good news, once. The
  same-tick recovery collapse ("N checks recovered", one message) is the mitigation and is a
  follow-up (§8), not a requirement: it changes email shape, not the bound.

#### Ordering when the budget binds — and where it actually applies (NEW-5)

- **(i) Round-robin across FAMILIES before instances**, so one noisy family cannot starve every other
  check. **Honest scope:** this orders within ONE `reconcileAlerts` call, and there are three entry
  points in fixed order — `runWatchtower`, then `reportSweepSignals`, then
  `reportSweepSignalsHealth`. So a `tenant_do_wedged:` storm in the first batch can exhaust the
  budget before the sweep's own checks are offered a slot. Rule (i)'s *named* goal does survive:
  `d1` is decided in `reconcileD1Alert` at the top of `runWatchtower`, before the tenant loop, so a
  simultaneous D1 outage stays audible.
- **(ii) Within a tick:** `alerted` (a new incident) outranks `escalated`, which outranks `realerted`
  (a repeat that says nothing new). `recovered` does not appear because it is exempt.
- **(iii) A RESERVED SLICE for the monitor's own checks.** Documenting NEW-5's gap is not enough,
  because it is the same cluster NEW-1 silences: per-entity families may consume at most
  **`MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY = 15`** of the 20, leaving **5 reserved** for the global platform
  and monitor families (`cron_legs`, `sweep_coverage`, `sweep_signals`, `alert_delivery`, `d1`,
  `engine`, `do_storage`, `failure_signals`, `vendor_wallet`, `warmup_*`). Two counters in one DO
  record, and it makes the cross-batch ordering gap harmless without needing ordering to cross
  batches at all. **This sub-cap is why `saturated` must read either counter** — it keeps the total
  below its own threshold in exactly the storm the budget exists for (see the counter section).

#### The resulting property

> **In any rolling 24 h window: ≤ 20 announcements TOTAL, of which at most 15 may be per-entity —
> so at least 5 slots are always available to the global and monitor families — plus the exempt
> families (dead-man, money-bearing one-shots, `alert_budget_exceeded`'s own ladder), plus a
> recovery tail bounded by the announcements that preceded it.**

(Stated as "≤20 total with a 15 per-entity sub-cap", not "15 + 5": when no per-entity family is
alerting, the global families may use the whole 20. The reservation is a floor for them, not a
ceiling.)

| Condition | Uncapped | With §5.5 |
|---|---|---|
| Today (1 tenant, 2 stuck domains) | 2/day | **2/day** — no counter binds |
| 100 tenants, correlated 50%-duty DO flap | ~114/day (gate-simulated) | **≤ 20/day announcements** + ≤2 budget-check + recovery tail |
| Pathological (all 1,400 per-entity instances flapping) | ~1,866/day (gate-simulated) | **≤ 20/day announcements**, of which ≤15 per-entity |
| The day a 7-day storm clears | — | **≤ 140 recoveries, once** (≤ announcements made) |
| Rolling-window boundary probe (NEW-3) | 40 in 0.20 h | **≤ 20 in any 24 h span** |
| Sustained churn, what the INBOX actually holds | — | **~30/day measured** (15 announcements + 15 recoveries in a pure per-entity storm), **≤ 42/day theoretical** + exempt traffic — see §9.13 |

**Residual, and the number is founder policy.** A daily ceiling means some announcements are delayed
for hours, and under a saturated day a new non-exempt incident is announced only when it wins the
ordering. The dead-man, the money-bearing one-shots and the budget-exceeded report always get
through, and no incident is ever left un-closed. **`MAX_ANNOUNCEMENT_EMAILS_PER_DAY = 20` (and its
15/5 split) is [RATIFY:founder], and §9.13 states the ask in INBOX units rather than in this
constant** — it changes what the founder can expect from the channel, and per
project law a cadence change goes through the policy table, not a hot patch.

*Rejected alternative:* per-family roll-up of `tenant_do_wedged:` into a global count-banded check.
It fixes the one exemplar and leaves every other per-entity family unbounded — the same "the bound
must not depend on getting each family right" argument that produced §1.4's cap. A same-tick
roll-up EMAIL (one message naming N affected tenants) is genuinely better *content* than 20
near-identical ones and is the top follow-up (§8), but it changes email shape rather than the volume
bound, so it is separable and is not required for the property.

---

## §6 Decision 6 — test plan (every item RED before GREEN, quoted in the build report)

Items 1-11 are v1's, unchanged unless noted. 12-16 are the gate's test floor.

1. **IN-9 alternation** — 24 alternating observations under DEBOUNCED: exactly one `alerted`, at
   t=10 min. RED today (0 emails).
2. **Recovery confirmation** — `[bad, good, good, good]` → `[pending, holding, holding, healthy]`,
   0 emails, `unhealthyObs === 0` after close. Plus 30 × `[bad, good ×288]` → 0 emails.
3. **`no_longer_applicable` closes in ONE observation** — through `reconcileAlerts` with the real
   cross-clear shape. The N-3 regression guard.
4. **Alternating-modes anti-storm, TWO red arms** — must fail on HEAD (second mode never announced)
   AND on the naive `last_detail !== detail` escape (13 emails). One arm does not pin the mechanism.
5. **`failure_signals` count-in-detail** — 13 ticks at counts 3…15 → exactly 1 email; then 120 → 1
   more (band crossing). RED on the naive escape and on HEAD.
6. **D1 compat** — pre-migration row + fresh key → 0 emails, key banked; **control arm** without the
   adopt rule → 1 spurious deploy-day email.
7. **DO compat** — legacy `d1_alert_state` / `dead_man_alert_state` normalize and behave identically.
8. **Cap fail-safe** — fresh key every tick → exactly 5 emails, `overflow` rising, disclosure in the
   next ladder body.
9. **Failing-by-construction policy table** — every family declares `recoverAfterObservations` and a
   key space; **`cap > max(|declared space|)` asserted over the table including `cron_legs` and
   `customer_progress_*`** (gate constraint 3 — it must RED today).
10. **Property fuzz** — (i) emails/episode ≤ §5.3's ceiling; (ii) an episode that announced ≥1 key
    emits exactly one recovery; (iii) `alertCount > 0 ⇒ keys.length > 0`.
11. **Defect-pinning tests** — find any remaining test asserting "an intermittent check stays silent"
    and rewrite it as a spec change with the reasoning quoted.
12. **§4 polarity (gate constraint 1 — the highest-value RED in the increment)** — a 300-tick
    sustained sub-threshold timeline asserting ≥1 `sustained_subthreshold` result. It **must fail on
    the v1 `&& holding` form**, because that inversion passes every "it alerts on a real signal" test
    — the real-signal path is the other arm.
13. **Cap-then-ladder over 30 simulated days (constraint 2)** — an episode at the cap with a churning
    key, unhealthy throughout: assert ~30 ladder emails, not 5. RED on escape-first ordering.
14. **B6's four-step continuity scenario (constraint 6)** — driven through `reconcileAlerts` with the
    real cross-clear, asserting `maybeEmitContinuityNudge` is reached with a NEW onset and the second
    episode gets its nudge. RED on the `healthyObs`-blind adoption predicate.
15. **A 100-instance `tenant_do_wedged:` flap timeline (constraint 5), FIVE arms** — the budget is
    only proven if each of its parts is proven separately:
    - **15a volume** — ≤20 announcements in any rolling 24 h with §5.5 armed; ~114/day without it
      (the gate's measured number), so the budget is load-bearing rather than decorative.
    - **15b `alert_budget_exceeded` is DELIVERED during a saturated day** (NEW-1). **The fixture must
      be a PURE per-entity storm** — 100 `tenant_do_wedged:` instances, no global family alerting —
      because that is the only shape in which the per-entity sub-cap binds while the total counter
      sits at 15/20. Assert **8 delivered** over 7 days (one confirm plus the daily ladder). It reds
      at **0** on both defective readings: v2's (the check was itself budgeted) and v3's (`saturated`
      read the total counter alone). A mixed-family fixture certifies the defect instead of catching
      it — the exact failure mode test 15 was split into arms to avoid.
    - **15c recovery storm** (NEW-2) — 100 simultaneous recoveries: assert every episode CLOSES in
      the tick it recovers (zero checks reading `status='unhealthy'` while healthy — v2's budgeted
      reading gives up to 100 for 4.0 days), and assert recovery emails ≤ announcements made.
    - **15d rolling-window boundary** (NEW-3) — 20 sends at T+23.9 h, more attempted at T+24.1 h:
      assert ≤20 in the 0.20 h span. RED on `{windowStartMs, count}`, which permits 40.
    - **15e reserved slice** (NEW-5) — a 100-instance per-entity storm must not prevent `cron_legs` /
      `sweep_coverage` / `alert_delivery` from sending: assert ≥1 monitor-family email lands on a
      saturated day.
16. **`send_starved:` alternation (constraint 4)** — assert the ruled behaviour: 0 emails, episode
    closed each drain. It pins the accepted inertness so a later "fix" is a deliberate decision.
17. **`watchtower-deadman.test.ts` and the continuity cross-clear tests pass UNEDITED.**

---

## §7 Decision 7 — sequencing against `feat/scale-monitoring-2026-08-20`

Re-stated against that lane's **working tree as read this pass** (16 modified + 8 untracked; the lane
has not committed, so this is a moving target — re-verify at merge).

1. **S4 determines `cron_legs`' key.** The lane splits `skippedForLegDeadline` out into
   `sweep_coverage`, so `cron_legs`' observation is now genuine leg failure. §1.2's narrowed key
   (`counted` / `threw` / `both`) is derived from `LegSignals` post-split; deriving it pre-split would
   churn every tick on rotation skips.
2. **W-M1 and the withheld-escalation rule.** The lane's `alert_delivery` counts
   `undeliveredAlerts` filtered by `dark_channel` / `send_failed` **by name** — the gate verified that
   the new `suppressed_key_cap` and `suppressed_daily_budget` reasons cannot false-count as delivery
   failures. That filter is load-bearing for §5.5 and must not become a catch-all.
3. **SIX arriving families, not three** (re-read at `67f3535`; the gate's N2 was accurate against the
   pre-commit tree and is superseded):
   - `sweep_coverage`, `sweep_signals`, `alert_delivery` — fixed names in `admin/sweep-signals.ts`.
     **`policyFor` still has no branch for any of the three**, so all three inherit DEBOUNCED today;
     `sweep_coverage` and `alert_delivery` are `gradeSweepStreak`-damped upstream and need `IMMEDIATE`
     (§3.3). `sweep_signals` is correctly DEBOUNCED — its own docstring states the choice, and it is
     *not* streak-damped, which is the one place the gate's N2 was a family too broad.
   - `mailbox_release_failed:`, `domain_ordinal_failed:`, `mailbox_slot_failed:` — per-entity
     prefixes from `engine/isolated-failure-alerts.ts`, **already classified `IMMEDIATE` by the lane**.
     This design endorses that classification and its stated reason, and adds `recoverAfter: 1` plus
     the 2-value key spaces in §1.2.
   All six owe the same three declarations; §6.9's guard reds until they have them.
4. **S5 (immortal rows).** The lane adds `watchtower-retention.test.ts` — any GC predicate must
   exclude `status = 'unhealthy'`: deleting a row with an open episode discards the ledger and re-arms
   every key in it. Three new columns also add bytes per row, which is additive to S5's cost argument.
5. **S1 can change the observation CADENCE, which every timing number in §3 is denominated in.** If
   the watchtower tenant scan becomes slice-rotated (the lane adds `tenant-slice.ts` and
   `SWEEP_TENANT_SLICE`), then for the per-entity families `confirmAfter: 2` means two ROTATIONS and
   `recoverAfter: 3` means three. **The binding requirement is not the arithmetic: a tenant skipped by
   rotation must emit NO `CheckResult` — never a healthy one.** A healthy-by-absence result would
   satisfy the recovery confirmation with rotation skips and close open episodes silently, which is
   the absence-reads-as-health class W-M1 and S4 exist to fix, arriving through the new mechanism.
6. **S10 restructures the loops that PRODUCE the clears §3 depends on.** The `reported`-set scans emit
   `basis: "no_longer_applicable"` for departed entities; whatever S10 does to their complexity, those
   clears must keep emitting with that basis, or a departed entity's episode never closes.
7. **Migration numbers are re-picked after the merge** (§2.1), never trusted from this doc.
   `0019_sweep_cursor.sql` is now tracked at `67f3535`, so `0020` is currently correct — and still
   re-check rather than trust it.
8. **ASK, to the lane that owns the file — one email per failed BATCH, not per failed item.**
   `isolated-failure-alerts.ts` raises one `reportCheck` per item and argues for it explicitly
   ("ONE CHECK PER ITEM, not per call… each of these items is separate money with a separate
   remedy"). **That reasoning is correct for check NAMES and this design endorses it** — per-item
   state is what makes per-item remedy tracking possible. It does not follow for EMAILS: the
   producer already holds `outcome.failures` as a list, so a same-tick batch could raise N per-item
   check states and send ONE message naming all N. Without it, a 100-tenant correlated batch is 100
   budget-exempt emails in one tick (§5.5). **This is that lane's file and its call** — flagged as a
   conflict rather than designed around, with the cost stated on both sides.

---

## §8 Non-goals, each with its reason

- **`send_starved:`'s root cause** — its unhealthy predicate conjoins capacity with demand, so zero
  send capacity reads healthy whenever the queue is momentarily empty. A producer-side fix with its
  own blast radius (it would fire during normal provisioning). IN-9's inertness there is accepted and
  pinned by test 16.
- **The SDN ledger (IN-17's own site)** — deferred behind the P0 delivery-outcome plumbing (§2.4).
  The mechanism, its class-mates and the prerequisite land here; the site does not.
- **A same-tick roll-up EMAIL for correlated onsets in the watchtower SCAN** (one message naming N
  affected tenants instead of 20 near-identical ones) — better content, separable from the volume
  bound, top follow-up. **Its twin: the same-tick RECOVERY collapse** ("N checks recovered", one
  message), which is what would turn §5.5's ≤140-once recovery tail into ≤1. Both change email
  shape, not the bound, which is why neither is required here. The equivalent for the one-shot `*_failed:` families is *not* a follow-up but
  an open ask to the lane that owns their producer (§7.8), because there the failure list already
  exists in one place.
- **`failure_signals` per-tenant re-keying** — one correlated outage would become 100 emails, worse
  than the defect. The band key closes the escalation half; the rendering half (episode peak +
  per-tenant breakdown in the body) costs zero emails.
- **Collapsing `mailbox_provisioning:` / `mailbox_rebuy:`** — that name split exists *because* the
  machine could not tell a repeat from an escalation, so a key makes it arguably redundant; removing
  it is a customer-invisible refactor with real regression surface and no defect behind it.
- **No cooldown or ladder constant changes.** `WATCHTOWER_COOLDOWN_MS`, `WATCHTOWER_STEADY_REALERT_MS`,
  `SDN_ALERT_COOLDOWN_MS`, `SWEEP_STALE_MS`, `DEAD_MAN_INTERVAL_MS` are untouched.
- **NB3 (`enforcement_actions.subsequentActions`)** rides the same mechanism one file over: the
  consecutive-distinct comparison becomes an announced set keyed on the AUP reason, the episode being
  the open TERMINATE row. No migration (the set lives in the existing `evidence_json`).

---

## §9 Acceptance checklist

1. `decideAlert` takes the observation as a discriminated argument carrying `materiality` on the
   unhealthy arm; all 22 (+3 arriving) producer expressions state a key; `npm run typecheck` exit 0.
2. Every family has a declared key space and a `recoverAfterObservations`; the guard reds when either
   is missing.
3. **`MAX_ANNOUNCED_KEYS_PER_EPISODE > max(|declared key space|)`** — satisfiable at cap 5 / max 4,
   asserted in the same guard. (v1's version was unsatisfiable; this is gate constraint 3.)
4. Phase-2 precedence is ladder-first: test 13 shows ~30 emails over 30 days at the cap, not 5.
5. `realertCount` preserves the shipped ladder: `watchtower-policy.test.ts`'s `sustained()`
   expectations pass **unedited**.
6. Test 12 (§4 polarity) reds on the v1 form and greens on `holdGrade === false`.
7. Test 14 (B6) reds on the `healthyObs`-blind adoption predicate.
8. **§5.5's property holds in all five of test 15's arms** (v2 gated a single number and three of the
   five arms would have passed while the mechanism was broken): ≤20 announcements in any **rolling**
   24 h span — not per tumbling window — at 100 flapping instances with §5.5 armed vs ~114/day
   without; `alert_budget_exceeded` delivered on a saturated day; every episode closing in the tick
   it recovers; ≥1 monitor-family email landing during a per-entity storm.
9. A pre-migration D1 row and a pre-field DO value each produce ZERO deploy-day emails, with a
   control arm.
10. `watchtower-deadman.test.ts` and the continuity cross-clear tests pass **unedited**.
11. The property fuzz reports zero violations of §6.10's three invariants.
12. Full battery + typecheck quoted with real (non-piped) exit codes on the MERGED tree, after the
    scale-monitoring lane lands.
13. **[RATIFY:founder] — stated in INBOX units, because that is what the founder counts.** The
    mechanism's constant is `MAX_ANNOUNCEMENT_EMAILS_PER_DAY = 20` (split 15 per-entity / 5 reserved
    for the global and monitor families), but that constant bounds **announcements**, not emails. The
    ask must be the arithmetic the inbox sees:

    > **On a bad day: up to ~20 announcement emails, plus up to the same number of recovery emails
    > (each recovery is owed only for an announcement that already went out), plus the exempt
    > families — the cron dead-man, the money-bearing one-shot failures, and up to 2/day telling you
    > alerts are being withheld. In sustained churn that measured ~30/day and is bounded at ~42/day
    > plus exempt traffic; today, with one tenant, it is 2/day and nothing binds.**

    What is bought for that: no incident is ever left un-closed, no episode close is ever delayed,
    and the platform always tells you when it is withholding. What is given up: on a saturated day a
    new non-exempt incident is announced only when it wins the ordering. **Put the number to the
    founder only after NEW-1 and NEW-2 are built, not before.**
