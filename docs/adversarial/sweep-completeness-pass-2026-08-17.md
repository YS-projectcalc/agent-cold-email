# Adversarial COMPLETENESS pass over the six class sweeps — 2026-08-17

Fresh-context attack on the **completeness** of the class-sweep program, not a re-run of the
sweeps. Three axes per the brief: missed members, missing classes one layer up, cross-sweep
consistency. Plus spot-execution of the load-bearing IN members.

**Verdict: `COMPLETENESS: GAPS-FOUND`.**

---

## Grounding (re-grounded mid-pass — HEAD MOVED)

| Item | Value |
|---|---|
| Ref at pass start | `81cc3e1ec87292843fe32eb946c7a4b0d9c36f5a` (the commit that added the six sweeps) |
| Ref at pass close | **`018dc653285507895bb357141d951aa7a9e885d4`** — six commits landed under me |
| Sweeps' own ref | `9d3ec7e`; `git diff 9d3ec7e 81cc3e1 -- apps/platform/src apps/platform/migrations apps/engine/src packages site` is **empty**, so every line number in the six inventories is valid |
| Re-verified at close | `git rev-parse HEAD:<path>` vs `git hash-object <path>` for all 9 finding-bearing files — **all match**; only untracked agent-memory dirs dirty |
| Regression ring | `018dc65` merged the operator read endpoints and touched `engine/tenant-messages.ts` (+73). Diff is **purely additive** (`listMessagesForOperator`); it does **not** touch `emitTenantMessage`'s re-stamp, `listSurfacedTenantMessages`' `LIMIT 5`, or `listMessagesPage`'s cursor. dedup IN-3/4/5 neither closed nor reopened. |
| In-flight trains | `feat/channel-truth-2026-08-17` = **empty** vs main. `feat/loop-isolation-2026-08-17` = 1 commit (`915064c`) rewriting `provisioning.ts` (+165/-56). Verified it does **not** close the `quoteOnly` finding: `:430` still returns `{quoteOnly:true,…}` inside the wrapped fn, and `idempotency.ts` / `tenant-do.ts` are untouched on that branch. |
| Mode | READ-ONLY git. Probes ran in a throwaway clone at `scratchpad/completeness-clone`. No edit outside this file. |

---

## 1. Spot-executions of load-bearing IN members

Four run (brief asked for three). Every assertion written as the CORRECT behaviour, so each
fails as the finding today and passes unmodified as a closure gate. Control arms included —
without them an emission/roll-up probe cannot distinguish a finding from a blind probe.

### SPOT-1 — dedup IN-8 + IN-9 (intermittent conditions never alert) · **CONFIRMED, and understated**

Real `gradeStreak` / `decideAlert` (both are import-free pure modules), esbuild-bundled and
run in node. `probes/spot1-flap.mjs`.

```
IN-8  gradeStreak, alternating bad/good x24 ticks (2h)
      grades: [null x24]                          -> never graded unhealthy, cron_legs never fires
IN-8b gradeStreak, 67% duty cycle (bad,bad,good) x8
      grades: [null x24]                          -> STILL never fires
CTRL  gradeStreak, 6 consecutive bad
      grades: [null,null,false,false,false,false] -> control HOLDS (probe is not blind)

IN-9  decideAlert DEBOUNCED, alternating x24 (2h)
      actions: [pending,healthy] x12              -> zero emails in 2h
CTRL  decideAlert DEBOUNCED, 6 consecutive bad
      actions: [pending,alerted,suppressed,...]   -> control HOLDS
```

**Severity amplification the sweep missed.** dedup IN-8 describes the failure as "errors every
*other* tick". It is worse: `LEG_ALERT_AFTER_SWEEPS = 3` requires **3 consecutive** and
`gradeStreak` zeroes `unhealthy` on *any* good tick (`admin/watchtower-grading.ts:100-112`), so
a leg failing **67% of every tick forever** is equally silent. The alert threshold is not a
failure *rate* at all — it is a run-length, and no failure rate below 100% sustained can reach it.

### SPOT-2 — MISSED MEMBERS, real `collectLegSignals` · **4 reproduced, 2 controls held**

`admin/sweep-signals.ts` esbuild-bundled (`--external:cloudflare:*`); fixtures copied verbatim
from the real return types. `probes/spot2-legcounters.mjs`.

```
CTRL sendPipeline.errors=3          -> counted=3  observedUnhealthy=true    HELD
CTRL webhooks leg threw (null)      -> legsThrew=[webhooks] unhealthy=true  HELD
A1   watchtower=[3 outcomes, ALL emailSent:false]  -> counted=0  unhealthy=FALSE
A2   sdnRefresh={reason:'failed',error:'HTTP 503'} -> counted=0  unhealthy=FALSE
A3   dead ops-mail tick + failed SDN + watchdogAlerts[2] -> counted=0  unhealthy=FALSE
A4   new leg {failed:7, failures:7, failureCount:7} -> counted=0  unhealthy=FALSE
```

### SPOT-3 — cached-terminal member 2 (`quoteOnly` consumes the key) · **CONFIRMED**

Real HTTP facade through the workers pool, `test/zz-completeness-spot3.test.ts`.

```
QUOTE  : 200 {"quoteOnly":true,"billing":{...9900...}}
COMMIT : 200 {"quoteOnly":true,"billing":{...9900...}}   <- the preview REPLAYED
DOMAINS: 0   MAILBOXES: 0                                <- nothing provisioned
IDEM   : [{"key":"setup_infrastructure:setup-k1","status":"done",
           "response_json":"{\"quoteOnly\":true,...}"}]
CONTROL (no preview, same key): 202, 1 domain, 2 mailboxes  -> PASSED
```

The cached-terminal sweep's ranking is correct: this outranks its own confirmed member on
reachability. It needs **no vendor failure, no DNS stall, no crash** — it fires on the two-call
flow `mcp/tools.ts:74` explicitly instructs, against sandbox adapters, on the happy path.
Still open on `feat/loop-isolation-2026-08-17` (verified above).

### SPOT-4 — two open items settled in **workerd** · `test/zz-completeness-spot4.test.ts`

```
(a) EMPTY PEPPER signUnsubscribeToken -> THREW DataError:
      "Imported HMAC key length (0) must be a non-zero value..."
    String(undefined) pepper -> resolves fine (no throw)

(b) DEFAULTED ROW (INSERT omitting status): {"status":"done","response_json":null}
    PAST-WINDOW CALL  -> ran=1, row after {"status":"done","response_json":"{...}"}  <- HEALED
    SECOND CALL       -> ran=1 (replays correctly)
    FRESH done+NULL   -> ran=0, threw RequestInProgressError
```

---

## 2. Missed members, per class

### watch-completeness — 5 missed (3 executed)

| # | Site | Scenario |
|---|---|---|
| **W-M1** | `apps/platform/src/admin/sweep-signals.ts:31` (`LEG_COUNTERS`) × `admin/watchtower-alerts.ts:35-39` (`AlertOutcome.emailSent`) | **The intersection the brief predicted: a claim about an alert that is itself recorded-as-delivered.** `runWatchtower` returns `AlertOutcome[]`, and each outcome carries `emailSent: boolean` — the information **exists**. `counterOf` reads only `errors\|budgetExpiries\|skippedForLegDeadline` as NUMBERS, and an array has none. **Scenario:** `OPS_ALERT_EMAIL` is unset or the mailer 5xxs; every alert this tick fails; `trySend` returns `false` (`watchtower-alerts.ts:222-230`); cached-terminal member 5 advances `last_alert_ts` anyway so the state machine believes it announced; and `cron_legs` emits *"Every ops-sweep leg completed with zero errors on consecutive ticks."* The founder is told the monitor is healthy on the exact tick the monitor could not reach them. **Verified:** SPOT-2 A1, controls held. |
| **W-M2** | `apps/platform/src/ofac/sdn-refresh.ts:24-29,65-70` | `maybeRefreshSdnList` deliberately never throws; its failure is `{reason:"failed", error:<string>}`. A string is not a counter ⇒ `counted=0`, `legsThrew=[]`. The OFAC list can fail to refresh forever with `cron_legs` clean. **Mitigated** — `reconcileSdnAlert` is a dedicated channel that emails on the first failure of a streak — so NON-BLOCKING, but it disproves the roll-up's stated coverage. **Verified:** SPOT-2 A2. |
| **W-M3** | `apps/platform/src/admin/sweep-signals.ts:49-52` (docblock) | *"a NEW leg is covered the moment it is added to that object — there is no per-leg list to keep in sync."* **False.** Coverage requires the leg to name its counter exactly `errors\|budgetExpiries\|skippedForLegDeadline` AND return `null` on throw. This is simultaneously a watch-completeness (a) member (a hardcoded field-NAME allowlist) and a **claim-drift** member in a surface neither sweep scans (a code comment asserting a contract). **Verified:** SPOT-2 A4 (a new leg reporting 7 failures under three plausible names reads clean). |
| **W-M4** | `apps/platform/src/scheduled.ts:118` vs `:125` | The `legs` bag is constructed at `:118`; `reportSweepSignals` is invoked at `:125` wrapped in its own `runLeg("sweepSignals", null, …)` and is **not in the bag it reports on**. **Scenario:** `reportSweepSignals` throws every tick (its first act is a `watchtowerStub(env).gradeSweepStreak` RPC). The throw is logged and swallowed. Nothing reports it — the alerting leg cannot alert on its own failure. `heartbeat` runs afterwards at `:131` and still writes, so `cron_sweep`'s dead-man reads **healthy**. Total, permanent, silent loss of every leg signal with every monitor green. Exactly the class invariant: *absence is indistinguishable from health*. |
| **W-M5** | `apps/dashboard/src/api/types.ts:164-169` | **Cross-boundary.** The client `InfrastructureStatus` is `{domains, mailboxes, mailboxHealth, sendReady}` — it **omits `messages`**. Repo-wide grep: zero `.messages` consumers in `apps/dashboard` outside `inbox/ThreadDetailPane.tsx` (thread messages, unrelated). **Scenario:** audit F8 says the customer's agent is a session process that is not running when an operator reply lands. The dashboard is the human fallback — and it structurally cannot render an operator message. That is the other half of why the 2026-08-14 reply sat unread for three days, and no sweep covers it because five of six were platform-centric and claim-drift was scoped to `SetupPage.tsx`. |

### claim-drift — 3 missed (all cross-boundary)

| # | Site | Scenario |
|---|---|---|
| **C-M1** | `apps/dashboard/src/api/types.ts` (whole file) | The sweep enumerated *"eight or more independent, hand-written copies"* of the contract. This is a **ninth**, and it is the only one that is **machine-consumed** — the dashboard *compiles* against it. Its own header says *"Keep in sync by hand."* Mechanically diffing all 18 mirrored interfaces against `apps/platform/src/engine/*.ts` found **2 with live field drift** (below); 12 are clean, 4 have no same-named server interface. The sweep's G1 guard maps `toolName → [platformSourceFile, interfaceName]` and would not see this file at all. |
| **C-M2** | `apps/dashboard/src/api/types.ts:149-152` | `MailboxHealthReport` mirrors `vendorReputationScore` + `vendorPlacementRate` but **omits `vendorHealth` and `vendorHealthError`** — the very discriminator that says whether those two numbers mean anything (`engine/infrastructure-status.ts:47-51`: `vendorHealth:'unknown'` ⇒ both are `0`). The comment claims the fields are *"kept typed for parity with the API shape"*; parity is exactly what is missing. Zero `vendorHealth` occurrences anywhere in `apps/dashboard`. This is claim-drift **and** signal-inversion (a degraded read renders identically to a measured one). |
| **C-M3** | `apps/platform/src/tenant-do.ts:575` | `clock_multiplier = 1440` for demo/free is stored, selected, and passed into `VirtualClock` — and **never applied**. `VirtualClock.now()` is `baseMs + offsetMs` (`clock.ts`); the multiplier is used only by `advance(realMs)`, and `grep -rn "\.advance("` across `apps/` + `packages/` returns **zero call sites**. Every real advance goes through `advanceVirtual()`, whose docstring says it *"bypasses the multiplier"*. Dead config that reads as a live rate — and two sweeps reasoned from it as if live (see §4 ruling). |

### hol-blocking — 3 of 5 UNCERTAINs settled

| # | Ruling | Evidence |
|---|---|---|
| **U1** | **IN** | Executed in workerd (SPOT-4a): an **empty-string** `TOKEN_HASH_PEPPER` throws `DataError` at `importKey`. Decisive asymmetry the sweep could not check: `auth.ts:27-31` `hashApiToken` uses `crypto.subtle.digest` with **no key**, so authentication, login, token rotation and dashboard sessions all keep working — while `engine/tick.ts:83`'s `signUnsubscribeToken` throws inside the due-send loop past the atomic claim, aborting every remaining row with no per-row grading, no `'failed'` event, no alert. **Silent total send stoppage behind a fully healthy-looking auth surface.** No boot-time non-empty validation exists (`env.ts:19` only types it). An *unset* var coerces to `"undefined"` and does NOT throw, so only the empty-string case fires — low reachability, one-line fix. |
| **U2** | **OUT** | Both writers of `event_types_json` are `JSON.stringify(dedupe(input.eventTypes))` of a zod-validated array (`engine/webhooks.ts:193`, `:229`); no `.sql` migration writes the column; the table is DO-side so no D1 migration reaches it. It cannot be malformed on main. |
| **U4** | **OUT** | Follows from U2 by the sweep's own stated rule (*"U2's answer; if `event_types_json` cannot be malformed, U4 is OUT"*). |
| U3, U5 | **still open** | Not reached — `apps/engine/src/json-store.ts`'s append path (U3) and the U5 drain-time arithmetic. U3 stays the higher-value of the two (engine boot crash loop). |

### cached-terminal — 1 severity CORRECTION, 1 caveat closed

- **Member 10 is real but its "unrecoverable" characterization is REFUTED.** SPOT-4b: the
  `DEFAULT 'done'` door is confirmed open (an INSERT omitting `status` lands
  `{"status":"done","response_json":null}`). But the success path at `idempotency.ts:113-120`
  has **no `AND status='pending'` guard**, so the first past-window call runs `fn` and **heals
  the row**; the next call replays correctly. Inside the 10-minute window it throws
  `RequestInProgressError` (retryable). Real defect = **a 10-minute spurious 409 plus the lost
  "exactly one retry proceeds" serialization** (`:88-96`), not a stuck data state.
  **Remediation impact:** scope it as `DEFAULT 'pending'` + the `CHECK` constraint only. A
  fixer told "unrecoverable" would also build a repair/backfill path that nothing needs.
- **`spikes/` and `tools/` — CLOSED, zero members.** Four sweeps carry this as an open caveat.
  `spikes/` is a single local GreenMail contract script (`a5-engine-imap/validate.mjs`)
  explicitly *"outside the workspace globs"* and touching no production code; `tools/` holds
  only shell scripts (`push-sdn.sh`, `submit.sh`) and the panels. No replay, marker, loop or
  claim surface in either.

### dedup-semantics — 1 amplification, 1 premise refuted

- **IN-8 understated** — see SPOT-1: any duty cycle below 100% sustained is silent, not just
  alternating.
- **U-4's premise is false** — see C-M3 and §4 ruling (iii).

---

## 3. What class the six are members of

All six sweeps independently proposed **the same remedy shape**, which is the tell:

| Sweep | Proposed guard |
|---|---|
| cached-terminal | `Settled<T> = {terminal: boolean; value: T}` |
| dedup-semantics | `Collapsed<T> = T & {deduplicated: boolean}` |
| signal-inversion | `{delivered: boolean; why: …}` and `basis: "reobserved" \| "no_longer_applicable"` |
| watch-completeness | *"a monitoring read must publish the denominator it was drawn from"* |
| hol-blocking | `forEachIsolated(items, fn, {onItemError, quarantine})` — a mandatory per-item outcome |
| claim-drift | bind the prose to the type — derive the contract instead of copying it |

> **PARENT CLASS — the outcome does not carry its own provenance.** A result states *what*
> happened but not *how well it is known*: whether it is terminal, whether it was delivered,
> whether it is complete, whether it was collapsed, whether it was observed or merely inferred,
> whether it is one item's fate or the batch's. Because the qualifier has no field, no caller
> can branch on it — so every consumer takes the optimistic reading, and does.

**Ruling: REAL, but it does NOT need its own sweep — it needs to be the acceptance criterion
across trains 1-5.** Five trains are each about to add a different wrapper to overlapping result
types. `withRequestIdempotency` alone is in scope for `Settled<T>` (train 1) *and* `Collapsed<T>`
(train 4). Land them independently and the second train rebases onto a signature the first
changed, or you get `Collapsed<Settled<T>>`. One shared vocabulary in `packages/shared`,
declared before train 1 merges, is the cheap version.

---

## 4. Rulings on the three candidate classes

### (i) "accidental invariants" — **REAL, worth its own sweep. Not in any train today.**

> **Definition.** A correctness property that holds today only because of an unrelated
> implementation coincidence — no CHECK constraint, no type, no test, no comment pins it — so a
> future edit to the *unrelated* code silently breaks it, and the sweep that examined the site
> correctly recorded it as OUT.

Four confirmed members, already sitting in the sweeps' own OUT/UNCERTAIN columns:

1. `admin/db.ts:179-192` + `migrations/0002_admin_ops.sql:44` — `dunning_events UNIQUE(tenant_id, cycle)` omits `action`; unreachable **only** because `decideDunningAction` happens to depend on `(cycle, declineCode)` and `last_decline_code` is written at exactly one site (dunning U-3).
2. `admin/db.ts:155-171` — the support digest's two-status allowlist is complete **only** because `'closed'` exists in the TS union with **zero writers** (watch-completeness leg 1).
3. `schema.ts:481-486` — `request_idempotency.status DEFAULT 'done'` is unreachable **only** because all three current writers set `status` explicitly (cached-terminal member 10; the door is confirmed open by SPOT-4b).
4. `schema.ts:57` — `screening_status DEFAULT 'clear'` is safe **only** because all three writers of `billing_state='active'` happen to screen first (cached-terminal OUT).

**Why it earns a sweep:** it inverts where you look. An inventory's **OUT column** is normally
treated as closed; this class says the OUT column is where the next incident lives. Its guard is
also unusually cheap and uniform: every "unreachable today" ruling must either be made
structurally impossible (a `CHECK`, a narrowed union, a non-optional field) or pinned by a test
that reds when the coincidence breaks. Members 2 and 3 are one migration line each.

### (ii) sub-threshold-persistent-conditions (dedup U-2) — **FOLD into dedup sub-mechanism C, and WIDEN C.**

Not a separate wave: TRAIN 4 already owns `gradeStreak`/`decideAlert`, and `gradeFailureSignals`
(`admin/watchtower-grading.ts:76-80`) is 30 lines away in the same file. But **C's current
wording would miss it.** C says *"consecutive-observation or cooldown semantics that DELETE
rather than delay"*; `gradeFailureSignals` is a **threshold**, not a consecutive-observation
rule — it returns `null` (HOLD) for any count in `1 .. threshold-1`, and the caller reports
nothing. Widen C to:

> **any grader whose no-signal state is reported identically to healthy** — whether the gate is a
> run-length (`gradeStreak`), a consecutive-observation count (`decideAlert`), or a threshold over
> a window (`gradeFailureSignals`).

Confirmed members: `gradeFailureSignals` (2 failed sends/hour forever, ≈48/day, never alerts) and
the executed SPOT-1 result (67% duty cycle, never alerts). Recommend **un-deferring from [IDEA]
and adding one line to TRAIN 4's scope** rather than opening a sixth class.

### (iii) mixed time-bases under windows (dedup U-4) — **DISMISS AS STATED. Premise refuted.**

U-4 asserts *"these windows are measured on `ctx.clock`, which for demo/free tenants is a
`VirtualClock` at up to 1440× … the 30-day idempotency TTL therefore expires in ~30 real minutes
for those tenants."* **The 1440× rate does not exist.**

- `VirtualClock.now()` returns `baseMs + offsetMs` — it does not track wall time at all.
- `clock_multiplier` is applied **only** by `advance(realMs)`.
- `grep -rn "\.advance("` across `apps/` and `packages/` (excluding `node_modules`) returns
  **zero call sites**.
- Every real advance is `advanceVirtual(virtualMs)`, whose own docstring says it *"bypasses the
  multiplier"* — called from `tenant-do.ts:1373` (`advanceClock`, plan-gated to demo/free) and
  `engine/demo.ts:36`.

So a demo tenant's clock is **frozen**, moving only in discrete jumps. watch-completeness
UNCERTAIN-1's framing ("a frozen clock makes these windows silently empty or silently permanent")
is the correct one; dedup U-4's is not. **Two sweeps built an UNCERTAIN on a mechanism that is
not implemented** — a wave that "removes the 1440× multiplier" would fix nothing.

What survives, and it is small: `engine/demo.ts:113,150` jumps the clock **+29 days then +3 days**
inside one demo run, which does cross the 30-day `REQUEST_IDEMPOTENCY_TTL_MS` and
`sent_message_keys` windows — a discrete event on demo tenants only, not a rate. **Recommend:
replace the deferred [IDEA] class with one [ORDER] line — delete the dead `clock_multiplier`
config (C-M3) or apply it — and fold the demo-jump note into TRAIN 4.**

---

## 5. Cross-sweep consistency — which framing stands

Ten overlaps. "Stands" = the framing a fixer should build from.

| # | Site | Conflict | **Ruling** |
|---|---|---|---|
| **1** | `engine/tenant-messages.ts:77-101` (re-stamp), `:194-209` (LIMIT 5), `:248-282` (cursor) | cached-terminal ruled `emitTenantMessage` **OUT** and handed F9 to "the sibling monitoring-completeness sweep"; watch-completeness picked up only the **cap** (`infrastructure-status.ts:175`); dedup owns all three (IN-3/4/5) | **dedup-semantics stands.** The handoff leaked: nobody but dedup owns IN-3 (the `created_at` re-stamp) or IN-5 (the keyset-cursor page skip). A fix built from watch-completeness's cap-only framing — add `hasMore`/`total` — leaves both open. Note `018dc65`'s new `listMessagesForOperator` **already ships the correct `total` shape**; copy it, don't invent it. |
| **2** | `engine/idempotency.ts:78-81` | cached-terminal member 1 (its confirmed member) vs dedup IN-13 (self-flagged as overlapping) | **cached-terminal owns it**; dedup already deferred. **But the two GUARDS collide**: `Settled<T>` (train 1) and `Collapsed<T>` (train 4) both wrap this function's result. Declare the shared vocabulary first (§3). |
| **3** | `engine/contact-operator-guard.ts:126` | dedup IN-1+IN-2 vs cached-terminal member 9 (spelling (c)) | **dedup stands** — the defect is the coarse key plus the undisclosed collapse, which is dedup's exact mechanism. cached-terminal member 9 is the same site renamed; do not scope it twice. (signal-inversion's `:143` OUT is a *different line*, no conflict.) |
| **4** | `admin/watchtower.ts:285`, `:307`, `:322` | cached-terminal members 6/7/8 vs signal-inversion arm B — both IN, different guards | **signal-inversion stands.** Its `CheckResult` union with `basis: "reobserved" \| "no_longer_applicable"` is strictly stronger: it makes `recoveryEmail` **ignore the producer's prose**, so a false cause cannot reach the founder even if someone writes one. cached-terminal's "re-assert the condition" is the same three sites, weaker. One wave. |
| **5** | `admin/sweep-signals.ts:126` (`warmup_cancel_gave_up`) | signal-inversion arm B IN (the *clear* is false) vs dedup IN-12 (the *escalation* 1→12 is suppressed) | **BOTH STAND — they are different defects at one site, not duplicates.** Fixing the self-clear does not surface the escalation, and vice versa. Flagged explicitly because a fixer reading one inventory will believe the site is closed. |
| **6** | `admin/watchtower-alerts.ts` `policyFor` + the four per-entity checks | signal-inversion **OUT**: *"All four un-exempted per-entity checks are re-observed every 5-min sweep by `scanTenants` … No check is one-shot-and-debounced today"* vs dedup IN-9 | **dedup IN-9 stands; signal-inversion's OUT is REOPENED.** Its reasoning tests "is it re-observed?" — but the requirement is "is it re-observed **consecutively**?", and `decideAlert` zeroes `unhealthyObs` on any healthy tick. **Executed:** SPOT-1, 24 flapping ticks → zero emails, control held. `send_starved:` (`dueNonDemoPendingSends > 0 && eligibleMailboxes === 0`) flaps *naturally* as the due queue drains and refills, so this is not a contrived pattern. |
| **7** | `engine/provisioning.ts:640-690` + `engine/retry-setup-message.ts` | **FOUR sweeps, four distinct defects**: signal-inversion (terminal branch emits nothing), dedup IN-6 (both emits share a `dedupKey`, so `action_required` is overwritten in place by the later `info`), claim-drift + cached-terminal member 11 (the body's "same idempotency key" is false after the 202) | **All four are real and distinct — and must be ONE edit.** This is the highest-collision region in the program: ~50 lines carrying scope from trains 1, 3 and 4 **plus** the already-landed train-2 rewrite (`915064c`, +165/-56 in this file). Sequencing, not correctness, is the risk. |
| **8** | `mcp/tools.ts:86` | claim-drift IN vs dedup IN-19 — same site, same defect | **claim-drift stands** (it owns the claim-surface guard G2/G3). |
| **9** | `mcp/tools.ts:74` | claim-drift IN (F4), cached-terminal member 12, hol-blocking IN-CLAIM | **Three sweeps, and hol-blocking's is a *different sentence* in the same description.** `tools.ts:74` carries ≥3 false claims (no per-domain `dns` field; fabricated async `jobId`; shortfall-resumption). Assign to claim-drift (train 3), but the shortfall sentence **cannot be corrected until HOL IN-1 lands** — a real train-3-after-train-2 dependency. |
| **10** | `engine/provisioning-reconcile.ts` (audit F5, DARK) | hol-blocking ("mitigates nothing today") vs cached-terminal §5 item 3 (arming it bypasses the replay) | **Both agree; state it so the arming decision is not mis-sold as a fix.** Arming `PROVISIONING_RECONCILE_ENABLED` does **not** substitute for cached-terminal member 1 — it never reaches members 2 (`quoteOnly`) or 3 (capacity-pending), which the reconcile lane cannot see — and it does not unblock HOL IN-1. It also carries real spend and is founder-gated. |
| **11** | time base | dedup U-4 ("1440× ⇒ windows too narrow") vs watch-completeness UNCERTAIN-1 ("frozen clock ⇒ windows empty or permanent") | **watch-completeness stands.** dedup U-4's mechanism is refuted (§4 iii). |

---

## 6. Attacks that FAILED (why this list is not longer)

| Attack | Why it held |
|---|---|
| `apps/dashboard` `HEADER_CHIP` (`BillingPage.tsx:15-23`) renders an enum allowlist — a new `ActivationSurfaceState` should fall through to `undefined` | Held. It is `Record<ActivationSurfaceState, …>`, so omission is a **compile error**; and I diffed the union both sides — 7 members each, byte-identical. Type-defended. |
| The dashboard's hand-mirrored DTOs should be riddled with drift | Mostly held — 12 of 18 mirrored interfaces are field-identical (`AccountSummary` 16/16, `InboxRow` 13/13, `EventCounts`, `ActivityItem/Page`, `DeliverabilitySummary`, `DashboardViewSummary`). Only 2 drifted. The mechanism is real; the current damage is bounded to C-M2 and W-M5. |
| `spikes/` / `tools/` hide a replay or marker (4 sweeps' open caveat) | Held — no first-party TS in either; `spikes/` is one local GreenMail script outside the workspace globs. |
| `event_types_json` can be malformed (hol U2) ⇒ webhook fan-out aborts forever | Held — both writers `JSON.stringify` a zod-validated deduped array; no migration touches the column; DO-side table. U2 and U4 → OUT. |
| An *unset* `TOKEN_HASH_PEPPER` breaks sends | Held — `String(undefined)` encodes to 9 bytes and `importKey` accepts it (verified in workerd). Only the empty-string case throws. |
| `request_idempotency` `done`+NULL is an unrecoverable stuck state (cached-terminal member 10) | **Refuted** — the success `UPDATE` has no status guard and heals the row; verified in workerd. Severity corrected, not dropped. |
| The `heartbeat` leg's `undefined` fallback (vs every other leg's `null`) is a hole in `collectLegSignals`' `leg === null` check | Held — `heartbeat` is invoked at `scheduled.ts:131`, *after* the bag is built at `:118`, so it is not in the bag at all; and a failed heartbeat fails **loud** (stale `cron_sweep` → the DO dead-man alarm). The genuine hole one line up is `sweepSignals` (W-M4). |
| `018dc65` (operator read endpoints, landed mid-pass) reopened or closed a dedup member | Held — purely additive; `emitTenantMessage`, `listSurfacedTenantMessages` and `listMessagesPage` are untouched. |
| `feat/loop-isolation-2026-08-17` already closes SPOT-3 | Held — `:430` still returns `{quoteOnly:true,…}` inside the wrapped fn; `idempotency.ts` and `tenant-do.ts` untouched on that branch. |

---

## 7. UNVERIFIABLE

1. **dedup IN-9's live reachability per check name.** I proved the state machine never alerts on a
   flap; I did not prove that `d1` / `do_storage` / `engine` actually flap in production. Resolution:
   `GET /admin/ops/checks` sampled across ticks, or a `watchtower_state` read.
2. **hol U3 / U5** — not reached (`apps/engine/src/json-store.ts` append semantics; the U5 drain
   arithmetic). U3 remains the higher-value one (engine boot crash loop).
3. **Member 10's concurrency arm.** SPOT-4b ran sequentially (`ran = 1`). The lost-serialization
   mechanism is visible in source (`:97`'s reclaim `UPDATE … AND status='pending'` no-ops on a
   `done` row, so `created_at` is never re-stamped) but N-concurrent-callers was not executed.
   Resolution: a workerd probe issuing overlapping RPCs against one stale `done`+NULL key.
4. **Deployed-vs-in-tree `site/`** (claim-drift §5 item 6) — unresolved; I read the pinned ref only.

---

## 8. NEW (out-of-scope) observations — no verdict weight

- **Trains 1 and 2 are both `[building]` and collide in one function.** `feat/loop-isolation`
  has already landed +165/-56 in `engine/provisioning.ts`; `feat/channel-truth` is still empty
  and is scoped to cached-terminal members 1-3 and signal-inversion F3 — the `quoteOnly` return,
  the `CapacityPendingError` return, the 202 return, and the `retryable` gate, all inside the
  same `try`/`catch` train 2 just rewrote. Train 1 will rebase onto a moved floor.
- **`018dc65` shipped the watch-completeness guard's correct shape on the new surface only.**
  `listMessagesForOperator` publishes `total` over "the SAME filter the returned page used". The
  two agent-facing surfaces in the same file still publish neither `total` nor `hasMore`. The
  in-file template now exists — TRAIN 5 should cite it rather than design one.
- **`OpsDigest.watchdogAlerts: string[]`** is a failure signal that `collectLegSignals` cannot
  count (not a number). Same root as W-M1/W-M3; listed for the fix's field inventory.
