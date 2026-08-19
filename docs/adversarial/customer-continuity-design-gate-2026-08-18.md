# Adversarial design gate — customer-continuity (2026-08-18)

Target: `docs/research/customer-continuity-design-2026-08-18.md` (563 lines, read in full).
Ground refs: main `c841315` (working checkout, design doc untracked); post-wave contract
`feat/vendor-truth-2026-08-18` = `d4daca3` on base `8c87c79`. Read-only review; no code changed.

## VERDICT: SHIP-AFTER-FIXES

7 blocking design deltas, 8 non-blocking notes. The core mechanism — one derivation, three
consumers, derive-don't-store — survives every attack I made on it and should be kept. What
fails is the *contract shape* around it: the recommended call is not executable on the tenant it
was written for, the guard that is supposed to make that impossible cannot observe the field that
breaks it, and the stuck-detector's liveness signal measures reads rather than progress.

Two of the seven deltas (B1, B5) cannot be resolved inside §2.7's "additive only, no input
contract change" scope. Those need a founder-visible scope decision, not a builder's judgement.

---

## BLOCKING

### B1 · The flagship recommended call 503s and pages the founder on Mordy's own tenant
*Lens 1 (spec-vs-code trace) + lens 2 (run it).*

§2.4 (doc:225-229) justifies omitting `registerDomains` from `call.params`: *"Omitting
`registerDomains` leaves persisted consent unchanged (`intents.ts:86-101`,
`provisioning.ts:542`)"*. Both cites are the **write** path. The **read** path is
`tenant-do.ts:788-798`:

```ts
return selectRealDomainPort(this.inboxKitConfig(), {
  armed: isInboxKitRegistrarArmed(this.env),
  optIn: input.registerDomains ?? false,
```

Absent reads as **opted OUT** — that is the deliberate B1 money ruling documented at
`tenant-do.ts:779-787`. `selectRealDomainPort` (`vendors/factory.ts:198-202`) then hands out
`RegistrarUnarmedDomainPort`, which throws on every method (`vendors/real/domain-port.ts:41-46`).

Failure scenario: Mordy's tenant is paid + activated + `inboxKitConfig` present, so
`createVendorAdapters` returns `kind:"real"` (`factory.ts:140`). His agent follows the emitted
step verbatim (`{domains:2, inboxesEach:3, …}`, no `registerDomains`). `runSetupInfrastructure`
reaches `searchLookalikes` at `provisioning.ts:518` — which runs **unconditionally, before any
plan-shortfall branch**, so even a repeat that buys nothing hits it — and gets
`RegistrarUnarmedError` → `alertRegistrarUnarmed` (founder email) → 503.

Verification: RAN `npx vitest run --root apps/platform registrar-arming` → `Test Files 1 passed
(1) / Tests 21 passed (21)`, and the run's own logs print the exact path:

```
RegistrarUnarmedError: domain.searchLookalikes is blocked: the registrar is not armed …
    at RegistrarUnarmedDomainPort.searchLookalikes (…/vendors/real/domain-port.ts:45:10)
    at runSetupInfrastructure (…/engine/provisioning.ts:518:44)
```
plus `send_email binding called … Subject: [coldrig] domain purchase blocked — registrar not armed`.

Note this is a *regression the recommendation introduces*: Mordy's call 2 succeeded, so his agent
has been sending `registerDomains: true` all along. The design would teach it to stop.

**The design's two stated constraints are mutually exclusive.** Emitting `registerDomains: true`
is rejected by zod unless `registrant` is also present (`packages/shared/src/intents.ts:94-103`,
`superRefine`) — and §2.4 forbids echoing registrant PII. Resolving B1 therefore requires an
**input-contract change** (relax the refinement when a complete persisted `registrant_json`
exists, or add an explicit "use stored registrant" sentinel), which §2.7 says this wave does not
make. Founder-visible scope call.

### B2 · G5, the guard that is supposed to make B1 impossible, is structurally blind to it
*Lens 5 (fixture realism).*

§2.6 G5 executes the emitted call *"through the real saga against **sandbox adapters**"*. On the
sandbox branch `selectSetupDomainPort` returns early (`tenant-do.ts:776`:
`if (bundle.kind !== "real") return bundle.domain;`), so `registerDomains` has **no effect at
all** in the fixture. The one field whose omission breaks the recommendation is the one field the
convergence guard cannot see. The design's claim that a recommendation is "structurally unable to
lie" (doc:98) holds only on the sandbox path.

Second defect in the same guard: G5 asserts `effect.provisionedAfter` **equals** the observed
post-call `billableMailboxCount`. The platform's own documented partial-success paths violate that
equality — `capacity_pending` reports what *landed*, not the ask (`billing.ts:954-961`
`MailboxBilling` doc); `forEachIsolated` deliberately completes some ordinals and fails others
(`provisioning.ts:633-658`); `DomainPropagationPendingError` returns `provisioning:"pending"`. So
either the fixture set excludes partials (the exact 167-green-tests-on-happy-path shape) or the
builder weakens the assertion at build time. State the property as **monotone progress** ("the
owed set did not grow and `provisionedAfter` is an upper bound"), not disappearance-and-equality.

### B3 · The extracted planner's signature cannot preserve behaviour, and its snapshot is lossy
*Lens 1.*

§2.1 declares `personaSlug` as a field of `ProvisioningSnapshot` (state) and
`planFor(snap, target:{domains, inboxesEach})` — persona is **not** in the target. Today it comes
from the **input**: `provisioning.ts:92`, `const personaSlug = slugify(input.persona)`. The code
comment 14 lines below says exactly why that matters:

> *"A call that changes `persona` targets different addresses, and counting rows would understate
> what it is about to buy, which is the one direction a spend guard must never be wrong in."*
> — `provisioning.ts:106-109`

With persona sourced from state, a persona-changing call is planned against the **old** addresses
→ `newMailboxes` understated → `assertWithinProvisioningCap` (`provisioning.ts:456`) and the
`quoteOnly` projection (`provisioning.ts:467`) are both sized too small. I1's characterization
matrix explicitly includes "persona changed" — so the test as specified cannot be green both
before and after the move.

Lossy snapshot: `ProvisioningSnapshot.intentsByOrdinal` carries `liveDomain: string | null`, but
`ProvisioningPlan.satisfied` is `Map<number, {id, domain}>` (`provisioning.ts:70`, written at
`:105` from `liveDomainForIntent`'s `id`). The declared snapshot cannot reconstruct `id`, so I1's
"byte-identical" assertion cannot typecheck as written.

**No persisted raw persona exists.** `tenant_profile` has no persona column (verified across
`schema.ts`); the only persistence is `domain_intents.persona_slug` (`schema.ts:952`), i.e. the
*slugified* form. So §2.4's `"persona": "Mordy Tee"` is not derivable from state, and I2's RED
assertion (`call.params.persona ===` the persisted persona verbatim) tests something that does not
exist. Emitting the slug is address-equivalent (`slugify` is idempotent on a slug) and is the
right answer — but for a tenant with **zero** `domain_intents` rows (paid, never provisioned —
precisely the population P2 exists to catch) there is no persona anywhere, and the
"literal, ready-to-send, succeeds as written" call is unconstructible.

### B4 · P2 cannot fire on its own benchmark: `lastAgentActivityAt` measures reads, not progress
*Lens 6 (attack the design) + lens 3 (live surface).*

§3.3 puts the discriminator on the **DO method** (`requireContext(caller:"agent"|"internal")`) and
I6 test (a) requires *"an `infrastructure_status` RPC advances the column."* But
`infrastructureStatus()` (`tenant-do.ts:800`) is one method serving **two principals**: the agent's
MCP tool *and* the cookie-authed dashboard SPA, which **polls it on a timer** —
`apps/dashboard/src/api/queries.ts:161-168` via `pollingOptions` (`queries.ts:29-30`,
`refetchInterval` + `refetchOnWindowFocus`). The platform already carries the correct
discriminator one layer up — `authVia: "bearer" | "cookie"` (`require-auth.ts:24`,
`:107`/`:121`), already mapped to a `source` param for other DO methods — and the design does not
use it.

Failure scenario (Mordy's exact state): owed = `[paid_seats_unprovisioned]`.
- Disjunct 2 is vacuous — `oldestOwedSinceMs` is `MIN` over owed steps *with non-null* `sinceMs`,
  and §3.2(b) sets `paid_seats_unprovisioned.sinceMs = null` on purpose.
- Disjunct 1 is defeated by any open dashboard tab, or by an agent that polls
  `infrastructure_status` while making no progress — which is the *likelier* stall shape than
  B4's "stops calling entirely".

Both false ⇒ the check never fires on the incident it was designed for.

The same conflation re-arms in I8: *"Answered = any agent activity after the nudge
(`lastAgentActivityAt` advanced)"* and *"the counter resets on an answer."* A customer who
receives the nudge email and opens their dashboard to look has "answered" — counter resets, check
goes healthy for 24h, then fires again. That is an **unbounded 24h nudge loop**, the cry-wolf class
`contact-operator-guard` exists to prevent, reached through the give-up cap rather than around it.

Delta: stamp on **progress-capable** calls only (the mutating intents), and/or derive staleness
from an existing write anchor — `request_idempotency.created_at` (`schema.ts:513-518`) is
re-stamped at claim time and is written for every keyed `setup_infrastructure:` /
`launch_campaign:` / `remove_mailboxes:` intent (honest caveat: only when the caller supplies a
key), and `deliverability_actions.ts` rows carry a `ts` for unkeyed paths. Reset the give-up
counter only on the owed set shrinking, never on a read.

### B5 · `paid_seats_unprovisioned` cannot distinguish a stalled customer from a satisfied one
*Lens 6.*

`unusedPaidSeats = max(0, max(5, mailbox_qty_synced) − billableMailboxCount)`.
`syncMailboxQuantity` sets `mailbox_qty_synced = max(5, provisioned)` (`billing.ts:877`,
`pricing.ts:50-52`), and `billableMailboxCount` is `COUNT(*) WHERE released_at IS NULL`
(`lifecycle.ts:151-155`). So the signal is **permanently non-zero for every tenant who wants
fewer than 5 mailboxes** — a legitimate steady state at the $99 floor, byte-identical in state to
Mordy's incident. There is no persisted "intended size" to separate them: checkout's
`input.mailboxes` "bounds the intended size … and seeds the quote" (`billing.ts:83-94`) but is
never stored on `tenant_profile`.

Consequences, all permanent for that population: a `kind:"owed"` step whose own definition ("the
account will not progress until this happens") is false; a `customer_progress:` check that can
never clear, since §3.4 clears only on `owedNextSteps.length === 0`; and, if phase 2 arms, a nudge
with no opt-out path (§5 forbids persisting emission state, and `remove_mailboxes`'
`acknowledged:true` does not apply here).

Adjacent windows in the same signal: a mid-`remove_mailboxes` downgrade, and the documented stale
window where a Stripe push failure leaves `mailbox_qty_synced` high (`billing.ts:905-908` swallows
and returns).

Delta: either persist an intended-seat count (a second column — the design budgeted one), or
demote this reason to `kind:"available"` whenever the gap is entirely the 5-seat floor and
`billableMailboxCount` has been stable across N observations.

### B6 · The lifecycle filter names a value that does not exist, omits the two that do, and the response path has no filter at all
*Lens 1.*

§3.4 excludes `billingState ∈ {canceled, canceling, disputed, terminated}`. `terminated` is
**never** a `billing_state` — it is `suspend_reason='terminate'` (`schema.ts:29-33`) plus a D1
`tenants_index.status` change. The real freeze predicate is
`isLifecycleFrozen(status, billingState) = status === 'suspended' || isFrozenBillingState(...)`
(`billing-state.ts:20-33`), and `status === 'suspended'` is absent from §3.4's list entirely.

Failure scenarios:
1. A dunning-suspended tenant (`status='suspended'`, `suspend_reason='dunning'`) can still
   authenticate — `require-auth.ts:32-42` documents that the DO-local freeze deliberately does not
   block login. It polls `infrastructure_status`, receives a step with `waitingOn: null`,
   `notBeforeMs: 0`, and a `setup_infrastructure` call that `assertNotLifecycleFrozen`
   (`provisioning.ts:444` → `billing-state.ts:52-60`) hard-rejects with a 400. The platform tells
   a customer to make a call it has already decided to refuse.
2. An abuse-terminated tenant passes §3.4's filter → the founder gets a "customer stalled" alert
   about someone we terminated.
3. §2.3's response embedding has **no lifecycle gate whatsoever** — the gate exists only in the P2
   check. Every frozen tenant gets the lying recommendation on every poll.

**This is also the answer to the designer's own §2.2 question.** The shape cannot express the real
next step for this population: `waitingOn` is `"operator" | null` with no "customer" member (the
customer must update a card / re-checkout), and `call.tool` is a 4-member union with no checkout
member — verified, there is no `checkout` MCP tool (`mcp/tools.ts`; the union's four members
`setup_infrastructure`/`launch_campaign`/`contact_operator`/`ack_message` are all real, at
`tools.ts:73,92,370,356`). The union needs a customer-billing `waitingOn` and a step form that can
point at a non-tool action, or `deriveNextSteps` must return `status:"none_owed"` with an
`available` explain-step for frozen tenants.

### B7 · A customer-facing doc claim that an env flag silently falsifies, with no lockstep guard
*Lens 4 (deploy/arm-time plumbing).*

§2.5 plans to teach *"DNS retry cadence + 'there is no background retry'"* on `mcp/tools.ts`,
`openapi.yaml`, `docs.html` and `for-agents.html`. But `runProvisioningReconcile` **is** a
background provisioning retry — *"re-drives the ALREADY-IDEMPOTENT `provisionDomainWithMailboxes`
to finish it, so a benign propagation wait completes without the agent ever having to retry"*
(`engine/provisioning-reconcile.ts:1-11`). It is dark only behind `PROVISIONING_RECONCILE_ENABLED`
(`env.ts:235`, gate at `admin/ops-sweep.ts:255-261`) — an env flip, not a code change.

G1–G4 are vocabulary-coverage guards (severity rungs, reason enum, tool names, the four B2 slot
claims). None binds this claim to the flag. This is verbatim the failure mode §2.6 opens by
naming: *"It does not catch behaviour that outgrew its prose."* Delta: either word the claim
conditionally, or add a guard asserting the prose matches the flag's default and reddens when the
flag's default flips.

---

## NON-BLOCKING (8)

1. **The 502 surface has no DO context.** §2.3 row 5 wires `nextSteps` into
   `error-response.ts:158-186`, but `toErrorResponse` runs in the **Worker's** `app.onError`
   (`index.ts:160-165`) with only the error object — no `ctx.sql`. Feasible via own-enumerable
   properties on the thrown error (`packages/shared/src/errors.ts:52-55` documents that they
   survive the DO→Worker RPC), but that means deriving at throw time deep in the saga. Unspecified;
   I4's coverage test would fail on this row.
2. **Signal payload widening.** `SendPipelineSignals` today carries names + numbers only
   (`ops-summary.ts:63-120`). `owedNextSteps: NextStep[]` puts full `why` prose plus
   `brand`/`physicalAddress`/`senderIdentity` into the ops-summary RPC, which feeds watchtower
   alert bodies and `buildOpsDigest`. Carry `owedReasons: NextStepReason[]` + a count instead. (The
   PII itself is low-sensitivity — CAN-SPAM footer data that ships in every outbound email — and
   registrant PII is correctly excluded; this is a scope-minimisation note, not a leak.)
3. **Demo/free/simulated tenants get a false billing sentence.** The formula yields
   `max(5,0) − 0 = 5` for a tenant paying nothing. §3.2(a)'s "skip" is written for the *check*, but
   `deriveNextSteps` is the shared primitive that also feeds *responses*. Put the skip in the
   primitive, not the consumer.
4. **`capacity_pending` has no reason of its own.** Folding a spend-ceiling / plan-slot hold
   (`tenant_profile.provisioning_state`, `schema.ts:39-45`) into `setup_operator_blocked` conflates
   two states with different operator responses.
5. **BYO tenants.** Not the cry-wolf I expected — `billableMailboxCount` counts BYO rows, so a
   5-mailbox BYO tenant reads 0 owed. But a BYO tenant under 5 seats gets recommended
   `setup_infrastructure` (managed lookalike purchase), the wrong product for that customer.
6. **The emitted call is never checked against the provisioning cap** (`quota.ts:45-76`, 60
   mailboxes / 20 domains). Narrow population, but "succeeds as written" is unproven near the cap.
7. **I8's re-arm key is set-identity, not new-member.** A customer who *clears* one blocker and is
   still owed produces a different sorted-reason key → re-arms 3 more nudges. Progress should not
   re-arm; require a reason never previously seen.
8. **`projectedMonthlyCents` is monthly for a `billing_interval='year'` subscriber.** Pre-existing
   (the shipped `billing` field has it too), inherited by `effect`. Out of scope, recorded.

---

## ATTACKS THAT FAILED (what a PASS on these is worth)

- **Dry-run purity / observe-then-mutate (I1 characterization risk).** `planProvisioning` is pure
  SELECTs end to end (`provisioning.ts:91-124`, verified line by line); every guard —
  `assertWithinProvisioningCap`, `withSpendCeiling`, `assertNotLifecycleFrozen`,
  `screenTenant` — is invoked by `runSetupInfrastructure` **after** the plan
  (`provisioning.ts:444-456`), never inside it. A dry run cannot trip or mutate them.
- **Input-gate interleave with a live saga.** DO SQLite is synchronous and §3.2 uses
  `deriveNextSteps(ctx).steps` un-awaited. With no `await` the derivation cannot interleave — the
  same property `contact-operator-guard.ts:1-25` documents. Held, *conditional on the builder
  keeping it sync*; make that a stated invariant, not an accident.
- **S1 subrequest ceiling (`8.0N + 29`).** No vendor call and no cross-DO call appears in any
  proposed signal; the derivation is DO-local SQL (~6–8 sync reads/response) and the P2 check rides
  `sendPipelineChecks`, already a pure function over a summary the scan fetched. Claim holds in
  both directions.
- **The loop-isolation guard is real.** `test/loop-isolation-coverage.test.ts:91-106` genuinely
  flags a new `for` body containing `ctx.sql.exec` (proven against synthetic sources). The design's
  stated structural protection against per-candidate SQL exists.
- **The Inc5 storm-guard mechanisms transfer.** `contact-operator-guard.ts:1-25` really does carry
  the "no `await` in this file" invariant with the input-gate reasoning, and `:30-33` really does
  state the real-wall-clock rule for a 1440× `VirtualClock`. Both cites are accurate.
- **Tool names and operationIds.** All four `call.tool` members exist as MCP tools
  (`tools.ts:73,92,356,370`) **and** as openapi operationIds (`openapi.yaml:78,186,1222,1249`).
  The "same string today" claim is true.
- **The B3 quartet is accurate.** `isSendReady(day) = day > WARMUP_RAMP_DAYS` and the 5/15/25/35/40
  ramp (`engine/warmup.ts`), and top-level `sendReady = mailboxHealth.every(...)`
  (`infrastructure-status.ts:173`). Every claim the design plans to document checks out.
- **Billing truth of `effect` (the money attack).** `effect` uses the identical
  `buildMailboxBilling` derivation as the already-shipped `billing` field
  (`billing.ts:977-984`), reading `checkout_discount_pct`; it introduces no new money-truth risk.
  Re-derived both figures: `(4900 + 5×1000) × 0.4 = 3960` and `(4900 + 6×1000) × 0.4 = 4360` —
  correct. The coupon-expiry hazard is real in principle but already constrained by a documented
  operator requirement (`billing/stripe-client.ts:72-79`: MORDYPILOT must be minted
  `duration:"forever"`).
- **§3.3's "nothing records last-agent-call" grep.** Re-ran it across `apps/platform/src`,
  `packages/shared/src` and `migrations` — zero matches. The claim is honest.
- **Canceled-then-resurrected tenant.** Teardown sets `released_at`, so `billableMailboxCount`
  drops to 0 and the new checkout sets quantity 5 → correctly owed. No defect.
- **"Re-derive, never remember" vs I8 (attack 8).** The nudge log stores a dedup key and a claim
  stamp, never read back as truth about tenant state. The non-goal holds in substance; the
  weakness is in the key's semantics (note 7), not in the storage.

---

## UNVERIFIABLE

- **Whether `REGISTRAR_PROVIDER` is armed in prod, and whether Mordy's
  `tenant_profile.register_domains` is 1.** Strongly implied (real domains were purchased for his
  tenant; his call 2 reached `searchLookalikes` without throwing), but I have no prod read from
  here. Resolution: one admin/ops read or `wrangler secret list`. Note the direction — if the
  registrar is *not* armed, B1 gets worse, not better: the recommendation can never succeed for
  any tenant that needs a domain.
- **Whether `PROVISIONING_RECONCILE_ENABLED` is set in the deployed env** (sets B7's urgency, not
  its existence).
- **No end-to-end proof of the proposed code**, because none exists yet. I ran the closest
  executable proxy (the registrar-arming suite) and traced every other claim to source.

---

## Q1–Q3 — SUPERSEDED BY FOUNDER RULINGS (see the addendum below)

My own Q1–Q3 recommendations are withdrawn. The founder ruled; the addendum re-attacks the design
against the rulings as given.

---

# ADDENDUM — re-attack against the founder rulings (2026-08-18)

Rulings received after the gate above:
- **Q1** — nudge = in-product `tenant_messages` row ONLY. Exactly ONE per stall episode, fired
  1 day after stall onset. No 1/day cadence, no give-up-after-3, no email.
- **Q2** — per-domain distribution WILL be built into `setup_infrastructure` as an additive
  contract change, this wave, its own gate. §2.2's example becomes exact-fit, not the 6-overshoot.
- **Q3** — `customer_progress` channel splits by blame: `waitingOn:"operator"` → EMAIL;
  customer-side inaction → DIGEST-ONLY.

**Verdict unchanged: SHIP-AFTER-FIXES.** The rulings are all implementable, but not against the
design's current non-goals. Blocking count goes 7 → 12. B1–B7 stand unchanged; none of the rulings
touches them.

## R1 · BLOCKING (Q1) · "one per episode, 1 day after onset" is unimplementable against §5 and §3.2(b)

The ruling makes three things load-bearing that the design explicitly refuses to store: an
**episode onset timestamp**, an **episode identity**, and an **emitted-once flag**. §5 forbids the
last two ("No persisted 'last emitted nextSteps' row … re-deriving, not remembering") and §3.2(b)
forbids the first ("`paid_seats_unprovisioned` has `sinceMs: null` and that is correct … Adding a
`first_activated_at` stamp is a follow-up, not this wave"). A pure re-derivation cannot answer
"has one day passed since this stall began" or "did we already send this episode's message."

The design must **retract those two non-goals explicitly**, or a builder will satisfy the ruling by
quietly violating them.

Constructive: the episode machine already exists and is already persisted. `AlertState`
(`admin/watchtower-policy.ts`) carries `status`, `sinceTs` (onset of the current status) and a
consecutive-unhealthy counter reset by any healthy observation — that is precisely "stall episode
with an onset." Drive the one-shot off the check's own transition (fire when the check has been
unhealthy for ≥ 24h and this episode has not yet emitted) rather than building a parallel
`agent_nudge_log`. Cost to name honestly: the state lives in the watchtower and the
`tenant_messages` write must land in the tenant DO, so this is **one cross-DO RPC on the transition
only** — the first thing in P2 that touches the S1 ceiling. Bounded (once per episode per tenant),
but §5's "the ceiling is not moved, in either direction" needs updating rather than being silently
false.

## R2 · BLOCKING (Q1) · The nudge mutates the set that would key its own episode — it manufactures its own re-arm

The brief asks whether the sorted-reasons dedup key should become the episode key. **It must not**,
and the reason is a closed loop:

1. The nudge writes a `tenant_messages` row. The natural rung is `action_required` — the four-rung
   doc defines it as *"the account will not progress until someone acts, and acting works. The
   actor is YOU, the agent reading this"* (`engine/tenant-messages.ts`), which is exactly a stall
   nudge.
2. `emitTenantMessage` inserts with `read_at` NULL.
3. §3.2's `unackedBlockingMessages` selects `severity IN ('action_required','operator_pending') AND
   read_at IS NULL` — the nudge row qualifies.
4. `message_action_required` is a member of `NEXT_STEP_REASONS` (§2.2), so a new owed step appears.
5. The owed-reason set changed → the episode key changed → the one-shot re-arms → go to 1.

The dedup key inherited from Inc5 was designed for a set the emitter does not write. Here it does.
Delta: key the episode on the check's own `AlertState.sinceTs`, or at minimum exclude every
message-derived reason from the episode key. Also worth stating as an invariant the design can
guard: **no reason whose source is a row this wave writes may participate in the episode key.**

Cheap escape hatch worth considering: emit at `info` instead, which keeps the nudge out of
`unackedBlockingMessages` entirely — at the cost of an agent branching on severity deprioritising
it, which is the exact honesty trade the four-rung doc was written to stop. Pick deliberately, not
by default.

## R3 · Consequence of the ruling (not a defect in it) · with email off, the nudge reaches neither detected population

Worth surfacing because it changes what B4 costs. The design's own §3.5 says a `tenant_messages`
row *"is not sufficient on its own — an absent agent never reads it."* The ruling removes the email
leg, so:

- the **disjunct-1** population (agent absent past the bound) cannot receive an in-product message
  by construction — that is what "absent" means;
- the **disjunct-2** population (agent present, nothing moving) is currently unreachable because
  §3.2(b) sets `sinceMs: null` on the flagship reason, so `oldestOwedSinceMs` is never defined for
  it (finding B4).

So under the ruling the nudge is inert for both populations until B4 is fixed. This does not argue
against the ruling — an in-product-only nudge is the right containment for unsolicited outbound.
It does mean **B4 is now a hard prerequisite for Q1 shipping at all**, not a quality improvement,
and the wave should be sequenced that way.

## R4 · NON-BLOCKING (Q1) · dedup-refresh is not "one message"; one-shot must be emit-on-transition

`emitTenantMessage`'s dedup branch does not skip — it **UPDATEs `severity, body, action_hint,
created_at, expires_at`** on the existing row. Re-stamping `created_at` means a re-emitted nudge
looks brand new to the agent on every poll and re-sorts to the top of the capped preview
(`listSurfacedTenantMessages`, `ORDER BY (source='operator') DESC, created_at DESC`, `LIMIT
MAX_SURFACED_MESSAGES`). The file's own comment already flags this class: per-domain `retry_setup`
refreshes displacing an operator reply.

So "exactly ONE per stall episode" cannot be implemented as re-derive-and-dedupe; it has to be
emit-once-on-transition. Two good properties survive: an operator reply can never be displaced by a
nudge (operator rows sort first), and any aging logic reading `unackedBlockingMessages`'
`created_at` must not be built on a column a refresh re-stamps.

## R5 · BLOCKING (Q2) · The desired-spec column is INSERT-only, so a narrowed distribution is re-widened autonomously

`domain_intents.inboxes_each` is the durable desired spec, and it is **INSERT-only by design** —
`schema.ts:941-953`: *"Written INSERT-only (`recordDomainIntent`'s INSERT OR IGNORE), so a retry
keeps the first call's spec."* The out-of-band reconciler reads it and re-drives toward it
(`engine/provisioning-reconcile.ts:159-175`).

Failure scenario: the customer calls `{domains:2, inboxesEach:3}` (both ordinals stamped 3), then
uses the new distribution to narrow: `{domains:2, distribution:[3,2]}`. The agent-facing plan
honours 2. Ordinal 1's stored spec stays **3**. If `PROVISIONING_RECONCILE_ENABLED` is ever armed,
the sweep re-drives ordinal 1 toward 3 and buys a third mailbox — **autonomously, with real spend,
raising the bill**, against a distribution the customer just narrowed. That violates the rule
ratified in the quantity-billing arc: unattended (cron/tick) paths must be bill-neutral-or-lowering,
never bill-raising without explicit consent.

Delta: the distribution lane must either make the per-ordinal spec updatable (with its own consent
semantics, since widening it is a purchase authorisation) or teach the reconcile the distribution.
Silently leaving it INSERT-only is the worst of the three.

## R6 · BLOCKING for the Q2 lane (pre-existing, currently dark) · the reconcile's completeness test is a COUNT, so it re-buys deliberately removed mailboxes

`provisioning-reconcile.ts:133-160` computes `liveMailboxes = COUNT(*) … WHERE domain_id = ? AND
released_at IS NULL` and skips only when `liveMailboxes >= inboxesEach`. But
`provisionDomainWithMailboxes` re-derives addresses **per SLOT**. A hole is invisible to the count
and visible to the slot derivation.

Failure scenario: a customer removes one of three mailboxes on a domain via `remove_mailboxes`
(which requires `acknowledged: true`). `releaseMailboxes` sets `released_at` and calls
`markMailboxIntentsReleased` (`engine/lifecycle.ts:315`) — so the address is genuinely free and a
re-provision is a **real purchase, not a no-op**. `liveMailboxes` is now 2 < spec 3, so the armed
reconcile re-buys exactly the mailbox the customer acknowledged removing.

This exists today and is dark behind the flag, so it is not caused by this design. It becomes a
blocker **for the Q2 lane** because exact-fit distributions make holes the normal state rather than
the exception, and because finding B5's recommendation already drives customers to
remove-then-be-told-to-re-add. Fix the guard to be slot-aware (or to skip released addresses)
before the distribution lands, and certainly before that flag is armed.

## R7 · Delta ON B3, not a new blocker (Q2) · fix the planner signature once, for both

The distribution changes `planFor`'s target — which is the same signature B3 says must also carry
`persona`. Do it in one change: `planFor(snap, { persona, distribution })`, with the legacy
`inboxesEach` expressed as a uniform distribution at the boundary. That gives exactly one target
type and removes the dual-authority question of what a call sending BOTH `inboxesEach` and a
distribution means. Two new validation classes come with it: distribution length vs `domains`, and
the sum against the 60-mailbox / 20-domain cap (`engine/quota.ts:32-37`) — today's per-element
bound is `inboxesEach: 1..10`.

**Attack that failed here, worth recording:** address determinism is SAFE under a distribution.
`managedMailboxAddress(personaSlug, domain, domainIndex, mailboxIndex)` is keyed on (ordinal, slot)
and never on the per-domain count (`provisioning.ts:111`), so changing ordinal 1 from 3 slots to 2
does not move any surviving address. Shrinking a distribution is a silent no-op under the TARGET
semantics — removal remains `remove_mailboxes`' job — which is correct, but the emitted `why`
prose must not imply a narrowed distribution releases anything.

## R8 · BLOCKING (Q3) · blame-split channels are not expressible without breaking either the single-authority rule or the one-name design

`policyFor(checkName) -> AlertPolicy` is keyed by **name**, and `AlertPolicy` carries only three
cadence dials — `confirmAfterObservations`, `firstRealertMs`, `steadyRealertMs`
(`admin/watchtower-policy.ts:21-32`). There is no channel dimension anywhere: every alerted /
realerted / recovered transition renders and sends (`watchtower-do.ts:177`, `alertEmailFor(...)`
then `trySend`). **"Digest-only" is not an expressible state for a watchtower check today.** And
the founder's axis is per-OBSERVATION (which owed steps a tenant has right now), while policy is
per-NAME.

Two ways out, both with a cost the design must choose deliberately:

- **Option A — blame in the check NAME** (`customer_progress_operator:` / `customer_progress_agent:`).
  Keeps `policyFor` the single authority. Costs: it breaks §3.4's stated rationale for one name
  ("Sharing one name keeps them deduped against each other"), and it creates a **flip hazard** — if
  a tenant's blame changes and the check simply stops reporting the old name, that name is never
  cleared and re-alerts on the steady 24h step forever. The wave's own orphan checks show the
  required pattern: an explicit healthy result driven off the reported-name set
  (`admin/watchtower.ts`, the `for (const name of reported)` clear loops). A blame flip must emit a
  healthy result for the abandoned name in the same pass.
- **Option B — one name, channel chosen at send time.** This is the second cadence/routing
  authority §3.1 promises not to introduce, and it breaks the debounce: with
  `confirmAfterObservations: 2`, observation 1 can be operator-blamed and observation 2
  customer-blamed. The state machine keeps no memory of observation 1's blame, so the channel is
  whichever fired last — a coin flip on exactly the axis the founder is partitioning.

**Recommendation:** Option A **plus** adding `channel: "email" | "digest"` to `AlertPolicy`, so the
routing decision stays inside the one table that already exists for exactly this purpose, and the
mandatory cross-clear on flip.

**The ruling also needs one more decision it does not currently cover: the MIXED state.** A tenant
can hold one `waitingOn:"operator"` owed step and one customer-actionable owed step at the same
time — the design already knows this, which is why §3.5's suppression rule is phrased "when
**every** owed step has `waitingOn:"operator"`". The founder's partition assumes the blame is
singular. Suggested precedence, for ratification: **any operator-blamed owed step wins → email**,
since our blocker is the one only we can clear and the customer-side item is unactionable until it
is.

---

---

# ADDENDUM 2 — live production evidence on B1 (tickets `sup_dce385a8`, retraction `sup_9d2c9a3a`)

The customer's now-unattended agent called `setup_infrastructure` **without** `registerDomains:
true` and received `registrar_unarmed` / *"Domain registration is not yet enabled for this
account."* The identical call **with** `registerDomains: true` + `registrant` succeeded onto the
ordinary retryable path.

**This is B1, reproduced in production.** B1 was derived by tracing `tenant-do.ts:790` →
`factory.ts:198` → `real/domain-port.ts:41` and proven locally by running the registrar-arming
suite. Production has now independently produced the same outcome on a real customer. I am
upgrading B1 from *traced and locally proven* to **confirmed live**; §2.4's ruling that `params`
may omit `registerDomains` because "omitting leaves persisted consent unchanged" is falsified on
any buy-bearing call. Blocking count 12 → 14.

The fully-unattended agent-to-agent posture also **strengthens P1's premise**, and I want that on
the record: with no human in the loop, response wording is the only control surface left. That
argues for shipping P1, not against it — it raises the cost of shipping it with the wrong contract.

## L1 · BLOCKING · Squaring "params must be complete" with "never echo registrant PII"

Recommended params must carry `registerDomains: true` on any step that reaches a buy. The zod
`superRefine` then demands `registrant` (`packages/shared/src/intents.ts:94-103`), which §2.4
forbids echoing. Three ways out, ranked:

- **(i) RECOMMENDED — relax the refinement**: accept `registerDomains: true` without a body
  `registrant` when the tenant has a complete persisted `registrant_json`. The engine already
  re-derives it (`readRegistrarOptInState` → `provisioning.ts:216`) and already fails loud at the
  actual spend site via `assertCompleteRegistrant`, which produces `IncompleteRegistrantError` — a
  400 that names the missing fields. So the safety property is preserved at the point that matters
  and the recommendation becomes emittable with **zero PII in the response**. Strictly widening; no
  existing caller changes behaviour.
- **(ii) A "supply-your-own" marker inside `params`** — workable, but it **breaks §2.2's central
  promise** in its own words: *"Literal, ready-to-send arguments. Complete: the call succeeds as
  written"* and *"Nothing here is a template for the agent to fill in."* If the founder wants this,
  the contract shape must change with it: a sibling `paramsToSupply: string[]` beside `params`, so
  a complete call and an almost-complete call are **structurally** distinguishable. A magic string
  living inside `params` gets JSON-serialised and sent verbatim by an unattended agent, and fails
  zod — which is the same class of failure this wave exists to close.
- (iii) Echo the registrant. Rejected — it puts registrant PII on a polled status surface.

**And a consent branch the design does not currently have.** The founder ruling is "per-tenant
opt-in only, never a default" (`intents.ts:69-72`, `factory.ts:188-190`). So the derivation must
split on the persisted value:

- `tenant_profile.register_domains = 1` → emit `registerDomains: true`. This re-affirms consent the
  tenant already gave; safe.
- `register_domains = 0` (or never set) → the platform **must not** auto-emit `true`. Doing so
  manufactures consent to real money spend on the customer's behalf inside a recommendation the
  agent is told to execute verbatim. This step cannot be an auto-executable `kind:"owed"` at all —
  it has to be `available` with the consent decision stated in `why`, and the same reasoning as Q2's
  bill-raising constraint applies.

## L2 · BLOCKING · `registrar_unarmed` is an A-class sibling one seam over, and the codebase says so in its own docstring

The gate has **two legs** — `armed` (the operator's global env switch) and `optIn` (the tenant's
per-call/persisted consent), `factory.ts:198`. One message serves both:

> `Domain registration is not yet enabled for this account. No purchase was made.` + `operatorNotifiedClause(NOT_NOTIFIED)` — `error-response.ts:94-102`, 503 `registrar_unarmed`

For the env leg that is roughly right. For the opt-in leg it is wrong twice over: it is not the
**account** (it is *this request* — `optIn: input.registerDomains ?? false`), and a 503 plus
"an operator has not been notified" routes an unattended agent to escalate to a human over
something its own next call fixes. The customer's own retraction says it exactly: *"registerDomains
was not set on this request" would self-correct.*

The codebase already grades this wrongly in writing. `packages/shared/src/errors.ts:180-186` calls
`RegistrarUnarmedError` *"an operator-fixable arming gap, generic customer message"* and contrasts
it with `IncompleteRegistrantError` as *"a TENANT-fixable data gap"* whose 400 names the fields so
the agent can resubmit. Production has now shown that one leg of the "operator-fixable" error is
tenant-fixable in one field. That is the vendor-truth wave's class A exactly — a self-clearable
refusal graded as "no action of yours can work" — surviving one seam over from where the wave swept.

**Why it is not already fixable:** neither the port nor the error knows which leg failed.
`selectRealDomainPort` throws away both booleans (`factory.ts:198-201` constructs
`RegistrarUnarmedDomainPort()` with no argument) and `RegistrarUnarmedError`'s constructor takes
only `op` (`errors.ts:107-115`). Delta: thread the failing leg from the factory (which holds both
booleans) into the port and into the error, then branch in `error-response.ts` — opt-in leg → a
**400** naming the field, modelled on `IncompleteRegistrantError`'s precedent; env leg → today's
503. This weakens nothing: the two-leg decouple guard is untouched, only the message changes.

Fold into this wave's scope. It sits inside §2.5's doc surface and §2.6's guard set, it is the
same class the design's own B1 benchmark is about, and with the customer unattended it is the
difference between self-correction and a stalled ticket.

---

## NEW (out-of-scope, no verdict weight)

- **R6's reconcile re-buy exists today**, independent of this design, dark behind
  `PROVISIONING_RECONCILE_ENABLED`. It should be tracked on its own line rather than inside the
  continuity wave — arming that flag with a count-based completeness test is a bill-raising
  unattended path regardless of whether the distribution ever ships.
- **`RegistrarUnarmedError` carries `operatorActionable: false`** by omission (`errors.ts:107-112`
  calls `super(message, false)` with no options). It is mapped by name before the `VendorError`
  branch, so the new third rung never sees it — inert today, but if that name-branch is ever
  removed the error would take the "check your inputs" arm, which is B1's original defect.

---

# ROUND 2 — gate on design v2 (§7, 2026-08-18)

Target: the same file, now 1214 lines; §§1–6 preserved with SUPERSEDED/AMENDED/RETRACTED markers,
§7 binding across 16 subsections. I read §7 in full rather than working from the relay.

## VERDICT: SHIP-AFTER-FIXES · 4 new blocking · 4 new non-blocking

**All 14 round-1 blockers are addressed. Eleven are fully closed. Three (B5, R2, R8) are closed in
substance but their replacements introduce a new defect** — which is the expected shape: the residue
is in the new guard and routing code, not in the fixes. The design is substantially better and the
core mechanism was correctly left alone.

## Per-blocker closure

| # | Status | What closed it, and what I checked |
|---|---|---|
| B1 | **CLOSED** | §7.5 emits `registerDomains: true`, citing the READ path (`tenant-do.ts:790` → `factory.ts:194-201`) rather than v1's write-path justification, plus the L1 consent branch for `register_domains = 0`. §7.8 removes the PII collision at the root. |
| B2 | **CLOSED** | §7.6 moves G5 fixtures to `bundle.kind === "real"` **and** mandates a NEGATIVE fixture — a step with `registerDomains` stripped must FAIL. That negative is the only thing that proves the guard can see the field; without it the move to real fixtures would be unfalsifiable. Monotone property replaces equality with all three partial-success paths named. |
| B3 | **CLOSED** | §7.3 puts persona in the TARGET (preserving the `provisioning.ts:106-109` spend-guard direction), the snapshot carries `{id, domain}`, the recommendation reads `domain_intents.persona_slug` with the slug-idempotence argument, and the never-provisioned case routes to `paramsToSupply`. All four sub-parts. |
| B4 | **CLOSED** | §7.10.2 keys on `authVia === "bearer"` threaded as an explicit RPC parameter on the existing `Provenance` idiom, with I12's decisive negative (a COOKIE-authed poll must NOT advance the column) and a full-net run. Exactly the fix. |
| B5 | **CLOSED, new defect** | Three-way split is the right shape and `seat_headroom_free` is better product truth than v1's permanent `owed`. The new `billed_quantity_drift` arm false-fires — **N1**. |
| B6 | **CLOSED** | §7.4 puts the lifecycle gate in the PRIMITIVE reading `isLifecycleFrozen` from source, not a hand-list; `account_frozen` + `waitingOn:"customer_billing"` + `via:"http" POST /checkout` closes the expressibility gap I raised; demo tenants excluded at the same place. All three scenarios. |
| B7 | **CLOSED** | G6 asserts `provisioningReconcileArmed({})` is false AND the prose is present, on the `spend-armed-env-coverage.test.ts` failing-by-construction shape, plus rewording to the flag's meaning. |
| R1 | **CLOSED** | Episode identity from the existing persisted `AlertState.sinceTs`; no parallel log built; the non-goal explicitly retracted rather than quietly broken; cross-DO cost named. Residual bound at **N7**. |
| R2 | **CLOSED in mechanism, new defect** | The timestamp key genuinely breaks the re-arm loop structurally. But the containment exclusion is wired to the wrong reader — **N2**. |
| R5 | **PARTLY CLOSED** | Direction rule stated with a guard test. No writer exists for the lowering direction — **N5**, bounded by the reconcile flag being unset. |
| R6 | **CORRECTLY DEFERRED** | Ledgered as arm-gate blocker #4, out of scope, and the design states it depends on neither. Consistent with the ops ledger's standing "do NOT arm" note. |
| R8 | **CLOSED, new defect** | Two names + `AlertPolicy.channel` + a `digest_only` DeliveryReason + mandatory cross-clear is Option A as specified. I verified the same-pass clear is genuinely implementable: `readReportedCheckNames(env)` is read ONCE before the tenant loop (`watchtower.ts:210`), so the abandoned name IS in `reported` on the flip tick. But the clear emits a recovery EMAIL — **N3**. |
| L1 | **CLOSED** | Refinement relaxed at the root, `paramsToSupply` as a sibling array rather than a sentinel, consent branch present. Residual at **N4**. |
| L2 | **CLOSED** | Two-leg split threaded factory → port → error, 400 `registrar_optin_missing` on the opt-in leg modelled on `IncompleteRegistrantError`, per-leg `operatorActionable`, decouple guard explicitly preserved. |

## NEW BLOCKING

### N1 · `billed_quantity_drift` false-fires permanently on any non-active billing state — on the EMAIL channel

§7.10.1's third arm fires when `billable >= 5 AND mailbox_qty_synced > billable`, grades it
`waitingOn:"operator"` ("our bug, not theirs"), and §7.11 routes any operator-blamed owed step to
`customer_progress_operator` → **channel email**.

But `syncMailboxQuantity` deliberately no-ops on `billing_state !== "active"` and **does not advance
`mailbox_qty_synced`** (`billing.ts:879-880`, *"Active-only (§7) — a teardown/freeze release never
reaches Stripe"*). A `past_due` tenant is NOT lifecycle-frozen (`FROZEN_BILLING_STATES` is
disputed/canceling/canceled, `billing-state.ts:20-23`), so it is **in scope** for §7.11's check.

Failure scenario needing no customer action at all: a `past_due` tenant's domain burns, the
deliverability loop's `REPLACE_DOMAIN` releases the burned mailboxes and calls `syncMailboxQuantity`
(`deliverability-actions.ts:353`), which no-ops. `billable` has dropped, `mailbox_qty_synced` has
not. Drift is now permanent for the whole dunning window, with no path to clear — and it emails the
founder, then re-alerts on the 24h steady step, forever, for behaviour that is documented and
correct rather than a bug.

Fix: the drift arm must carry the same conjunct the sync itself uses — only meaningful when
`billing_state === 'active'`, i.e. when the push is actually eligible to run.

### N2 · The R2 exclusion is wired to a signal the unhealthy predicate does not read

§7.12 contains the invariant *"no reason whose source is a row this wave writes may … sustain the
check"* and implements it as: `unackedBlockingMessages` **excludes `kind='continuity_nudge'`**.

But §7.11's predicate is `unhealthy ⇔ owedCount > 0 AND (…)`, and §7.10.3 sources `owedCount` from
`deriveNextSteps`' owed steps — not from `unackedBlockingMessages`. The nudge row is
`action_required` with `read_at` NULL (severity deliberately kept honest, which I agree with), so
`deriveNextSteps` produces `message_action_required`, `owedCount` stays ≥ 1, and **the check is
sustained by the platform's own message.**

The failure is the inverse of v1's and worse for the design's purpose. Not a nudge storm: the
episode never ends, so `AlertState.sinceTs` never advances, so `sinceTs > continuity_nudge_episode_ts`
is never true again and **every future stall for that tenant is silently un-nudged**. The population
that cannot self-clear this is exactly the target one — an agent that isn't acting also isn't calling
`ack_message`.

Fix: the exclusion belongs in `deriveNextSteps` (the shared primitive that feeds both the response
and `owedCount`), not on the `unackedBlockingMessages` signal. §7.6(d) states the right property; the
implementation names the wrong site. This is the shared-primitive-caveat-wired-to-one-consumer class,
and it is the third time this project has produced it.

### N3 · The mandatory cross-clear emits a RECOVERY EMAIL for a tenant that is still stalled, and recoveries are un-debounced

R8's cross-clear is right and necessary, but I traced what a clear actually does.
`decideAlert` (`watchtower-policy.ts:188-196`): on a healthy observation, if the episode had
`alertCount > 0` the action is `"recovered"` — which renders and sends
(`watchtower-do.ts:177`). So a blame flip on a still-stuck tenant emails *"customer progress
operator: resolved."*

Worse, the two directions are asymmetric. A new name's first alert is debounced
(`confirmAfterObservations: 2`), while a recovery fires on the **first** healthy observation with no
debounce. So an oscillating blame produces **more "resolved" emails than alerts**. Oscillation is not
hypothetical here: blame is "any owed step with `waitingOn === 'operator'`", and the
`setup_operator_blocked` condition tracks a vendor wallet that dips empty and refills — auto-topup is
live in prod, so that flag genuinely flaps.

Fix: a blame flip is a re-classification, not a recovery. Suppress the recovery email for an
abandoned name when the sibling name goes unhealthy in the same pass (clear the state, skip the
send), or give `basis: "no_longer_applicable"` a policy meaning that maps to no email — today the
basis only changes the prose, not whether a send happens.

### N4 · `first_paid_at` has no backfill, so B4's defect is reopened for the existing paying population

`addColumnIfMissing(table, column, typeAndDefault)` is a plain `ALTER TABLE ADD COLUMN` with a
**literal** default (`tenant-do.ts:325-370`) — it cannot compute a value. So `first_paid_at INTEGER`
lands NULL for every tenant already paying, and it is stamped only at a **future**
`checkout.session.completed`.

§7.10.1 gives `first_paid_at` one job: be the anchor for the `billable == 0` bucket that "has no
anchor anywhere." For every tenant who paid before deploy, that anchor stays NULL, so
`paid_seats_unprovisioned` keeps `sinceMs: null`, so `oldestOwedSinceMs` is undefined, so §7.11's
disjunct 2 is vacuous — B4's exact defect, reopened for precisely the population the incident is
about. The column works only for customers acquired after the deploy.

**Fixable cheaply, and the anchor is honest.** `webhook_events(event_id, type, ts)` lives in the
tenant DO, is written `INSERT OR IGNORE` for every processed Stripe event (`billing.ts:574`), and is
**never pruned** — I grepped for `DELETE FROM webhook_events` and there is none. So
`SELECT MIN(ts) FROM webhook_events WHERE type = 'checkout.session.completed'` is a real
first-payment timestamp derived from the money event itself, not from read time. Add it as a one-shot
`UPDATE … WHERE first_paid_at IS NULL` beside the column add — the same self-applying idiom
`grandfatherActiveScreening` already uses. Simulated-checkout tenants have no such row, but they are
excluded anyway by the `mailbox_qty_synced === 0` gate (§7.4).

## NEW NON-BLOCKING

**N5 — R5's direction rule has no writer on the lowering side.** "Lowering always allowed, raising
only by the customer's own call" is well-formed, but nothing lowers `inboxes_each`:
`remove_mailboxes` operates on resolved mailbox ids (`engine/remove-intents.ts`) and never touches
the per-ordinal spec. The ordinal IS derivable (mailbox → `domain_id` → `domains.domain` →
`domain_intents.candidate_domain`), so this is buildable; it just isn't assigned. Harm is bounded
while `PROVISIONING_RECONCILE_ENABLED` stays unset, which the design correctly does not depend on.

**N6 — §7.2's empty-profile premise is wrong about `brand`.** It states that a paid tenant which
never called `setup_infrastructure` has "no brand, persona, physical address or sender identity."
Brand is captured at **signup** (`routes/signup.ts:48,57` → `initTenant({brand})`) and
`tenant_profile.brand` is `NOT NULL`. The genuinely-empty fields are `primary_domain`,
`physical_address`, `sender_identity` (all `DEFAULT ''`) and persona (no column at all). So
`paramsToSupply` must be computed **per field, by emptiness**, never by a "never provisioned"
population test — otherwise the platform asks the agent to re-supply something it already knows,
which is the mirror image of the defect this wave exists to fix.

**N7 — the S1 retraction's bound is per-tenant, not per-sweep.** "Once per episode per tenant" is
true and does not bound one tick. A correlated onset — a deploy that widens the check's scope, or a
fleet-wide vendor condition — puts many tenants' 24h transitions in the same sweep, worst case +1
subrequest per tenant on a measured `8.0N + 29`. Bounded and acceptable, but state the sweep-level
bound rather than only the per-tenant one; that is exactly the arithmetic S1 exists to hold.

**N8 — `seat_headroom_free` needs a guard that it can never be `owed`.** It is the one reason whose
`kind` is load-bearing for two separate suppressions (no alert, no nudge). A one-line assertion over
the fixture matrix costs nothing and pins it.

## ATTACKS THAT FAILED IN ROUND 2

- **Mid-flight quantity-sync false-fire (the brief's specific question) — REFUTED.** There is a real
  interleave window: `syncMailboxQuantity` awaits a Stripe call, and a DO's input gate opens at every
  await, so a concurrent `opsSummary` can observe `released_at` set with `mailbox_qty_synced` not yet
  updated. But `DEBOUNCED_ALERT_POLICY.confirmAfterObservations = 2` at a 5-minute cadence requires
  **two consecutive** samples to land inside a sub-second window. The transient case does not alert.
  The permanent case (N1) is a different mechanism entirely.
- **Same-tick flip clear — HOLDS.** I doubted it and it survived: `readReportedCheckNames(env)` is
  read once before the tenant loop (`watchtower.ts:210`) and passed in as `reported`, so on the flip
  tick the abandoned name IS present and can be cleared in the same pass. No one-tick-late window,
  no daily re-alert gap. (The clear's *email* is N3; the timing is sound.)
- **`via` union expressiveness — HOLDS.** `{via:"mcp_tool"|"http"|"none"}` with an always-present
  discriminator covers every state I could construct, including the frozen tenant that has no MCP
  tool (no `checkout` tool exists — re-verified), and `via:"none"` gives the operator-blocked case a
  stated value rather than an empty object. The presence-tested discriminator also avoids the
  shape-guess class the vendor-truth wave was bitten by.
- **`paramsToSupply` as a sibling rather than a sentinel — HOLDS**, and is the right call: a
  placeholder inside `params` gets serialised and sent verbatim by an unattended agent.
- **The three retracted non-goals — each is genuinely narrow.** The persisted-emission retraction is
  one timestamp compared `>`, recording which episode we spoke in rather than tenant state; the
  column-budget retraction is honest; the S1 retraction is correctly scoped to the nudge transition
  (P1 paths and P2 signals really are unmoved — I re-checked that no signal added in §7.10.3 touches
  a vendor or another DO). Only its *bound* needs restating (N7).
- **Two check names vs `watchtower-policy.test.ts`'s completeness map — HOLDS.** That test enumerates
  every declared check name and fails until each is classified, so both new names must be
  deliberately classified; the design already names it at I14.

## Q4 — `seat_headroom_free` emission, gated both ways

**I agree with the designer: emit it.** It is the only place the platform tells a customer they are
leaving paid-for capacity on the table, it is `available` so nothing chases them, and
`effect.projectedMonthlyCents` proves the $0 claim inside the payload (3960 → 3960) rather than
asserting it in prose. Conditions if the founder rules EMIT: keep the BYO suppression (§7.10.3), and
add N8's guard that it can never be `owed`.

If the founder rules SUPPRESS: the suppression must live **in the primitive**, alongside the demo and
BYO gates, not at each of the seven surfaces — a suppression wired per-consumer is the N2 class
again. And it should be recorded explicitly as a deliberate silence, because it is the one case where
the platform knows something useful to the customer and chooses not to say it, which is the exact
mechanism §1 names as common to B2/B3/B4.

---

## Q4 RULED: EMIT (founder, 2026-08-18) — gate on the settled branch

The SUPPRESS branch above is moot. Re-attacking the emit path as the live contract: **1 blocking,
1 non-blocking, 1 severity upgrade.** The ratified sentence itself survives its hardest attack.

### E1 · BLOCKING · The free-headroom invitation is emitted on a broken account

`seat_headroom_free` covers the whole band `0 < billable < 5`, and that band includes a tenant whose
remaining ordinals **hard-failed**. `forEachIsolated` completes the call after logging
`DOMAIN_ORDINAL_FAILED` per failed ordinal (`provisioning.ts:660-670`), and the ten-member reason
list has no member for "an ordinal failed" — if the failure happened before the buy there is no
`domains` row either, so `domain_dns_incomplete` does not fire in its place.

Failure scenario: a tenant asks for 2 domains × 3, ordinal 0 lands, ordinal 1 dies on a permanent
vendor refusal. Result: `billable = 3`, no reason describes the failure, and the response tells them
*"you are already paying for 5 mailboxes; provisioning the remaining 2 adds $0 to your bill."* That
sentence is an invitation which presumes the path works, delivered to a customer whose path is
broken — the platform's most confident-sounding message on its least healthy state, to an unattended
agent.

Fix, one predicate and deliberately not dependent on my having enumerated every gap in the reason
list: **emit `seat_headroom_free` only when `owedCount === 0`.** If anything at all is owed, the
free-headroom line is noise at best and misdirection at worst; when nothing is owed it is exactly the
sentence the founder ratified. This also makes the message robust to the reason list growing later.

### E2 · NON-BLOCKING · The BYO suppression now silences the ratified message for the population most likely to need it

§7.10.3 suppresses **both** seat reasons when the tenant holds `domains.source='byo'` rows. That was
right for the ACTION — recommending a managed lookalike purchase is the wrong product for a BYO
customer. Under EMIT it also silences the free-headroom FACT, and BYO tenants are the likeliest
population to sit under 5: someone connecting two of their own mailboxes while paying the 5-seat
floor has the most free headroom and is told least about it.

Better shape: suppress the managed-purchase **action**, not the message — emit `seat_headroom_free`
with a BYO-appropriate action (the BYO connect path, or `via:"none"` with a note), which the new
`NextStepAction` union makes expressible. Also note the mixed case: a single `source='byo'` row
suppresses the managed side entirely for a tenant running both.

### E3 · Severity upgrade · N8's guard is now enforcing a founder ruling, not a design preference

The ratification is "emit, **and nothing chases them**" — which holds only while `kind` stays
`available`. A later change flipping it to `owed` would put it into `owedCount`, which sustains the
check (§7.11), which alerts and eventually nudges: B5's permanent cry-wolf re-created on a signal
ratified as silent, for every paying customer under 5 mailboxes. So N8 moves from a nice-to-have to a
required guard, and it should assert the whole chain rather than the field: `seat_headroom_free` is
never `owed`, never appears in `owedReasons`, never names a check, never fires a nudge.

### Attacks on the ratified sentence that FAILED

- **Is "$0" true on the WHOLE bill, or only the mailbox line?** This was the attack most likely to
  sink the ruling, and it holds. Filling to 5 may require buying a DOMAIN, but domains are platform
  COGS, not customer-billed — stated at `packages/shared/src/intents.ts:70` (*"our wallet/COGS —
  their bill is unchanged, mailbox-count-based only"*) and already live in the shipped tool
  description (`mcp/tools.ts:74`). Warmup is inside the mailbox reserve, likewise not customer-billed.
  With `billableMailboxes` flooring at 5 (`pricing.ts:50-52`), any fill to ≤ 5 is genuinely $0 on the
  customer's invoice, and `effect.projectedMonthlyCents` proves it in-payload (3960 → 3960) rather
  than asserting it in prose.
- **Does the ratified emit leak into anything that chases the customer? No — structurally.**
  `available` steps do not enter `owedCount`, so the check cannot go unhealthy on it (§7.11); the
  nudge fires off the check, so it cannot nudge; and §7.10.3's payload carries `owedReasons` only, so
  it never reaches an alert body or the digest. "Nothing chases them" is a structural property, not a
  convention — conditional on E3's guard holding it there.
- **Exact-fit expressibility.** With Q2's distribution the fill to exactly 5 is expressible
  (`[3,2]`), so the recommendation never has to overshoot into a real charge to satisfy the $0
  sentence. Under v1's uniform `inboxesEach` it could not, which is what made the same message
  dishonest before Q2.

---

# ROUND 3 — gate on §7.17 (v3, 1456 lines, 2026-08-18)

Scope as briefed: §7.17 only, the round-2 + Q4 fold. I read §7.17 in full and re-derived each of the
eight resolutions against source rather than against the relay.

## VERDICT: SHIP-AFTER-FIXES · 2 blocking residue

**All 8 round-2 resolutions close their finding, and §7.17.4 contains a genuine new catch the
round-2 gate did not have — I verified it and it is sound.** The residue is not in §7.17's eight
resolutions. It is that **the Q4 gate's own blocking item (E1) was never folded**, and that a
pre-existing internal contradiction between two binding subsections is now pinned by a build fixture.

The brief's premise on this point was stale: it lists "E1 `owedCount===0` predicate + E2
fact-not-action BYO suppression + the refreshed §7.5 worked example" as things to verify in §7.17.8.
None of the three is present. I grepped the whole 1456-line document — `owedCount === 0` appears only
at line 1117 (the check's pre-existing clear condition) and line 1444 (I6's nudge-exclusion RED),
never as the `seat_headroom_free` emit predicate; there is no E2 language anywhere; and §7.5 is
byte-unchanged at `billable = 2`.

## The eight resolutions — all CLOSED

| # | Status | Verification |
|---|---|---|
| **N1** | **CLOSED** | The arm gains the *identical* conjunct the sync uses (`billing_state === 'active'`), read from `tenant_profile` at derivation time rather than a cached copy — which also forecloses the stale-authority variant. The generalisation is stated correctly ("a check that reports a push is overdue must carry the same eligibility predicate as the push"). The debounce-is-load-bearing note preserves my failed attack as a *constraint*, so nobody later exempts this check from `confirmAfterObservations: 2` and re-opens the transient. |
| **N2** | **CLOSED, and promoted** | The exclusion moves into `deriveNextSteps`, which is where `owedCount` is sourced; `unackedBlockingMessages` then needs no special case because it inherits the primitive's view. The part that makes this a class fix rather than an instance fix is the **retroactive application**: §7.17.2 names round-1 non-blocking 3 (the demo skip written for the check while the primitive also feeds responses) as the same shape, and promotes a standing build rule — every suppression goes in the primitive; a consumer needing its own filter means the primitive is under-specified. That is the correct generalisation of a defect I have now reported three times on this project. |
| **N3** | **CLOSED; decline RATIFIED** | `withheldAlertState` (`watchtower-policy.ts:256-264`) is reused rather than re-invented, with a new `DeliveryReason` member `"reclassified"`, scoped to the flip pair. **I ratify the declined alternative.** Giving `basis:"no_longer_applicable"` a blanket "no email" meaning would silence every such clear across the entire watchtower, not the two checks this wave adds — my round-2 note offered it as an "or", and the scoped version is strictly better. Recording the decline *with* its blast-radius reason is the right form. |
| **N4** | **CLOSED, + new delta VERIFIED** | See below — this is the most valuable item in §7.17. |
| **N5** | **CLOSED** | Bound stated rather than silently carried, and the lowering-side writer is assigned to I4 as a **precondition of arming the reconcile**, not of this wave. That scoping is correct: harm is zero while the flag stays unset, and the design depends on it nowhere. |
| **N6** | **CLOSED** | Per-field emptiness, not a population test. Re-verified against `schema.ts`: `brand TEXT NOT NULL` (no default — always set at signup), while `physical_address`, `sender_identity` and `primary_domain` are each `TEXT NOT NULL DEFAULT ''`, and persona has no column at all. I5's signup-only fixture "fails on any population-test implementation" is the right anchor — it tests the discriminator, not the output. |
| **N7** | **CLOSED** | `8.0N + 29` + `1N` = `9.0N + 29`; arithmetic checks. The ~122 → ~109 tenant figures are approximately right (at a 1000-subrequest ceiling I get 121 → 107); the rounding is not load-bearing and the bound is now stated at the level S1's arithmetic operates on. |
| **N8** | **CLOSED** | And my E3 "whole-chain" phrasing was over-specified — I withdraw it. `owedReasons`/`owedCount` are derived by filtering on `kind === 'owed'` (§7.10.3), so pinning `kind` **structurally implies** never-in-`owedReasons`, never-names-a-check and never-nudges. The one-line assertion is genuinely sufficient; asking for four assertions where one field implies the rest would have been guard theatre. |

### §7.17.4's new delta — verified, sound, and stronger than the design claims

The designer's claim is that `webhook_events.ts` is stamped from `ctx.clock` and is **not** shifted by
the clock migration, so a backfilled `first_paid_at` can land in the real future. I checked both
halves independently:

- `applyStripeWebhookEvent` stamps `ts` from `const now = ctx.clock.now()`
  (`engine/billing.ts:572-578`). **True.**
- `clock-migration.ts`'s UPDATE list shifts `scheduled_sends.send_at`,
  `scheduled_sends.sending_since`, `request_idempotency.created_at`, `domains.first_send_eligible_at`,
  `domains.dns_first_checked_at` and `domains.dns_gave_up_at` (lines 204-253). **`webhook_events` is
  absent.** True.

So the clamp is warranted, and its safe-direction reasoning is correct: clamping a future-dated value
to backfill time *understates* age, which delays an alert and can never fire one early.

**One supporting point the design does not make, and should:** adding `webhook_events` to
`clock-migration.ts` would **not** fix the affected population, because that migration is one-shot —
it sets `clock_mode = 'real'` as its final statement (`clock-migration.ts:286`) and is guarded on
that, so it has already run for every tenant whose timestamps are in the virtual domain. The clamp is
therefore not merely the safer fix; it is the **only available** one. Worth one sentence in §7.17.4,
because a future reader will otherwise propose the migration route.

## BLOCKING RESIDUE

### R3-1 · E1 was never folded — the free-headroom invitation still fires on a broken account

§7.10.1's table (line 1007) still routes on the bare condition `0 < billable < 5`, and §7.17.8
carries only two conditions: BYO suppression and the never-`owed` guard. The Q4-gate blocker is
absent.

The scenario is unchanged and still live: `forEachIsolated` completes a call after logging
`DOMAIN_ORDINAL_FAILED` per failed ordinal (`provisioning.ts:660-670`), and the reason list has no
member for a hard-failed ordinal — if it failed before the buy there is no `domains` row either, so
`domain_dns_incomplete` does not cover it. A tenant at 3 of 5 whose second domain died on a permanent
vendor refusal is told *"provisioning the remaining 2 adds $0 to your bill."*

Fix is unchanged and is one predicate: **emit `seat_headroom_free` only when `owedCount === 0`.**
Deliberately not dependent on enumerating every gap in the reason list, so it stays correct as that
list grows.

### R3-2 · §7.5 contradicts §7.10.1, and I5 pins the build's flagship acceptance test to the contradiction

This is not merely staleness against prod. **Two binding subsections disagree with each other.**

- §7.10.1 (line 1007): `0 < billable < 5` → `seat_headroom_free`, `kind: "available"`.
- §7.5 (lines 829-841): Mordy at **2 mailboxes** → `"reason": "paid_seats_unprovisioned"`,
  `"kind": "owed"`, `"status": "owed"`.

`billable = 2` satisfies `0 < billable < 5`, so §7.5's worked example emits the reason and kind that
§7.10.1's own table forbids for that state. The example was written for v1's two-way split and never
revisited when B5's three-way split landed.

It matters because **I5's RED test pins the fixture to it verbatim** ("Mordy-state fixture yields the
§7.5 step verbatim"). A builder writes a synthetic fixture at `billable = 2` asserting
`paid_seats_unprovisioned`/`owed`; that fixture passes on an implementation that ignores the
three-way split, and nothing catches it — the flagship acceptance test would certify the exact
behaviour B5 was raised to remove.

Prod movement compounds it. The ops ledger records the fleet complete at ~22:45Z: four mailboxes
active across both domains, zero unhealthy. So Mordy is at `billable = 4`, both ordinals live, and
his real step is `seat_headroom_free` (`available`) for one more mailbox. The example's `params` and
`effect` survive the refresh by coincidence — under `distribution: [3,2]` ordinal 0's third slot is
still unfilled, so the action is still `{domains:2, distribution:[3,2]}` and `provisionedAfter: 5` at
`3960` — but its `reason`, `kind`, `status` and the entire `why` sentence ("2 are provisioned…domain
slot 1 has never been requested") are all false against both prod and §7.10.1.

Refresh §7.5 to `billable = 4` / `seat_headroom_free` / `available`, and repoint I5. That also gives
E1 its natural demonstration: with zero unhealthy checks Mordy passes `owedCount === 0`, so the
refreshed example shows the ratified sentence firing exactly where it should.

## NON-BLOCKING RESIDUE

**R3-3 · E2 was declined without being recorded as a decline.** §7.17.8 presents "BYO suppression
stays" as *carrying* a condition attached to the ruling, but my round-2 Q4 note asked for the
opposite shape — suppress the managed-purchase **action**, keep the **fact**, since BYO tenants
connecting two of their own mailboxes are the population most likely to sit under 5 and hear least
about their free headroom. Declining a non-blocking note is entirely legitimate; presenting it as a
carried condition hides that a choice was made. Record it as a decline with its reason, the way
§7.17.3 correctly records the `no_longer_applicable` decline.

## INCREMENT SPOT-CHECK — the five RED changes are the right anchors

- **I6 before I15 is the honest dependency, and the order already supports it** (I6 < I15 in §7.13's
  unchanged sequence). Its RED — *a tenant whose only unacked message is a `continuity_nudge` must
  derive `owedCount === 0`* — fails on the v2 wrong-site implementation and passes only on the
  primitive-site one. That is the anchor that makes I15's end-to-end loop assertion meaningful rather
  than circular, and §7.17.9 says so plainly.
- **I11 carries the clamp's proof, not its assertion.** A virtual-clock future-dated fixture is the
  only construction that can distinguish a clamp from an unclamped write; asserting the backfill
  value alone would have passed either way.
- **I13's RED is correctly two-part** — no recovery email **and** the abandoned name's state still
  cleared. Either half alone is satisfiable by a wrong implementation: suppress the send by skipping
  the clear, and the 24h re-alert returns.
- **I5's signup-only fixture** tests the discriminator (`brand` excluded, four fields included)
  rather than the output, so it fails on any population-test implementation. Right anchor — but see
  R3-2 on its other half.
- **I4's assignment as an arm-gate precondition** keeps a flag-gated concern out of this wave's
  critical path without dropping it.

---

# ROUND 3 (extended) — gate on §7.18, and FINAL verdict

Scope extension: §7.18, the Q4 EMIT-branch fold (doc now 1645 lines; precedence §7 → §7.17 → §7.18).

## FINAL VERDICT: SHIP-AFTER-FIX · 1 blocking, one line, scoped to I6

**Both round-3 blockers are closed, and E2 is adopted in fuller form than I asked for.** The single
remaining item is a consistency fix: the clamp rule the design writes in §7.17.4 is not applied to
the anchor introduced two subsections later. It is one line, the design already contains the rule,
and E1 stays closed regardless.

## Round-3 residue — cleared

- **R3-1 (E1) CLOSED.** §7.18.1 states the predicate exactly as
  `seat_headroom_free ⇔ owedCount === 0 AND 0 < billable < MINIMUM_BILLABLE_MAILBOXES`, with the
  robustness argument preserved (it does not depend on having enumerated every gap in the reason
  list). The COGS verification of the $0 claim is carried accurately into §7.18's preamble with both
  cites intact.
- **R3-2 (§7.5 vs §7.10.1) CLOSED, and better than a refresh.** §7.18.4 refreshes the example to
  `billable = 4` / `seat_headroom_free` / `available`, and adds the rule that matters more than the
  refresh: **a doc example and a test fixture have different jobs and must not share a state.** The
  example is dated in place; the fixture is synthetic and hermetic. That is the durable fix — a
  refreshed example pinned to a live tenant would just go stale again on the next prod move.
  `status: "none_owed"` with a non-empty `steps` array is consistent with §2.2's own definition
  ("emitted with `steps: []` or with `available`-only steps") and is, as the brief says, the
  cleanest possible justification for making the discriminator explicit rather than inferring it
  from emptiness.
- **R3-3 (E2) CLOSED in fuller form than requested.** §7.18.3 suppresses the action rather than the
  fact and adds a four-row composition table. I verified the new action against source: the tool
  `configure_byo_domain` is real (`mcp/tools.ts:289`) and its schema genuinely accepts
  `action: "request_managed_mailboxes"` with `id` and `count`
  (`mcp/schemas.ts:163-170`), so the args shape is correct rather than plausible — and
  `remove_mailboxes`' own shipped description already points at exactly this path for adding
  mailboxes (`tools.ts:186`). The mixed-tenant row ("the composition test is over what the tenant
  *holds*, never 'does any BYO row exist'") is the half I flagged as a live defect, and it is
  addressed head-on.

## Two corrections to my own record

- **My `DOMAIN_ORDINAL_FAILED` cite was stale.** I cited `provisioning.ts:660-670` in rounds 2 and 3;
  the design cites `701-708` and the design is right — the row is written at
  `provisioning.ts:703`. My line numbers came from an earlier read of the file.
- **E3: I withdrew the four-assertion demand and the designer reinstated it with a better argument
  than mine.** §7.18.5's case is that each link is separately breakable by a *future* edit — if
  someone later derives `owedReasons` by name rather than by filtering on `kind`, assertion 1 alone
  stops covering assertions 2-4 — and that the guard is enforcing a founder ruling, so the comment
  should say so. That is legitimate defence-in-depth on a ratified property at negligible cost. I
  accept the reinstatement; my "guard theatre" call was about redundancy today and did not account
  for the derivation itself being editable.

## NEW BLOCKING — scoped to the eleventh reason (I6)

### X1 · `ordinal_incomplete` ages from an anchor with the exact clock defect §7.17.4 just fixed

§7.18.2 makes the new reason "ageable from `domain_intents.updated_at` (real wall-clock for the paid
tenants in scope)". The parenthetical is false, and it is false for the same reason §7.17.4 is right
about `webhook_events`:

- `recordDomainIntent` stamps both `created_at` and `updated_at` from **`ctx.clock.now()`**
  (`engine/provision-intents.ts:97`), not real time.
- `clock-migration.ts` shifts `scheduled_sends`, `request_idempotency` and three `domains` columns
  (lines 204-253). **`domain_intents` is not in that list** — the same omission the design correctly
  identified for `webhook_events`.
- A demo/free tenant *can* provision: `SANDBOX_PROVISIONING_CAP = {domains: 5, mailboxes: 15}`
  exists precisely for that (`quota.ts:21`), and `provisionDomainWithMailboxes` calls
  `recordDomainIntent` on the sandbox path too. So a tenant that attempted provisioning while on a
  `VirtualClock` and later upgraded carries virtual-domain `updated_at` on those rows, permanently.

Failure direction: a `VirtualClock` runs up to 1440× **ahead**, so `updated_at` sits in the real
future, `now − updated_at` is negative, "past the grace bound" is never true, and
**`ordinal_incomplete` silently never fires for that tenant.** That is fail-silent rather than
fail-loud, which is the safe direction for alerting — but the whole justification for shipping this
reason in-wave (per the orchestrator ruling) is that an ordinal-hard-failed tenant is *"a silently
broken state invisible to P2."* A reason whose anchor can silently disable it for a subpopulation
does not fully close that class.

Fix, one line, and the design already contains it: apply §7.17.4's clamp to this anchor too. Better,
state it once at wave level — **every anchor this wave ages from must be clamped to real time,
because `clock-migration.ts` shifts exactly three tables and anything else stamped from `ctx.clock`
is virtual-domain forever.** That covers `first_paid_at`, `domain_intents.updated_at`, and whatever
the next increment reaches for. This is the regression-ring pattern this project keeps producing:
the last fix bred the next finding, one table over.

Everything else about the reason checks out and it is well-composed: `domain_orphan:` covers
`status='committed'` with no `domains` row while this covers `'intent'`/`'dangling'`, which are
disjoint status sets and genuinely unread today — so it closes a real gap rather than double-reporting.
The log-row-never-the-predicate rule is correct and well-argued: a `deliverability_actions` row
survives a successful retry, so predicating on it would pin a healed tenant as broken forever, and
using it only for the customer-safe `why` detail and its date is the right split. And the dependency
note is honest — E1 is closed by §7.18.1 alone, so deferring the reason would not reopen it.

## NEW NON-BLOCKING

**X2 · The named synthetic fixture cannot exercise E1's own RED.** §7.18.4 and I11 both name the
hermetic fixture as *3 domains at `[2,2,1]` with a 6-seat paid quantity*. That is `billable = 5` with
`mailbox_qty_synced = 6` — which is a `billed_quantity_drift` fixture (`billable >= 5 AND synced >
billable`), not a headroom one. E1's RED requires a tenant **inside** the band `0 < billable < 5`
with an owed reason present, which `[2,2,1]` cannot produce. I11 converges four separate REDs (N1,
N4, E1, E3) on one named fixture and at least one of them needs a second: e.g. two live mailboxes on
ordinal 0, an `'intent'` row on ordinal 1, and a 5-seat quantity. The hermetic-fixture *rule* is
right; this particular instance does not cover the case it is attached to.

## Whole-design status

Across four passes: 14 round-1 blockers, 4 round-2, E1, and X1 — every one either closed or reduced
to a one-line consistency fix. The core mechanism is unchanged from v1 and has now survived every
attack I could construct against it across all four: one derivation with three consumers,
derive-don't-store, the dry run through the real planner, DO-local signals riding existing fan-outs,
and address determinism under a per-domain distribution. The parts of this design that were right at
the start were right for reasons that held up under sustained attack, which is worth recording as
plainly as the defects.

---

# FINAL RECORD — consolidation and two standing rulings

## Timing, for the record

My **ROUND 3** section was written against the 1456-line snapshot, before §7.18 existed. My
**ROUND 3 (extended)** section above was written against the 1645-line document and reviewed §7.18
in full — it is where R3-1 and R3-2 are confirmed closed, at §7.18.1 (line 1499, the
`owedCount === 0` predicate) and §7.18.4 (line 1567, the refresh to `billable = 4` with I5 repointed
to a synthetic hermetic fixture) respectively, along with §7.18.3 closing E2 and mooting the
E2-decline bookkeeping note, and §7.18.5 closing E3. Both confirmations stand; nothing below revises
them.

The process observation from round 3 was true of the file as it existed when I read it and is worth
keeping for the reason it was recorded — **a fold folds the round it names, and findings delivered
outside the numbered round are the ones that fall through** — with the correction that on this
occasion the fold simply had not landed yet. The lesson survives the correction: on any multi-round
review, grep the fold for each finding's distinguishing string before confirming closure, and
re-check the document length before concluding an omission.

## Ruling 1 — the clamp is the only fix available for the affected population (VERIFIED)

Recorded so nobody re-proposes the migration route. I asserted this in the round-3 section from
inference; I have now verified it from source:

- `clock-migration.ts:1` — *"The one-shot virtual→real clock migration"*.
- `clock-migration.ts:48-49` — *"Call ONCE per tenant, from TenantDO only, guarded by
  `clock_mode != 'real'`"*.
- The guard itself is `tenant-do.ts:275`: `if (row.clock_mode === "real") return new RealClock();`
  — a migrated tenant never re-enters the migration.
- The final statement of the migration stamps `clock_mode = 'real'`
  (`clock-migration.ts:286`), and the failure path deliberately leaves it `'virtual'` so an errored
  migration retries on the next construction (`tenant-do.ts:286`).

**Precise statement, which is stronger than "the only fix" and also more accurate:** adding
`webhook_events` or `domain_intents` to the migration's shift list would repair only tenants that
have **not yet migrated**. Every already-migrated tenant is permanently beyond that migration's
reach, and those are exactly the tenants whose rows carry virtual-domain timestamps today. So the
clamp is required regardless of what the shift list is later changed to, and the migration route can
never be a substitute for it. Both §7.17.4's `first_paid_at` and X1's `domain_intents.updated_at`
resolve the same way, which is the argument for stating the clamp once at wave level rather than per
column.

## Ruling 2 — N8 / E3: KEEP the four assertions, do not trim to one

I raised the whole-chain guard (E3), then withdrew it as redundant because `owedReasons` and
`owedCount` are derived by filtering on `kind === 'owed'`, so pinning `kind` structurally implies the
other three links. The designer reinstated all four in §7.18.5.

**Ruling: KEEP.** The designer's argument is better than my withdrawal was. My redundancy analysis
was correct about the code as it stands today and silent about the thing that actually breaks
guards — a future edit to the *derivation itself*. If `owedReasons` is ever built by naming reasons
rather than by filtering on `kind`, assertion 1 stops covering assertions 2-4 and the founder's
"nothing chases them" ruling quietly stops being enforced by anything. Four assertions over the same
fixture matrix cost approximately nothing, and the guard is enforcing a founder ruling rather than a
design preference, so the comment naming that ruling is itself part of the value: a future editor
learns the cost of relaxing it. Trimming would optimise the wrong quantity.

## The design's final verdict

**SHIP-AFTER-FIX** — one blocking item (X1), one line, scoped to I6, with the rule it needs already
written in the design at §7.17.4. One non-blocking item (X2, the named hermetic fixture cannot
exercise E1's own RED). Everything else across four passes — 14 round-1 blockers, 4 round-2, E1,
X1 — is closed.
