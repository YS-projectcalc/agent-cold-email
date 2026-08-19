# Customer-continuity build gate — ROUND 3 (the r2 fix round)

**Date:** 2026-08-19
**Target:** worktree `/Users/yaakovscher/dev/coldstart/.claude/worktrees/continuity`, branch `feat/customer-continuity-2026-08-18`
**HEAD reviewed:** `4a37ad015ce1b6870935130a2c7501af2f2a2bc2` (`4a37ad0`), tree clean at review time
**Review diff:** `19c4db5..4a37ad0` — 17 files, +832/−50
**Prior verdicts (binding):** `customer-continuity-build-gate-2026-08-19.md` (r1), `customer-continuity-build-gate-r2-2026-08-19.md` (r2)
**Reviewer posture:** read-only git in both checkouts; all executable probes run in an rsync sandbox at
`/private/tmp/.../scratchpad/sb-r3` with `node_modules` symlinked back. Zero writes to the shared worktree.

---

## VERDICT: **NO-SHIP**

Two BLOCKING findings, both in the code the r2 fix introduced, both proved by execution rather than by
reading. The r2 blocker itself (B2 — the expiry silencing and deleting a live `retry_setup`) is **closed**:
its three parts each verified independently below. But the reason added to close it,
`ordinal_slot_shortfall`, is a **false-positive generator with four reachable production paths**, and its
attached remedy is computed in a different coordinate system than the shortfall it claims to fix — so the
recommendation it emits is wrong in both directions, including one that spends real money on a domain the
platform itself burned.

This is not a request to revert the wave. It is a request to fix the predicate and the remedy of ONE reason
before this branch reaches the paying tenant.

---

## Battery — re-run by me, on the worktree, unpiped, real exit codes

| Leg | Command | Result | Exit |
|---|---|---|---|
| Typecheck | `npm run typecheck` (repo root) | clean | **0** |
| Platform | `npx vitest run` in `apps/platform` | **210 files, 2044 passed, 1 skipped** (634s) | **0** |

Both match the builder's claim exactly. As in r1 and r2, **the green battery told me nothing** — every finding
below is green under it. This is the third consecutive round where that is true, which is itself the strongest
argument for keeping this gate.

I did not re-run dashboard/engine/cli; the diff touches none of their sources and the builder's counts for
those legs are consistent with r2's. Recorded as accepted-on-trust, not verified (see UNVERIFIABLE).

---

## BLOCKING

### BLOCKING-1 — `ordinal_slot_shortfall` cannot tell a failed setup from a deliberate, an autonomous, or a persona-driven change to the live mailbox set. Four reachable paths, all producing a permanent false "owed".

**Where:** `apps/platform/src/engine/next-steps.ts:807-873` (`ordinalSlotShortfallSteps`), specifically the
predicate at `:815-828`.

**Mechanism.** The reason is `count of missing managedMailboxAddress(persona, domain, ordinal, slot) over
slots 0..inboxes_each-1`. Its two inputs move independently of each other:

- `domain_intents.inboxes_each` is **INSERT-only** (`provision-intents.ts:99` `INSERT OR IGNORE`) — a frozen
  record of what the FIRST call asked for. Nothing lowers it; `test/desired-spec-direction.test.ts` forbids a
  writer that raises it.
- `liveMailboxAddresses` is `SELECT email FROM mailboxes WHERE released_at IS NULL` — it **shrinks** for
  several reasons that are not failures, and it **moves** when the persona changes.

So the predicate reads "fewer live addresses than the frozen ask" and reports it as *"N mailboxes requested on
domain slot X were never created"*. That sentence is false in every path below, and because `inboxes_each` can
never come down, the step is **permanent**: it never clears, the account is permanently `status: "owed"`,
`seat_headroom_free` is permanently suppressed, and (see NB-1) the stuck-customer check trips
immediately.

**Path A — an autonomous domain burn. No customer action at all. This is the worst one.**
`deliverability-actions.ts:218` releases every mailbox on a burning domain and retires the domain. `'retired'`
is a *distinct status from* `'released'`, and `readProvisioningSnapshot` treats anything
`status != 'released'` as a live domain (`provisioning-plan.ts:132`). So the burned ordinal keeps
`intent.live` non-null and `dns_status = 'ready'`, its mailboxes are gone, and the shortfall fires.

Proved (sandbox probe E, real `deriveNextSteps` over a seeded post-burn fleet):

```
status: owed  reasons: ["ordinal_slot_shortfall"]
why: "3 mailboxes requested on domain slot 0 were never created — that domain is live
      and its mail DNS is up, so only the mailboxes are missing..."
recommended distribution: [3,2]
that call would buy: {"newDomains":0,"newMailboxes":3}
...and ordinal 0 (the RETIRED domain) is 'satisfied': [[0,{...,"domain":"burned0.com"}], ...]
```

The emitted call is fully runnable (`paramsToSupply: []`, `registerDomains: true` pre-affirmed) and the real
planner says all three new mailboxes land **on `burned0.com` — the domain the platform retired for
reputation**. The platform is recommending that an unattended agent re-populate a domain it just burned,
undoing its own deliverability protection and re-billing the customer for it.

**Path B — a customer-initiated downgrade, reported back inside the downgrade's own response.**
`removeMailboxes` (`billing.ts:1049`) releases the N newest mailboxes and never touches `inboxes_each`; its
result carries `nextSteps: deriveNextSteps(ctx)` at `billing.ts:1070`. Proved (probe B — a clean 2×4 fleet,
nothing failed, customer removes 2 with `acknowledged: true`):

```
removeMailboxes released: 2 failed: 0
status returned to the customer: owed
why: "2 mailboxes requested on domain slot 1 were never created — ..."
recommended params: {..., "domains":3, "distribution":[3,3,2], "registerDomains":true}  toSupply: []
what that recommended call would BUY: {"newDomains":1,"newMailboxes":3}
```

The customer asks to spend less; the same call's response tells them the platform failed them, and hands their
agent a ready-to-execute call that undoes the downgrade **and buys a third domain they never asked for**.

**Path C — a persona change.** `recordDomainIntent`'s `INSERT OR IGNORE` keeps the FIRST persona on the intent
row while the saga provisions under the REQUEST persona (`provisioning.ts:620,667`). Proved (probe D): a
tenant with 5 live mailboxes on one domain — 2 under `alpha`, 3 under the current `beta` — derives
`status: owed`, `["ordinal_slot_shortfall"]`, *"1 mailbox requested on domain slot 0 was never created"*.

**Path D — the intended case (a retryable per-slot vendor failure)** is real and correctly covered. It is the
only one of the four the derivation is right about.

**Live-tenant reachability.** `ten_91aab24a`'s intents are legacy NULL-spec, so the abstention at
`next-steps.ts:820` insulates him **today** (this is disclosed residual (b), and it is doing more work than the
builder credited it with — see the ruling). The spec writer (`43ad313`, 2026-08-14) is on `origin/main`, so:
the moment he makes any `setup_infrastructure` call — which is exactly what this wave's recommendations push
him toward — his new ordinals carry a spec and Path A/B/C become live for him. For every customer acquired
after this deploys, all four paths are live from their first setup call. Against the standing "100s of
customers" order, this ships a permanent false-owed to every account that ever downgrades or burns a domain.

**This is the design gate's own class, reopened one table over.** From the r2-round design verdict: *"For any
'owed/unfinished' derivation, find a state that is BOTH the defect and a legitimate terminal preference; if the
system stores nothing that separates them, the signal is unshippable as `owed`."* That was raised and accepted
for `unusedPaidSeats`. `inboxes_each` has the same property, and the schema stores nothing that separates
"never created" from "created, then deliberately or autonomously removed".

**Verification method:** four executable probes against the REAL `deriveNextSteps`, `removeMailboxes`,
`readProvisioningSnapshot` and `planFor` in the `cloudflare:test` DO harness, in a sandbox copy of this exact
HEAD. Not traced — run.

---

### BLOCKING-2 — the remedy is computed in a different coordinate system than the shortfall, so *"repeating the setup call creates exactly the missing ones"* is false in both directions.

**Where:** `apps/platform/src/engine/next-steps.ts:838-841` (the action's distribution) versus `:821-826` (the
shortfall's own count); the claim itself at `:860`.

**Mechanism.** The shortfall is measured **per ordinal, per slot**, against that ordinal's own
`inboxes_each`. The remedy is `fillDistribution(snap.provisioning, max(billedQuantity, 5))` — a **flat total**
packed 3-per-domain (`MAILBOXES_PER_DOMAIN = 3`) across ordinals, where `billedQuantity` is
`mailbox_qty_synced`, i.e. `max(5, current live count)` (`billing.ts:894`). The remedy therefore targets
*roughly the number of mailboxes the tenant already has*, redistributed — which has no relationship to which
slots are missing. `inboxes_each` is bounded 1..10 by the schema (`packages/shared/src/intents.ts:116`), well
above the fill's 3-per-domain packing, so the two coordinate systems diverge routinely.

Both failure directions proved (probe A, real `deriveNextSteps` + real `planFor`):

| Case | State | Emitted `distribution` | What the real planner says it buys |
|---|---|---|---|
| A | asked `[3,3]`, one slot failed, 5 live, billed 5 | `[3,2]` | `{newDomains: 0, newMailboxes: 0}` — **a total no-op** |
| B | asked `[5]` on one domain, one slot failed, 4 live, billed 5 | `[3,2]` | `{newDomains: 1, newMailboxes: 2}` — **buys a NEW DOMAIN**, never fills slot 4 |
| control | the wave's own `SLOT_SHORTFALL_FLEET` shape | `[3,2]` | `{newMailboxes: 1}` — correct |

Case A: the account is permanently short one mailbox it paid for, and the platform's own remedy can never
deliver it. The agent executes, gets success, re-derives, sees the identical step, forever.

Case B is worse and it escalates. The call buys a domain + 2 mailboxes; live goes 4→6; `mailbox_qty_synced`
syncs to 6; the next derivation's fill target is 6 → `[3,3]` → buys another; at 7 → `[3,3,1]` → **a third
domain**. Each iteration spends real money (domain registration + $10/mailbox), the shortfall on ordinal 0
slot 4 is never touched, and the step keeps telling the agent this "buys nothing twice", up to the 60-mailbox
self-serve ceiling.

**Why the suite is green on it.** The wave's own fixture is grain-matched to the single case where the two
coordinate systems happen to agree: `SLOT_SHORTFALL_FLEET` is 2 ordinals asking 3+2 with the fill target
landing on exactly `[3,2]`. My control case above reproduces it passing. Move the ask one notch in either
direction and the remedy breaks. This is the fixture-realism class from r1 (*"grain-matched fixtures cannot see
a NULL they always seed"*), one wave later, in the fixture built to close r1's finding.

**Note on scope:** `ordinalIncompleteSteps` (`:838` sibling at `:731`) uses the same `fillDistribution` and
makes a comparable claim. There the claim is domain-level and `fillDistribution` packs existing ordinals first,
so it is usually right; I am **not** raising it as a finding, but a fix for BLOCKING-2 should be shaped so it
covers that sibling rather than special-casing the new reason.

**Verification method:** executed. `planFor` run against the emitted `params.distribution` verbatim.

---

## NON-BLOCKING

**NB-1 — `sinceMs` measures the intent's last status transition, not the shortfall's onset; it turns every
BLOCKING-1 false positive into an immediate founder alert and customer nudge.**
`next-steps.ts:832` anchors `sinceMs` to `clampedAge(intent.updatedAt, …)`. `domain_intents.updated_at` moves
only on a status transition (`provision-intents.ts:382`) or a key rebind. In BLOCKING-1's paths A/B/C the
ordinal committed weeks ago, so `oldestOwedSinceMs` is instantly past
`DEFAULT_CUSTOMER_PROGRESS_OWED_MAX_MS = 48h` → `owedTooOld` at `admin/watchtower.ts:546` → the
`customer_progress_*` check goes unhealthy after two observations (10 min) → founder alert + the one-shot
customer nudge saying the account has not progressed. Correct for `ordinal_incomplete` (where the intent
genuinely has been stuck since `updated_at`); wrong for a shortfall on a committed ordinal. Fixing BLOCKING-1
removes most of the blast radius; the anchor is still measuring the wrong thing.

**NB-2 — the prune's new retention compares a real-wall-clock column against `ctx.clock`.**
`tenant-messages.ts:558`: `const cutoff = ctx.clock.now() - READ_RETENTION_MS`, applied to **both** legs.
`read_at` is stamped `ctx.clock.now()` (`:387`) — like-for-like, correct. `expires_at` is stamped
`realNowMs()` (`:433`) — cross-domain. A demo/free tenant's `VirtualClock` is advanced arbitrarily
(`clock.ts:110` `advanceVirtual`, used to resolve a 28-day warmup ramp), so once it leads real time by >30
days, `cutoff > realNow` and every just-expired row is deleted on the next sweep — the exact destruction part 3
was added to prevent, inert for that population. The builder disclosed N-B-6 as "skipped with cause: `expires_at`
is a real-wall-clock column, so `readNextStepsSnapshot`'s realNow read is like-for-like". **That cause is true
for the read and does not hold for the prune line the same commit wrote.** Scope: demo/virtual-clock tenants
only; no paying tenant. Fix is one `realNowMs()` for the expired leg, keeping `ctx.clock` for the read leg.

**NB-3 — the min-age gate ages from a column the dedup branch re-stamps.**
`next-steps.ts:971-976` gates the durable expiry on `clampedAge(m.createdAt, …) >= orphanGraceMs`;
`emitTenantMessage`'s dedup branch does `UPDATE tenant_messages SET … created_at = ? …` (`:137`). A repeatedly
re-emitted `retry_setup` therefore never ages past the grace and is never expirable. The direction is
fail-safe (over-owed, and the re-emit only happens while the failure recurs, which is when you want the row),
so this is an observation, not a defect — but it is the design gate's own *"no aging logic may read a column a
refresh re-stamps"* rule, and the wave's own tests age rows by direct `UPDATE`, so it is untested. Worth a
comment at minimum.

**NB-4 — the grace-window silence is real, bounded, and undisclosed.** (The brief's "think hard" item.)
The fix splits the immediate owed-exclusion (ungated) from the durable expiry (gated). I probed the exact r2
case — a `dangling` ordinal inside its 30-minute grace with a live `retry_setup` row:

```
INSIDE GRACE status: none_owed  owedCount: 0  reasons: []
INSIDE GRACE steps: [{"reason":"ready_to_launch","kind":"available"},
                     {"reason":"seat_headroom_free","kind":"available"}]
surfaced messages: ["retry_setup"]
after ops fan-out, rows: [{"kind":"retry_setup","expires_at":null}]
```

So for up to `PROVISIONING_ORPHAN_GRACE_MS` the customer's machine-readable answer is `none_owed`, with
`seat_headroom_free` saying "Nothing is blocked and nothing is required" and `ready_to_launch` offered — while
their second domain purchase has thrown.

**I rule this NON-BLOCKING**, on four grounds I verified rather than assumed: the durable row survives
(`expires_at: null` after the ops fan-out, above); the action item is still listed on the customer's message
surface with its `actionHint`; at grace expiry `ordinal_incomplete` fires and it is owed again (the wave's own
test at `next-steps-slot-shortfall.test.ts:254-269`, which I re-read); and the alternative — counting every
unacked row — is precisely the stale-row defect r1's B2 existed to fix. The fix moved the failure from
*durable and destructive* to *transient and reversible*, which is a genuine improvement, not a relabel.

Two conditions on that ruling. (i) It is **undisclosed** — the brief presents the split as closing the race,
and it closes the durable half only. (ii) It is **untested**: the wave's grace test asserts only
`expires_at === null` and never asserts what the customer is told. `provisioningOrphanGraceMs` is env-tunable
(`ops-summary.ts:183`) with no upper bound, so an operator raising it silently extends the silence. Ask for a
test pinning `owedReasons` inside the grace.

**NB-5 — `paid_seats_unprovisioned` and `ordinal_slot_shortfall` double-fire on the same condition.**
When `billable === 0` with a committed, DNS-ready ordinal carrying a spec, both fire: `owedCount` is 2 for one
problem and the customer gets two `why` sentences and two identical `setup_infrastructure` actions for it. No
contradiction in `effect` (the shortfall's is `null`), so it is noise rather than a lie. Cheap fix: have the
shortfall yield when `paid_seats_unprovisioned` is present, the way `seat_headroom_free` already yields.

---

## Rulings on the disclosed items

### (a) Fixture semantics — **HONEST, and the fix is real. My predecessor's claim was wrong.**
I verified this myself rather than accepting either account. `git show 19c4db5:apps/platform/test/next-steps-stale-system-messages.test.ts`
seeds `inboxes_each` as `Math.max(1, ord.liveMailboxes)` — so `HEALTHY_FLEET`'s intents asked **2+2**, live ==
requested. The r2 gate's "intents asking 3+2" was reading `fillDistribution`'s output off the billed floor as
if it were the persisted ask. The builder is right and said so plainly. The `requestedSlots` seed field is a
real fix, applied to both fixture files, and `SLOT_SHORTFALL_FLEET` genuinely asserts owed + not-expired +
headroom-suppressed. **Not a dodge.** The one thing it does not fix is that the new fixture is still
grain-matched on the *remedy* axis — see BLOCKING-2's control row.

### (b) The legacy NULL-spec residual — **ROADMAP-grade, and the decline to backfill was correct for a reason stronger than the one given.**
The builder declined to backfill `inboxes_each` because guessing would record a wrong ask and a raising writer
is forbidden by `test/desired-spec-direction.test.ts`. Both true. **The stronger reason, which the disclosure
does not state: that abstention is currently the only thing keeping BLOCKING-1 off `ten_91aab24a`'s account.**
A backfill would have armed all four false-positive paths on the one paying tenant on the day this deploys. So
the decline was right, and the residual's blast radius as stated ("a future slot failure on a legacy ordinal
isn't owed; it survives 30 min + 30 days recoverable instead of being deleted in one sweep") is **honestly
stated and correctly bounded** — I could not find a state that makes it worse than described.

On the sub-question asked: yes, the expiry still silences the CUSTOMER surface in that window even though the
operator can recover the row — that is NB-4, and it is the same 30-minute transient for legacy and non-legacy
ordinals alike. The raised-ask case (a later, larger ask leaving the lower stored number) is also correctly
described as invisible; note it is the *safe* direction of the same INSERT-only property that makes BLOCKING-1
unsafe in the other direction.

Ruling: ROADMAP, tied to the `PROVISIONING_RECONCILE` arm-gate work item as proposed. Not a ship blocker.

---

## Attacks that FAILED (what I tried, and why it held)

- **The 32-row expiry cap starves the tail / re-picks the same rows forever.** Refuted. The snapshot's message
  read excludes expired rows (`next-steps.ts:238`: `expires_at IS NULL OR expires_at > ?`), so an expired
  row leaves the candidate set and the next tick picks up the next 32. Ordering is `created_at DESC, rowid
  DESC` — deterministic, converges. The bind count is `2 + 32 = 34`, comfortably under the 100-param SqlStorage
  ceiling. N-B-3 is correct as built, including the choice not to chunk-loop.
- **The address construction diverges from `planFor`.** Held. `next-steps.ts:822` is byte-identical to
  `planFor`'s address-constructing branch (`provisioning-plan.ts:217`), same argument order, same
  `managedMailboxAddress`. r2 brute-forced the inversion; I re-read both and they match.
- **N-B-1's `billClaimSentence` can disagree with the machine field.** Held, and structurally so.
  `billingEffect` is `buildMailboxBilling(ctx, provisionedAfter)` (`billing.ts:985`), whose returned
  `provisionedAfter` **is** the argument, and the prose branches on `effect.provisionedAfter` — the same object
  that travels in `effect`. They cannot disagree. The r1 "confident wrong number" class is genuinely closed at
  this site.
- **The min-age gate can be defeated by a future-dated `created_at` on a virtual-clock tenant.** Held. It goes
  through `clampedAge`, which clamps to `MIN(anchor, realNow)` → age 0 → the destructive write is *deferred*.
  Safe direction, and it is the documented wave-level rule (`clamped-age.ts`), not a per-site judgement.
- **The G5 exemption lets a genuinely failed execution hide behind `ordinal_slot_shortfall` newly appearing.**
  Held, for the reason the builder gives: (a) is not the conjunct that binds a failed execution — (b)
  (`!stillOwed || shortfall < beforeShortfall`) is, and exempting a reason from (a) does not touch (b), (c) or
  (d). I re-derived J1's argument against the new member rather than assuming it transfers. Separately: no G5
  fixture reaches a shortfall state at all (all `seedRealTenant` fleets are live == requested), so the guard
  neither catches nor is weakened by BLOCKING-1/2 — worth saying out loud, since a reader could mistake the
  green G5 for coverage.
- **Burn-replacement intents leak into the ordinal loop.** Held. `domainIntentOrdinal` returns `undefined` for
  `replacementDomainIntentKey` rows and `readProvisioningSnapshot` skips them (`provisioning-plan.ts:157-159`).
  (The burn's damage arrives through the *retired domain*, not the replacement intent — BLOCKING-1 path A.)
- **BYO / DNS-not-ready / no-spec abstentions are wrong or vacuous.** Held. All three are scoped by the same
  predicates their sibling reasons use, and the wave's negative tests are non-vacuous — I re-ran them and also
  hit the same branches from my own seeds.
- **Two-digit slot parsing collides with `inboxes_each` up to 10.** Held. Slot indices run 0..9 (single digit)
  because the schema caps each distribution entry at 10; r2's brute force covers the in-range space.
- **r1/r2 holds un-holding.** Spot-checked three: `SELF_WRITTEN_MESSAGE_KINDS` is still applied at the single
  site where `owedCount` is sourced (`next-steps.ts:246`, the snapshot filter — the correct reader); the zod
  `.superRefine` on `SetupInfrastructureInput` is untouched by this diff; `backfillPersonaSlugs`'s isolation is
  unchanged apart from the additive `deferred` counter, which is counted-not-dropped as claimed and correctly
  unreachable today (batch 32 > the ordinal ceiling of 20).
- **The builder's own committed agent-memory files hide an undisclosed knock-on** (the r2 lesson). Checked
  first, per my ledger: `git diff --stat 19c4db5..4a37ad0 -- .claude/agent-memory` shows two new files and one
  updated. All three are honest this round, and the previously-buried knock-on is now written up as closed with
  a pointer to the fix. Nothing hidden there.

---

## UNVERIFIABLE

- **Dashboard / engine / CLI legs of the battery.** I ran typecheck + the platform suite only. The diff touches
  no source in those packages, so I accepted the builder's counts rather than spending ~10 more minutes; that
  is trust, not verification. *Resolved by:* re-running the three legs on `4a37ad0`.
- **`ten_91aab24a`'s current live row values.** I could not query production from this session, so the
  live-tenant reachability statement in BLOCKING-1 rests on r1/r2's recorded probe of his rows (all-legacy
  NULL-spec intents) plus the `43ad313` ancestry check, not on a fresh read. *Resolved by:* one read-only probe
  of `SELECT key, status, persona_slug, inboxes_each FROM domain_intents` for that tenant. If any row comes
  back with a non-NULL `inboxes_each`, BLOCKING-1 is live for him **today**, not after his next setup call.
- **Whether a real vendor slot failure leaves `domain_intents.updated_at` at the commit instant.** I traced the
  writers (`UPDATE domain_intents` exists in exactly three places) but did not execute the saga's failure path,
  so NB-1's claim that `sinceMs` is correct for a *first* setup and wrong thereafter is traced, not run.
  *Resolved by:* a test that fails one slot through the real saga and asserts the emitted `sinceMs`.

---

## NEW (out of scope, no verdict weight)

- `readProvisioningSnapshot` treats `status != 'released'` as "live" while the deliverability subsystem has a
  terminal `'retired'` state. That mismatch predates this wave and is what makes BLOCKING-1 path A possible;
  other planner consumers inherit it (a `setup_infrastructure` retry will happily provision onto a retired
  domain regardless of this wave). Worth a class sweep of "what counts as a live domain" independent of this
  branch.
- A burned ordinal (intent `committed`, domain retired) is covered by **no** reason: `ordinal_incomplete`
  requires status `intent`/`dangling`, and post-fix `ordinal_slot_shortfall` describes it wrongly. Pre-existing
  coverage gap, surfaced by this review rather than caused by it.
