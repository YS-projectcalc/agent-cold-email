# Customer-continuity BUILD gate — ROUND 5 (focused: the NEW-1 fix)

**Ground ref:** worktree `/Users/yaakovscher/dev/coldstart/.claude/worktrees/continuity`, branch
`feat/customer-continuity-2026-08-18`, `git rev-parse HEAD` = **`ffccdc7cc3c819ee9ef2eecfdfd1bfb49e12ebaa`**
(clean tree; commits `9bb9b98` + `ffccdc7` on `08d8e53`). Review diff `08d8e53..ffccdc7` — **4 files,
+655/−137, ALL under `apps/platform` (1 src + 3 test).** The builder's "platform + test only" claim is
verified by `git diff --numstat`; nothing in `packages/`, `site/`, or `mcp/` moved this round, and
`.claude/agent-memory` carries **zero** files in this diff (the r2 class checked first, came up empty).
Date 2026-08-19. Reviewer: fresh-context adversary, read-only git in both checkouts, all execution in
rsync sandboxes.

## VERDICT: **SHIP**

**The r4 NEW-1 class is CLOSED, 3/3, and I re-derived every part of the closure rather than accepting it.**
All four checklist items in the brief pass on the substance, each verified by execution:

| Checklist item | Verdict | How I verified it |
|---|---|---|
| 1. Three members priced; withheld branch stays `null`; abstention stated | **PASS** | Ran the real derivation + real `planFor` over 14 constructed fleets; the invariant `effect.provisionedAfter === billable + plan.newMailboxes` held in every priced case, incl. BYO-mixed compositions no fixture covers |
| 2. `billMoveSentence` derived from the same `effect`, anchored on `mailbox_qty_synced` | **PASS** | Anchor reasoning re-derived and correct; the DANGEROUS direction is structurally impossible (proof below). One defect in the SAFE direction — N2 |
| 3. Class guard over the derivation, non-vacuous, no exemptions | **PASS** (with N3) | Ran the new guard against the **pre-fix source** — 10 violations spanning all three reasons. Genuinely non-vacuous |
| 4. Revert-fail-restore + battery | **PASS** | Reproduced the revert-fail myself; every battery leg re-run unpiped, numbers match the builder exactly |

**Four NEW findings, all NON-BLOCKING**, reported separately per convergence discipline — none of them
re-scores the r4 checklist. Two are genuinely introduced by this diff (N1, N2); one is a guard-strength
overclaim (N3); one is a false justifying clause on an otherwise-correct scoping call (N4).

**Ruling on the builder's no-exactness-gate soundness call: the SCOPING DECISION IS CORRECT, the STATED
REASON IS FACTUALLY FALSE.** Detail in "The soundness call" below — this is the round's most important
non-blocking item because the false clause is exactly the kind a later edit will trust.

---

## Battery, re-run by me (not quoted from the builder)

All legs on the worktree at `ffccdc7`, unpiped, real exit codes:

| Leg | Result | Exit |
|---|---|---|
| `npm run typecheck` (4 packages) | clean | **0** |
| `apps/platform` vitest (run from `apps/platform`) | **211 files, 2063 passed, 1 skipped** | **0** |
| `apps/dashboard` vitest | 143 passed | **0** |
| `apps/engine` vitest | 140 passed + 4 skipped | **0** |
| `packages/cli` (`npm test -w packages/cli`, `node --test`) | **12 pass / 0 fail** | **0** |

Every number matches the builder's claim exactly. **As in rounds 1–4, the green battery told me nothing** —
all five findings came from executing the real derivation against constructed row values and from running
the new guard against the OLD source.

**Runner gotcha, recorded for the next round:** `npx vitest run` from the **repo root** (rather than from
`apps/platform`) picks up a different project set and reports `192 failed / 69 passed` on a perfectly green
tree. That is a WRONG-CWD artifact, not a red suite. Always `cd apps/platform` first.

**Probe harness** (unchanged, still the whole game): `rsync -a --exclude node_modules --exclude .git` the
worktree to a sandbox, symlink `node_modules` back, drop probes in `<sandbox>/apps/platform/test/`,
`npx vitest run test/<probe>.test.ts`. ~4s per probe with the full `cloudflare:test` DO harness, zero writes
to the shared worktree. The workers pool still swallows `console.log` — collect into a module-level array
and dump through a deliberately failing `expect`.

**Second sandbox, and it is what made this round decisive.** I built a `sb-old` sandbox identical to the
first except that `apps/platform/src/engine/next-steps.ts` was replaced by `git show 08d8e53:…` — the
pre-fix source with the post-fix test files. That single setup answered two questions by execution rather
than by reading: *is the emitted action really byte-identical?* and *does the new guard really fail on the
old code?*

---

## The checklist, re-derived

### 1. Three members priced — **CLOSED**

Ran the derivation over 14 fleets covering all three reasons plus the abstention and withheld branches.
Representative results (`effect` is the step's own field; `REAL PLAN` is `planFor` re-run on the step's
OWN emitted `params`):

```
ordinal_slot_shortfall   billed 5, live 5, 1 slot never created
    distribution=[3,3]  REAL PLAN {d:0, m:1}
    effect={"provisionedAfter":6,"projectedMonthlyCents":10900}   $99.00 -> $109.00
    why: "...creates exactly the 1 missing one and buys nothing twice.
          This call DOES change your bill: `effect` projects 6 mailboxes, above the 5..."

ordinal_incomplete       billed 5, live 2, ordinal 1 dangling
    distribution=[3,2]  REAL PLAN {d:1, m:3}
    effect={"provisionedAfter":5,"projectedMonthlyCents":9900}    unchanged (inside the floor)

domain_dns_incomplete    billed 5, live 2, ordinal 1 mid-DNS
    distribution=[3,2]  REAL PLAN {d:0, m:3}
    effect={"provisionedAfter":5,"projectedMonthlyCents":9900}    unchanged (inside the floor)
```

**`provisionedAfter` means the same thing here as in the sibling `paid_seats_unprovisioned`.** I traced
both to the identical expression: the sibling's `planRecommendation` returns
`provisionedAfter: snap.billableMailboxes + plan.newMailboxes` (`next-steps.ts:522`), and the three new
sites compute `billingEffect(ctx, snap.billableMailboxes + executed.plan.newMailboxes)` inline. Same
number, same meaning.

**And it really is the billing meter.** `snap.billableMailboxes` (`next-steps.ts:336-338`),
`billableMailboxCount` (`lifecycle.ts:151-155`) and `provisionedMailboxCount` (`billing.ts:858-862`) are
three **byte-identical** SQL statements — `SELECT COUNT(*) FROM mailboxes WHERE tenant_id = ? AND
released_at IS NULL` — and `syncMailboxQuantity` pushes `billableMailboxes(provisionedMailboxCount(ctx))`
to Stripe (`billing.ts:894`). BYO mailboxes are NOT excluded from either side, so the two cannot diverge
by composition. There is no third definition to disagree with.

**The below-floor crossing is handled.** `billableMailboxes()` floors at 5 on both sides of the comparison,
so `live 3 -> 5` reads "unchanged" (true, $99 = $99) and `live 3, buys 3 -> 6` reads "DOES change" (true,
$99 -> $109). Verified by execution in both directions.

**The discount folds correctly, on the live tenant's actual rate.** Seeding `checkout_discount_pct = 60`
(the MORDYPILOT coupon) reproduced the design canon's own worked numbers exactly:
`effect.projectedMonthlyCents = 4360` against a `subscriptionToday` of `3960` — the $39.60 → $43.60 the
design doc states at `docs/research/customer-continuity-design-2026-08-18.md:236-242`. The step's price is
the price the customer is actually charged, not list.

### 2. `billMoveSentence` — **CLOSED**, and the dangerous direction is impossible

The builder's recorded reasoning for anchoring on `mailbox_qty_synced` rather than the five-seat minimum
is **correct, and I re-derived it rather than accepting it**: `seat_headroom_free`'s own predicate is
`billable < MINIMUM_BILLABLE_MAILBOXES` (`next-steps.ts:734`), so the floor IS its right anchor; the three
setup-family reasons carry no such predicate and fire at any size, where an account already billing 6 would
have had a call landing at 6 announced as a bill change. Declining to reuse `billClaimSentence` is also
right — its "Ask for fewer to stay inside the minimum" is false advice about mailboxes already paid for.

**The direction that would be blocking cannot occur.** `monthlyRevenueCents(n, d) = round((4900 + 1000 ×
max(5,n)) × (1 − d/100))` is monotonic non-decreasing in `n`, and the post-call charge is
`monthlyRevenueCents(provisionedAfter)`. So whenever the sentence takes its "does not add to it" branch —
i.e. `billableMailboxes(provisionedAfter) ≤ billableMailboxes(billedQuantity)` — the post-call charge is
provably **≤** the current charge. A bill-raising call described as free is structurally unreachable, not
merely un-fixtured. The residual error is one-directional and is N2 below.

`newMailboxes === 0` correctly short-circuits to "this call buys nothing", which is what stops an
under-synced account (`billed < live`) from being told a no-op call raises the bill — the builder disclosed
this reasoning in the docstring and it holds.

### 3. The class guard — **non-vacuous, verified by revert**

Running `test/next-steps-billing-effect-guard.test.ts` against the **pre-fix** source produced 10
violations spanning **all three** members:

```
slot shortfall (the wave's fixture)/ordinal_slot_shortfall: plan buys 1 mailboxes, effect: null
slot shortfall, one slot missing on the second ordinal/ordinal_slot_shortfall: ...
slot shortfall on a single deep ordinal/ordinal_slot_shortfall: ...
slot shortfall of three mailboxes/ordinal_slot_shortfall: plan buys 3 mailboxes, effect: null
ordinal incomplete (dangling second ordinal)/ordinal_incomplete: plan buys 3 mailboxes, effect: null
ordinal incomplete beside a short live ordinal/ordinal_incomplete: plan buys 4 mailboxes, effect: null
ordinal incomplete beside a short live ordinal/ordinal_slot_shortfall: ...
a domain whose mail DNS has not come up/domain_dns_incomplete: plan buys 5 mailboxes, effect: null
a mid-registration domain on an account already at the floor/domain_dns_incomplete: plan buys 2 ...
a second domain mid-registration behind a finished one/domain_dns_incomplete: plan buys 2 ...
```

plus the worked-example test failing with `expected null to deeply equal {provisionedAfter: 6,
projectedMonthlyCents: 10900}`. **Revert-fail-restore independently reproduced.** The guard is real
coverage, not coverage theater, and no exemption survives in it. Its weakness is N3.

### 4. Seeder extraction — **no test was weakened**

`git diff --numstat` on `apps/platform/test/next-steps-slot-shortfall.test.ts` is **3 insertions / 112
deletions**, and all three insertions are import lines. The `Ordinal`/`Seed` interfaces and every line of
`seedTenant` moved byte-for-byte into `test/next-steps-fleet.ts`. **Not one assertion was touched.** The
NB-4 grace pin is intact (`expires_at` assertions at lines 132/192/211/227/249 unchanged).

---

## The soundness call — `domain_dns_incomplete` without the exactness gate

**RULING: the decision is CORRECT for this round; the sentence justifying it contains a false factual
clause that must be corrected.**

The comment at `apps/platform/src/engine/next-steps.ts:1221-1227` reads:

> THE ACTION IS UNCHANGED, deliberately … The shortfall's exactness-withhold gate is NOT imposed here and
> would be wrong if it were: that gate exists because a wider call re-creates addresses a customer released
> ON PURPOSE, while this reason recommends the ordinary fill-to-the-billed-quantity call its seat-family
> siblings also emit, **on a domain whose slots nobody has released.**

**The bolded clause is false, and I proved it.** Fleet: ordinal 0 holding slots 0–1 with slot 2 RELEASED
(a deliberate downgrade — the row survives with `released_at` set), ordinal 1 mid-DNS.

```
P1  billable=2 billed=5
    liveAddrs = mordytee11@p1-a.com, mordytee12@p1-a.com     (mordytee13@… was RELEASED)
    domain_dns_incomplete -> distribution=[3,2], REAL PLAN {d:0, m:3}
```

Three mailboxes: **one of them is `mordytee13@p1-a.com`, the address the customer deliberately released.**
The fill prefix reaches it because `fillDistribution` packs by SLOT INDEX to the billed quantity, and the
released slot is an index inside that prefix. This is the r3 path-B shape arriving through this reason's
remedy, exactly as the brief anticipated.

**But it is PRE-EXISTING, and this diff does not arm it — it makes it visible.** Proved by running the
identical probe against the pre-fix source in `sb-old`: across all seven fleets, `params.domains`,
`params.distribution` and `params.persona` are **identical** before and after. The only field that moved is
`effect` (was `null` everywhere, now priced) plus the appended sentence.

```
08d8e53:  domain_dns_incomplete  distribution=[3,2]  REAL PLAN {d:0,m:3}  effect=null
ffccdc7:  domain_dns_incomplete  distribution=[3,2]  REAL PLAN {d:0,m:3}  effect={provisionedAfter:5,…}
```

So the builder's byte-identical-action claim is **verified by execution, not by reading**. And where the
re-buy costs money (a released slot inside a fill prefix on an above-floor account), the new sentence
*states* the cost — "This call DOES change your bill: `effect` projects 8 mailboxes, above the 7 your
subscription bills for today". The diff is a net mitigation for this pre-existing behaviour, never an
aggravation.

**Therefore:** do NOT block, do NOT impose the exactness gate in this round (imposing it would withhold the
DNS remedy from ordinary fill shapes, which is the strictly worse trade). **Do** correct the comment clause
— "on a domain whose slots nobody has released" is a load-bearing invariant claim that is untrue, and it is
the sentence a later edit will build on. **Do** add the released-slot-in-fill-prefix case to the r3 ROADMAP
item that already tracks "the fill remedy can re-buy deliberately released addresses", noting that
`domain_dns_incomplete` and `ordinal_incomplete` are both members.

---

## NEW findings (all NON-BLOCKING, none re-scoring the r4 checklist)

### N1 — a priced call the request boundary REFUSES · NON-BLOCKING · lens 2 (run it) + lens 1 (spec trace)

The three new pricing sites compute `effect` directly from `executeSetupCall` and **bypass the cap check
the sibling enforces**. `planRecommendation` returns `buys_nothing` when
`snap.billableMailboxes + plan.newMailboxes > MAX_SELF_SERVE_MAILBOXES` (`next-steps.ts:520`), with the
comment "Cap-checked IN MEMORY before emitting (non-blocking 6), so 'the planner says this call succeeds as
written' is proven near the ceiling rather than assumed". The three setup-family reasons have no equivalent.

**Proved by execution.** Fleet: 11 live ordinals of 3 mailboxes addressed under an earlier persona
(`alpha`) while the intents carry `beta`, billed 33, plus a 12th domain mid-DNS. I then ran the **real**
`assertWithinProvisioningCap` against the step's own planned delta:

```
billable=33 cap=60
- domain_dns_incomplete: domains=11 distLen=11 plan={d:0, m:33}
    effect={"provisionedAfter":66,"projectedMonthlyCents":70900}
    BOUNDARY: REFUSED: plan 'managed' allows at most 60 mailboxes (have 33, this request adds 33)
    why: "...This call DOES change your bill: `effect` projects 66 mailboxes, above the 33 your
          subscription bills for today, and carries the projected monthly total."
```

A **$709.00/mo** projection, stated as a definite bill change, on a call the boundary rejects with a 400.
This violates the design contract at `docs/research/customer-continuity-design-2026-08-18.md:130` —
*"params: Literal, ready-to-send arguments. **Complete: the call succeeds as written.**"*

**Pre-existing vs introduced — precisely:** the *refused call* is pre-existing (`sb-old` emits the same
`{d:0,m:33}` call and the boundary refuses it identically). The **fabricated price on it is NEW in this
diff** — pre-fix that step shipped `effect: null`.

**Why NON-BLOCKING:** no spend occurs (the call is refused before anything is bought), and reachability
needs a single tenant at ≥ ~31 live mailboxes with a persona change or slot-index gaps AND a DNS-pending
domain. The live paying tenant holds 5.

**Fix shape (flagging, not fixing):** route the three through `planRecommendation`, or add its
`billableMailboxes + newMailboxes > MAX_SELF_SERVE_MAILBOXES` conjunct at the three sites and fall back to
the withheld/unpriced posture. The guard should then assert `provisionedAfter <= MAX_SELF_SERVE_MAILBOXES`
for every audited step.

### N2 — "at the same monthly total your subscription already bills" is FALSE under billing drift · NON-BLOCKING · lens 2

`billMoveSentence`'s third branch (`next-steps.ts:834-837`) asserts sameness, but it fires on
`floored(after) ≤ floored(billed)` — which includes **strictly less**. Proved by execution in the drift
state the platform itself models:

```
P2  billable=5 billed=8  (the state `billed_quantity_drift` exists for)
- billed_quantity_drift [owed]  "still billing for 8 mailboxes while 5 are provisioned"
- ordinal_slot_shortfall [owed] effect={"provisionedAfter":6,"projectedMonthlyCents":10900}
    MONEY effect.cents=10900  subscriptionToday=12900  delta=-2000
    why: "...`effect` projects 6 mailboxes AT THE SAME MONTHLY TOTAL YOUR SUBSCRIPTION ALREADY BILLS,
          so this call does not add to it."
```

$109.00 is not $129.00. The clause is false; the machine field is right (a post-call sync pushes 6 and the
invoice *drops*), and the trailing "does not add to it" is true. **NEW in this diff** — pre-fix these steps
carried no bill sentence at all.

**Why NON-BLOCKING:** the error is one-directional (it hides a bill DECREASE, never a surprise charge — see
the monotonicity proof above), and the corrective fact is co-emitted in the same response by
`billed_quantity_drift`. Reachable whenever `syncMailboxQuantity` failed to advance
`mailbox_qty_synced` — a documented window (`billing.ts:896-902`: non-active billing state, unarmed/simulated
Stripe, or a push throw).

**Note the guard cannot catch this:** `next-steps-billing-effect-guard.test.ts:329` re-implements
`billMoveSentence`'s own predicate (`billableMailboxes(provisionedAfter) > billableMailboxes(billed)`), so
it agrees with the source by construction. A guard that compared
`effect.projectedMonthlyCents` against `monthlyRevenueCents(billed, discountPct)` would have caught it.

**Fix shape:** three-way the branch — `>` raises, `===` is unchanged, `<` states the decrease (or says
nothing about sameness).

### N3 — the class guard's fleet list is a HAND-LIST, and its docstring overclaims · NON-BLOCKING · lens 5

The guard's docstring (`next-steps-billing-effect-guard.test.ts:33-36`) claims:

> A reason added later that emits a bill-raising call and forgets its `effect` reddens here without anyone
> remembering to write a test for it — which is the property the r4 builder named as "what would have
> caught this".

**That is true only for a reason whose predicate one of the 17 hand-listed `FLEETS` happens to reach.**
Proved: in a sandbox I added a hypothetical new reason emitting a runnable `setup_infrastructure` call with
`effect: null`, gated on `snap.composition.byoDomains > 0` — a composition **no fleet seeds**. The guard
stayed **green, 4/4 passed**. The enumeration is derivation-driven *within* a hand-picked fleet set, not
over the reason universe.

Two narrower instances of the same shape: `BILL_MOVE_REASONS` (line 52) is a hard-coded three-string list,
so a fourth reason using `billMoveSentence` gets no prose check; and the prose check is a substring test
for `"DOES change your bill"` that never parses the projected number (mitigated only by the sentence being
generated from the same object).

**Currently benign:** all five reasons that can emit `setup_infrastructure` today
(`paid_seats_unprovisioned`, `seat_headroom_free`, `ordinal_incomplete`, `ordinal_slot_shortfall`,
`domain_dns_incomplete`) ARE reached by the fleets, and I confirmed the invariant holds on the BYO-mixed
compositions the fleets omit (`provisionedAfter === billable + newMailboxes` in all three BYO probes).

**Fix shape:** assert that the set of reasons audited across the fleets covers every reason that can carry
a `setup_infrastructure` action (derive the expected set from `NEXT_STEP_REASONS` minus a justified
skip-list, the way the sibling `NEXT_STEP_REASONS` runtime array does it), and add one BYO-composition
fleet. Or, at minimum, downgrade the docstring's claim to what it actually delivers.

### N4 — the false clause in the no-exactness-gate justification

See "The soundness call" above. `next-steps.ts:1226-1227`.

### N5 — trivial · unused export

`export const PERSONA = "mordytee"` (`apps/platform/test/next-steps-fleet.ts:48`) is referenced only inside
its own file. CLAUDE.md anti-slop rule (a). One-word fix.

---

## Attacks that FAILED (this is what makes the SHIP meaningful)

- **Lens 7, regression ring — did the fix move the emitted ACTION anywhere?** Built a second sandbox with
  the pre-fix `next-steps.ts` and ran the same 7-fleet probe. `params.domains`, `params.distribution`,
  `params.persona`, `paramsToSupply` identical in every case. **Only `effect` and the appended sentence
  moved.** The pricing-only claim holds by execution.
- **Is `provisionedAfter` the real Stripe meter, or a lookalike?** Three separate call sites, three
  byte-identical SELECTs; `syncMailboxQuantity` pushes exactly `billableMailboxes(` that count `)`.
  BYO mailboxes are on the same side of every predicate. No divergence exists.
- **Does the 5-seat floor break the arithmetic at the crossing?** No — both sides of the comparison go
  through `billableMailboxes()`. Executed below-floor, at-floor and above-floor: all three correct.
- **Does the discount break the "compare the counts, not the cents" shortcut?** Not at any realistic rate.
  Executed at 0% / 60% (the live tenant's) / 100%: correct at 0 and 60, matching the design canon's own
  worked figures. Only a **100%** discount collapses it (both sides $0 while the prose says "DOES change
  your bill") — listed as an observation, not a finding.
- **Can a call buy a DOMAIN while the prose says "buys nothing"?** No. `planFor` adds `slots` new mailboxes
  for every ordinal with no live domain, and `fillDistribution` never emits a 0 entry — so
  `newDomains > 0 ⟹ newMailboxes ≥ 1`, and the "buys nothing" branch implies no domain either. (Domains
  carry no price term of their own; SPEC §18 bundles them at ceil(mailboxes/3).)
- **Does an unpriced domain purchase escape the projection?** No — the curve is `$49 + $10 × mailboxes`
  with domains bundled, so a new domain inside the ratio genuinely adds $0.
- **Does the seeder extraction weaken anything?** No. 3 insertions, all imports; 112 deletions, all the
  moved seeder. Byte-for-byte.
- **Is the r4 exactness-withhold predicate still what r4 proved sound?** Yes —
  `executed.plan.newDomains !== 0 || executed.plan.newMailboxes !== missingTotal` is **byte-identical**
  between `08d8e53` and `ffccdc7` (diffed both). `shortfallRemedy` gained only `ctx` and the `effect` field.
- **Is the NB-4 grace pin still binding?** Yes — every `expires_at` assertion in the shortfall suite
  survives the seeder move untouched.
- **Does the BYO composition (unfixtured) break the pricing invariant?** No. Mixed BYO+managed fleets
  through `seat_headroom_free`, `paid_seats_unprovisioned`, `ordinal_slot_shortfall` and
  `domain_dns_incomplete` all satisfied `provisionedAfter === billable + newMailboxes`.
- **Does the PERSONA_UNKNOWN abstention lie when 5 mailboxes encode the persona?** No. My probe reached
  that state only because the test seeder writes `persona_slug = NULL` directly into a live DO; in
  production `backfillPersonaSlugs` runs at DO construction (`tenant-do.ts:229`) and inverts the address,
  so the sentence is reachable only after the backfill has genuinely abstained — where it is true.
- **Does an under-synced account (`billed < live`) get told a no-op call raises the bill?** No — the
  `newMailboxes === 0` short-circuit fires first, exactly as the docstring claims.
- **Did the builder commit agent-memory files naming a knock-on (the r2 class)?** No — zero files under
  `.claude/agent-memory` in this diff.
- **Did anything outside `apps/platform` move?** No — 4 files, verified by `--numstat`. The dashboard,
  engine and CLI legs cannot be affected by this diff, and all three are green anyway.

---

## UNVERIFIABLE

1. **Production row state.** I cannot reach the live tenant's D1/DO rows from here. Every reachability
   statement about the one live paying tenant (5 live mailboxes, NULL `inboxes_each`, 60% discount) is
   INHERITED from the r3/r4 verdicts and the design canon, not re-derived against prod. **Resolved by:**
   the pre-arm probe already on the deploy checklist (below).
2. **The Stripe side of the projection.** I verified that `syncMailboxQuantity` computes and pushes
   `billableMailboxes(count)`; I did not observe a real Stripe invoice. **Resolved by:** a post-deploy
   check of one real quantity change against the Stripe dashboard.
3. **N1's reachability at real scale.** My 33-mailbox fleet is synthetic. Whether any tenant will ever
   sit near the 60 ceiling with a persona change is a product question, not a code one.

---

## Deploy requirements (consolidated — r4's list plus this round's)

Carried forward from r4, all still binding (these come from EARLIER commits in the stack, which this
round's 4-file diff does not touch):

1. **Site deploy required** — `site/openapi.yaml` changed in the wave (+187/−…), including the
   `next_step` reason enum. The API doc surface ships separately from the worker.
2. **Full rebuild required** — `packages/shared` changed in the wave (`next-steps.ts`, `pricing.ts`,
   `errors.ts`, `intents.ts`, `index.ts`, `provenance.ts`). A partial platform-only deploy would ship a
   worker bundled against a stale shared package. Confirmed: `billableMailboxes` is imported into
   `next-steps.ts` from `@coldstart/shared` this round, so the bundle must resolve the current package.
3. **Pre-arm re-check** — before deploy, confirm no live tenant has a non-NULL `domain_intents.inboxes_each`
   for an ordinal short of its ask. That NULL is what keeps `ordinal_slot_shortfall` off the live tenant,
   and r3 established the deliberate no-backfill decision it rests on.

Added this round:

4. **Nothing new is required by this diff.** No migration, no env var, no flag, no new package, no
   Dockerfile/wrangler change — 1 source file and 3 test files under `apps/platform`. This is the one round
   of the five with no arm-time plumbing of its own.
5. **Post-deploy spot-check (5 minutes, cheap):** call `infrastructure_status` for the live tenant and
   confirm every `owed` step carrying a `setup_infrastructure` action has a non-null `effect` whose
   `provisionedAfter` equals the live mailbox count plus what the call creates — the same invariant the new
   guard enforces, observed once on real data.

---

## Recommended follow-ups (ROADMAP, not gates)

- `[ ] 2026-08-19 [IDEA] next-steps: route the three setup-family pricing sites through the cap conjunct
  (N1) — a priced call the request boundary refuses`
- `[ ] 2026-08-19 [IDEA] next-steps: three-way billMoveSentence's comparison so a bill DECREASE is not
  reported as "the same monthly total" (N2)`
- `[ ] 2026-08-19 [IDEA] next-steps guard: derive the audited-reason set from the reason universe + add a
  BYO fleet; downgrade the docstring's future-proofing claim to what it delivers (N3)`
- `[ ] 2026-08-19 [ORDER] next-steps.ts:1226 — correct "on a domain whose slots nobody has released";
  proved false. Fold the released-slot-in-fill-prefix case into the existing r3 ROADMAP item, naming
  `domain_dns_incomplete` and `ordinal_incomplete` as members (N4)`
- `[ ] 2026-08-19 [IDEA] test/next-steps-fleet.ts: drop the unused `PERSONA` export (N5)`
