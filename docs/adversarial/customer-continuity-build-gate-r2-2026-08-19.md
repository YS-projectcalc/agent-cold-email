# Adversary build gate ROUND 2 — CUSTOMER-CONTINUITY wave (fix round)

**Date:** 2026-08-19
**Target:** worktree `.claude/worktrees/continuity`, branch `feat/customer-continuity-2026-08-18`
**Ground ref:** `git rev-parse HEAD` = `19c4db54989d4554d12635d80b7eeb83c2214dd4`
(fix commit `19c4db5` on the already-gated `887ab25`; scope = `git diff 887ab25..19c4db5`,
28 files, +1549/−117). Working tree clean at review time (`git status --porcelain` empty).
**Binding context:** round-1 verdict `docs/adversarial/customer-continuity-build-gate-2026-08-19.md`
(SHIP-AFTER-FIXES; BLOCKING-1, BLOCKING-2, J1–J4, N-1…N-7). Canon
`docs/research/customer-continuity-design-2026-08-18.md` §7.

## VERDICT: SHIP-AFTER-FIXES

**B1 is closed and closed well.** **J4 is closed.** **N-1…N-7 are closed** (one residual, non-blocking).
**B2 is NOT closed: the fix over-corrects and is a net regression on the customer-facing surface.**
One BLOCKING finding survived self-refutation, is reproduced by an executed test, and is
acknowledged in the fix round's own committed agent-memory file as a deferred knock-on
("the slot-level partial that train 5 still owes a reason for") without appearing in the
fix round's disclosed residuals.

---

## Battery evidence (re-run independently at HEAD, this worktree)

```
$ npm run typecheck                                  # all 5 workspaces
(no output)                                          TYPECHECK_EXIT=0

$ cd apps/platform && npx vitest run
 Test Files  209 passed (209)
      Tests  2029 passed | 1 skipped (2030)
   Duration  628.07s                                 VITEST_PLATFORM_EXIT=0

$ cd apps/dashboard && npx vitest run
 Test Files  29 passed (29)   Tests  143 passed (143)

$ cd apps/engine && npx vitest run
 Test Files  17 passed | 2 skipped (19)   Tests  140 passed | 4 skipped (144)

$ npm test -w packages/cli                           # node --test, NOT vitest
 tests 12   pass 12   fail 0
```

Matches the builder's claim exactly (209f/2029p/1skip · 29/143 · 17+2skip/140+4skip · 12/12).
Not piped through `head`/`tail` for the exit codes; `--reporter=basic` deliberately not used
(it exits 1 having run zero tests on this repo). One correction to the method, not to the
result: `packages/cli` is a `node --test` suite — running `npx vitest run` there reports
"4 failed / no tests" because vitest finds no suite in a `node:test` file. That is a wrong
runner, not a red suite.

**The green battery is recorded as fact and is not the basis of this verdict.** The BLOCKING
finding below is asserted by two of the suite's own passing tests.

---

## BLOCKING — the B2 auto-expiry silences and then DELETES a LIVE `retry_setup` action item

**Lens:** 7 (regression ring — attack the last fix hardest) + 6 (attack the design) + 2 (run it) + 5 (fixture realism).
**Severity:** BLOCKING. Customer-facing, unattended agent, destroys the only durable record of
work the customer must redo, and blinds this same wave's stuck-customer check and nudge.
**Direction:** silence — strictly worse than the stale-row noise it replaces.

### The rule the fix implements

`messageSteps(snap, setupFamilyOwed)` treats a `retry_setup` / `setup_failed`
`action_required` row as RESOLVED whenever no step in `SETUP_FAMILY_REASONS`
(`paid_seats_unprovisioned`, `ordinal_incomplete`, `domain_dns_incomplete`,
`setup_capacity_held`) is owed in the same pass
(`apps/platform/src/engine/next-steps.ts:110-116, 786-799, 986-995`), and
`expireResolvedSystemMessages` banks that durably on the ops fan-out
(`apps/platform/src/engine/ops-summary.ts:594-606`,
`apps/platform/src/engine/tenant-messages.ts:411-421`).

### Why the predicate is wrong

The setup family does not cover the condition `retry_setup` is emitted for. The
`action_required` emit is `engine/provisioning.ts:820-831` — `err instanceof VendorError &&
err.retryable`, i.e. `setDnsWithRetry` or `awaitMailboxReady` exhausted its in-call backoff.
On the mailbox leg the saga has already:

- marked the intent `committed` (`engine/provisioning.ts:318`),
- written the `domains` row and completed DNS (`:326`),
- and **persisted every slot that succeeded before throwing the first failure** —
  `provisionMailboxesForDomain` runs the slots through `forEachIsolated` and rethrows only
  after all of them have had their chance (`engine/mailbox-provisioning.ts:182-224`).

So the surviving state is: intent `committed`, domain live, DNS `ready`, and *some* mailboxes.
Against that state:

| setup-family reason | fires? | why not |
|---|---|---|
| `ordinal_incomplete` | no | requires `status` ∈ {`intent`,`dangling`} and `live === null` (`next-steps.ts:668-684`) |
| `domain_dns_incomplete` | no | requires `dnsStatus !== "ready"` (`:719`) |
| `paid_seats_unprovisioned` | no | requires `billable === 0` (`:496`) |
| `setup_capacity_held` | no | requires `provisioningState === "capacity_pending"` (`:747`) |

The band `0 < billable < 5` is owned by `seat_headroom_free`, which is `kind: "available"` and
**never owed** by ruling (`packages/shared/src/next-steps.ts:27-28`, `next-steps.ts:589-593`).
There is no reason in the closed `NEXT_STEP_REASONS` union for "a mailbox slot on a live,
DNS-ready domain failed". `setupFamilyOwed` is therefore `false`, and the row is expired.

### Executed proof

Copied the worktree to a sandbox (`rsync --exclude node_modules` + a `node_modules` symlink —
the shared worktree was never written to) and ran a probe that seeds the post-slot-failure
state and the verbatim `emitTenantMessage` payload from `provisioning.ts:822-831`:

```
$ npx vitest run test/adv-r2-probe.test.ts
 Test Files  1 passed (1)     Tests  3 passed (3)
```

All three assertions hold on the fix commit:

1. **Ordinal 1 asked for 3 slots, got 2** (domain committed, DNS ready, billed 5):
   `owedSignals(...).owedCount === 0`, `status === "none_owed"`, and `seat_headroom_free` is
   emitted carrying *"Nothing is blocked and nothing is required"* while a retryable mailbox
   failure is genuinely outstanding. One `opsSummary()` (the watchtower's per-tenant fan-out,
   `crons = ["*/5 * * * *"]`, `apps/platform/wrangler.toml:122`) stamps `expires_at`.
   `pruneTenantMessages` then **deletes** the row — `deleted: 1`, table empty — because that
   sweep has no retention grace for expired rows, unlike read rows
   (`engine/tenant-messages.ts:530-540`). The audit trail goes with it.
2. **Grace race.** A `dangling` ordinal whose domain buy threw retryably is covered by
   `ordinal_incomplete` only after `PROVISIONING_ORPHAN_GRACE_MS` = 30 min
   (`ops-summary.ts:180`). The ops sweep runs every 5 min, so the message is expired inside
   the grace window; when the grace opens, `ordinal_incomplete` fires but
   `message_action_required` never returns. Even where the family *does* eventually cover the
   condition, the message loses the race.
3. **Control passes:** an `operator_pending` row on the same fleet is not expired — the
   severity scoping the builder added really does hold.

### Corroboration inside the diff itself

Two pre-existing tests had to be edited away from `retry_setup` because the new rule silences
it — `test/next-steps-gating.test.ts:246-275` swaps `retry_setup` → `send_blocked` with the
note *"on a fleet whose setup family is empty it is a RESOLVED row by construction, so it would
no longer be a fair stand-in for 'any other action item'"*. And the fix round's own committed
memory file states the knock-on explicitly:

`.claude/agent-memory/hard-builder/staleness-exclusion-needs-severity-scope-not-just-kind.md:25-26`
> "Note the knock-on: removing a stale row's owed-ness also removes the accidental MASKING it
> was doing for gaps in the reason list (here, the slot-level partial that train 5 still owes a
> reason for)."

That is this finding, written down and deferred to a future train rather than disclosed as a
residual of the fix. The masking it removes was load-bearing for the customer surface.

### Fixture blindness (why 2029 green tests do not see it)

`test/next-steps-stale-system-messages.test.ts:117-123`'s `HEALTHY_FLEET` is 2+2 mailboxes at
`billedQuantity: 5` — one short of the paid floor — and `:189-214` **asserts** the `retry_setup`
row is expired in exactly that state. The fixture names it "a domain whose setup then FINISHED",
but the state is byte-identical to "one slot failed and the customer must retry". The test
encodes the assumption it was written to prove.

### Blast radius beyond the message

`owedCount` reaching 0 also disarms, for the same tenant at the same moment:

- `seat_headroom_free`'s own E1 guard, so the account is told *"nothing is required"* (`:597`);
- the wave's `customer_progress_*` stuck-customer checks, which require `owedCount > 0`
  (`admin/watchtower.ts:545`);
- the one-shot continuity nudge, which is gated on those checks.

Every mechanism this wave built to catch a stuck customer is switched off by the wave's own
expiry, on the one failure mode that leaves a customer stuck with a live domain.

### Reachability on `ten_91aab24a`

Round 1 recorded his fleet as `mordytee11/12@theauthorpitchdesk.com`,
`mordytee21/22@goauthorpitchdesk.com`, both domains active, both intents `committed`, billed 5.
That is precisely the fixture shape above. Two consequences, both real:

- The fix **correctly** expires his existing stale `retry_setup` row — round-1 BLOCKING-2's
  instance is resolved.
- It also guarantees that any *future* genuine `retry_setup` for him is expired within one
  5-minute tick and deleted on the next deliverability sweep.

### Fix direction (flagging only, not implemented)

Either (a) add the missing reason — an owed step for "a live ordinal is short of its requested
slots", which the derivation can compute from `domain_intents.inboxes_each` vs live mailbox
addresses, and let the family predicate cover it; or (b) narrow the re-derivation to what it can
actually prove: expire only a row whose `actionHint`/`dedupKey` domain has *no* shortfall of any
kind, rather than a tenant-wide boolean; or (c) keep the exclusion from `owedCount` but do not
bank `expires_at` (an unexpired row stays visible to the operator and to `list_messages`, so a
mistake is recoverable). (c) alone removes the destructive half.

---

## NON-BLOCKING

1. **N-B-1 — `seat_headroom_free` asserts "$0 / your bill is unchanged" in prose in exactly the
   case where it withholds the number that proved it.** The function's own docstring says
   *"`effect.projectedMonthlyCents` proves the $0 claim IN-PAYLOAD rather than asserting it in
   prose"* (`next-steps.ts:577-578`). On `unpriceable` the effect is `null` and the unconditional
   *"…N more mailboxes cost nothing — your bill is unchanged"* remains (`:616-624`), immediately
   followed by *"the platform will not project a mailbox count or a price for this call"* — two
   contradictory sentences in one string, to an unattended agent. The `$0` claim is also not
   pure floor arithmetic: with two ordinals and live mailboxes at slot indexes the target
   distribution does not reach, `fillDistribution` → `[3,2]` (`:286-301`) and `planFor`
   (`provisioning-plan.ts:176-196`) counts unmatched slots, so `provisionedAfter` can exceed the
   5-seat floor. Pre-existing in the priced case (where `effect` contradicts the prose); the fix
   removes the contradicting field but keeps the prose.
2. **N-B-2 — `GET /admin/ops/digest` now mutates tenant state.** `buildOpsDigest`
   (`admin/ops-sweep.ts:525-540`) calls `opsSummary` per tenant, which now expires messages. An
   operator's read-shaped inspection endpoint destroys the evidence it is being used to inspect —
   and round 1 used that exact endpoint as its read-only probe. Per-tenant failures are caught,
   so this is a property change rather than an outage.
3. **N-B-3 — `expireResolvedSystemMessages` has no chunk guard against the 100-bound-parameter
   ceiling.** It binds `2 + ids.length` (`tenant-messages.ts:415-421`); this repo's own note puts
   the SqlStorage ceiling at 100 (`admin/db.ts:102-104`), and the sibling written in the same
   commit caps deliberately at 32 (`engine/persona-backfill.ts:42-51`). Needs ~98 distinct unacked
   `retry_setup` rows (one per domain ever burned/replaced) to trip, so it is a hardening gap, not
   a live defect — but it would throw inside an unwrapped call in `readSendPipelineSignals`.
4. **N-B-4 — the liveness stamp does not fire on a call that fails argument validation.** It sits
   after the zod parse (`mcp/handler.ts:146-170`), so an agent hammering a real tool with one bad
   field for 24h still scores `agentStalled`. Same false-stall direction N-4 was raised for, much
   narrower. Also: every `readOnlyHint: true` tool now performs a write on the hosted MCP path.
   That is deliberate and the stub-level write-spy (`test/mcp-tool-annotations.test.ts:148+`) still
   passes, but the guard no longer covers the transport path where the write happens.
5. **N-B-5 — the nudge no longer requires a CONFIRMED alert.** The gate is now `!result.healthy &&
   nowMs - stallOnsetTs >= continuityNudgeDelayMs(env)` (`admin/watchtower.ts:743-747`), dropping the
   old `transition.action === "alerted"` conjunct and with it the `confirmAfterObservations`
   debounce. Inert at the 24h default; a short `CONTINUITY_NUDGE_DELAY_MS` would let an
   unconfirmed check message a customer.
6. **N-B-6 — the new `expires_at` predicate reads REAL wall-clock while every sibling reader uses
   `ctx.clock`.** `readNextStepsSnapshot` binds `realNow` (`next-steps.ts:214-227`);
   `listSurfacedTenantMessages` (`:273-286`), `listMessagesPage` (`:328-330`) and
   `emitTenantMessage`'s dedup (`:119-134`) all bind `ctx.clock.now()`. On a VirtualClock tenant
   (clock ahead of real) an operator-set future `expiresAt` is hidden from `messages[]` while still
   counted as owed by `nextSteps` — "owed" with nothing to show. Paid tenants are clock-migrated
   and `billedQuantity === 0` gates demos out, so I could not reach it; flagged as an inconsistency
   in a rule the fix's own comment states as universal ("EXPIRY IS PART OF 'UNREAD' EVERYWHERE ELSE").
7. **N-B-7 — the backfill's batch cap silently drops the overflow without counting it.**
   `if (recovered.length < PERSONA_BACKFILL_BATCH) recovered.push(...)` (`persona-backfill.ts:129`)
   neither writes nor increments `abstained` for rows past 32, so the log line under-reports. The
   comment argues the case is unreachable today (32 > the ordinal ceiling), which is correct.

---

## Attacks that FAILED — this is what makes B1 and J4 meaningful

- **The inversion writing a WRONG persona (the worst outcome available).** Bundled the real
  `personaSlugFromManagedAddress` + `recoverPersonaSlug` with esbuild and brute-forced every
  reachable coordinate: 13 persona shapes (including digit-trailing `acme1`, `x1`, `c1010`,
  `b110` — all valid `slugify` outputs) × ordinals 0–19 (`distribution` `.max(20)`) × 1–10 slots
  (`z.number().int().min(1).max(10)`, `packages/shared/src/intents.ts:116`) × 3 domain shapes =
  **7,800 full-fleet cases: 0 wrong, 0 abstentions.** Then every non-empty subset of a 10-slot
  domain (releases): **265,980 partial-fleet cases, 0 wrong**; 262,340 abstained and 3,640
  recovered correctly. The two-digit collision I went hunting for (`persona="x1"` slot 0 vs
  `persona="x"` slot 10 — both spell `x111@d`) is *detected* by the both-directions check when the
  slot is in range, and *unreachable* otherwise because `distribution` caps at 10. Held.
- **The round-trip accepting an address this platform never derived.** `sales@`, `info@`,
  `mordytee@`, `mordytee1@` all return `undefined`, and one foreign address on a domain forces the
  whole domain to abstain (`recoverPersonaSlug` returns `undefined` when any email inverts under no
  slot). Two personas on one domain abstain. Held.
- **`targetsLiveOrdinal` being a looser guard than the branch it protects.** It tests
  `intentsByOrdinal.get(ordinal)?.live` over `0..distribution.length-1`
  (`next-steps.ts:379-384`) — byte-for-byte the condition under which `planFor` constructs an
  address (`provisioning-plan.ts:181-195`). Past the guard, `planFor` provably never calls
  `managedMailboxAddress`, so the surviving `?? ""` is safe rather than lucky. Held.
- **`persona_slug = ''` slipping past the `=== null` abstention** and re-opening round-1
  BLOCKING-1 one value over. The only writer is `recordDomainIntent`'s `spec?.personaSlug`
  (`provision-intents.ts:97-107`), fed `slugify(input.persona)` (`provisioning.ts:620`), and
  `slugify` ends `|| "hello"` — the empty string is unwritable. Held.
- **Backfill ordering and tenant isolation.** `ensureColumnMigrations()` (`tenant-do.ts:208`)
  precedes it; `reconcileLegacyDomainIntents` (`:224`) precedes it, which is what puts a legacy row
  back on an ordinal key the inversion needs; the UPDATE carries `tenant_id = ?` and re-asserts
  `persona_slug IS NULL`; `3n+1 = 97 ≤ 100` bound params at the stated batch of 32; the DO is
  single-threaded so concurrent construction has no purchase; `candidate_domain` is rewritten to
  the *purchased* name on commit (`provision-intents.ts:381-388`), so the bucketing key matches the
  mailboxes. A burn-replacement (`replace:`) intent has no ordinal and is skipped, exactly as
  `readProvisioningSnapshot` skips it. Held.
- **J4 leaking the opt-in leg.** `reason` is a required constructor parameter on
  `RegistrarUnarmedError` (`packages/shared/src/errors.ts:121-135`), so no throw site can omit it;
  the `reason !== "env"` return is inside `alertRegistrarUnarmed` (`engine/registrar-alert.ts:24-39`)
  and all three call sites (`provisioning.ts:505`, `:754`, `deliverability-actions.ts:316`) go
  through it — the unbounded caller-rate page on `searchLookalikes` is dead. The body was rewritten
  to name the env leg specifically, so round-1's "on-call string describes the pre-fix world" is
  closed too. Held.
- **N-3 re-proved from scratch on the NEW mechanism** (round 1's exactly-once proof was about the
  retired realert-grid gating and I did not inherit it). `stateByName` is the pre-pass read and is
  never mutated in the loop (`watchtower.ts:657,673,720` — the only three references), so on a flip
  tick the abandoned name still carries the original `sinceTs`; `Math.min` adoption is persisted on
  the blamed name (`:722-725`), so a flip back reads the true onset from either side and converges.
  The lowered `sinceTs` cannot accelerate an email: `decideAlert`'s phase-2 backoff compares
  `nowMs - (episode.lastAlertTs ?? sinceTs)` (`watchtower-policy.ts:236`), and I checked the
  fallback is unreachable — `normalizeAlertState` only assigns `alertCount > 0` when
  `lastAlertTs !== null` (`:178-185`), and `withheldAlertState` copies both from the same previous
  state (`:286-293`). The mandatory cross-clear still pushes the abandoned name healthy in the same
  batch (`watchtower.ts:571-581`), so no stale-unhealthy sibling accumulates to poison a later
  episode. Held.
- **N-2 storm from firing every 5-minute tick.** `maybeEmitContinuityNudge` returns before the
  derivation once `continuity_nudge_episode_ts >= episodeSinceTs` (`engine/continuity-nudge.ts:50-56`),
  and adoption only ever lowers the passed value, so repeats are genuine no-ops. The one case that
  re-derives every tick is cry-wolf suppression (`:60`), which is bounded and deliberate. Held.
- **N-4 bookkeeping taking down the call it observes.** Both stamps are wrapped best-effort
  (`mcp/handler.ts:167-170`, `routes/infrastructure.ts:26-32`) — and the builder swept the class
  rather than the instance, catching the pre-existing bare `await` on the REST sibling. Held.
- **N-7 registrant divergence.** `selectSetupDomainPort` now derives from THIS call's contact
  fields with `readPersistedRegistrantJson` as the structured fallback (`tenant-do.ts:900-912`), and
  `runSetupInfrastructure` writes `brand/primary_domain/physical_address/sender_identity`
  unconditionally (`provisioning.ts:515-521`) before `assertCompleteRegistrant` reads the row — so
  "they cannot disagree" is now true by construction, in all four
  (registrant present/absent × registerDomains true/false) combinations. Held.
- **N-5 / N-1 / N-6.** `NEXT_STEP_TOOLS` is a runtime array with the type derived from it and G3
  iterates it (`packages/shared/src/next-steps.ts:61-70`, `test/next-steps-doc-lockstep.test.ts:56-68`)
  — an ADDED sixth member is now checked, which was the whole point.
  `PROGRESS_INTRODUCED_REASONS` is pinned by exact contents plus a subset assertion. The
  `schema.ts:98-108` comment now describes the post-relaxation world. Held.
- **Round-1 spot-check for un-holding.** `mcp/schemas.ts` is untouched by this diff, so the
  zod `.extend()` + `.superRefine()` result stands unchanged. `SELF_WRITTEN_MESSAGE_KINDS` is still
  applied at the site where `owedCount` is sourced (`next-steps.ts:229-231`), immediately after the
  rewritten SELECT — the new `expires_at` clause did not displace it. MCP tool count is unchanged
  (`mcp/tools.ts` edits are handler-body only). Held.

---

## UNVERIFIABLE

1. **Live re-probe of `ten_91aab24a`.** A read-only `GET /admin/ops/digest` against
   `api.coldrig.dev` was blocked by this session's permission classifier, so I could not
   re-derive his current row values myself; the reachability paragraph above uses round 1's
   recorded state as its premise. Resolved by: an operator running the digest /
   `/admin/tenants/<id>/messages` reads and pasting the output. Note the reachability of the
   BLOCKING finding does not depend on it — it is proven in the repo's own harness.
2. **Whether the slot-level partial has ever occurred in production.** No admin surface
   enumerates `MAILBOX_SLOT_FAILED` action rows across tenants. Resolved by: a
   `recentActions` read for `MAILBOX_SLOT_FAILED` on the live tenant.
3. **Behaviour of the new per-tick nudge RPC at scale.** §7.17.7's subrequest bound is now
   reached whenever N tenants are stalled rather than only on a correlated onset (the builder
   states this). Unmeasurable at n=1. Resolved by: a load estimate once the tenant count is
   above the per-tick subrequest budget.
4. **`expires_at` divergence on a VirtualClock tenant (N-B-6).** I could not construct a paid
   virtual-clock tenant that passes the `billedQuantity === 0` gate. Resolved by: a fixture that
   activates a paid plan without migrating the clock.

---

## NEW (out of scope, no verdict weight)

- `seat_headroom_free`'s "$0" prose is unconditional even in the PRICED case, where `effect`
  can simultaneously report `provisionedAfter > 5`. Pre-existing at `887ab25`; listed as
  N-B-1 only for the half this fix round changed.
- The `NEXT_STEP_REASONS` union has no member for "a live ordinal is short of its requested
  slots", which is the root of the BLOCKING finding. Adding it would also let
  `paid_seats_unprovisioned`'s `billable === 0` cliff and `billed_quantity_drift`'s
  `billable >= 5` cliff stop leaving the 1..4 band uncovered for anything but headroom.
- `personaSlugFromManagedAddress` preserves case, so an uppercase address would recover a
  non-slug persona that `planFor`'s `slugify` would then fail to match. Unreachable today —
  every writer goes through `managedMailboxAddress(slugify(...))` — but the round trip is the
  one place the "slug" invariant is not enforced.
