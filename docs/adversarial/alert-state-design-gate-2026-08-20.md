# Alert-state increment — adversarial DESIGN gate (2026-08-20)

Fresh-context gate on `docs/research/alert-state-design-2026-08-20.md`. Design attacked BEFORE build.

## VERDICT: **SHIP-AFTER-FIXES** — 6 BLOCKING, 7 non-blocking

The mechanism is right. §5.3's alternation proof, §2.2's compat rule and §3.4's timing all survive
independent simulation. What does not survive is the arithmetic around them: the U-2 decision is a
no-op as specified, the cap's own calibration is false on the design's own table, the escape's
precedence against the ladder is undecided in a way that costs 29 emails over 30 days, and the
blast-radius section proves a per-check ceiling while asserting a per-inbox property.

## Grounding

| Item | Value |
|---|---|
| Ref | `f222afcd1df320e83017d42495d630fa60a13b9a` (main). Design doc committed at this HEAD. |
| Working tree | main dirty in 3 agent-memory files only — zero source drift. |
| Lanes re-checked | `scalemon` at `69ec655` **+15 uncommitted changes** (moved since design time, which recorded it clean); `scalemodules` at `5bafa6c`; `continuity` at `ffccdc7`. §7 findings are against scalemon's WORKING TREE, not a frozen ref. |
| Mode | READ-ONLY git throughout (`rev-parse`, `status`, `log`, `diff`, `worktree list`). |
| Method | Executable model of §1 + §3 built from the design's prose alone, with the baseline half transcribed from `admin/watchtower-policy.ts` at this ref. 13 scenarios run. Every finding below cites its simulation letter. |

---

## BLOCKING

### B1 · lens 2 (run it) + lens 6 (attack the design) · §4's U-2 fix is a NO-OP — the `sustained_subthreshold` arm is unreachable by construction

§4 composes the fix as:

```
grade   = gradeFailureSignals(failed, complaints)
holding = await stub.gradeSweepStreak("failure_signals_hold", grade === null, SUSTAINED_HOLD_TICKS, 1)
  grade === null && holding  -> unhealthy, key = "sustained_subthreshold"
```

`gradeStreak` (`apps/platform/src/admin/watchtower-grading.ts:122-135`) returns `false` = UNHEALTHY,
`true` = HEALTHY, `null` = HOLD — and the two arms are disjoint by input:

```ts
if (observedUnhealthy) { ...; return { next, grade: next.unhealthy >= alertAfter ? false : null }; }
const healthy = prev.healthy + 1;
return { next: {...}, grade: healthy >= recoverAfter ? true : null };
```

The design feeds `observedUnhealthy = (grade === null)`. So on any tick where the arm's own guard
(`grade === null`) is satisfied, the RPC took the FIRST branch and can only have returned `false` or
`null`. **`true` is unreachable while `grade === null`**, so `grade === null && holding` is always
falsy.

**Verification (sim J):** 300 ticks (25 h) of a sustained sub-threshold rate (`failed = 2`/hour,
forever) — `holding` took the values `{null, false}` and nothing else; `sustained_subthreshold` fired
**0 times**; results emitted: **0**. Byte-identical to HEAD's blindness.

Failure direction is SILENT, and it propagates:
- U-2 is not closed. The dead band still emits no result at all (`watchtower.ts:258`, `if (grade !== null)`).
- §4's claim that (c′) "fixes the 2026-08-16 gate's non-blocking finding 3 for free — `failure_signals`
  no longer sits at `pending` indefinitely" is false as written.
- §1.2 declares a 5th `failure_signals` key that no producer can emit, which is the input to §1.4's
  cap calibration (see B3).

The intended guard is `holding === false`. This is the one code-shaped artifact in the document and
its polarity is inverted; a builder told "no decision needs re-deriving" will transcribe it.

### B2 · lens 6 + lens 2 · The cap is a terminal decision, so reaching it DELETES the persistence ladder for the rest of the episode — and the design never states the escape-vs-ladder precedence

§1.4 bullet 3: *"If `|ledger.keys| >= MAX_ANNOUNCED_KEYS_PER_EPISODE`, no email: `overflow += 1`, and
the outcome records `why: "suppressed_key_cap"`."* — a terminal outcome for the tick. §1.4 also says
the escape "is its own branch that re-anchors the ladder" but never says WHERE in the order that
branch sits, and §9's acceptance checklist has no item that pins it.

§5.2 meanwhile states the ceiling as `1 + 4 + ceil(hours/24) + 1` — which PRESUMES the ladder keeps
firing after the cap.

**Verification (sim L):** an episode at the cap, then 30 days of continuous unhealth with a fresh key
each tick:

| branch order | emails over 30 days |
|---|---|
| escape-first (§1.4's natural reading) | **5** — all five inside the first 30 minutes, then silence |
| ladder-first / fall-through | 34 |

Under the reading the design's own prose most supports, a check that is still broken produces
**nothing for 30 days**. §5.2's stated ceiling (36) matches only the other reading.

This is not a corner case. Three families reach the cap in normal operation:
- `cron_legs` — §1.2 declares its key space **combinatorial**, and §1.4 says the cap exists for it.
- `sweep_coverage` — the scale lane's new family, whose own comment says it is non-zero on EVERY tick
  permanently at scale (see N2).
- `customer_progress_operator:` — 12-value reason space (see B3).

### B3 · lens 6 · §1.4's cap calibration is false on the design's own table; §6.9 / §9.3's assertion is unsatisfiable before a line is written

§1.4: *"Calibration is checkable: 5 is `max(|declared space|)` across the table (`failure_signals`,
after §4). §6.9 asserts `cap >= max(|declared space|)` failing-by-construction."*
§9 item 3 restates it as an acceptance criterion.

§1.2's own rows contradict it three times:

| Family | §1.2's declared size | vs cap 5 |
|---|---|---|
| `cron_legs` | **combinatorial** (a subset of the legs) | unbounded |
| SDN (`sdn_alert_state`) | ≤ **10** (`{refresh\|ingest} × {network, http_5xx, http_4xx, parse, stale}`) | 2× |
| `customer_progress_*` | `\|reasons\|` = **12** (`NEXT_STEP_REASONS`, `packages/shared/src/next-steps.ts:24-49`) | 2.4× |

A builder cannot satisfy §9.3 without either raising the cap — which breaks §5.2's ceiling arithmetic
and the ~2/day argument that rests on it — or narrowing three families' key spaces, which is an
undone design decision. §1.4 sells the cap as "the safety argument, not a fail-safe"; the argument
does not close.

### B4 · lens 1 (spec-vs-code) · §3.2's `send_starved:` claim is inverted, and IN-9 is INERT for the one family the design names as naturally oscillating

Two of the design's own statements cannot both hold:

- §3.1, row 4: `no_longer_applicable` → *"unchanged — closes the episode in ONE observation"*.
- §3.2, last paragraph: *"`send_starved:` flaps as the due queue drains and refills … Under this rule
  the drain does not count as recovery evidence."*

`no_longer_applicable` does not merely "not count as recovery evidence" — it terminates the episode
immediately and zeroes `unhealthyObs` and the ledger. That is strictly stronger than counting, in the
opposite direction. And the drain arm IS `no_longer_applicable`
(`apps/platform/src/admin/watchtower.ts:444-449`, exactly the lines §3.2 cites).

**Verification (sim F):** 24 ticks of starved / drained alternation — HEAD **0 emails**, designed
**0 emails**, action trace `pending, healthy, pending, healthy, …`. Identical. The IN-9 fix does
nothing here.

The contradiction has a second face: §5.2's volume table lists `send_starved:` as the 50%-duty
flapper that moves from "**0 forever**" to "≈1/day" — a state B4 shows it cannot reach. §3.2 and §5.2
disagree about the same family, and §5's blast-radius accounting is built on the wrong one.

Either reading loses something: as specified, IN-9 is inert for `send_starved:`; if a builder
"corrects" it so the drain does hold the episode open, the per-tenant flapper cost in B5 arrives on a
second family.

### B5 · lens 6 + lens 4 · The ratified ~2 emails/day property is NOT established — the ceiling is per-check-INSTANCE and 12 of the 19 families are per-entity

§5.2 calls the flapper row "the only increase" and names exactly two members: `send_starved:` (B4:
cannot reach it) and `d1` (a single global instance). The design's own Grounding row concedes
"Instance count is unbounded (per mailbox / domain / tenant)" — and then §5's proof never multiplies
by it. §5.3's invariant is explicitly *per episode*; the ratified property is *per inbox per day*.

The family that DOES reach the flapper row is `tenant_do_wedged:<tenantId>`:
- per tenant (`watchtower.ts:226`),
- unhealthy on ANY throw from the `opsSummary` RPC (`:242-252`),
- cleared with `basis: "reobserved"` unconditionally (`:237-241`) — so `holding` engages and the
  episode never closes,
- `DEBOUNCED` + `recoverAfter: 3` under §3.3.

**Verification (sim G):** 50%-duty flap, 30 days, ONE tenant — HEAD **0 emails**, designed **31**.
At 100 tenants that is **3100 emails / 30 days ≈ 103/day** against a ratified ~2/day. The band is
wide: any duty ≥ 1 failure per 3 ticks never reaches `healthyObs = 3`, so the episode never closes.

Transient cross-DO RPC failure at 100+ tenants is precisely the surface
`feat/scale-monitoring-2026-08-20` exists for (audit S1), and the founder order driving this program
is "100s of customers". `customer_progress_operator:<tenantId>` has the identical shape
(`reobserved` whenever `inScope`, `watchtower.ts:590`).

This is not a hidden mechanism — §5.2 names the flapper row and calls it "the defect being fixed".
The finding is that both exemplars are wrong and the instance multiplier is absent, so the section
asserts preservation of a founder-ratified property it does not demonstrate.

### B6 · lens 7 (regression ring) · `holding` reopens the continuity N-2 nudge in the SILENT direction, breaking a property the r2 gate proved by name

`customer-continuity-build-gate-r2-2026-08-19.md`, N-3: *"The mandatory cross-clear still pushes the
abandoned name healthy in the same batch, **so no stale-unhealthy sibling accumulates to poison a
later episode**."*

`holding` creates exactly that stale-unhealthy sibling: a `reobserved` clear now leaves the row at
`status='unhealthy'` for up to `recoverAfter - 1` ticks (15 min). The onset-adoption at
`watchtower.ts:720-725` fires on `siblingState.status === "unhealthy"` — a population that now
includes siblings whose PRODUCER said healthy.

Reachable scenario, all steps grounded:
1. Tenant stalls under `customer_progress_operator:` at T0. Nudge fires at T0+1d;
   `continuity_nudge_episode_ts = T0` (`engine/continuity-nudge.ts:67`).
2. `owedCount` drops to 0 for ONE tick. Both names are cleared `reobserved` (`watchtower.ts:590-601`)
   → both enter `holding`, both still `status='unhealthy'`.
3. Within 15 min a NEW stall appears with agent blame. `customer_progress_agent:` adopts
   `Math.min(now, T0) = T0` because the operator sibling still reads unhealthy in the pre-pass
   `stateByName` (`:657, :720-725`).
4. `maybeEmitContinuityNudge(T0)` hits
   `if (row.continuity_nudge_episode_ts !== null && row.continuity_nudge_episode_ts >= episodeSinceTs) return;`
   (`continuity-nudge.ts:56`) — `T0 >= T0` → **returns before deriving anything**.

The new stall episode receives **zero** nudges for its entire duration. At HEAD step 2 sets
`status='healthy'`, adoption does not fire, the new episode gets its own onset, and the nudge lands.
Blame oscillation is documented in-repo as normal (`watchtower.ts:701-707`: *"Blame genuinely
oscillates (it tracks a vendor wallet that dips and refills)"*).

§5.4's assurance — *"makes the nudge more exactly-once, never less"* — walks only the duplicate
direction. The guard is `>=`, so an inherited onset is a permanent deletion, not a delay.

---

## NON-BLOCKING

### N1 · The escalation DELETES the 6 h rung; it does not "push out" the 24 h reminder
§1.4: *"a genuine 24h persistence reminder is pushed out by exactly the email that just went out."*
The escape increments `alertCount`, and `gapMs = alertCount >= 2 ? steady : first`
(`watchtower-policy.ts:236`), so the first escalation moves the check from the 6 h rung to the 24 h
rung. **Sim M:** with an escalation at minute 10 — `alerted@5min, escalated@10min, realerted@1450min`;
without it — `alerted@5min, realerted@365min`. The 6 h "still broken" ping is gone. Direction is
fewer emails (safe for volume), but the rule's effect is not the one the sentence describes.

### N2 · §7.3 names three families that are not the ones arriving — and the three that ARE arriving are `cron_legs`-shaped, which §3.3 has no rule for
`MAILBOX_RELEASE_FAILED` / `DOMAIN_ORDINAL_FAILED` / `MAILBOX_SLOT_FAILED` are activity-row action
strings (`engine/lifecycle.ts:296`, `engine/provisioning.ts:687`, `engine/mailbox-provisioning.ts:195`),
routed to TRAIN 5 as "reach no watchtower check". The scale lane's actual new families are
`sweep_coverage`, `sweep_signals`, `alert_delivery` (`admin/watchtower-alerts.ts` diff in the
`scalemon` worktree).

Two consequences the design does not carry:
- All three are `gradeSweepStreak`-damped upstream — `cron_legs`' shape. §3.3's DEFAULT is `DEBOUNCED`
  with `recoverAfter: 3`, which is exactly the double-damping §3.3 says must not be applied to
  `cron_legs`. §7.3 says only that they "owe three declarations"; no rule tells the builder which.
- `sweep_coverage`'s unhealthy detail embeds `coverage.total`, `coverage.coverageTicks` and
  `signals.deferralDetail` — count-bearing, i.e. §1.1 rule 1's trap — on a family whose own comment
  says "at scale it is non-zero on EVERY tick, permanently". That family + B2 = permanent silence.

### N3 · Migration number collision
§2.1 claims `0019` and §2.4 claims `0020`. `apps/platform/migrations/0019_sweep_cursor.sql` already
exists (untracked) in the scale lane, which §7 mandates merges FIRST. Not fatal —
`wrangler d1 migrations apply` keys on filename — but both stated numbers are wrong the moment the
merge order the design specifies is honored.

### N4 · §5.4's withheld-escalation rule is unimplementable in the store §2.4 adds the ledger to
`reconcileSdnAlert` has no delivery-outcome plumbing at all: `sendSdnAlertEmail` returns `void`,
returns silently when `OPS_ALERT_EMAIL` is unset, and swallows every send throw
(`ofac/sdn-alert.ts:107-122`). So an SDN escalation into a dark channel banks its key and is
**permanently deleted** — the exact outcome §5.4 says must not happen ("converts a dark-channel
escalation into a permanently deleted one"). Related, same section: §3 gives SDN no
`recoverAfterObservations`, so by §0's own coupling argument the SDN lane ships §1 without §3; and
`SdnAlertAction` (`sdn-alert.ts:36`) is a separate union §3.5 never mentions.

### N5 · The `AlertAction` enumeration is read at more sites than §3.5 names
- `alertEmailFor`'s switch ends `default: return null` (`watchtower-alerts.ts:263-265`) — a forgotten
  `escalated` case silently drops the email while the ledger records the key as announced.
- `wouldEmail` (`watchtower.ts:688`) is a SECOND, independent enumeration of the email-owing actions;
  §3.5 does not mention it, and the digest-channel `why` is wrong without it.
- `reasonForNoEmail` (`watchtower-alerts.ts:358-362`) falls through to `nothing_owed` for any
  unmapped action, so `holding` reports "there was nothing to tell" unless explicitly mapped.

### N6 · `holding` makes `GET /admin/ops/checks` self-contradictory for up to 15 minutes
`upsertWatchtowerState` writes `result.detail` unconditionally (`watchtower.ts:726`) and
`readAllCheckRows` maps `healthy: row.status === "healthy"` (`:869-899`). During `holding` the row
reads `status='unhealthy'` next to a detail written by a HEALTHY producer ("Domain X now has working
mail DNS"). §4 credits itself with fixing the analogous display defect; §3 creates this one.

### N7 · Cite error in §1.2 (key space itself is correct)
"the three `alertMailboxStuck` call sites (`mailbox-provisioning.ts:399,421`)" — there are TWO
(`:399`, `:421`). The declared 3-value space is still derivable because `:399` carries a
`lookup_failed` / `too_recent` ternary. Cite error, not a design error.

---

## Per-§ rulings

| § | Ruling |
|---|---|
| §0 (coupling) | **UPHELD** for the watchtower store — §1 without §3 does re-open the storm through churn, and sim G/H confirm episode count is the free variable. **NOT upheld for SDN**: §2.4 ships §1 there without §3 (N4). |
| §1.1 (key rules) | UPHELD. The three binding rules are right and the `basis: RecoveryBasis` precedent is real and load-bearing (`watchtower-alerts.ts:36-52`). |
| §1.2 (key table) | **FIX** — three declared spaces exceed the cap (B3); one cite wrong (N7); three arriving families missing (N2). |
| §1.3 (ledger) | UPHELD. |
| §1.4 (escape + cap) | **BLOCKING** — precedence undecided (B2), calibration false (B3), ladder-rung effect mis-stated (N1). |
| §2.1–§2.3 (compat) | **UPHELD** — sim I: 0 deploy-day emails on a pre-0019 row; the unreachability argument for `alertCount > 0 && keys = []` checks out against every writer in `decideAlert`/`withheldAlertState`. Migration number needs re-picking (N3). |
| §2.4 (SDN) | **FIX** — the adopt predicate is sound, but the store has no delivery-outcome plumbing (N4). |
| §2.5 (rejected version rows) | UPHELD — the rejection reasoning is correct and `admin/db.ts:250-256` says what the design says it says. |
| §3.1–§3.3 | UPHELD **except** the `no_longer_applicable` consequence (B4) and the missing rule for the three arriving `gradeSweepStreak`-damped families (N2). |
| §3.4 (both failure modes) | **UPHELD** — sim E: first alert at minute 10 on `reobserved`-clearing checks, HEAD emits 0 over the same 24 ticks. The stated residual (two failures within 20 min) is honest and correct. |
| §3.5 (vocabulary) | **FIX** — under-enumerates the action consumers (N5). |
| §4 (U-2) | **BLOCKING** — no-op as specified (B1). The rejection reasoning for (a)/(b)/(c) is sound and should survive the fix. |
| §5.1–§5.2 (volume) | **BLOCKING** — per-instance multiplier absent, both flapper exemplars wrong (B5, B4). |
| §5.3 (alternation proof) | **UPHELD, exactly** — sim A: 1 email over 13 ticks; sim B: 2 over 13 with three rotating modes. |
| §5.4 (must-not-regress) | **FIX** — N-3 holds; N-2 does not (B6); the withheld rule is right but unimplementable on the SDN store (N4). |
| §6 (test plan) | Sound in shape. Items 4, 6 and 8 are the load-bearing ones and all three are real REDs. Item 9 is **unsatisfiable** until B3 is settled. Needs new items for B2's precedence, B5's multiplier and B6. |
| §7 (sequencing) | **FIX** — §7.1/§7.2/§7.4/§7.5/§7.6 hold; §7.3 names the wrong families (N2); §2.1's migration number collides with the lane it sequences behind (N3). |
| §8 (non-goals) | UPHELD. All three declines carry a real reason; the `failure_signals` per-tenant decline (100 emails at 100 tenants) is the correct call and is the same arithmetic B5 asks §5 to apply to itself. |
| §9 (acceptance) | Item 3 unsatisfiable (B3); item 4 fine; item 5 verified by sim I. |

---

## Attacks that FAILED (why the SHIP-AFTER-FIXES is meaningful)

- **§5.3's alternation proof.** Simulated on the design's own machine: 13 ticks, two alternating
  modes, episode already announced at A → **exactly 1 email** (sim A). Pushed harder to three
  rotating modes → 2 emails, then flat (sim B). The invariant "tick count does not appear" is real.
- **§6.8's cap fail-safe count.** Fresh episode, a brand-new key every tick, 40 ticks → **exactly 5
  emails** then silence (sim K). The count §6.8 claims is right; B2 is about what the silence costs
  afterwards, not about the count.
- **§2.2's legacy-adopt rule.** Pre-0019 row (`status='unhealthy'`, `last_alert_ts` non-NULL,
  `alert_count=2`, empty ledger) → `legacy_adopt`, **0 emails**, key banked (sim I). I then tried to
  reach `alertCount > 0 && keys.length === 0` from new code by walking every writer — `alerted` writes
  both together, `escalated`/`realerted` only append, `withheldAlertState` copies the previous state,
  `healthyState` zeroes both. Unreachable. Held.
- **§3.4's timing claim.** Alternating bad/good on a `reobserved`-clearing check → first `alerted` at
  **minute 10**, inside the founder's ceiling; HEAD emits 0 over the same 24 ticks (sim E).
- **The 19-families correction.** Counted `EXPECTED_CONFIRM_OBSERVATIONS` in
  `test/watchtower-policy.test.ts:142-170`: exactly 19 keys, matching the design's enumeration
  name-for-name. The brief's "~30 names" was the wrong number; the design's correction is right.
- **§4's premise.** Checked that a dead-band tick really emits NO result rather than a healthy one —
  `watchtower.ts:258`, `if (grade !== null)`. Premise confirmed; only the composition is broken.
- **§2.3's DO-side inertness.** Confirmed only `d1_alert_state` and `dead_man_alert_state` live in DO
  storage (`watchtower-do.ts`), both single-valued key spaces, neither able to escalate.
- **Does the design make episodes/day WORSE anywhere?** Hunted for it specifically, since B2/B5 both
  turn on episode count. `recoverAfter` only ever delays closure and `no_longer_applicable` is
  unchanged, so episodes/day is monotonically non-increasing. Held. (Sim H: a 40%-duty check emits
  115 emails/day at BOTH revisions — pre-existing, not a regression, and worth its own item someday.)
- **§7.2's W-M1 composition.** The scale lane's `undeliveredAlerts` filters on `dark_channel` /
  `send_failed` by name, so a new `suppressed_key_cap` `DeliveryReason` cannot false-count as a
  delivery failure. Held.
- **§3.2's `no_longer_applicable` exemption argument** for entity departure and for the N-3
  cross-clear. Both correct: a departed entity emits no further observation, and the cross-clear at
  `watchtower.ts:576-583` genuinely needs one-tick closure. Only the `send_starved:` sentence is
  wrong (B4).
- **Key-derivation cites.** `vendor_wallet`'s four arms (`watchtower-vendor.ts:97/108/118/124`) and
  `mailbox_rebuy:`'s three sites (`mailbox-provisioning.ts:389/412/430`) are accurate;
  `domain_dns_aging:`'s `gaveUp` at `:334` is accurate.
- **Dead-man.** `recoverAfter: 1`, no escape, no constant touched, and the DO alarm path
  (`watchtower-do.ts` `alarm()`) applies `policyFor` with the same decide→send→bank order. The
  ≤15-min page guarantee is untouched by every change in this design.

---

## UNVERIFIABLE

- **The live ~2 emails/day baseline** (the 2 Mordy `domain_dns_aging` checks stable at key `pending`).
  No live D1 / admin-token access from this context. The argument holds structurally — the key's only
  input is `gaveUp` — but the current row state is unverified. *Resolves with:*
  `GET /admin/ops/checks?unhealthy=1` against prod.
- **`tenant_do_wedged:`'s production flap RATE.** I proved the mechanism and the per-tenant
  multiplier (B5); I did not observe the duty cycle. *Resolves with:* a week of Worker-log counts on
  the `watchtower.ts:242` catch, or `watchtower_state` history for that prefix.
- **§7 against a frozen scale-lane ref.** `scalemon` is uncommitted and moving; N2/N3 are against its
  working tree as read at this ref. *Resolves with:* re-checking §7 after that lane commits.

---

## What the BUILD BRIEF must carry

**Constraints (each falsifiable):**
1. Fix §4's polarity to `holding === false`, and add a RED test that fails on `&& holding` — a 300-tick
   sustained sub-threshold timeline asserting ≥1 `sustained_subthreshold` result. Without the RED arm
   the inversion passes every "it alerts on a real signal" test, because the real-signal path is the
   `grade === false` arm.
2. State the escape-vs-ladder precedence explicitly, and make a cap-suppressed escalation FALL THROUGH
   to the ladder. Pin it: an episode at the cap, unhealthy for 30 days with a churning key, must emit
   ~30 ladder emails, not 5.
3. Settle the cap against the real `max(|declared space|)`. Either the cap rises (and §5.2's ceiling
   arithmetic and §5.1's argument are re-derived at the new number) or `cron_legs` / SDN /
   `customer_progress_*` get narrowed key spaces stated as closed enumerations. §9.3 cannot be
   accepted until one of these lands.
4. Rule on `send_starved:` explicitly: either accept that IN-9 is inert for it and say so in §3.2, or
   give the drain arm episode-holding semantics — and if the latter, cost it under B5's multiplier
   first.
5. Re-derive §5 as emails **per inbox per day**, over the per-entity instance count. The two families
   that matter are `tenant_do_wedged:<id>` and `customer_progress_operator:<id>`. A per-episode
   ceiling is not an answer to a per-day property.
6. `holding` must not leave a sibling readable as unhealthy to the onset-adoption at
   `watchtower.ts:720-725`. Whatever the mechanism (a distinct `status`, a `holding` flag the adoption
   predicate excludes, or gating adoption on `healthyObs === 0`), the acceptance test is B6's
   four-step scenario asserting the second episode still gets its nudge.
7. Every `AlertAction` consumer, enumerated: `alertEmailFor`'s switch (kill the silent `default`),
   `wouldEmail` (`watchtower.ts:688`), `reasonForNoEmail`, and `SdnAlertAction`.
8. Do not add the ledger to `sdn_alert_state` until that store can tell a delivered email from a
   swallowed one, or the escalation is deleted on the first dark tick.
9. Re-read the scale lane's ACTUAL new families at merge time (`sweep_coverage`, `sweep_signals`,
   `alert_delivery`) and classify all three, including their policy — they are `cron_legs`-shaped, not
   default-shaped.
10. Re-pick the migration numbers after the scale lane merges.

**Test floor — additions to §6, each RED before GREEN:**
- §4 polarity (constraint 1) — the single highest-value RED in the increment.
- Cap-then-ladder over 30 simulated days (constraint 2).
- `cap >= max(|declared space|)` asserted over the table INCLUDING `cron_legs` and
  `customer_progress_*` (constraint 3) — it must red today.
- `send_starved:` alternation, asserting whichever behaviour the ruling picks (constraint 4).
- A 100-instance `tenant_do_wedged:` flap timeline asserting a stated per-day inbox ceiling
  (constraint 5).
- B6's four-step continuity scenario, driven through `reconcileAlerts` with the real cross-clear
  shape, asserting `maybeEmitContinuityNudge` is reached with a NEW onset (constraint 6).
- `watchtower-deadman.test.ts` and the continuity cross-clear tests pass **unedited** (already in §9.6
  — keep it).
