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

## Q1–Q3 — my recommendations (the founder decides)

**Q1 — automated nudge.** Ship the `tenant_messages` half now; **hold the email leg until B4 is
fixed.** With read-activity as the "answered" signal, the email leg has an unbounded 24h loop
whose trigger is the customer reacting to the previous email. Once B4 is fixed (reset only on the
owed set shrinking), the email leg is safe at the stated caps. Signup contact only.

**Q2 — the 5-over-2-domains overshoot.** Not (b): concentrating 5 mailboxes on one domain
contradicts the platform's own `MAILBOXES_PER_DOMAIN = 3` bundling and its deliverability posture.
Take (a) — but with a hard constraint the design does not currently impose: **an automatically
emitted recommendation that raises the bill must be `kind:"available"`, never `"owed"`, and must
never be the input to an automated nudge.** As written, the design auto-emits a
billing-increase recommendation as a default and classifies it as something the account owes us.
That is a pricing/consent decision wearing a UX label — it belongs in Q-space explicitly (this is
my answer to attack angle 9: yes, a policy decision is smuggled in as a default). (c) is the right
long-term answer and is a real API change; not this wave.

**Q3 — alert channel.** **Digest-only.** It fires on healthy infrastructure and, per B5 and B6,
has known false-positive populations (every sub-5-seat customer, every dunning-suspended tenant).
Email at the default policy would page the founder for each. Revisit once B5's
stalled-vs-satisfied ambiguity is resolved — at that point the signal is trustworthy enough to
promote.
