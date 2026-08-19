# Adversary build gate — CUSTOMER-CONTINUITY wave (phases A+B)

**Date:** 2026-08-19
**Target:** worktree `.claude/worktrees/continuity`, branch `feat/customer-continuity-2026-08-18`
**Ground ref:** `git rev-parse HEAD` = `887ab25be55a20511a9a6bf8ac58ad39e39c58f1`
(phase A `5165f58` + phase B `887ab25` on base `61aaad0`; scope = `git diff 61aaad0 HEAD`,
58 files, +5870/−232). Working tree clean at review time.
**Canon:** `docs/research/customer-continuity-design-2026-08-18.md` (§7 binding),
`docs/adversarial/customer-continuity-design-gate-2026-08-18.md` (the 4-pass design gate),
ROADMAP `## Open` CUSTOMER-CONTINUITY entry. All four cited docs verified present at HEAD
via `git cat-file -e HEAD:<path>`.

## VERDICT: SHIP-AFTER-FIXES

Two BLOCKING findings survived self-refutation. Both are reachable on the ONE live paying
tenant (`ten_91aab24a`) — the intended first recipient of the new response contract — and
neither is visible to the 2001-test battery, because every end-to-end fixture seeds the one
column production leaves NULL.

---

## Battery evidence (run at HEAD, this worktree)

```
$ npm run typecheck            # all 5 workspaces
dashboard / engine / platform / agent-cold-email / shared — tsc --noEmit, no output
TYPECHECK_EXIT=0

$ cd apps/platform && npx vitest run
 Test Files  207 passed (207)
      Tests  2001 passed | 1 skipped (2002)
   Duration  618.97s
exit code 0
```

Matches the builders' claim (207f / 2001p / 1skip) exactly. Deliberately NOT run with
`--reporter=basic` (that reporter exits 1 having run zero tests on this repo).
Green battery + green typecheck are recorded as fact and are NOT the basis of this verdict.

---

## BLOCKING-1 — the recommendation loses the persona for every pre-column tenant, and prices a $16/mo increase as "your bill is unchanged"

**Lens:** 5 (fixture realism) + 1 (spec-vs-code) + 2 (run it).
**Severity:** BLOCKING. Money field, customer-facing, unattended agent, live tenant.

### Mechanism

`readProvisioningSnapshot` sources the persona from ONE place —
`domain_intents.persona_slug` (`apps/platform/src/engine/provisioning-plan.ts:148-151`).
That column was added later by `addColumnIfMissing` and is written **INSERT-only**
(`INSERT OR IGNORE`, `apps/platform/src/engine/provision-intents.ts:99-108`), so it is
permanently NULL for every intent row written before it existed. No later call updates it.

`deriveNextSteps` then treats NULL as the empty string in two places:

- `apps/platform/src/engine/next-steps.ts:280` — `field("persona", snap.provisioning.personaSlug ?? "")`
  → `""` is empty → `"persona"` is pushed onto **`paramsToSupply`**.
- `apps/platform/src/engine/next-steps.ts:318` — `persona: snap.provisioning.personaSlug ?? ""`
  is handed to `planFor`, which does `slugify("")`. `slugify` ends
  `|| "hello"` (`provisioning-plan.ts:42`), so the plan is computed against addresses
  `hello11@…`, `hello21@…` — matching none of the tenant's real mailboxes. Every slot
  counts as NEW.

The code comment asserting the premise is false in production:
`next-steps.ts:276-279` — *"Absent for a tenant that has never provisioned, and then it is
genuinely unknown."* The live tenant HAS provisioned; his persona is in every one of his
four mailbox addresses.

### Live-state proof

`GET /admin/tenants/ten_91aab24a-…/provisioning-state` (read-only, 2026-08-19) returns both
ordinal intents with **`"personaSlug": null`**, alongside mailboxes
`mordytee11@theauthorpitchdesk.com`, `mordytee12@…`, `mordytee21@goauthorpitchdesk.com`,
`mordytee22@…`. That operator view SELECTs `persona_slug` straight from `domain_intents`
(`engine/provisioning-state.ts:200`) — the same column `readProvisioningSnapshot` reads, so
the probe is not measuring a different thing.

### Executed proof (real `planFor`, real constants, his real rows)

Bundled `engine/provisioning-plan.ts` with esbuild and ran it against a snapshot transcribed
from the production probe:

```
distribution           = [3,2]          # fillDistribution(2 ordinals, max(billed 5, floor 5))
slugify('')            = "hello"
persona=""          newMailboxes=5 provisionedAfter=9 priceCents(no discount)=13900
persona="mordytee"  newMailboxes=1 provisionedAfter=5 priceCents(no discount)=9900

What next-steps.ts actually passes: persona = snap.personaSlug ?? ""  ->  ""
```

At his real discount — `GET /admin/ops/digest` reports platform `mrrCents: 3960` with exactly
one `managed` tenant, i.e. the 5-mailbox floor at 60% off (9900 × 0.4 = 3960):

| | `effect.provisionedAfter` | `effect.projectedMonthlyCents` |
|---|---|---|
| correct (persona known) | 5 | **3960** |
| actual (persona lost) | 9 | **5560** |

So `seat_headroom_free` would ship prose reading *"…so 1 more mailbox costs nothing — your
bill is unchanged"* (`next-steps.ts:500-504`) directly beside an `effect` object asserting
nine mailboxes at **+$16.00/mo**. `effect` is documented as "the SAME projection the
response's own `billing` field carries, so a step's claim about the bill IS the bill"
(`packages/shared/src/next-steps.ts:96-99`).

### The second half: `paramsToSupply: ["persona"]`

The emitted call is not silently wrong — it is flagged incomplete. But `paramsToSupply` is
specified as *"Fields the PLATFORM cannot know"* with an explicit prohibition:
*"Asking an agent to re-supply a brand the platform already holds is the mirror image of the
defect this wave fixes"* (`packages/shared/src/next-steps.ts:82-87`). The platform holds this
one. And because nothing in the response says *which* string, an unattended agent that guesses
(`"Mordy Tee"`, the brand, anything ≠ `mordytee`) issues a call that targets five brand-new
addresses on domains that already carry four mailboxes — a real purchase, autonomously, from
the platform's own recommendation.

### Why the battery cannot see it

Every fixture that drives `deriveNextSteps` end-to-end seeds `persona_slug` NON-NULL **and**
derives the live mailbox addresses from that same string:
`test/next-steps-convergence.test.ts:96-104,115` (`managedMailboxAddress(persona, …)`),
`next-steps-derivation.test.ts:54-59`, `next-steps-gating.test.ts:77-83`,
`next-steps-surfaces.test.ts:58-59` (literal `'sender'`). Only
`provisioning-plan.test.ts:52` can pass NULL, and that is the pure-planner unit test where
the persona rides the target and `snapshot.personaSlug` is never read. Grain-matched
fixtures, exactly the shape that hid the cardinal bugs behind 167 green tests before.

### The refutation that makes this decisive

The same codebase, reading the same NULL, one module over:

```
apps/platform/src/engine/provisioning-reconcile.ts:148-156
  summary.skippedNoSpec++;
  logAction(ctx, "PROVISIONING_RECONCILE_SKIPPED", …, {
    reason: "no durable provisioning spec on this intent (a legacy row) — completing it
             needs an agent retry that supplies the persona and mailbox count", … })
```

The reconciler treats a NULL spec as *"not safely completable — abstain"*. The new
recommendation path substitutes `""`, lets `slugify` turn it into `"hello"`, and computes a
money figure from it. Two readers of one NULL, opposite handling; the new one is the
customer-facing one.

### Reachability, stated honestly

`seat_headroom_free` requires `owedCount === 0` (`next-steps.ts:482`). This tenant currently
has an unacked `action_required` message (see BLOCKING-2), so on his literal next call the
headroom step is suppressed. The wrong number lands **one `ack_message` later** — and the new
contract's own `message_action_required` step instructs precisely that ack
(`next-steps.ts:699-703`). The persona defect is not confined to that one reason: it is in
`setupParamsFor`, so it also degrades `paid_seats_unprovisioned` (`:389-409`, including its
`effect`), `ordinal_incomplete` (`:572`) and `domain_dns_incomplete` (`:608`).

Population = every tenant whose `domain_intents` predate the column = the entire current
paying population (n=1).

### Fix direction (not implemented — flagging only)

Derive the persona from state that exists for the affected population, or abstain the way the
reconciler does. The mailbox local-part is `${personaSlug}${ordinal+1}${slot+1}@${domain}`
(`engine/mailbox-provisioning.ts:114`) and is unambiguously invertible against a known
ordinal/slot. A recommendation whose plan cannot be computed honestly should not carry an
`effect` at all — `effect: null` is already a supported value.

---

## BLOCKING-2 — a stale system message becomes a permanent `owed` step, and there is no auto-resolution path

**Lens:** 3 (live surface) + 6 (attack the design).
**Severity:** BLOCKING as a deploy precondition.

`readNextStepsSnapshot` counts every unacked `action_required` / `operator_pending`
`tenant_messages` row as owed (`next-steps.ts:172-181`, `:656-716`). `read_at` has exactly one
writer, `ackMessage` (`engine/tenant-messages.ts:254`); nothing expires or auto-clears a
system message whose condition later resolved, and `expires_at` is NULL on the row in
question.

Live: `GET /admin/tenants/ten_91aab24a-…/messages` returns an unacked
`kind: "retry_setup"`, `severity: "action_required"` row created `1787085239604`, whose body
reads *"Setup for goauthorpitchdesk.com has not finished yet — its mailbox purchase is still
completing at the vendor."* That work **completed**: `goauthorpitchdesk.com` is `active`, and
mailbox intents `mordytee21/22` are `committed` with `updated_at` `1787087626974` /
`1787087638175`, both **later** than the message.

Consequences on the live tenant, unattended:

1. His next `infrastructure_status` returns `status: "owed"`, not `none_owed` — the brief's
   stated premise for this wave's first response is falsified by production state.
2. `owedCount > 0` suppresses `seat_headroom_free` (`next-steps.ts:482`).
3. `owedCount > 0` + `oldestOwedSinceMs` (that message is ~1 day old, and `owedTooOld` trips
   at 48h) makes `customer_progress_agent:<tenant>` unhealthy
   (`admin/watchtower.ts` new block). `waitingOn: null` ⇒ agent-blamed ⇒ digest channel, so
   the founder is correctly not emailed.
4. The one-shot nudge then fires and writes an `action_required` message telling him
   *"This account has not progressed in over a day"* — about work that finished. First
   delivery ~30h after the check's onset (see NON-BLOCKING-2).

The wave's own N2 containment (`SELF_WRITTEN_MESSAGE_KINDS`, `next-steps.ts:74,181`) correctly
stops the nudge from sustaining its own check — verified, that loop is closed. This finding is
the *input* side: a stale row the wave did not write is now load-bearing for owed-ness,
alerting and nudging, with no clearing mechanism other than the customer.

Cheap resolution before deploy: ack or expire that message. Durable resolution: system-emitted
`action_required` messages whose condition is re-derivable need an auto-clear, or `owedCount`
should not treat an aged system message as owed without re-checking its condition.

---

## Rulings on the four open judgment calls

### J1 — `PROGRESS_INTRODUCED_REASONS` scoping of G5(a): **KEEP, with one pin (non-blocking)**

Not an escape hatch. §7.6(a) as written ("the owed set did not grow") is genuinely
unsatisfiable on the partial-success paths §7.6 itself requires to pass, and the builder
reported the deviation rather than weakening the assertion silently
(`test/next-steps-convergence.test.ts:39-52`) — the right call.

The guard stays falsifiable because (a) is one of four conjuncts and is **not** the one that
binds a failed execution. That is (b): `!stillOwed || shortfall < beforeShortfall`
(`:234-236`). A builder adding reason X to the exempt set mutes only "X newly appeared"; if X
is the executed step's own reason, (b) still reddens. (c) pins `effect.provisionedAfter` as an
upper bound, (d) is asserted separately with a planted row. The three exempted members each map
to a real documented mechanism (`capacity_pending` state, per-ordinal isolation, DNS
propagation) — verified in code, not taken from prose.

Residual: it is a hand-maintained allowlist living in the same file as the assertions it
relaxes, with nothing reddening when it grows. Recommend pinning its exact contents (the
treatment `NEXT_STEP_REASONS` already gets), so widening it is a deliberate edit.

### J2 — I12 split-RPC vs §7.10.2's literal param-threading: **SAME OUTCOME. Accept.**

Swept every call site. `infrastructureStatus()` has exactly two callers:

- `mcp/tools.ts:95-96` — hosted MCP resolves the tenant from the Authorization header only, so
  it always stamps. Correct.
- `routes/infrastructure.ts:19-24` — stamps only under `c.get("authVia") === "bearer"`.
  Correct; a cookie dashboard poll never stamps.

No site reads without stamping where it should, none stamps without a bearer. The split-RPC
form is strictly better than param-threading: it preserves `readOnlyHint: true` and the
write-spy that a prior BLOCKING finding produced, which folding the stamp into the read would
have re-broken. `recordAgentActivity` is synchronous, throttled to 5 min
(`tenant-do.ts:513`), one read + at most one write — §7.16 invariant 1 intact.

One real gap, reported as NON-BLOCKING-4: the stamp covers 1 of 28 tools.

### J3 — I15 transition-gating: **exactly-once per episode HOLDS; timing and blame-flip do not**

Attacked the storm direction first and it held. `decideAlert` preserves `sinceTs` across
`realerted` (`watchtower-policy.ts:236-241` — `next` reuses `episode.sinceTs`), so the DO-side
guard `stored >= episodeSinceTs` (`engine/continuity-nudge.ts:56`) makes repeat RPCs a genuine
no-op. No double-nudge from re-alerts, none from the digest channel (transitions still advance
when no email is owed), none from a withheld send. Cry-wolf rule verified at `:60`, and it
deliberately does not stamp, so a later mixed-blame tick in the same episode can still qualify.
Deactivation mid-episode exits via the `!stalled` clear branch and never calls the RPC.

Two deviations from "EXACTLY ONE per stall episode, 1 day after onset": NON-BLOCKING-2
(timing) and NON-BLOCKING-3 (blame flip).

### J4 — `alertRegistrarUnarmed` on the opt-in leg: **SCOPE IT TO THE ENV LEG**

`engine/provisioning.ts:503-507` fires the alert on `instanceof RegistrarUnarmedError` with no
`reason` branch, so the newly tenant-fixable 400 still pages the founder. Reasons to scope:

1. **The wave contradicts itself.** It sets `operatorActionable: reason === "env"`
   (`packages/shared/src/errors.ts`), then pages the operator for the leg it just declared not
   operator-actionable. `engine/registrar-alert.ts:22-33` reads neither field.
2. **The alert body is now false for that leg.** Subject and text say *"the registrar is not
   armed (gate (a))"*. On the opt-in leg the registrar IS armed — the tenant simply did not
   send the field. This is the known class of a fix leaving its on-call error string describing
   the pre-fix world.
3. **Unbounded, caller-controlled rate.** `RegistrarUnarmedDomainPort.searchLookalikes` throws
   (`vendors/real/domain-port.ts:52-54`) and `searchLookalikes` runs unconditionally
   (`provisioning.ts:498`), before any shortfall branch. Any agent retry loop omitting
   `registerDomains` pages the founder on **every attempt** — via a direct `mailer.send`, with
   none of the watchtower's debounce/backoff. The registrar is armed in production (both of
   this tenant's domains show `source: provisioned` with `purchasedAt`), so this leg is live
   today.
4. Nothing is lost: the opt-in refusal is fully self-describing in the 400 the wave added.

Keep the alert on `reason === "env"` — that one really is the operator's gate.

---

## NON-BLOCKING

1. **N-1 (J1 residual)** — `PROGRESS_INTRODUCED_REASONS` unpinned; see J1.
2. **N-2 — the nudge lands at ~30h, and the tunable is partly inert.** Gating on
   `alerted|realerted` means the delay is sampled only on the realert grid:
   `alerted` at ≈sinceTs (fails the 24h test), first `realerted` at
   `WATCHTOWER_COOLDOWN_MS` = 6h (fails), next at `+WATCHTOWER_STEADY_REALERT_MS` = 24h ⇒ the
   first passing sample is ≈**30h**. Setting `CONTINUITY_NUDGE_DELAY_MS` below 6h changes
   nothing; below 30h it still delivers at 30h. Direction is late, not never — hence
   non-blocking — but "1 day after onset" is not what ships, and the env knob does not do what
   its name says.
3. **N-3 — a blame flip mid-stall produces a second nudge.** `continuity_nudge_episode_ts` is
   per-tenant while the episode identity is per-check-NAME. When `anyOwedWaitingOnOperator`
   flips, `blamedName` switches, the new name opens a fresh `AlertState` with a later
   `sinceTs`, and `sinceTs > stored` passes again. One continuous stall, two nudges (one per
   blame regime).
4. **N-4 — the liveness stamp covers 1 of 28 tools; the alert text overstates it.** Only
   `infrastructure_status` stamps. An agent actively calling `setup_infrastructure`,
   `launch_campaign`, `ack_message`, `activity`, etc. for 24h without polling status is scored
   `agentStalled`. The operator-facing detail string says *"No bearer-authed activity in over
   Xh"* (`admin/watchtower.ts`), which is not what is measured — it is "no
   `infrastructure_status` call". False-stall direction, bounded by the `owedCount > 0`
   conjunct.
5. **N-5 — G3 is green-by-construction for additions.** `test/next-steps-doc-lockstep.test.ts:60`
   hand-copies the five `NextStepTool` members into a literal. A RENAME fails loud (the
   `NextStepTool[]` annotation rejects it), but a sixth member ADDED to the union and emitted in
   a step is never checked — and "a new tool value that isn't a real tool" is the direction the
   guard exists for. `NEXT_STEP_REASONS` solved this properly (runtime array, type derived from
   it); tools did not, because `NextStepTool` is type-only and erased.
6. **N-6 — stale schema comment.** `apps/platform/src/schema.ts:100-103` still reads *"NULL
   until a tenant calls setup_infrastructure with registerDomains:true (zod requires
   'registrant' on that call -- packages/shared/src/intents.ts)"*. This wave removed that
   refinement. Doc-lockstep miss inside the wave that added doc-lockstep guards.
7. **N-7 — "can never disagree" is not quite true.** `tenant-do.ts:836-840` claims the port's
   baked registrant and the buy-site pre-flight cannot disagree. When `registrant` is omitted
   and the persisted `registrant_json` has no `organization`, the port bakes
   `organization ← PRE-update brand` (`selectSetupDomainPort` reads `base.sql` before
   `runSetupInfrastructure`'s UPDATE) while `assertCompleteRegistrant` validates the POST-update
   brand (`provisioning.ts:176`). Both pass; the registrar filing carries the previous brand.
   Cosmetic in impact, but it is a real-money legal filing and the comment is absolute.

---

## Attacks that FAILED (this is what makes the two findings meaningful)

- **Zod `.extend()` dropping `.superRefine()`** — the classic trap: `SetupInfrastructureToolInput
  = SetupInfrastructureInput.extend({idempotencyKey})` (`mcp/schemas.ts:51`) sits on a refined
  schema, and the wave's new safety property (`distribution.length === domains`, "exactly one of
  the two") lives in that refinement. RAN it against the installed zod 4.4.3: both refinement
  issues fire identically on the base and the extended schema. Held.
- **MCP boundary rejecting the platform's own recommendation** — emitted `z.toJSONSchema(…,
  {target:"draft-7", io:"input"})` for the real tool: `distribution` is advertised with correct
  bounds, and `required` is `[brand, primaryDomain, domains, persona, physicalAddress,
  senderIdentity]` — `inboxesEach` is gone. The recommended shape validates. Held.
- **`inboxesEach` optional breaking a downstream consumer** — swept every `inboxesEach` reference
  in `src`. Nothing reads `input.inboxesEach`; the saga consumes
  `distribution[domainIndex]` (`provisioning.ts:638`) and every internal opts type keeps it
  required and non-optional. `resolveDistribution` really is the single widening point. Held.
- **Registrant relaxation wiping persisted state** — `registerDomains:true` + absent registrant
  writes consent ALONE (`provisioning.ts:525-536`); revocation still clears both columns, both at
  the early unconditional write (`:462-467`) and the full write (`:538-549`). Walked all four
  (true/false × registrant present/absent) combinations. Held.
- **`backfillFirstPaidAt`** — ordering is correct (`ensureColumnMigrations()` at
  `tenant-do.ts:207` precedes `backfillFirstPaidAt()` at `:209`, and the column is added at
  `:454`); the clamp `Math.min(derived.ts, realNowMs())` (`:574`) is present and points the safe
  way; the `WHERE … AND first_paid_at IS NULL` write plus the "already stamped → return" guard
  make it idempotent, and a DO is single-threaded so the concurrent-construction attack has no
  purchase; a never-paid tenant correctly stays NULL (`:570`) and `clampedAge(null, …)` yields
  `null`. Held.
- **The nudge re-arming its own check (the R2 loop)** — `SELF_WRITTEN_MESSAGE_KINDS` is applied
  in `readNextStepsSnapshot` (`next-steps.ts:181`), i.e. at the site where `owedCount` is
  actually sourced, not on a consumer. That is the correct reader — the exact mistake the design
  gate's round-3 finding was about. `tenant_messages` feeds `owedCount` through no other path.
  Held.
- **Nudge storm via realerts** — `sinceTs` preserved across `realerted`; DO-side guard makes
  repeats no-ops. Held (see J3).
- **Digest channel leaking an email** — `alertEmailFor` returns `null` on
  `policy.channel === "digest"` as its FIRST statement, before the action switch
  (`admin/watchtower-alerts.ts`), and `policy` is a required parameter so no caller can omit it
  (typecheck-enforced). Held.
- **Mandatory cross-clear emailing "resolved" about a still-broken thing** — `reclassified`
  suppresses the SEND but not the state transition, and `unhealthyProgressNames` is computed once
  over the whole batch before the loop, so it is order-independent and a genuine full recovery
  still emails. Held.
- **N1's active-conjunct on `billed_quantity_drift`** — the arm carries
  `billingState === "active"` (`next-steps.ts:429`), matching `syncMailboxQuantity`'s own early
  return, so a `past_due` tenant does not email the founder daily through the whole dunning
  window. Held.
- **Two G4 doc claims checked against live code, not prose** — "top-level `sendReady` is the AND
  across all mailboxes": `infrastructure-status.ts:195` is
  `mailboxHealth.length > 0 && mailboxHealth.every(m => m.sendReady)`. "Rising to 40/day after 4
  weeks": `engine/warmup.ts` has `WARMUP_RAMP_DAYS = 28`, `day <= 28 → 35`, else `40`. Both true.
- **Lifecycle gate hand-list** — `deriveNextSteps` imports the real `isLifecycleFrozen`
  predicate (`next-steps.ts:795`) instead of re-listing states, closing the design gate's
  exclusion-list finding, and the gate lives in the primitive so both consumers inherit it.
- **Deploy shape** — ZERO numbered D1 migrations in the diff (confirmed: `git diff --stat` over
  `migrations/` is empty); all four new columns land via DO-side `addColumnIfMissing`.
  `site/openapi.yaml` documents `distribution`, `NextStepReason` and `NextSteps`;
  `openapi.yaml` + `AGENTS.md` changed ⇒ **site deploy required**. MCP tool count is still 28 —
  no claim-surface count drift, though `setup_infrastructure`'s description grew substantially.

---

## UNVERIFIABLE

1. **Live drive of the new contract end-to-end.** Production runs `main`; `nextSteps` does not
   exist there, so the emitted payload could only be derived locally, not observed on the wire.
   Resolved by: replaying `deriveNextSteps` against a restored copy of this tenant's DO storage,
   or a post-deploy `infrastructure_status` capture before the customer's agent next polls.
2. **The exact `checkout_discount_pct`.** Inferred as 60 from platform `mrrCents: 3960` with a
   single `managed` tenant on the 5-mailbox floor. No read-only admin surface exposes the column
   directly. The BLOCKING-1 divergence does not depend on it (it is 5 vs 9 mailboxes either way);
   only the cent figures do.
3. **Digest rendering.** `channel: "digest"` today means "silently observed" — no digest renderer
   exists (stated honestly in `watchtower-policy.ts`). Whether the founder ever sees an
   agent-blamed stall is out of this wave's scope but is a real hole in the blame-split's value.
4. **Population size beyond n=1.** No admin path enumerates tenants, so "every tenant whose
   intents predate the column" could not be counted platform-wide. The one paying tenant is
   confirmed affected.

---

## NEW (out of scope, no verdict weight)

- `engine/provisioning-reconcile.ts:159-160` compares `liveMailboxes >= inboxesEach` — a COUNT
  against a planner that derives per-SLOT addresses. An acknowledged mailbox removal leaves a
  hole a count cannot see. Pre-existing, flag-gated, untouched by this diff; noted because it is
  the same coordinate-system class as BLOCKING-1 and lives in the same module family.
- `setup_infrastructure`'s MCP description is now ~4600 characters in a single string literal.
  Not a defect; worth a note that it is approaching the point where per-claim guards (G4's shape)
  are the only practical way to keep it honest.
