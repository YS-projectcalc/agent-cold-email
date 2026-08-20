# Alert-state increment — design (2026-08-20)

DESIGN ONLY. No code was written for this document and no source file was touched. It settles the
six deferred members that are one mechanism, so a builder can implement it without re-deriving any
decision.

## Grounding

| Item | Value |
|---|---|
| Ref | `69ec655` at design start; **re-checked at close: main moved to `6b1af1e`** (wave-A close ledger). `git diff 69ec655 6b1af1e --stat` touches only `HANDOFF.md`, `MEMORY.md`, `ROADMAP.md`, `archive/*` — **zero source files**, so every line number below is still valid. |
| Mode | READ-ONLY git. One file written: this one. |
| Lanes in flight | `feat/scale-monitoring-2026-08-20` and `feat/scale-modules-2026-08-20` — **both worktrees are at `69ec655` with zero commits and clean status at design time**, so every line number below is main's and no lane has moved these files yet. |
| Evidence read in full | `admin/watchtower-policy.ts`, `admin/watchtower-alerts.ts`, `admin/watchtower.ts`, `admin/watchtower-grading.ts`, `admin/watchtower-infra.ts`, `admin/sweep-signals.ts`, `watchtower-do.ts`, `admin/watchtower-vendor.ts` (unhealthy arms), `engine/mailbox-provisioning.ts:389-435`, `admin/db.ts:225-290`, `ofac/sdn-alert.ts`, `packages/shared/src/provenance.ts`, `migrations/0008,0013,0018`, `test/watchtower-policy.test.ts` |
| Docs read | `class-sweep-dedup-semantics-2026-08-17.md` (IN-9..IN-12, IN-17, U-2), `sweep-completeness-pass-2026-08-17.md` (§4(ii), SPOT-1), `wave-a-trains-3-4-gate-2026-08-20.md` (ruling 5, NB3), `alert-policy-gate-2026-08-16.md`, `customer-continuity-build-gate-r2-2026-08-19.md` (N-2/N-3), `scale-readiness-audit-2026-08-17.md` (S4, S5) |
| Correction to the brief | The alert policy table covers **19 check FAMILIES**, not ~30 names — 9 fixed names (`CHECK_LABELS`) + 10 per-entity prefixes (`*_CHECK`), enumerated by `watchtower-policy.test.ts:142-170`. Instance count is unbounded (per mailbox / domain / tenant); *per-policy* decisions are made 19 times, and that is the real cost surface. |

---

## §0 The mechanism, and why the six are one increment

> **The suppression decides on a two-valued comparison, so it cannot tell a repeat from an
> escalation, nor an intermittent recurrence from a resolved flap.**

Two axes, both two-valued today:

| Axis | The comparison today | What it cannot express | Members |
|---|---|---|---|
| **Entering an episode** | `status` healthy/unhealthy; `unhealthyObs` zeroed by ANY healthy observation (`watchtower-policy.ts:263`) | "unhealthy twice, not consecutively" | IN-9, U-2 |
| **Inside an episode** | `last_detail` overwritten; nothing compared at all (`:243-247`, `sdn-alert.ts:86-88`) | "a different, worse condition under the same check name" | IN-10, IN-11, IN-12, IN-17, NB3 |

They must land together, and this is the load-bearing reason (§5.3 proves it): the per-episode
announced set of §1 is bounded **only if episodes do not churn**, and episodes stop churning only
because of §3's recovery confirmation. Shipping §1 alone re-opens the storm through a different
door — every flap starts a fresh episode with an empty set, so every key re-announces.

The mechanism-level lesson from the wave-A attempt is already recorded in-repo
(`.claude/agent-memory/hard-builder/changed-detail-escape-storms-on-alternation.md`): a
changed-detail escape compared against the PREVIOUS detail measured **13 emails over 13 ticks** on
two alternating failure modes. Everything in §1 exists to make that number a function of distinct
conditions rather than of tick count.

---

## §1 Decision 1 — materiality keys and the per-episode announced ledger

### §1.1 What a materiality key is

A **materiality key** is a bounded, producer-stated classification of an UNHEALTHY observation,
derived from structured facts the producer already holds, never from rendered prose.

Three binding rules:

1. **Never the detail string, never a count.** `tenant_do_wedged:`'s detail embeds `errMsg(err)` and
   `vendor_wallet`'s embeds `JSON.stringify(body)` — unbounded key spaces, one email per variant.
   `failure_signals`' detail embeds the window COUNT, which changes on almost every 5-minute tick;
   keying on it is the worst case in the whole inventory.
2. **Declared per family, as a closed enumeration**, in one table beside `policyFor`. A family whose
   space is not declared cannot be alerted on (enforced failing-by-construction, §6.9).
3. **Required, not optional.** It is a required field on the `healthy: false` arm of `CheckResult`,
   exactly as `basis: RecoveryBasis` is required on the `healthy: true` arm. That precedent is
   in-repo and it worked: "it does not compile until each producer states which it is, and that is
   precisely the decision the old code made implicitly" (`watchtower-alerts.ts:44-48`). An optional
   field with a default re-creates the silent-inherit failure that making `policy` a required
   argument was introduced to stop (`watchtower-policy.ts:14-16`).

Cost, stated exactly: `grep -c 'healthy: false' apps/platform/src` = **23 occurrences in 6 files**,
of which one is the type declaration at `watchtower-alerts.ts:51` ⇒ **22 producer expressions** —
13 in `admin/watchtower.ts`, 4 in `admin/watchtower-vendor.ts`, 2 in `engine/mailbox-acquisition.ts`,
2 in `admin/sweep-signals.ts`, 1 in `watchtower-do.ts` (the dead-man).

### §1.2 The key table, per family

`✱` marks the families where an escalation is a genuinely different, action-changing condition —
i.e. where the escape earns its existence. The rest are single-valued and cost nothing.

| Family | Key space | Derived from | Size |
|---|---|---|---|
| `domain_dns_aging:` ✱ | `pending` \| `gave_up` | `agingPendingDomains[].gaveUp` (`watchtower.ts:334`) | 2 |
| `failure_signals` ✱ | `failed_b1` (3-9) \| `failed_b2` (10-99) \| `failed_b3` (100+) \| `complaints` \| `sustained_subthreshold` (§4) | banded grade, never the raw count | 5 |
| `warmup_cancel_gave_up` ✱ | `gaveup_b1` (1) \| `gaveup_b2` (2-4) \| `gaveup_b3` (5+) | `digest.gaveUpWarmupCancels` band | 3 |
| `cron_legs` ✱ | sorted set of failing leg names + `threw` flag | `LegSignals.legsThrew` + the non-zero counter names S4 leaves in the signal (§7.1) | **combinatorial** |
| `vendor_wallet` ✱ | `unreachable` \| `shape_drift` \| `below_floor_autotopup_on` \| `below_floor_autotopup_off` | the four arms already branched at `watchtower-vendor.ts:97,108,124` | 4 |
| `warmup_duplicates` ✱ | `dup_b1` (1) \| `dup_b2` (2+) | duplicate-mailbox count band | 2 |
| `mailbox_provisioning:` ✱ | `lookup_failed` \| `too_recent` \| `rebuy_attempting` | the three `alertMailboxStuck` call sites (`mailbox-provisioning.ts:399,421`) | 3 |
| `mailbox_rebuy:` ✱ | `unusable_at_vendor` \| `budget_spent` \| `dispatch_failed` | the three `alertMailboxRebuyFailed` call sites (`:389,412,430`) | 3 |
| `tenant_do_wedged:` ✱ | mapped error class, `other` bucket | `err.name`, never `err.message` | bounded by the map |
| `customer_progress_operator:` ✱ | the single highest-precedence owed reason | the continuity design's §7 precedence order (already a total order — reuse it, do not invent one) | \|reasons\| |
| `customer_progress_agent:` | same (digest channel — key costs 0 emails) | as above | \|reasons\| |
| `d1`, `engine`, `do_storage` | `down` | — | 1 |
| `send_starved:`, `cred_push_aging:`, `mailbox_orphan:`, `domain_orphan:` | `starved` / `aging` / `orphaned` / `orphaned` | — | 1 |
| `cron_sweep` (dead-man) | `stale` | — | 1, **and hard-exempt from the escape entirely** (§3.4) |
| SDN (`sdn_alert_state`, its own machine) ✱ | `{refresh\|ingest} × {network, http_5xx, http_4xx, parse, stale}` | the path plus a mapped class of the failure — never the vendor error text | ≤10 |

Two families deserve their reasoning spelled out because they drive the safety argument:

- **`cron_legs`' key space is combinatorial** (a subset of the legs). It is the family the cap in
  §1.4 exists for, which is why the cap is a design invariant rather than a nicety.
- **`customer_progress_*`** keys on the single highest-precedence owed reason rather than the SET of
  reasons. The set is `2^n`; the precedence order already exists and is already the thing the
  founder acts on.

### §1.3 The announced ledger

Per check, per episode:

```
AnnouncementLedger = { keys: string[]; overflow: number }
```

- `keys` — every materiality key **actually announced** (an email that was delivered, or a
  digest-channel transition that genuinely fired) in the current episode.
- `overflow` — how many further DISTINCT keys were suppressed by the cap, so the next re-alert body
  can say so instead of the condition vanishing.
- Cleared to `{keys: [], overflow: 0}` on episode close — i.e. exactly where `healthyState()`
  already zeroes the counters (`watchtower-policy.ts:262-264`).

### §1.4 The escape rule, and the cap

A new transition, `escalated`, is produced when: an episode is open, `alertCount > 0`, and this
observation's materiality key is **not** in `ledger.keys`.

- It **sends**, sets `lastAlertTs = nowMs`, increments `alertCount`, and appends the key.
- It is **not** an `||` around the cooldown check. The wave-A attempt failed precisely because the
  escape bypassed the cooldown branch entirely; here the escape is its own branch that re-anchors the
  ladder, so a genuine 24h persistence reminder is pushed out by exactly the email that just went
  out.
- If `|ledger.keys| >= MAX_ANNOUNCED_KEYS_PER_EPISODE`, no email: `overflow += 1`, and the outcome
  records `why: "suppressed_key_cap"` (a new `DeliveryReason`).

`MAX_ANNOUNCED_KEYS_PER_EPISODE = 5`.

**Why the cap is the safety argument, not a fail-safe.** The anti-storm property must not depend on
every one of the 19 key derivations being correct. With the cap, worst-case emails per episode are
`1 (confirm) + 4 (escalations) + ladder rungs + 1 (recovery)` **whatever a key function does** —
including a key function that turns out unbounded in production, and including `cron_legs`'
combinatorial space. Calibration is checkable: 5 is `max(|declared space|)` across the table
(`failure_signals`, after §4). §6.9 asserts `cap >= max(|declared space|)` failing-by-construction,
so adding a 6th key to any family reds the suite and forces a deliberate cap decision rather than a
silent truncation.

---

## §2 Decision 2 — how the new fields enter stores with no migration mechanism

Three stores, three answers. `normalizeAlertState` (`watchtower-policy.ts:176-186`) is the existing
seam and it is **extended, not replaced** — it already exists for exactly this ("DO storage has no
migration mechanism at all, so the fallback below is the only thing that reconciles a
`d1_alert_state` value written by the previous deploy").

### §2.1 D1 `watchtower_state` — migration 0019, the 0018 pattern

```
ALTER TABLE watchtower_state ADD COLUMN healthy_obs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchtower_state ADD COLUMN announced_keys TEXT NOT NULL DEFAULT '{"keys":[],"overflow":0}';
```

No backfill `UPDATE`. 0018 needed one because a wrong `alert_count` re-announces on deploy day; here
the deploy-day hazard is handled by a *rule* instead of by data, because the same rule is the only
option available for the DO store (§2.2), and one rule beats two mechanisms that must agree.

### §2.2 The legacy-adopt rule (the whole compat story, in one predicate)

> An episode with `alertCount > 0` and an EMPTY ledger adopts its first observed key **silently** —
> no email, key appended, `alertCount` untouched.

This is safe because the predicate is **unreachable for state written by the new code**: the
confirming transition always writes `alertCount = 1` together with `keys = [key]`; `realerted` and
`escalated` only append; `withheldAlertState` copies the previous ledger; `healthyState` zeroes both
together. So `alertCount > 0 && keys.length === 0` can only have been produced by a row or DO value
that predates the column. §6.6 pins it as an invariant over the fuzz, and §6.7 as a live D1 case.

Failure direction if the rule is wrong: at most one missed escalation on the first tick after
deploy, per currently-open episode (today: 2 stuck `domain_dns_aging` checks). The opposite default —
treating an empty ledger as "nothing announced" — sends one spurious escalation per open episode on
deploy day, which is exactly the class 0018's backfill was written to prevent and which the
2026-08-16 gate proved load-bearing by control arm.

**Corrupt-blob handling is part of the rule, not an afterthought.** A `JSON.parse` failure on
`announced_keys` is treated as the legacy case (adopt silently) and logged — never as
`{keys: [], overflow: 0}`. A catch-all-to-empty loader here would re-announce every key in the
episode, i.e. convert a corrupt byte into a storm.

### §2.3 DO storage (`d1_alert_state`, `dead_man_alert_state`)

No migration exists and none is added. `PersistedAlertState` is already
`Omit<AlertState, counters> & Partial<Pick<AlertState, counters>>`; the Partial pick gains
`healthyObs` and `announcedKeys`, and `normalizeAlertState` supplies them.

**The DO-side compat surface is inert by construction**: the only two checks that live there are
`d1` (key space `{down}`) and `cron_sweep` (key space `{stale}`, and hard-exempt anyway), so neither
can produce a second key and neither can escalate. The fields are carried for uniformity of the one
`decideAlert`, which is the property `watchtower-policy.ts:1-16` exists to hold.

`commitD1Alert`'s accepted residual (`watchtower-infra.ts:75-79`) is **not worsened**: a persistently
failing commit already loses `unhealthyObs`; it would also lose `announcedKeys`, whose failure
direction is a duplicate escalation — the same direction that catch block already accepts, and the
opposite of silence.

### §2.4 SDN `sdn_alert_state` — migration 0020

```
ALTER TABLE sdn_alert_state ADD COLUMN announced_keys TEXT NOT NULL DEFAULT '{"keys":[],"overflow":0}';
```

Same legacy-adopt rule, with the streak standing in for `alertCount`:
`failure_streak > 0 && last_alert_ts IS NOT NULL && keys.length === 0` → adopt silently.

### §2.5 Rejected: version rows

Rejected. D1 supports `ALTER TABLE … ADD COLUMN … DEFAULT`, which is what 0018 did and what the repo
knows how to review; a version column would add a second read path and a branch per reader for zero
new capability. DO storage cannot be migrated at all, so the normalize seam is mandatory regardless
— a version field there would simply be one more thing to normalize. (`enforcement_actions`' comment
at `admin/db.ts:250-256` records the repo's standing position that a constraint change needing a
table rebuild is out of bounds; `ADD COLUMN` is not that.)

---

## §3 Decision 3 — confirmation and recovery (IN-9)

### §3.1 The change

`AlertPolicy` gains `recoverAfterObservations`. `AlertState` gains `healthyObs`. The rule becomes:

| Observation | Today | After |
|---|---|---|
| unhealthy | `unhealthyObs += 1` | `unhealthyObs += 1; healthyObs = 0` |
| healthy, `basis: "reobserved"`, episode open, `healthyObs + 1 < recoverAfter` | `recovered`/`healthy`, **all counters zeroed** | `holding` — silent, status stays `unhealthy`, **`unhealthyObs` preserved**, ledger preserved |
| healthy, `basis: "reobserved"`, `healthyObs + 1 >= recoverAfter` | as above | `recovered` (if `alertCount > 0`) else `healthy`; episode CLOSES, counters zeroed, ledger cleared |
| healthy, `basis: "no_longer_applicable"` | `recovered`/`healthy` | **unchanged — closes the episode in ONE observation** |

The confirm gate therefore becomes "N unhealthy observations not yet answered by a full recovery
run", which is the exact wording the already-shipped sibling fix uses one layer down
(`watchtower-grading.ts:113-120`). This design is that fix, applied at the second layer, which is
what the completeness pass ruled (`§4(ii)`) and the wave-A gate confirmed still open ("IN-9 remains
open only for checks that report a verdict every tick — `d1`, `engine`, `do_storage`").

### §3.2 Why `no_longer_applicable` must NOT require confirmation

It is not a measurement of the condition; it says the entity left the population. Requiring three of
them would break two shipped, gate-ratified properties:

1. **The continuity blame-flip cross-clear.** `watchtower.ts:576-583` pushes the abandoned
   `customer_progress_*` name healthy with `basis: "no_longer_applicable"` in the SAME batch, so it
   "cannot re-alert on its own 24h step". If that clear needed 3 confirmations the abandoned name
   stays unhealthy for 15 minutes and can re-alert — the exact defect N-3 closed and r2 re-proved
   from scratch.
2. **Entity departure.** A released domain or torn-down mailbox never produces another observation
   at all, so a confirmation requirement would leave its episode open forever, re-alerting on the
   24h ladder — a storm in the other direction, and it would compound S5's immortal rows.

This is a reuse of the already-shipped `RecoveryBasis` discriminator, not a new concept. It is also
the correct answer to the naturally-oscillating checks: `send_starved:` flaps as the due queue drains
and refills, and its own clear arm *already* distinguishes "mailboxes came back" (`reobserved`) from
"it simply has no due sends right now" (`no_longer_applicable`, `watchtower.ts:444-449`). Under this
rule the drain does not count as recovery evidence, which is the honest reading and needs no
per-check tuning.

### §3.3 Per-policy defaults (all 19 families, by policy)

| Policy | `confirmAfter` | `recoverAfter` | Members | Reason |
|---|---|---|---|---|
| `DEBOUNCED_ALERT_POLICY` (+ its digest twin) | 2 (unchanged) | **3** | `d1`, `do_storage`, `engine`, `failure_signals`, `warmup_cancel_gave_up`, `vendor_wallet`, `warmup_duplicates`, `cred_push_aging:`, `send_starved:`, `tenant_do_wedged:`, `domain_dns_aging:`, `mailbox_orphan:`, `domain_orphan:`, `customer_progress_operator:`, `customer_progress_agent:` | 3 clean 5-minute ticks = 15 min, the same hysteresis value `LEG_RECOVER_AFTER_SWEEPS` already uses one layer down |
| `IMMEDIATE_ALERT_POLICY` | 1 (unchanged) | **1** | `cron_legs`, `mailbox_provisioning:`, `mailbox_rebuy:` | **The existing exemption reason transfers exactly.** One-shot event reports are never re-observed, so a recovery confirmation would not delay the recovery email, it would DELETE it — the same sentence `watchtower-policy.ts:93-96` already gives for the confirm side. `cron_legs` is pre-damped upstream and its recovery ALREADY requires 3 clean ticks inside `gradeStreak`; a second confirmation would double-damp it to 30 min. |
| `DEAD_MAN_ALERT_POLICY` | 1 (unchanged) | **1** | `cron_sweep` | Hard exemption (founder ruling 2026-08-16, C). Timing stays byte-identical, which `watchtower-policy.test.ts:64-71` pins as `["alerted","recovered"]` on the first healthy observation. |

**Affected exemptions:** none is weakened. The two one-shot families and the dead-man keep
`recoverAfter: 1` for the reason they already keep `confirmAfter: 1`. `cron_legs` keeps it because
its damping lives upstream. Explicitly OUT: the dead-man gets no escalation escape at all — its key
space is single-valued, and the check of last resort must not gain a second way to email.

### §3.4 Both failure modes, closed — and the residual, stated

- **Intermittent never confirms** (the defect): alternating bad/good at the 5-min cadence now reads
  bad@0 `pending` → good@5 `holding` → bad@10 **`alerted`**. First email at 10 minutes, inside the
  founder's stated 10-15 min ceiling. SPOT-1 measured zero emails in 2 h on this exact timeline
  today.
- **Once-a-month flake eventually pages** (the naive fix's defect): a single bad tick followed by 3
  clean ticks closes the episode at 15 min and zeroes the counters, so nothing accumulates across a
  month. Parity with today is exact — today that timeline emits 0 emails, and after this change it
  still emits 0. A carried count *without* §3.1's episode closure is what pages eventually; that is
  why the carry and the closure are one decision.
- **Residual, and it is a knob, not an oversight.** A fault is detectable iff two failures occur
  with fewer than `recoverAfter` clean observations between them — i.e. **two failures within 20
  minutes** at today's 5-minute per-check cadence (§7.5 if S1 rotates the watchtower scan: the bound
  is in observations, not minutes). A check failing once every 4+ ticks (≤25% duty) closes its
  episode between failures and stays silent. Raising `recoverAfter` widens detection at the cost of
  delaying every recovery
  email. 3 is chosen to match the shipped upstream hysteresis; a change is a founder-visible cadence
  change and goes through the policy table, never a hot patch.

### §3.5 New vocabulary, and where it lands

- `AlertAction` gains `holding` (silent; distinct from `pending`, which means "nothing announced
  yet", and from `suppressed`, which means "already announced, inside the backoff") and `escalated`.
- `DeliveryReason` (`packages/shared/src/provenance.ts:92`) gains `pending_recovery` (for `holding`)
  and `suppressed_key_cap`. Both are additive; `reasonForNoEmail` maps them.
- `alertEmailFor`'s switch renders `escalated` through `unhealthyEmail` with an escalation
  preamble naming the previous key and the new one, plus the `overflow` count when non-zero.

---

## §4 Decision 4 — U-2 (`gradeFailureSignals` sub-threshold blindness)

**Picked: (c′) — keep ONE check name and make the dead band TIME-BOUNDED, expressing a sustained
sub-threshold window as an unhealthy result with its own materiality key
`sustained_subthreshold`.**

Composition, at the caller (`watchtower.ts:255-270`), from two already-shipped primitives:

```
grade = gradeFailureSignals(failed, complaints)            // unchanged, still pure, still 3-valued
holding = await stub.gradeSweepStreak("failure_signals_hold", grade === null, SUSTAINED_HOLD_TICKS, 1)
  grade === false            -> unhealthy, key = band(failed, complaints)
  grade === null && holding  -> unhealthy, key = "sustained_subthreshold"
  grade === true             -> healthy, basis reobserved
```

`gradeSweepStreak` is already a generic keyed streak store on the WatchtowerDO
(`watchtower-do.ts:129-134`) — this needs **no new store and no new grader**, only an explicit
threshold parameter on that RPC (additive; the DO and Worker deploy together).
`SUSTAINED_HOLD_TICKS` = 144 (12 h at the 5-min cadence); the recover parameter is 1, so a single
genuinely clean window clears the hold streak.

Why (c′) and not the others:

- **(a) Lower `FAILURE_SIGNAL_FAILED_THRESHOLD` from 3 — REJECTED.** It destroys a documented
  product rationale that is still correct ("a hard bounce is a normal outcome of cold email … three
  in an hour is a pattern, not an address", `watchtower-grading.ts:33-38`), and it does not close the
  class: whatever the threshold, there is a sustained rate just below it. It trades a real silence
  for a real storm and leaves the mechanism intact.
- **(b) Widen `Grade` from `boolean | null` — REJECTED as insufficient.** `Grade` is already
  three-valued (`true | false | null`). The information the check lacks is not categorical, it is
  **temporal**: a HOLD is correct for one tick and a signal after twelve hours. Widening the type
  without a store just relabels the silence, and the store this needs already exists.
- **(c) A second check name `failure_signals_sustained` — REJECTED, narrowly.** It works, but it
  adds a 20th family, a second episode/cooldown pair, and one more permanent `watchtower_state` row
  per platform (S5's amplification), to express a condition that is a *rung of the same check*.
  Under (c′) the escalation sub-threshold → over-threshold is exactly a materiality-key change,
  which is the mechanism this increment is building anyway. (c′) also fixes the 2026-08-16 gate's
  non-blocking finding 3 for free: `failure_signals` no longer sits at `pending` indefinitely in
  `/admin/ops/checks` while emitting no result at all.

**Named boundary (NOT fixed here).** `failure_signals` is a GLOBAL roll-up. At 100+ tenants the
summed count sits above the threshold permanently, pinning the check unhealthy forever and blinding
it — which is S4's disease at a different site, and belongs to the scale train. This design does not
claim to fix it, and is built so it survives that fix: the key is a band over the **graded
severity**, not over the raw count, so re-expressing the observation as a rate over a denominator
changes the band inputs and nothing else.

---

## §5 Decision 5 — blast radius and the storm proofs

### §5.1 The ratified property, preserved

The shipped promise is ~2 founder emails/day (one per stuck Mordy `domain_dns_aging` check on the
24h ladder — `HANDOFF.md`, Landmines). It is preserved because **an escalation email requires a
materiality key not yet announced in the open episode**, and both stuck domains are stable at key
`pending`. The single extra email each can ever produce is the `pending → gave_up` transition — a
genuinely terminal, hand-requiring escalation that today waits out up to 24 h (IN-10's exact
scenario), delivered once, ever, per episode.

### §5.2 Volume, before and after

| Scenario | Today | After |
|---|---|---|
| Two stuck domains, stable | 2/day | 2/day |
| One of them gives up | 2/day (news delayed ≤24 h) | 2/day + **1 once** |
| Sustained single-mode outage | 1 confirm + 6 h + 24 h/day | identical |
| Episode with K distinct materiality keys | 1 confirm + ladder | 1 confirm + (K−1 capped at 4) + ladder |
| 50%-duty flapper (`send_starved:`, `d1`) | **0 forever** | 1 confirm + ladder ≈ 1/day while it flaps |
| Genuine full recovery | 1 recovery, 5 min after the last failure | 1 recovery, 15 min after |
| `customer_progress_agent:` (digest) | 0 | 0 — escalations there move state, never email |

The only increase is the flapper row, and it is the defect being fixed. **Hard ceiling, per check,
per episode: `1 + 4 + ceil(hours/24) + 1` emails, independent of tick count and independent of
whether any key function is correctly derived.** §6.10 asserts it as a property.

### §5.3 The alternation proof, on this design's own state machine

The wave-A measurement: two alternating failure modes, 13 ticks, `escape = (last_detail !== detail)`
→ **13 emails**. On this design, with an episode already announced at key A:

| Tick | Observation | Key | Ledger before | Action | Emails |
|---|---|---|---|---|---|
| 1 | mode A | `A` | `{[A],0}` | `suppressed` | 0 |
| 2 | mode B | `B` | `{[A],0}` | **`escalated`** | 1 |
| 3 | mode A | `A` | `{[A,B],0}` | `suppressed` | 0 |
| 4-13 | A,B,A,B… | `A`/`B` | `{[A,B],0}` | `suppressed` ×10 | 0 |
| | | | | **total** | **1** |

Total over the same 13 ticks: **1 email** (2 including the confirming one that opened the episode).
And the brief's "exactly ONE email" case is the one that matters most for the SDN lane: if the two
alternating modes map to the SAME class — HTTP 525 and HTTP 503 both key `refresh/http_5xx` — the
key never changes and the total is **exactly 1**, because the key is a class, not a string.

The invariant behind the table, and the thing to gate on:

> **Emails per episode ≤ 1 + min(distinct materiality keys − 1, cap) + ladder rungs + 1.**
> Tick count does not appear.

### §5.4 What must NOT regress (checked against the shipped gates)

- **Dead-man timing byte-identical** — `recoverAfter: 1`, no escape, `SWEEP_STALE_MS` /
  `DEAD_MAN_INTERVAL_MS` untouched. The 2026-08-16 mutation battery kills any drift here via
  `watchtower-deadman.test.ts`, which this increment must leave unedited.
- **Continuity N-3** — the blame-flip cross-clear still closes in one tick (§3.2), `stateByName` is
  still the pre-pass read, `Math.min` adoption of `sinceTs` still persists on the blamed name.
- **Continuity N-2** — the exactly-once nudge is keyed on `sinceTs` vs
  `continuity_nudge_episode_ts`, both untouched. One second-order effect must be checked by the
  builder and is called out in §6.5: `holding` keeps an episode open across a healthy tick, so a
  stall that would have closed and re-opened now keeps ONE `sinceTs` — which makes the nudge *more*
  exactly-once, never less.
- **Withheld sends** — `withheldAlertState` must revert `announcedKeys` to the previous ledger
  alongside `lastAlertTs`/`alertCount`. Missing this converts a dark-channel escalation into a
  permanently deleted one (the key is recorded as announced although nothing was sent) — the same
  persist-before-confirm defect member 5 closed for the ladder.

---

## §6 Decision 6 — test plan (every item RED before GREEN, quoted in the build report)

The builders' anti-storm shapes are the floor, not the ceiling.

1. **IN-9 alternation** (`watchtower-policy.test.ts`) — 24 alternating observations under
   `DEBOUNCED`: assert exactly one `alerted`, at t=10 min. RED today (SPOT-1: `[pending, healthy]`
   ×12, zero emails).
2. **Recovery confirmation** — `[bad, good, good, good]` → `[pending, holding, holding, healthy]`,
   0 emails, and `unhealthyObs === 0` after the close. Plus the month-flake arm: 30 × `[bad, good
   ×288]` → 0 emails (parity with today, which is the point).
3. **`no_longer_applicable` closes in ONE observation** — driven through `reconcileAlerts` with the
   real continuity cross-clear shape, not through `decideAlert` alone. This is the N-3 regression
   guard; it must fail if a builder makes recovery uniform.
4. **The alternating-modes anti-storm case (IN-17), with TWO red arms.** 13 ticks, two alternating
   failure modes. It must fail on HEAD (1 email, but the genuine second mode never announced) AND on
   the naive `last_detail !== detail` escape (13 emails). A test that only reds one arm does not
   pin the mechanism — the naive fix passed every "a new mode alerts" test written at the time.
5. **`failure_signals` count-in-detail** — 13 ticks with counts 3,4,5…15 → exactly 1 email
   (band-stable); then one tick at 120 → exactly 1 more (band crossing). RED on the naive escape
   (13 emails), RED on HEAD (the escalation to 120 is invisible for up to 24 h).
6. **Persisted-state compat (D1)** — insert a pre-0019 row via the migration defaults
   (`status='unhealthy'`, `last_alert_ts` non-NULL, `alert_count=2`, `announced_keys` default), run
   one tick with a fresh key: assert **zero** emails and the ledger now holds that key. **Control
   arm** without the adopt rule → 1 spurious deploy-day email, proving the rule is load-bearing
   (the technique the 2026-08-16 gate used on 0018's backfill).
7. **Persisted-state compat (DO)** — a legacy `d1_alert_state` value with neither new field
   normalizes and behaves byte-identically; a legacy `dead_man_alert_state` keeps the 6h cadence.
8. **Cap fail-safe** — a producer emitting a fresh key every tick: exactly 5 emails, then silence,
   with `overflow` rising and the next re-alert body disclosing the suppressed count.
9. **Failing-by-construction policy table** — `watchtower-policy.test.ts:142-170` gains a
   `recoverAfterObservations` and a declared key space per family; a new check name with no declared
   key space fails the guard, and `cap >= max(|declared space|)` is asserted in the same test.
10. **Property fuzz** — the 2026-08-16 gate's own technique (60k randomized timelines): assert
    (i) emails per episode ≤ the §5.3 ceiling; (ii) an episode that announced ≥1 key emits exactly
    one recovery; (iii) **`alertCount > 0 ⇒ ledger.keys.length > 0`** — the invariant that makes
    §2.2's legacy predicate unreachable for new state.
11. **The two defect-pinning tests** — `sweep-signals.test.ts`'s intermittent-leg case was already
    corrected in wave A; check whether any remaining watchtower test asserts "an intermittent check
    stays silent" as the requirement, and rewrite it as a spec change with the reasoning quoted
    (wave-A gate ruling 2 is the template for how to justify one).

---

## §7 Decision 7 — sequencing against `feat/scale-monitoring-2026-08-20` (TRAIN 5)

This build lands AFTER that lane merges. Both touch `admin/sweep-signals.ts`, `admin/watchtower.ts`
and the policy table. Four composition requirements, each a real defect if missed:

1. **S4 (skip-vs-error split) determines `cron_legs`' key.** S4 removes `skippedForLegDeadline` from
   the failure signal (it is a capacity metric, not an error, and at scale it is non-zero on every
   tick). `cron_legs`' materiality key is the SET of failing legs — so it must be derived from
   whatever counters S4 leaves in the signal, read from `LEG_COUNTERS`, never hard-coded. If the key
   is computed pre-S4 it churns every tick as the rotation skips different legs, exhausting the cap
   on normal operation.
2. **W-M1 (count failed alert deliveries) and the withheld-escalation rule.** W-M1 makes
   `AlertOutcome.emailSent === false` a counted failure. An escalation that was composed and not
   delivered must NOT append its key (§5.4) — otherwise W-M1 starts counting delivery failures for
   escalations that the ledger has already recorded as announced, and the escalation is deleted
   rather than retried.
3. **The new `*_FAILED` checks** (`MAILBOX_RELEASE_FAILED`, `DOMAIN_ORDINAL_FAILED`,
   `MAILBOX_SLOT_FAILED`) each arrive as a new check family and therefore owe three declarations:
   a `policyFor` classification, a `recoverAfterObservations`, and a materiality key space. Because
   §6.9's guard is failing-by-construction, those names will RED this increment's table until
   classified — which is the intended coupling and the reason the merge order is scale-lane-first.
   If this increment merges first, the scale lane's builder inherits the RED and classifies them in
   the same edit.
4. **S5 (immortal `watchtower_state` rows).** If the scale lane adds any GC/DELETE of
   `watchtower_state`, its predicate must exclude `status = 'unhealthy'`: deleting a row with an
   open episode discards the ledger and re-arms every key in it. `announced_keys` also adds bytes
   per row, which is additive to S5's cost argument, not orthogonal to it.

5. **S1 (fan-out restructure) can change the OBSERVATION CADENCE, which is what every timing number
   in §3 is denominated in.** S1's fix class is "batch/rotate legs, bound `listAllTenantIds`", and
   the send-pipeline leg already rotates (S11: at 500 tenants a given tenant is visited about once
   per 35 min, not once per 5). If the watchtower tenant scan (`watchtower.ts:225-253`) becomes
   rotated, then for the 7 per-entity families `confirmAfterObservations = 2` means two ROTATIONS
   and `recoverAfterObservations = 3` means three — §3.4's "two failures within 20 minutes" becomes
   "within three rotations". **The binding requirement is not the arithmetic, it is this: a tenant
   skipped by rotation must emit NO `CheckResult` for its checks — never a healthy one.** A
   healthy-by-absence result would satisfy the recovery confirmation with rotation skips and close
   open episodes silently, which is the same absence-reads-as-health class W-M1 and S4 are about,
   arriving through the new mechanism. Rotation that emits nothing composes correctly and needs no
   change here (a HOLD already moves no counter).
6. **S10 (quadratic clearing loops) restructures the code that produces the clears §3.2 depends on.**
   The two loops it names (`watchtower.ts:280-286`, `:302-308` in the audit's numbering) are the
   `reported`-set scans that emit `basis: "no_longer_applicable"` for departed entities. Whatever
   S10 does to their complexity, those clears must keep emitting, and must keep that basis — under
   this design a departed entity with no clear keeps its episode open forever and re-alerts on the
   24h ladder.

Out of scope here, named so it is not mistaken for covered: `failure_signals`' global roll-up going
permanently-unhealthy at scale (§4's named boundary) and the S5 row growth itself.

---

## §8 What this design deliberately does not do

- **It does not collapse the `mailbox_provisioning:` / `mailbox_rebuy:` name split.** That split
  exists *because* the state machine could not distinguish a repeat from an escalation
  (`watchtower-alerts.ts:90-98`); a materiality key is now the general lever, so the split is
  arguably redundant — but removing it is a customer-invisible refactor with real regression surface
  and no defect behind it. YAGNI (CLAUDE.md rule i).
- **It does not re-key `failure_signals` per tenant.** IN-11's harm is partly a rendering harm and
  partly an escalation harm; the escalation half is closed by the band key, and the rendering half
  (the re-alert must carry the episode's peak, the current value, and the per-tenant breakdown)
  costs zero emails. Per-tenant naming would convert one correlated platform outage into one email
  per tenant — 100 emails at 100 tenants — which is worse than the defect.
- **It does not change any cooldown or ladder constant.** `WATCHTOWER_COOLDOWN_MS`,
  `WATCHTOWER_STEADY_REALERT_MS`, `SDN_ALERT_COOLDOWN_MS`, `SWEEP_STALE_MS`, `DEAD_MAN_INTERVAL_MS`
  are untouched.
- **NB3 (`enforcement_actions.subsequentActions`) rides the same mechanism, one file over.** Its
  consecutive-distinct comparison becomes an announced SET keyed on the AUP reason (already a closed
  enumeration), with the episode being the open TERMINATE row. Reachability stays one human behind
  `ADMIN_TOKEN`; it is in this increment only because it is the same edit shape, and it is the one
  member that needs no migration (the set lives in the existing `evidence_json`).

---

## §9 Acceptance checklist (each item falsifiable by a named command)

1. `decideAlert` takes the observation as a discriminated argument carrying `materiality` on the
   unhealthy arm; all 22 producer expressions state a key; `npm run typecheck` exit 0.
2. Every one of the 19 families has a declared key space and a `recoverAfterObservations` in the
   policy table; the failing-by-construction guard reds when either is missing.
3. `MAX_ANNOUNCED_KEYS_PER_EPISODE >= max(|declared key space|)`, asserted in the same guard.
4. The 13-tick two-mode case emits exactly 1 email (same class) / 2 (distinct classes), and the same
   test reds on both HEAD and the naive `last_detail` escape.
5. A pre-0019 D1 row and a pre-field DO value each produce ZERO deploy-day emails, with a control arm
   proving the adopt rule is load-bearing.
6. `watchtower-deadman.test.ts` and the continuity cross-clear tests pass **unedited**.
7. The property fuzz reports zero violations of the three invariants in §6.10.
8. Full battery + typecheck quoted with real (non-piped) exit codes on the MERGED tree, after the
   scale-monitoring lane lands — not on this increment's lane worktree.
