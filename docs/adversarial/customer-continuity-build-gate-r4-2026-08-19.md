# Customer-continuity BUILD gate — ROUND 4

**Ground ref:** worktree `/Users/yaakovscher/dev/coldstart/.claude/worktrees/continuity`, branch
`feat/customer-continuity-2026-08-18`, `git rev-parse HEAD` = **`08d8e53e3740993d399e79c6ce6120d8b6d06a3e`**
(clean tree). Review diff `4a37ad0..08d8e53`, 8 files, +797/−89. Base of the r1–r3 stack: `61aaad0`.
Date 2026-08-19. Reviewer: fresh-context adversary, read-only git in both checkouts.

## VERDICT: **SHIP-AFTER-FIXES**

**Both round-3 blockers are CLOSED.** I re-derived each rather than accepting the closure, and both
survived every attack I could construct (details in "The r3 checklist" below). Judged against the fixed
r3 checklist alone, this round is a **PASS**.

**One NEW blocking defect, outside the r3 checklist, must be fixed before deploy.** It is money-adjacent,
it is on the path this commit newly made live, and it is the same class the r1 gate blocked on. Reported
separately per convergence discipline — it does not retroactively re-score B1/B2.

| Item | Verdict |
|---|---|
| r3 BLOCKING-1 (false-positive predicate) | **CLOSED** |
| r3 BLOCKING-2 (remedy coordinates) | **CLOSED** |
| NEW-1 (`effect: null` on a bill-raising call) | **BLOCKING** |
| NEW-2 (burned ordinal → "nothing is required") | NON-BLOCKING, ROADMAP |
| R1 / R2 / R4 / R5 / R7 / R8 | ruled below — none blocking |

---

## Battery, re-run by me (not quoted from the builder)

All legs run on the worktree at `08d8e53`, unpiped, real exit codes:

| Leg | Result | Exit |
|---|---|---|
| `npm run typecheck` (4 packages) | clean | **0** |
| `apps/platform` vitest | **210 files, 2059 passed, 1 skipped** | **0** |
| `apps/dashboard` | 29 files, 143 passed | **0** |
| `apps/engine` | 17 files +2 skipped, 140 passed +4 skipped | **0** |
| `packages/cli` (`node --test`, the correct runner) | 12 pass / 0 fail | **0** |

Every number matches the builder's claim exactly. As in rounds 1–3, **the green battery told me nothing** —
both findings below came from executing the real derivation against constructed row values, not from
reading the diff.

**Probe harness** (unchanged from r2/r3, still the whole game): `rsync -a --exclude node_modules --exclude .git`
the worktree to a sandbox, symlink `node_modules` back, drop probe tests in `<sandbox>/apps/platform/test/`,
`npx vitest run test/<probe>.test.ts`. Full `cloudflare:test` DO harness, ~4s per probe, zero writes to the
shared worktree. Note for the next round: **the workers pool swallows `console.log`** — collect into a
module-level array and dump it through a deliberately failing `expect`, or your probe prints nothing.

---

## NEW-1 — BLOCKING · the shortfall's runnable call raises the bill and declares `effect: null`

**Lens 7 (regression ring) + lens 2 (run it).** The fix turned this remedy from a call that bought
*nothing* into a call that buys real mailboxes — and left the money field saying the bill does not move.

**The contract this violates is published and explicit.** `packages/shared/src/next-steps.ts:154`:

```
/** null when the step changes no billable count. */
effect: MailboxBilling | null;
```

and the type's own docstring (`packages/shared/src/next-steps.ts:111-133`): *"the SAME projection the
response's own `billing` field carries, so a step's claim about the bill is the bill"* … *"Human-readable
pricing formula (SPEC §18) **so no add is a silent bill surprise**."* The design canon repeats it verbatim
(`docs/research/customer-continuity-design-2026-08-18.md:141`). `effect: null` is an **affirmative claim**,
not "unknown" — this file makes that exact point at `next-steps.ts:556-558`, where it refuses to leave a
bare `effect: null` because *"an agent cannot tell [it] from 'this step changes no billable count'"*.

**Proved by execution**, on the wave's own "case A" fixture (billed 5, ordinal 0 = 3 live/3 asked,
ordinal 1 = 2 live/3 asked):

```
action.via     = mcp_tool
params         = {"brand":…,"domains":2,"distribution":[3,3],"persona":"mordytee",
                  "physicalAddress":…,"senderIdentity":…,"registerDomains":true}
executed plan  = {"newDomains":0,"newMailboxes":1}      <- real planFor on the emitted params
step.effect    = null
live billable  = 5
billing BEFORE = {"provisionedAfter":5,"projectedMonthlyCents":9900}
billing AFTER  = {"provisionedAfter":6,"projectedMonthlyCents":10900}
delta          = +1000 cents/mo   (+$10.00)
why            = "…creates exactly the 1 missing one and buys nothing twice."
```

A 3-slot variant returns `{newDomains:0,newMailboxes:3}`, `effect: null`, **delta +3000 cents/mo (+$30)**.

**The sibling in the same file, emitting the same tool, prices it correctly.**
`paid_seats_unprovisioned` sets `effect: billingEffect(ctx, planned.provisionedAfter)`
(`next-steps.ts:645`) and my probe returned `{"provisionedAfter":5,"projectedMonthlyCents":9900,…}`.
So the file is internally inconsistent about the same tool call.

**It is a CLASS, not an instance — and the second member is in the seam this commit created.**
`ordinal_incomplete` (`next-steps.ts:869`) also ships `effect: null`. Probed at billable 5:
plan `{newDomains:1, newMailboxes:2}`, **delta +2000 cents/mo (+$20)**, `effect: null` — while its own
prose (added by this commit) says *"The call below buys 1 new domain and creates 2 mailboxes"*. Both
members are routed through `executeSetupCall`, the helper this commit introduced, so the fix passed the
plan through the new seam and did not carry the money field with it.

**Mechanism.** `billableMailboxes` is `COUNT(*) FROM mailboxes WHERE released_at IS NULL`
(`next-steps.ts:327-329`), the same meter `syncMailboxQuantity` pushes to Stripe. `planFor` returning
`newMailboxes: N` is exactly N new rows with `released_at IS NULL`. So the billable count provably moves
by N, and at/above the 5-seat floor the invoice moves by N × $10/mo. `effect: null` asserts it does not.

**Why this is blocking and not a nit.** The r1 gate blocked this wave on this precise class ("a confident
wrong number needs both halves checked — prose and machine field"; *"converts a planner bug directly into a
billing lie"*). The consumer is an **unattended agent executing the literal params verbatim** — that is the
step's stated purpose. The step is `kind: "owed"`, so the account is told it must do this.

**Live-tenant reachability: ZERO today, primary path at scale.** `ordinal_slot_shortfall` abstains when
`inboxes_each` is NULL (`next-steps.ts:974`), and the r3 gate established that the one live paying tenant's
rows predate that column and were deliberately not backfilled. So deploying does not mislead the current
customer. It fires for **every tenant provisioned after the column exists** — i.e. exactly the population
the standing "hundreds of customers" order is about. (This inherits r3's finding rather than re-deriving it
against prod — see UNVERIFIABLE.)

**Fix shape (flagging, not fixing).** The plan is already in hand at the emit site: `shortfallRemedy` holds
`executed.plan`, and `billingEffect(ctx, snap.billableMailboxes + plan.newMailboxes)` is the same call the
sibling already makes. The `via:"none"` withheld branch should stay `effect: null` — nothing is bought
there, which is the one case where null is true. Same treatment for `ordinal_incomplete`, or the class
reopens one reason over.

---

## NEW-2 — NON-BLOCKING (ROADMAP) · a burned ordinal is told "nothing is required"

This is R1's knock-on, and it is **larger than the builder disclosed** — the disclosure covers the expired
message; the customer-facing half is not mentioned.

Probed with the `retry_setup` row aged past the min-age gate (the gate that made my first attempt look
clean — worth knowing for the next round):

- **R1-A** burned ordinal alone, mailboxes released, billed 5 → `paid_seats_unprovisioned:owed,
  message_action_required:owed`, status `owed`, **expirable 0**. Covered. Good.
- **R1-B** burned ordinal + a healthy ordinal carrying all 5 seats → reasons `ready_to_launch:available`
  only, status **`none_owed`**, **expirable 1** — the live action item about the burned ordinal *is*
  expired. R1 confirmed exactly as disclosed.
- **R1-C** control, active short ordinal → `ordinal_slot_shortfall:owed` + `message_action_required:owed`,
  expirable 0. The row survives. The discrimination is correct.
- **PROBE 6** burn leaves 2 live of 5 billed → steps are `ready_to_launch:available,
  seat_headroom_free:available` and the customer is affirmatively told:

  > "You are billed for a 5-mailbox minimum and 2 are provisioned… **Filling them costs nothing** …
  > **Nothing is blocked and nothing is required**; this is only worth doing if you want the extra
  > sending capacity."

  after a **platform-initiated** deliverability burn destroyed 3 of their 5 paid mailboxes.

**Why NON-BLOCKING anyway** — four verified grounds:
1. The pre-fix behaviour is not an available alternative: it was a *false* `owed` whose emitted call would
   have re-bought mailboxes **on the burned domain** (r3 BLOCKING-1 path A). Restoring it is strictly worse.
2. The common burn shape is covered — a burn releases the domain's mailboxes, and when that drops billable
   to 0, `paid_seats_unprovisioned` fires `owed` (R1-A, proved).
3. For every NULL-`inboxes_each` tenant — including the one live paying tenant — this hole **predates this
   commit**, because the false shortfall never fired for them either. It is not a regression for the
   current customer.
4. The expired row is hidden, not destroyed: 30-day operator retention, and the burn path has its own
   operator alerting (`deliverability-actions.ts` `logAction` + `REPLACE_DOMAIN_WITHHELD_UNRELEASED`).

**Condition:** this belongs on the r3 ROADMAP item "burned ordinal covered by NO reason", and that item
should record the *customer-surface* half (affirmative "nothing is required"), not only the expired
message. `seat_headroom_free`'s E1 guard keys on `owedCount`, so closing the coverage hole closes this too.

---

## The r3 checklist — both blockers CLOSED (re-derived, not accepted)

### B1 — the predicate discriminates a failure from a deliberate shrink. **CLOSED.**

I enumerated the real `domains.status` value space from the writers rather than the docstring:
`'active'` (schema.ts:146 default + provisioning.ts:305 explicit INSERT) · `'burning'`
(deliverability-actions.ts:196) · `'paused_primary'` (deliverability-actions.ts:377) · `'retired'`
(clock-migration.ts:181) · `'released'` (lifecycle.ts:434). **No writer anywhere sets status back to
`'active'`**, so discriminator 1 is sticky-safe, and there is no legitimate healthy-live value other than
`'active'` that it silently excludes. Swept by execution:

```
PROBE4 [active]         shortfall=true    <- the true positive still fires
PROBE4 [paused_primary] shortfall=false
PROBE4 [burning]        shortfall=false
PROBE4 [retired]        shortfall=false
```

`paused_primary` is additionally safe by a second mechanism: `applyHardPauseDomain` calls
`pauseDomainMailboxes`, which sets `deliv_status='paused'` and does **not** release, so it opens no gap.

**Discriminator 2's durability claim — I verified the grep the builder asked me to.** Zero
`DELETE FROM mailboxes` in `apps/platform/src` or `packages` (the only hit is a comment at
lifecycle.ts:148 stating the invariant). `INSERT` sites: `mailbox-provisioning.ts:694` (`INSERT OR IGNORE`,
after vendor readiness) and `byo-mailbox-composition.ts:113`.

**One correction to the builder's stated claim, benign in direction.** The commit message and the
`MailboxHistory` docstring say every remover funnels through `releaseMailboxes`. That is **not quite true**:
`clock-migration.ts:134` writes `released_at` **directly** (`UPDATE mailboxes SET released_at = ?,
deliv_status = 'paused' WHERE provider = 'sandbox'`), bypassing the funnel — a fourth path the docstring
does not name. Direction is safe: the same migration retires the sandbox-origin `domains` rows to
`'retired'`, which discriminator 1 excludes, and where the sets diverge `everAddresses` still contains the
address so the reason correctly stays quiet. **Worth a docstring correction** — the claim as written is the
kind of load-bearing "every X funnels through Y" that a future edit will rely on.

`billing.ts:1058` (`removeMailboxes`, the customer downgrade) does go through `releaseMailboxes`, as claimed.

### B2 — the remedy is computed in the defect's coordinates and executed before it is claimed. **CLOSED.**

The r3 no-op and domain-buying shapes are both dead, verified by running the real planner on the emitted
params (never a shape check): case A `{newDomains:0,newMailboxes:1}` (was a total no-op); case B
`newDomains:0` (was 1). My own cross-ordinal probes agree.

**I attacked the exactness predicate `newDomains === 0 && newMailboxes === missingTotal` for a wrong-slot
collision and it is SOUND** — this was the brief's sharpest question, and the answer is structural, not
empirical. From `provisioning-plan.ts:203-221`, `planFor`'s per-ordinal contribution is exactly
`slots − |live addresses matching the planned persona|`, always ≥ 0, and `newDomains` increments only for an
ordinal with no live domain. Decompose over the emitted prefix `0..deepestShort`:

- short ordinal *i* contributes `neverCreated_i + released_i`;
- `missing_i = min(neverCreated_i, capacityShort_i) ≤ neverCreated_i`;
- every non-short prefix ordinal contributes ≥ 0.

So `Σ planFor = missingTotal` forces, term by term: `released_i = 0` on every short ordinal, **zero**
contribution from every non-short prefix ordinal, and the cap non-binding. **The emitted call can only ever
buy exactly the never-created addresses** — there is no arithmetic coincidence that lets exactness hold
while the call buys a deliberately-removed slot. `shortfallDistribution` returning `null` unless every
prefix ordinal is live with a valid 1..`MAX_MAILBOXES_PER_ORDINAL` ask is what pins `newDomains = 0`.

Confirmed empirically where it matters — a downgrade on ordinal 0 beside a real failure on ordinal 1:

```
PROBE5 via = none · waitingOn = operator
why = "…The platform will not recommend a call for this: the closest call it can construct
       buys 0 new domains and creates 2 mailboxes, which is not what is missing here."
```

**`packages/shared` rewiring — verified behaviour-identical by RUNNING it**, not by reading that the
constant equals 10 (`pricing.ts` has zero imports, so the circular-import/TDZ failure mode I went looking
for does not exist):

```
ZOD const = 10 · distribution:[10] ok=true · distribution:[11] ok=false
             · inboxesEach:10 ok=true · inboxesEach:11 ok=false
```

---

## Rulings on the disclosed residuals

**R1 — acceptable WITH the ROADMAP item, priority raised.** See NEW-2. Direction is correct; the
disclosure understates it by one surface (the customer is affirmatively told "nothing is required", not
merely left un-owed). Not blocking, for the four verified grounds above.

**R2 — RATIFIED, non-blocking.** I read the guard rather than the summary. `assertWithinProvisioningCap`
(`quota.ts:45-75`) counts live resources only and throws `ValidationError` **before** any spend, so the
worst case is a refused call at the boundary — no money moves. The shortfall remedy does bypass
`planRecommendation`'s in-memory cap mirror (`next-steps.ts:511-512`), so an over-cap call *can* be emitted;
the outcome is a 400, not a purchase. Declining to add an untested branch on a spend-adjacent path is the
right call, and I would have declined it too.

**R4 — non-blocking, with one named residual.** Traced the whole route: `waitingOn:"operator"` →
`owedSignals.anyOwedWaitingOnOperator` (`next-steps.ts:1516`) → `blamedName = operatorName`
(`watchtower.ts:551`) → the email channel. **It cannot spam.** `stalled` additionally requires
`owedCount > 0 && (agentStalled || owedTooOld)` with the 48h `owedMaxMs` bound (`watchtower.ts:545-547`),
and emission goes through the alert state machine's debounce → COOLDOWN → STEADY cadence, not per-tick.
The customer side is protected too: the cry-wolf rule (`continuity-nudge.ts:60`) suppresses the nudge when
every owed step is operator- or billing-blamed. Reading the blame **off** the action rather than asserting
it beside it is correct, and `waitingOn: null` would have been a lie there.

*The residual:* the withheld branch is reachable from a **customer-caused** history. PROBE 2 —
ordinal 0 under persona `alpha`, ordinal 1 under persona `beta` (a normal two-call history, since
`recordDomainIntent` is INSERT OR IGNORE per ordinal while the global persona follows the newest
`updated_at`) — produced global persona `beta`, a correct `missing: 1`, and:

```
via = none · waitingOn = operator · anyOwedWaitingOnOperator = true
why = "…the closest call it can construct buys 0 new domains and creates 4 mailboxes…"
```

The abstention is **correct** (any single call carries one persona, so no expressible call tops up ordinal 1
without creating 3 spurious `beta` mailboxes on ordinal 0), but the founder is then paged indefinitely for a
state the customer created and only an operator can clear. Worth a ROADMAP line, not a fix in this round.

**R5 — RATIFIED, direction confirmed.** `liveCountByDomain` is keyed by domain NAME, so two ordinals
sharing a name pool their live counts, shrinking `capacityShort` ⇒ **under-report (silence)**, never
over-report or overbuy. Two independent reasons it stays theoretical: `liveDomainsByName` keeps the FIRST
row per name (`provisioning-plan.ts:126-137`), and the address walk embeds the ordinal, so addresses cannot
collide across ordinals. Candidate generation also excludes names the tenant already holds.

**R7 — RATIFIED as the right deviation, on the strongest available reason.** Abstaining whenever the plan
is inexact is correct for a spend-adjacent remedy: the surplus in a "close enough" call is precisely the
set of deliberately-removed addresses, so emitting it would silently undo the customer's own downgrade —
re-entering, through the remedy, the exact defect the discriminators exist to prevent. The soundness proof
above is what makes the abstention *complete* rather than merely conservative: exactness cannot hold on a
wrong-slot call, so nothing dangerous slips past the gate on the other side.

**R8 — RATIFIED; the cap cannot under-report a real shortfall into silence.** `missing` reaches 0 only via
`capacityShort ≤ 0` (the domain already holds as many live mailboxes as it asked for — not short of
capacity, by definition) or `addressesNeverCreated === 0` (every ask-address exists in `everAddresses` —
created then deliberately removed). Neither is a real never-created gap. The true positive still fires
(`PROBE4 [active]`), and the C2 partial-drift case is short by what it lacks.

---

## Attacks that FAILED (this is what makes the PASS mean anything)

- **Lens 2, would it run:** suspected a circular import `intents.ts → pricing.ts` leaving
  `MAX_MAILBOXES_PER_ORDINAL` in TDZ ⇒ `.max(undefined)`. **Held** — `pricing.ts` has no imports at all, and
  the bound was verified live (10 ok, 11 rejected, both fields).
- **NB-5 yield pointing at a reason that was never emitted** (the r2 "silence unmasked" class): suspected
  `paidSeatsUnprovisioned` was a second copy of the raw predicate, which would let `seatSteps`' early
  `return []` at `next-steps.ts:628` suppress both reasons. **Held** — it is computed off the *emitted*
  steps (`next-steps.ts:1463`), and the builder documented exactly that reasoning at 1457-1461.
- **False-negative sweep over the whole `domains.status` value space** — no legitimate live state is
  silently excluded; no writer returns a domain to `'active'`.
- **`everAddresses` hiding a real gap:** enumerated every `released_at` writer and every release caller
  (teardown / downgrade / burn / clock-migration). Each either deliberately removes the address (correctly
  muted) or retires the domain (excluded by discriminator 1). **Held.**
- **Wrong-slot collision under the exactness predicate** — refuted structurally *and* empirically; see B2.
- **`0..deepestShort` positional distribution:** a healthy ordinal 0 named at its own ask buys zero, so
  naming the prefix is idempotent (case A returns `newMailboxes: 1`, all of it on ordinal 1).
- **NB-4 grace pin actually constrains:** the test asserts `status === "none_owed"`, `owedReasons === []`
  **and** the exact reason list `["ready_to_launch","seat_headroom_free"]`. Widening the silence reddens it.
  My r3 condition ("pin what the customer is told, not just `expires_at === null`") is satisfied.
- **Prior holds spot-checked for un-holding:** the diff does not touch `messageSteps`, the 32-cap, or
  `SELF_WRITTEN_MESSAGE_KINDS` (still applied at the one site where `owedCount` is sourced,
  `next-steps.ts:305`); `mailbox-provisioning.ts` (the r2 brute-forced address inversion) is untouched.
- **openapi/site lockstep:** all 12 `NEXT_STEP_REASONS` members are present in `site/openapi.yaml:1702`.
- **NB-2 clock split** reads correctly: `expiredCutoff = realNowMs()`, `readCutoff = ctx.clock.now()`, each
  leg aged on the clock that stamps its own column.

---

## UNVERIFIABLE

1. **Live production surface (lens 3).** No deployed build of this branch and no prod credentials here, so
   I could not drive the live flow. Everything above ran against the real code in the real
   `cloudflare:test` DO harness — the closest executable proxy, not the live surface.
2. **NEW-1's blast radius depends on a prod fact I did not re-derive.** My "zero live-tenant reachability
   today" rests on the r3 gate's finding that the one paying tenant's `domain_intents` rows have NULL
   `inboxes_each`. I inherited that; I did not re-probe prod. **Resolve before deploy** with a read-only
   count of `domain_intents WHERE inboxes_each IS NOT NULL` per live tenant — if any deployed tenant has a
   non-NULL ask, NEW-1 is live for them on day one.
3. **Whether the deliverability burn's replacement lands often enough** to make NEW-2 rare in practice —
   needs production incident history, not code.

---

## If/when it ships — deploy requirements

- **The site deploy is required.** `site/openapi.yaml` changes in the wave (vs base `61aaad0`: +165/−22),
  including the `nextSteps.reason` enum. The platform Worker and the site must go together or the published
  contract advertises a reason the API does not return, or vice versa.
- **No D1 migration in this commit.** The wave's columns are DO-side `addColumnIfMissing`; nothing here adds
  a numbered migration, so there is no migration-ordering precondition for this diff.
- **`packages/shared` changed**, so the platform, dashboard and CLI all need rebuilding from the same
  install — not a platform-only deploy.
- **Precondition:** settle UNVERIFIABLE-2 (the non-NULL `inboxes_each` count) before arming, since it
  decides whether NEW-1 is a day-one customer-visible billing misstatement or a scale-time one.
