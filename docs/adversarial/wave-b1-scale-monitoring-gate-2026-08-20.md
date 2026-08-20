# Wave B.1 — scale + monitoring combined adversary gate (2026-08-20)

**Target** worktree `.claude/worktrees/integrate-waveb`, branch `integrate/wave-b1-2026-08-20`.
**Ground ref** `git rev-parse HEAD` = **`7241a57`**, working tree CLEAN (`git status --porcelain` empty).
Review diff `c98694f..7241a57` — 61 files, +4640/−445. Git read-only throughout; every probe ran in an
rsync sandbox with `node_modules` symlinked.

## VERDICT: **FAIL** — 1 BLOCKING, 9 NON-BLOCKING.

The one blocking item is a hole in the wave's **own load-bearing arithmetic**, on the exact mechanism
the wave exists to protect (dead-man reachability). It was created by the two lanes not reconciling:
lane 1 sized the per-tick subrequest budget assuming the screening-recovery leg is small, lane 2 capped
that leg at 500 tenants. The remedy is a constant plus a deadline, not a redesign.

---

## Battery — re-run by me, in the sandbox, real exit codes

| suite | result | exit |
|---|---|---|
| `npm run typecheck` (root) | clean | **0** |
| `apps/platform` vitest | **232 files / 2242 passed / 1 skipped** | **0** |
| `apps/engine` vitest | 18 files (2 skipped) / 153 passed / 4 skipped | **0** |
| `apps/dashboard` vitest | 31 files / 165 passed | **0** |
| `packages/cli` (`npm test -w`) | 12 pass / 0 fail | **0** |

Genuinely green, and — for the sixth consecutive gate on this project — it told me nothing. Every
finding below came from running the real functions or from re-deriving an arithmetic claim.

---

## BLOCKING

### B1 · The `sdnRecovery` leg can spend the entire invocation budget AHEAD of the dead-man heartbeat, and the budget file's own accounting assumes it cannot

**Mechanism.** `admin/sweep-budget.ts:93` sets `SWEEP_FIXED_SUBREQUESTS = 60` and its docstring
enumerates what that 60 covers, explicitly including *"the screening-recovery leg (bounded by the
pending-review queue, not by tenant count)"*. The whole slice is derived from it:

```
slice   = floor((1000 × 0.6 − 60) / 11)      = 49
tick    = 11 × 49 + 60                        = 599 subrequests
reserve = 1000 − 600                          = 400   ("the trailing heartbeat, and the next O(N) leg")
```

Lane 2 then set `ofac/screening-recovery.ts:22` `RECOVERY_BATCH_LIMIT = 500`, and the leg is a bare
`for` loop over up to 500 sentinel-held tenants (`screening-recovery.ts:53-76`) with **no fan-out
deadline, no `sweepTenants`, and no `SweepScope`**. Each iteration costs the Worker two subrequests:
the `stub.rescreenIfListUnavailable()` DO RPC (`:59`) and — on `status === "clear"`, which its own
comment calls *"the common case"* — the `resolveScreeningReview` D1 write (`:70`).

```
worst case: 599 (full slice) + 500 × 2 = 1,599   against the 1,000 the file is sized against
break-even: (1000 − 599) / 2 ≈ 200 stuck tenants — RECOVERY_BATCH_LIMIT is 2.5× over it
```

**Failure scenario.** An OFAC feed outage (or a fresh environment) spanning a signup burst leaves N
tenants screened fail-closed to `LIST_UNAVAILABLE_VERSION`. The next tick on which a list loads drains
up to 500 of them in one leg. Past the cap, `runLeg` swallows the budget-exhaustion throw
(`scheduled.ts:49-56`) and **every leg after `sdnRecovery` dies silently**: `provisioningReconcile`
(`:127`), the cursor commit `sweepCursor` (`:139` — so the rotation also pins), `retireChecks` (`:147`),
`sendPipeline` (`:154`), `reportSweepSignals` (`:178`), and the **heartbeat** (`:205`). The dead-man
then pages *"cron STOPPED"* about a cron that is running — which is verbatim the audit's BLOCKING-2 and
the failure this entire wave was built to remove.

**Why this is blocking rather than a scale note.** The wave ASSERTS the property in operator-facing
prose it ships: `sweep-signals.ts:318-319` tells the founder *"the slice is bounded by the invocation's
subrequest budget, and raising it past that is what used to make the dead-man heartbeat vanish."* As
shipped that sentence is false — a second leg can exceed the budget on its own. Note the internal
inconsistency is unavoidable either way: if the 1,000 cap is real, this leg breaks the invariant; if it
is not real (the file flags it UNVERIFIED), the slice arithmetic it derives has no basis.

`file:line` — `apps/platform/src/ofac/screening-recovery.ts:22,53-76`;
`apps/platform/src/admin/sweep-budget.ts:80-93`; `apps/platform/src/scheduled.ts:118-205`.
**Verification** — traced by construction and re-derived the arithmetic; the leg's absence of a
deadline/scope confirmed by reading every parameter of `rescreenListUnavailableReviews`. NOT reachable
at the pilot (1 tenant); it arms on a sentinel backlog in the low hundreds.

**Not reachable in production today.** Recorded as blocking because the wave's stated acceptance
property is false as shipped and the fix is small: give the leg `scope.fanout` via `sweepTenants` (the
primitive already exists and every sibling leg uses it), and/or set `RECOVERY_BATCH_LIMIT` to fit the
400-subrequest tail reserve, and add its real cost to `SWEEP_FIXED_SUBREQUESTS`.

---

## NON-BLOCKING (most severe first)

### N1 · A mistaken ceiling raise is durable for the calendar month, and NO supported path lowers it
`ceiling_cents` has exactly two writers, both in `withSpendCeiling`: the `INSERT OR IGNORE` seed
(`spend-ceiling.ts:314`) and the new raise-only reconcile (`:333`, `WHERE period_key = ? AND
ceiling_cents < ?`). Grepped every occurrence of `vendor_spend_ledger` and `ceiling_cents` in
`apps/platform/src`: there is **no lowering statement anywhere and no admin route**. So a typo'd
`PAYING_TENANT_COUNT=50` (ceiling $6,060) that lands on one provisioning call durably raises the live
month's stored bound, and neither knob walks it back — `SPEND_CEILING_CENTS` is subject to the same
raise-only UPDATE. The only remedy is a direct `wrangler d1 execute` UPDATE, documented nowhere.
The wave genuinely enlarges this hazard: pre-wave a wrong number only stuck if it was in force at the
month's FIRST spend; now any tick can bake it in. The comment discloses the reduction direction
("reductions land next period") and is silent on the irreversibility of a raise.
**I considered this BLOCKING and stepped down**: it requires operator error, it removes a backstop
rather than spending money, and a remedy exists. What is owed is disclosure plus surfacing the
IN-FORCE `ceiling_cents` (the alert reports the CONFIGURED number, `spend-ceiling.ts:213`, which can
differ from the row the gate actually used).

### N2 · The capacity alert instructs the operator to set the knob that permanently disables the wave's own formula
`spend-ceiling.ts:213` still reads *"spend ceiling reached (ceiling N¢/mo) — raise SPEND_CEILING_CENTS
or upgrade InboxKit"*. Post-wave, `SPEND_CEILING_CENTS` is the **absolute override**
(`spendCeilingCents`, `:102-105`) — an operator who follows this instruction freezes the ceiling at a
literal and the per-paying-tenant scaling never applies again, re-creating the growth-ceiling-disguised-
as-a-safety-bound that S2 exists to fix. The on-call string describes the pre-fix world; the growth
knob is now `PAYING_TENANT_COUNT`. One-line fix.

### N3 · S5's retirement + S8's roster denominator compose into a PERMANENT false "missing" above one slice — PROVED
`scanTenants` now holds the failure roll-up on a partial scan (`watchtower.ts`: `const grade =
scanComplete || observed === false ? observed : null`). That HOLD is **correct** — a partial scan must
not send a false RECOVERED. But `expectedCheckRoster` (`watchtower-roster.ts:38`) lists
`failure_signals`, and `retireHealthyCheckRows` deletes any row healthy for 7 days. Above one slice
(>49 tenants) `scanComplete` is permanently false, so a healthy platform emits **no `failure_signals`
observation at all** — nothing rewrites the row, retirement deletes it, and no producer recreates it.
`GET /admin/ops/checks` then reports `missing: ["failure_signals"]` forever, on the guard whose entire
stated purpose is to catch *"an env var lost in a deploy DELETES a check from the monitored set."*
Alerting itself is unaffected (an unhealthy observation still grades `false` and opens a fresh episode).
**Executed**, two probes:
```
COMPLETE scan (slice 10 / 4 tenants): failure_signals present = true
PARTIAL  scan (slice  2 / 4 tenants): failure_signals present = false
present BEFORE retire=6  retired=6  present AFTER=0
MISSING after one retireHealthyCheckRows: ["do_storage","failure_signals","cron_legs",
                                           "sweep_coverage","sweep_signals","alert_delivery"]
```
The second line is the general case: every roster member aged past retention is deleted. Four of them
(`cron_legs`, `sweep_coverage`, `alert_delivery`, `sweep_signals`) are rewritten later in the SAME tick
(`scheduled.ts:178,193` run after `retireChecks` at `:147`) so they have no observable gap;
`do_storage` and `failure_signals` are written at `:87`, BEFORE the retirement, so they carry a
one-cron-period gap every 7 days even below one slice. `warmup_cancel_gave_up` has the identical shape
(`sweep-signals.ts:370`, `gaveUp > 0 || digest.complete`) but is not on the roster, so it produces no
false positive — only a silently un-refreshed row.

### N4 · The three new one-shot `*_FAILED` check families are immortal by construction — and S5's stated property is false for them
`mailboxReleaseFailedCheckName` / `domainOrdinalFailedCheckName` / `mailboxSlotFailedCheckName` have
three producers (`lifecycle.ts:325`, `provisioning.ts:723`, `mailbox-provisioning.ts:232`) and — grepped
— **zero clearers**: nothing anywhere ever reports these names healthy. `retireHealthyCheckRows` only
deletes `status = 'healthy'` rows (correctly, per the frozen design's §7.4), so these rows persist for
the platform's lifetime. That makes `retireHealthyCheckRows`' docstring claim — *"the table no longer
grows with the platform's lifetime count of entities that ever alerted"* — false for the three families
the same wave introduced, and it partially reopens the audit's S10 (the quadratic `reported` loops),
whose NOT-A-DEFECT-NOW disposition rests on S5 having removed the precondition. Worth noting the
wave's own S10 correction (4 `reported` loops, not the audit's 2 — confirmed at `watchtower.ts:390,436,
511,547`) makes that constant 2× the audited one. **Executed:**
```
10-YEAR-OLD one-shots: retired=1 rowsLeft=3 unhealthyLeft=3
```
The alert-state design gives them `recoverAfter: 1` (§7.3), which does not help: recovery needs a
healthy observation and no producer emits one.

### N5 · `alert_delivery` and `sweep_coverage` are DOUBLE-DAMPED and page at 20 min — the exact number `cron_legs`' exemption exists to avoid
`policyFor` (`watchtower-alerts.ts:246-288`) has no branch for the three names this wave added, so all
three inherit `DEBOUNCED_ALERT_POLICY`. `cron_legs` sits four lines above with an `IMMEDIATE` exemption
whose comment states the reason verbatim: *"Already damped upstream… a debounce here would make a
genuinely broken sweep page at 20 min and breach the founder's 10-15 min ceiling."* `sweep_coverage` and
`alert_delivery` are damped upstream by the same `gradeSweepStreak` (`LEG_ALERT_AFTER_SWEEPS = 3`) and
then debounced again (`WATCHTOWER_CONFIRM_OBSERVATIONS = 2`): first `false` grade at tick 3, second at
tick 4 ⇒ **first email at tick 4 = 20 min**, 25 with a missed tick. `alert_delivery` is the check that
says *"we could not reach you"* — the worst one to delay. The frozen design owns the assignment (§7.3
→ §3.3), so this is scheduled, not unnoticed; it ships under-specified in the meantime. One-line fix.

### N6 · `sweep_coverage`'s two arms differ ~15× in sensitivity, and the noisy one suppresses the quiet one
`coverageBad = signals.deferred > 0 || coverage.coverageTicks > COVERAGE_TICKS_ALERT_AFTER`
(`sweep-signals.ts:294`). The second arm is thresholded at 12 ticks (~590 tenants, the number the
detail text and its "build the read-model" remedy are written for). The first arm has **no threshold at
all** — one deferred tenant on one leg, on consecutive ticks, trips it. `ASSUMED_DO_RPC_MS = 25` is
explicitly flagged as an in-process miniflare floor; at a real ≥34 ms per RPC the 15 s fan-out deadline
binds on any full slice, i.e. from ~38 tenants — roughly 15× below the threshold the message is
calibrated to. Once the check is in an announced episode, `decideAlert` returns `suppressed` for every
later observation (`watchtower-policy.ts:243-247`), so the coverage-ticks condition — the one that means
"go build the read model" — never produces its own alert, only an edited `detail` string. This is the
S4 defect (capacity pinning a check and suppressing a real signal) reproduced inside the check S4
created. Milder than the original (capacity poisoning capacity, and the 6 h re-alert does carry the
current detail), but the same class. Ruling 2's *classification* is right; its *calibration* is not.

### N7 · The S3 retry adds a term the 10-minute idempotency claim TTL's derivation does not contain
`REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS = 10 min` (`idempotency.ts:26`) is justified by an explicit
budget: *"up to ~156 sequential real vendor calls in one call to fn()… at a pessimistic several seconds
per round trip, that whole chain finishes in low single-digit minutes; 10 minutes leaves multiples of
headroom."* The new bounded retry adds up to `(INBOXKIT_MAX_ATTEMPTS − 1) × MAX_RETRY_WAIT_MS` = **20 s
of sleep per vendor call**, and the client serializes the whole attempt sequence including its backoff
(`inboxkit-client.ts`, the `queue` chain). One 429-then-success per call over 30 calls is +5 min; over
156 it is +26 min. Past the TTL a concurrent same-key retry takes the "presumed dead" branch
(`idempotency.ts:189-202`), re-stamps the claim and re-runs the saga alongside the original. The
per-intent layers beneath (ordinal-derived domain intents, `provision:` keys, the spend reserve) are
what keep that from double-buying — which is exactly why this is non-blocking rather than blocking —
but the TTL comment's arithmetic is now stale and should be re-derived with the retry term in it.

### N8 · S7's retention does not bind at the standing-order scale (a quantified half-close — ruling 4)
`DEFAULT_RETENTION_MS = 90 days` bounds the engine store by TIME, not by size, and the engine is a
single shared daemon (one `ENGINE_BASE_URL`). At 100 paying tenants × 5 mailboxes × ~40 sends/day ≈
20k sends/day, 90 days retains **~1.8M sends** — squarely the regime the audit measured at 358 MB and a
**4,925 ms frozen event loop**, recurring every 500 records. So retention removes the lifetime-unbounded
growth (real and worth having) and leaves the freeze unbounded above roughly 50 paying tenants. The
compaction-deferral revert is CORRECT and well-reasoned (a deferred snapshot promotes a failed durable
append to a durable success — `store.ts`'s `maybeCompact` docstring, and `reconcile.test.ts`'s B1 case
is the proof). ROADMAP-grade for the pilot; the number above is when it stops being.

### N9 · `sweepAgeSeconds`' published provenance is overstated
`routes/admin-ops.ts` says the new dead-cron tell *"comes from `watchtower_cursor`, which every
completed sweep stamps unconditionally."* `watchtower_cursor.last_sweep_ts` has exactly one writer,
`recordWatchtowerCompleted`, called at `watchtower.ts:834` — inside the **watchtower leg**, which
`runLeg` can swallow. `watchtower-infra.ts`'s own header says so: it means *"the watchtower leg
completed"*; the unconditional signal is the DO-side heartbeat, which this endpoint does not serve.
The error direction is safe (a dead cron always reads stale; a broken watchtower leg reads stale
too, which over-reports), so the DECISION to publish it is right and only the sentence is wrong — but
it is the sentence an operator will reason from at 3 a.m.

---

## Rulings requested

1. **Send-pipeline `rotationOffset` × slice cursor — FOLLOW-UP INCREMENT, do not delete in this wave.**
   Simulated the two windows with the verbatim source arithmetic over 400–4,000 ticks:
   | case | never served | worst send staleness | worst fan-out gap |
   |---|---|---|---|
   | N=500, slice 49, healthy | 0 | 10 ticks | **11** |
   | N=500, slice 49, one wedged engine (1 served/tick) | 0 | 538 ticks (~45 h) | 11 |
   | N=490 / 98 / 147 | 0 | 39 / 27 / 41 | **10 / 2 / 3** |
   | CONTROL — pre-wave shape (no slice), wedged | 0 | 499 ticks (~42 h) | 1 |
   **No configuration starves any tenant**, and the wedged worst case is within ~8% of the pre-wave
   number (538 vs 499), so the composition is not a regression. Separately, the fan-out gap matched
   `coverageTicks(total, slice)` **exactly** in every case — the published coverage bound is true.
   Deleting tested rotation behaviour to fix a non-issue is the worse trade inside a combined wave.
2. **`budgetExpiries` as a deferral — the CLASSIFICATION is correct, the CALIBRATION is not.** A tenant
   abandoned at its per-tenant budget genuinely was not reached, and a slow engine is a capacity fact
   about that tenant. The S4 shape is not re-introduced into `cron_legs`. But see **N6**: it lands in a
   check whose deferral arm has no threshold while its sibling arm has one at 12 ticks, and it will pin.
3. **Per-item alert burst on mass release-failure — ACCEPTABLE until the alert-state budget lands.**
   Per-entity check NAMES are right (per-item money, per-item remedy) and the frozen design endorses
   that reasoning explicitly (§7.8). Only the EMAIL fan-out needs batching, the producer already holds
   `outcome.failures` as a list, and the design has already scoped it as this lane's call. Bound today
   is the tenant's own fleet (5–10 at the pilot, ≤60 on Scale). Put it on the ledger as owed with the
   alert-state increment; it does not need a bound before this merge.
4. **S7's half-close — ROADMAP-grade, with the number.** See **N8**: the not-picked options
   (incremental serialization / a real datastore) are correctly deferred; the deferral is honest and
   the revert is right. It stops being ROADMAP-grade at ~50 paying tenants, which should be written
   down rather than left implicit.
5. **S11 partial (serial poll kept) — ACCEPTABLE.** The per-tenant poll is bounded by
   `SEND_PIPELINE_TENANT_BUDGET_MS`, and a poll that cannot keep up is now visible as
   `budgetExpiries`/`skippedForLegDeadline`. The DO input-gate reasoning for not parallelising holds.
   Caveat: the visibility lands in the check N6 says will be pinned.
6. **Spend ceiling, attacked both ways.** Formula sound. `parsePositiveInt` uses
   `Number.parseInt(raw, 10)`, so `"1e6"` parses to 1 (no exponent widening), blank/garbage falls back
   to the pilot bound, and `"0"` fails CLOSED — all pinned by the wave's own tests, which I re-ran.
   Raise-only is correct for its stated purpose and a reduction **cannot** strand a live month
   (verified: the UPDATE is guarded `ceiling_cents < ?`, so reserved+committed can never end up above
   the stored bound). The widening direction is where it fails: **N1** (irreversible raise, no
   lowering path, undocumented) and **N2** (the alert instructs the knob that disables the formula).
   The non-spend-arming classification is genuinely pinned, not merely asserted — positive control:
   removing `PAYING_TENANT_COUNT` from `KNOWN_NON_SPEND_ARMING` reds with
   `env.ts field(s) PAYING_TENANT_COUNT are uncategorized`.
7. **Dedup-stamp gating predicate — SOUND today, unguarded for tomorrow.** `withRequestIdempotency` has
   exactly five non-test call sites (`tenant-do.ts:832,967,1116,1197`, `mailbox-provisioning.ts:278`).
   The recorded payload is `settled.value` — the raw `T`, not the `Settled` envelope
   (`idempotency.ts:229-233`) — so a top-level `deduplicated` really is visible to the predicate; I
   checked this specifically because an envelope would have made the whole deliverable inert. Only
   `reply` and `remove_mailboxes` return one; `launch_campaign`, `setup_infrastructure` and `provision:`
   do not, and `contact_operator` does not route through the wrapper at all. **No field-name collision
   surface exists at this ref.** Residual: nothing enumerates the wrapper's call sites against their
   return types, so a sixth site whose DTO happens to carry a boolean `deduplicated` for an unrelated
   reason would silently mint a false disclosure. A one-assertion guard would close it.

---

## Attacks that FAILED (this is what makes the non-findings meaningful)

- **S9 narrowing soundness, by execution with MY names, not the builder's 14.** Ran the narrowed read
  and the full-scan oracle against 32 adversarial candidates — NFKD diacritics (`José Ramón García`),
  full-width (`Ｇｌｏｂｅｘ Ｃｏｒｐ`), ligatures (`ﬁrst ﬂight`), Cyrillic (normalizes to empty),
  punctuation-as-separator (`O'Brien & Sons`, `AL-RASHID TRADING CO.`), digits, the shortest possible
  2-token name (`a b`), reversed token order, single-token-vs-2-token-entry, `%`/`_`/`\0` and a
  300-char run. **Verdict identical on every one.** Also crossed the untested
  `LOOKUP_TOKENS_PER_STATEMENT = 40` chunk boundary (64 tokens, targets planted in chunks 2 and 3):
  `narrowed=2 full=2`. Structurally: `tokens_json` is always `tokenize(name_normalized)` — both ingest
  paths funnel through `parseSdnCsv` → `swapInSdnList`, so the column the narrowing keys on and the
  column rule 2 matches on cannot disagree. The `[t , t!)` range argument is sound because
  `normalizeName` emits only `[a-z0-9 ]` single-spaced and trimmed, and `' '` (0x20) is the only
  character below `'!'` (0x21). Max 3 candidates ⇒ the un-chunked `exactNames` IN clause binds ≤4
  params, well inside D1's 100-param ceiling.
- **"An empty filtered leg pins the rotation cursor at zero."** My leading hypothesis. Refuted by
  reading every leg: all six pass the FULL slice to `sweepTenants` and filter inside `fn` (dunning's
  `past_due` test is inside the callback), so `visited` is never 0 for a non-empty slice, and
  `commitSweepCursor`'s `covered === 0 → null` restart is unreachable that way.
- **Cursor arithmetic across wrap, exact multiples, short tails and mid-rotation churn.** Walked
  N=4/5/8/10 by hand and simulated N=98/147/490/500: no tick is wasted at the wrap (the `ids.length === 0
  && cursor !== null` restart branch recomputes `complete` after refilling), no tenant is skipped or
  double-swept, and the fan-out gap equals the published `coverageTicks` exactly.
- **The "full page read as last page" sibling** (the builder's own first-commit bug). Checked every
  new completeness inference: `complete: ids.length >= total`, `truncated: page.rows.length < total`,
  `truncated: entries.length < count` — all compare against a TOTAL, never against the LIMIT. Clean.
- **"An immortal unhealthy row buries a live incident past the page limit."** It cannot: the ORDER BY
  is `(status = 'healthy') ASC, since_ts DESC, check_name ASC`, so unhealthy sorts first and NEWEST
  unhealthy first within it. I reproduced the builder's revert-fail claim myself rather than quoting
  it — dropping the `(status = 'healthy') ASC` term reds `admin-ops-checks.test.ts` with
  `expected 'cred_push_aging:h204@example.com' to be 'engine'`.
- **§7.5 of the frozen design — "a tenant skipped by rotation must emit NO CheckResult, never a healthy
  one."** HOLDS. All six `for (const name of reported)` clear loops live inside `sendPipelineChecks`
  (`watchtower.ts:325-644`), which is called from inside the `sweepTenants` callback, so a
  rotation-skipped or deadline-deferred tenant produces nothing at all. This was the composition break
  I most expected to find.
- **§7.2 — the `alert_delivery` filter must not become a catch-all.** HOLDS: `sweep-signals.ts:199` is
  an explicit two-value allowlist (`send_failed`, `dark_channel`), so the design's forthcoming
  `suppressed_*` reasons cannot false-count as delivery failures.
- **§7.4 — the GC must exclude `status = 'unhealthy'`.** HOLDS exactly.
- **S3's money rule, every branch.** Read every `throw`/`continue` in `attempt()`: a thrown `fetch` is
  re-thrown once with an explicit "deliberately not retried" note; only `res.status === 429` continues;
  a `Retry-After` over `MAX_RETRY_WAIT_MS` re-throws the SAME graded error. `Retry-After` parsing is
  right in every direction I could construct — `"0"`, negative, blank, unparseable and past HTTP-dates
  all fall back to jittered backoff rather than to zero; `"3600"` correctly refuses. The per-instance
  queue re-arms RESOLVED, so one rejection cannot wedge later calls.
- **LIKE escaping.** `likePrefixPattern` escapes `\`, `%`, `_` in a SINGLE regex pass, so the
  double-escaping hazard its own comment worries about cannot occur, and the query carries
  `ESCAPE '\'`. Both the page and the COUNT use the escaped pattern.
- **Migrations.** `0019`/`0020` are unique, additive (`CREATE TABLE IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS`), contain no destructive DDL, and are wired into `test/setup.ts` in
  order. No `wrangler.toml`, `packages/`, `apps/dashboard`, or `site/` changes at all.
- **`env.ts` classification guard.** Positive control run (above, ruling 6) — it is mechanical, not
  documentary.
- **`countSupportTicketsByStatus` completeness.** The new `total` makes
  `open + escalated + closed === total` a checkable identity and the route emits `unaccounted`; the
  previous agreement-by-shared-blindness is genuinely closed.

---

## UNVERIFIABLE

1. **`SWEEP_SUBREQUEST_BUDGET = 1000` and whether DO RPCs count toward it.** The file flags this
   itself; miniflare does not enforce a cap. B1's severity is denominated in this number. *Resolves
   with:* one instrumented production tick, or a Cloudflare support answer on whether DO RPC counts
   as a subrequest on Workers Paid.
2. **`ASSUMED_DO_RPC_MS = 25`.** In-process miniflare is a floor, not a forecast. N6's arming point
   (~38 tenants vs ~590) moves with the real number. *Resolves with:* a timed production tick.
3. **Live D1 index-build cost for `0020` on ~19k `sdn_entries` rows.** Expected trivial; not measured
   against a real D1. *Resolves with:* the migration's own timing at apply.
4. **InboxKit's actual live rate limit and `Retry-After` behaviour.** The retry is correct whatever it
   is, but the 20 s-per-call worst case driving N7 is a bound, not an observation. *Resolves with:* a
   real armed provisioning run.
5. **Real send volume per tenant per day**, which sets N8's arming point. Assumed ~40/mailbox/day from
   the warmup ramp.

---

## NEW / out-of-scope observations (no verdict weight)

- The dedup stamp does the right thing on `remove_mailboxes`' retry loop as a side effect: the tool
  description instructs *"resend the identical request with the same key until failedCount is 0"*, and
  a replayed finished result now says `deduplicated: true`, so an agent can tell the retry did nothing.
- `migrateThreads` casts a non-string `threads` value to `ThreadRecord` unchecked; a malformed `ts`
  yields `undefined < cutoff === false`, i.e. never pruned. Safe direction (retain), worth a note.
- `listOpenAndEscalatedSupportTickets` returns a page and the route emits no `truncated` for it (the
  reasoning — `counts` is whole-table — is sound, but its two siblings in this same wave DO emit one).

---

## Deploy requirements

1. **Migrations `0019_sweep_cursor.sql` and `0020_sdn_entries_name_index.sql`** must be applied to the
   live D1 before/with this deploy. Both additive and idempotent; `0020` builds an index over
   ~19k rows (see UNVERIFIABLE 3).
2. **`PAYING_TENANT_COUNT`** is optional. Unset ⇒ the pilot bound. **Founder-visible:** the default
   monthly spend ceiling moves **$150 → $180** at count=1. Raise this knob — not
   `SPEND_CEILING_CENTS` — as customers land (see N2).
3. **No `wrangler.toml` change, no new secret, no site deploy.** `git diff --stat` over `site/`,
   `packages/`, `apps/dashboard` and `wrangler.toml` is empty; the changed admin endpoints are
   operator-only and appear in no published `openapi.yaml` path.
4. **Ops-watch spec update owed** (the watch polls `?unhealthy=1` + `sweepAgeSeconds` against a 2-row
   baseline): the unhealthy set now grows monotonically with never-clearing `*_FAILED` rows (N4), so
   the 2-row baseline is no longer valid; `count`/`total`/`truncated`/`missing`/`retentionMs` are new
   fields; and `missing` will report roster members during retirement windows (N3). `unhealthyCount`
   deliberately keeps its whole-store meaning — that one did NOT change under the watch.
