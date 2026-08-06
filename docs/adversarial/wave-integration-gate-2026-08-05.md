# Combined-diff ship gate — three-lane wave (2026-08-05/06)

**Reviewer:** adversary (fresh context) · **Ran:** 2026-08-06
**Ground ref:** worktree `/Users/yaakovscher/dev/coldstart-wt-integration`, branch `integrate/2026-08-05-wave`,
`git rev-parse HEAD` = **`43f4e19d7cb7e1b69df115b50464fdc7934ef96d`** (matches the brief). Base `ef1c2db`.
Diff reviewed: `git diff ef1c2db..43f4e19` — 56 files, +4805/−666.

**Baseline re-derived, not accepted:**
- `npx vitest run` (apps/platform): **140 files / 1268 tests passed**, 362s.
- `npm run typecheck` (all 5 workspaces): **clean**.
- Green suites were NOT treated as evidence. Every finding below was EXECUTED.

---

## VERDICT: **SHIP-AFTER-FIXES**

One BLOCKING finding survives self-refutation (#1). It is a one-line fix in
`inboxkit-domain-port.ts`. Everything else the brief named as a gate criterion —
dunning's three invariants, buy-idempotency, retryable-laundering, bill-only-on-confirmed,
the legacy-NULL adopt path, the MCP non-Error path, merge integrity — **held under attack**.

---

## Findings

### 1. BLOCKING · lens 2/5/6 · The purchased-domain DNS readiness gate marks a domain READY on nameserver match alone, overriding the vendor's own `dns_propagation_status: "pending"` — and mailboxes are then bought, warmup-enrolled and billed on it

`apps/platform/src/vendors/real/inboxkit-domain-port.ts:395-400` (`purchasedDomainIsReady`):

```ts
if ((record.status ?? "").trim().toLowerCase() !== "active") return false;
if (nameserversMatch(record.nameservers, record.actual_nameservers)) return true;   // ← route 1 short-circuits
return isReadyStatus(record.dns_propagation_status) && isReadyStatus(record.nameserver_match_status);
```

Route 1 returns `true` and never consults `dns_propagation_status`. `setDnsWithRetry`
(`engine/domain-dns.ts:183`) then flips `dns_status='ready'` and `provisionDomainWithMailboxes`
(`engine/provisioning.ts:286-294`) buys mailboxes on the next line.

**Failure scenario (EXECUTED, real REST route + real adapter):** vendor record
`status:"active"`, `nameservers:[a,b]`, `actual_nameservers:[a,b]`,
`dns_propagation_status:"pending"`, `nameserver_match_status:"pending"` — i.e. the
registrar's NS delegation has landed but the vendor has not finished the mail DNS.
`POST /setup-infrastructure` returned:

```
status 202  {"jobId":"job_375555b1…","billing":{"provisionedAfter":1,"projectedMonthlyCents":9900,…}}
domains:    [{"domain":"gonsonly.com","dns_status":"ready","connection_type":"purchased"}]
mailboxes:  [{"email":"sender11@gonsonly.com"}]          ← BILLABLE row
/mailboxes/buy calls: 1     /warmup/add calls: 1          ← real spend + recurring warmup subscription
```

**CONTROL (same run):** identical vendor record with `actual_nameservers: []` →
`/mailboxes/buy` = 0. So the nameserver match is the sole cause.

This is exactly the outcome the wave exists to prevent — `mailbox-provisioning.ts`'s own
invariant 2, and this module's own stated asymmetry ("a false 'ready' provisions billable
mailboxes onto a domain whose mail DNS does not work, which is the silent, monthly-billing
failure this wave exists to prevent", `inboxkit-domain-port.ts:365-372`). Route 1 is the one
code path that violates it.

**Two further problems with route 1's justification (lens 1, spec-vs-code):**
- The doc calls it "FIRST-PARTY PROOF". It is not first-party: `actual_nameservers` is a
  field in the *vendor's* `/domains/list` response. Route 1 trusts the vendor's raw field
  over the vendor's own verdict computed from that same field plus more.
- `nameserver_match_status` is the vendor's verdict on precisely the comparison route 1
  re-derives. So route 1 substitutes for the NS-match half and silently drops the
  `dns_propagation_status` half entirely.

**Why no existing test catches it (lens 5, fixture realism):** the only propagated fixture,
`test/fixtures/inboxkit.ts:286` `IK_DOMAINS_LIST_PURCHASED_PROPAGATED`, sets
`actual_nameservers`, `dns_propagation_status:"completed"` and `nameserver_match_status:"matched"`
*simultaneously*; `provisioning-orphan-acceptance.test.ts:135` `propagate()` does the same.
No fixture expresses the intermediate state, so route 1 and route 2 are never distinguished.

**Verification:** EXECUTED — throwaway test driving `RealInboxKitDomainPort.setDns` directly
(all five flags `true`), then the full `POST /setup-infrastructure` route with a stateful
vendor fake (output quoted above), plus the empty-`actual_nameservers` control.

**Self-refutation:** The one link I could not verify is whether InboxKit ever actually
publishes `actual_nameservers` fully before flipping `dns_propagation_status` to a ready
token. I have no live vendor access. But: (a) the causal ordering makes it the *expected*
window — mail DNS cannot propagate until the NS delegation lands; (b) the builder's own
fixture merely *assumes* simultaneity, it does not establish it; (c) the module's stated
rule is to fail closed on exactly this kind of unproven vendor ordering. A gate whose
correctness rests on an unverified vendor-internal ordering, when the safe form costs
nothing, should not ship for the customer this wave is unblocking.

**Remedy (not applied — I flag, I do not fix):** require the vendor's own verdict as well,
e.g. `return isReadyStatus(dns_propagation_status) && (nameserversMatch(...) || isReadyStatus(nameserver_match_status))`,
or simply delete route 1. Either keeps every existing test green
(`IK_DOMAINS_LIST_PURCHASED_PROPAGATED` satisfies both halves).

---

### 2. NON-BLOCKING · lens 7 (integration seam) · The `retry_setup` message blames DNS for a failure that is actually the MAILBOX leg — the REST body and the agent-facing message contradict each other

`apps/platform/src/engine/provisioning.ts:537-547`. Wire A fires on **any** retryable
`VendorError` escaping the provisioning loop and emits one hard-coded DNS sentence. When
msgchannel Inc1 was written and gated, the only retryable throw inside that `try` was
`setDnsWithRetry`. Wave 1 added a second one downstream: `awaitMailboxReady`
(`engine/mailbox-provisioning.ts:275`), which throws retryably when the vendor has accepted
a mailbox buy but not finished creating it. Neither lane's gate could see this; it exists
only in the merged code.

**Failure scenario (EXECUTED, real `POST /setup-infrastructure`, DNS already propagated,
mailbox buy accepted-but-`scheduled`):**

```
REST body:      {"code":"vendor_error","step":"mailbox purchase","retryable":true}
tenant_messages: kind=retry_setup, dedup_key="gowireamailbox.com",
  body="Setup for gowireamailbox.com has not finished yet — its DNS registration is
        still completing at the vendor. Nothing was lost; retry setup_infrastructure
        with the same idempotency key to finish it."
```

The domain named is correct (msgchannel Finding 1 is genuinely closed — see "Attacks that
failed"), but the *step* is wrong: DNS is ready; the mailbox is pending. The two customer
surfaces disagree in the same request. Secondary: `dedupKey` is the domain and `kind` is
`retry_setup` for both causes, so a DNS-pending and a mailbox-pending message for one domain
collapse into a single row whose body is whichever fired last.

Graded NON-BLOCKING because the prescribed action ("retry with the same idempotency key") is
correct in both cases — the harm is a false diagnostic claim, not a wrong action. But the
whole point of this channel is telling the agent what is happening without a human relay.

**Verification:** EXECUTED — real REST route, stateful vendor fake, `tenant_messages` read
straight out of DO SQLite.

---

### 3. NON-BLOCKING · lens 6 · A `mailbox_intents` row stuck at `'intent'` while the vendor already holds the mailbox causes a second paid buy — the mailbox leg has no twin of the domain leg's adopt-before-buy at that status

`apps/platform/src/engine/mailbox-provisioning.ts:176-192`. `buyMailboxUnlessAlreadyOurs`
asks the vendor **only** when `status === 'dangling'`. Status `'intent'` is treated as
"no purchase has been attempted. Buy." That is an assumption, not a proof: it holds only if
every buy that reaches the vendor also reaches the `catch` that writes `'dangling'`. A
CPU-time kill or isolate eviction between the vendor's accepted response and
`markMailboxIntent(..., "bought", ...)` (line 205) breaks it.

The module doc claims "when it is ambiguous the VENDOR is asked what it holds"
(`mailbox-provisioning.ts:14-15`). Status `'intent'` + a landed buy *is* ambiguous, and the
vendor is not asked. Note the asymmetry with the domain leg, which asks unconditionally on
the non-resume path (`findAdoptableDomain`, `provisioning.ts:208-210`).

**Failure scenario (EXECUTED):** seed `mailbox_intents` at `'intent'` with the vendor already
holding `sender11@lostmark.com`, run `provisionMailboxesForDomain` → `buys: ["sender11@lostmark.com"]`
(a second paid mailbox). Asking `provisioningState` first would have returned `'ready'`.

**Self-refutation:** the window is narrow (a hard kill inside one microtask gap) — a
*lost response* is already handled correctly, because the fetch rejects and the `catch`
marks `'dangling'`. And the naive fix is not free: asking on `'intent'` and getting `'absent'`
during the vendor's async window would still buy, so it closes most of the hole, not all of
it. Hence NON-BLOCKING, not BLOCKING. Worth recording as a known residual either way, since
it is the same class the domain leg spent a durable table to close.

---

### 4. NON-BLOCKING · lens 4 (guard scope) · The vendor-name source tripwire's scan root excludes `packages/shared`, whose error messages reach customers verbatim

`apps/platform/test/vendor-identity-leak.test.ts:24` globs `../src/**/*.ts` only. But
`packages/shared/src/errors.ts` defines classes whose `message` `error-response.ts` returns
**verbatim** to a tenant (`ValidationError` → 400, `IncompleteRegistrantError` → 400,
`CapacityPendingError` → 409). A future vendor-naming literal there would not trip the guard.

**Current state is CLEAN** — I ran the tripwire's own `findVendorNameLeaks` over
`packages/shared/src` (17 files) and it returned `[]`; every `inboxkit` hit there is inside a
comment. So this is a guard-coverage gap, not a live leak.

Same shape, lesser: the allowlist exempts whole *files* including `src/engine/provisioning.ts`
and `src/engine/spend-ceiling.ts`, which do write customer-visible values (`logAction`,
`emitTenantMessage`). Their current `inboxkit` occurrences are legitimate (an `instanceof`
import and env-var reads — I checked each), but the exemption is broader than its rationale.

**Verification:** EXECUTED — imported the guard's own detector and ran it against the
unscanned tree.

---

### 5. REFUTED · Integration item (b) — the uncaught async `VendorError: inboxkit domains/register failed for govendorerrrest.com`

**Not a wave defect and not a floating unawaited promise.** I materialised the pre-wave base
into a sandbox (`git archive ef1c2db`) and ran the same test file there: the log line is
**byte-identical at `ef1c2db`**, with the same 4-frame stack. The test that produces it
(`hotfix-h9.test.ts:189-254`) is unchanged by this wave.

Mechanism: workerd logs a rejection that crosses the DO RPC boundary as
`Uncaught (in promise)` even when the Worker side handles it — the same file's two
`NotFoundError: thread … not found` lines are asserted-404 handled paths and log identically.
The shorter stack (no `TenantDO.setupInfrastructure` frame) is explained by
`withRequestIdempotency`'s `if (!key) return fn();` (`engine/idempotency.ts:69`) — a
promise-adoption return, not an `await`, which terminates V8's async frame collection. The
call is fully awaited end to end; the test asserts the resulting 502.

**Verification:** EXECUTED at both refs.

---

### 6. REFUTED · Integration item (a) — lost or stale hunks from the 3-way merge

Ran two mechanical sweeps over all three lane commits (`8fd578e` dunning, `00a6230`
provisioning-wave1, `a9f57a4` msgchannel):
- every non-trivial line a lane **added** → still present at HEAD;
- every non-trivial line a lane **removed** → absent at HEAD, excluding intra-lane moves
  (compared against each lane's own materialised tree, so the `provisioning.ts` split into
  `mailbox-provisioning.ts` / `provision-intents.ts` / `domain-dns.ts` / `infrastructure-status.ts`
  doesn't produce false positives).

Result: **no lost hunk, no resurrected deletion.** Three benign hits, each explained:
msgchannel's `import { emitTenantMessage, listSurfacedTenantMessages, type TenantMessage }`
correctly split across two files by wave 1's move; two test fixtures correctly gaining
`connectionType: "purchased"`; one leftover import line surviving in
`retry-setup-message.test.ts`. The MODIFY/DELETE trap the integrator described (msgchannel's
side reverting wave 1's vendor-leak fix) did not recur elsewhere — msgchannel's `messages`
field survived the move into `infrastructure-status.ts:78,163`.

**Verification:** EXECUTED (scripted line-level diff sweeps).

---

## Attacks that failed (this is what makes the verdict mean something)

**Dunning invariant (i) — one wedged tenant cannot abort another tenant or another cron leg.**
Re-derived from source rather than from their tests: all **9** legs in `runScheduledOpsSweep`
are wrapped in `runLeg` (`scheduled.ts:36-82`); the dunning loop now has its own per-tenant
`try/catch` (`ops-sweep.ts:105-111`); `buildOpsDigest`'s `Promise.all` became a guarded
sequential loop (`ops-sweep.ts:298-308`); `reapStaleReservations` gained per-row isolation.
I also verified the builder's claim that the 3 sibling sweeps "already guard per-item" —
they do (`ops-sweep.ts:187,225,254`). The final `console.log` `JSON.stringify`s the fallbacks,
so a `null` leg result cannot itself throw. HELD.

**Dunning invariant (ii) — a crash between suspend and guard row loses the suspend or re-notifies every tick.**
Reproduced the post-crash state exactly (applied the suspend effect directly, left no guard
row), then ran two sweep ticks: tick 1 sent the notice and committed the guard row, tick 2
sent **0** notices. Converges in one tick, no permanent miss, no per-tick spam. HELD.
I specifically attacked the load-bearing assumption underneath it — that
`suspendForDunning()` returns `true` when re-run on an already-suspended, still-`past_due`
tenant (if it returned `false`, the notice would never be sent and the guard row never
written). EXECUTED: `first=true, second=true`. `rowsWritten` counts matched rows. HELD.

**Dunning invariant (iii) — a payment recovery racing the sweep leaves a paying tenant suspended.**
Traced the conditional `UPDATE … WHERE id = ? AND billing_state = 'past_due'`
(`engine/ops-summary.ts:78-90`) and confirmed `'terminate'` deliberately stays unconditional.
Checked the reverse interleaving too (recovery landing *after* the suspend commits →
`reactivateFromDunning` handles it). HELD.

**Retryable-laundering across the DO RPC boundary (brief vector iv).** The real risk was
that `retryable`/`step` are own properties that could be dropped when the error crosses RPC,
which would invert the grade at the customer surface. The existing test at
`vendor-identity-leak.test.ts:87` only simulates the shape, so I drove the **real** HTTP path:
a DNS-leg retryable failure returned `502 {"code":"vendor_error","step":"domain lookup","retryable":true}`,
and the reconstructed error observed at `routes/infrastructure.ts:13` carried
`{retryable: true, step: 'mailbox purchase', remote: true}`. Own properties survive. HELD.

**Brief vector (i) — the paying customer's legacy `connection_type: NULL` row via the REAL setup entry point.**
The shipped tests cover this only with an injected fake port and a direct engine call. I built
the real combination: a seeded `domains` row with NULL `connection_type` + a committed
`domain_intents` row, driven through `POST /setup-infrastructure` against the **real**
`RealInboxKitDomainPort` with the live-captured `/domains/list` shape. Result: `0`
nameserver-handshake calls, `0` re-registrations, `connection_type` backfilled to `"purchased"`,
DNS honestly reported not-ready. The vendor-lookup-failure variant leaving `'unknown'`
un-persisted is covered by `provisioning-dns-gate.test.ts:227`. HELD.

**msgchannel Finding 1 (my own prior BLOCKING finding) re-gated against the REFACTORED saga.**
The `onDomainResolved` callback fires on both branches before anything downstream can throw:
the resume branch at `provisioning.ts:181` (before `setDnsWithRetry` and before mailboxes) and
the buy/adopt branch at `provisioning.ts:254`. I walked every throw site between loop entry
(`:489`) and the first callback looking for a retryable `VendorError` that could still name
the fresh candidate — `assertCompleteRegistrant`, `recordDomainIntent`, the `existing` SELECT,
`findAdoptableDomain` (swallows to `null`), and `buy` (whose target *is* `opts.domain`). None
reachable. Their `multiCandidateStuckDnsDomainPort` fixture is a genuine fix for the
false-green I flagged (two stable candidates, two same-key runs, asserts both row count and
named subject). My own ATTACK 2 independently confirms the *domain* named is the real one.
Phantom-domain naming is CLOSED. HELD (only the step prose is wrong — finding #2).

**Brief vector (v) — a vendor-accepted-but-never-listable mailbox counted or billed.**
`insertProvisionedMailbox` runs only after `awaitMailboxReady` returns
(`mailbox-provisioning.ts:113`), and the meter counts rows. Confirmed live in my ATTACK 2 run:
`/mailboxes/buy` = 1 with zero `mailboxes` rows and a 502. HELD.

**Brief vector (vi) — vendor-identity leaks in customer-visible transports.** Hunted the
transports rather than re-running their guard: I suspected `spend-ceiling.ts:165-166`'s
`"upgrade the InboxKit plan and raise INBOXKIT_PLAN_SLOTS"` string, since
`error-response.ts:101` returns `CapacityPendingError.message` **verbatim** to the tenant.
Traced it: that string is confined to `alertCapacityPending`'s operator email (gated on
`OPS_ALERT_EMAIL`); the thrown message is the sanitized one, and the wave is what sanitized
it (the pre-wave message really did read `provisioning held: InboxKit plan-slot capacity
reached (3/10)`). REFUTED. Also swept `packages/shared` and `apps/dashboard` for emittable
vendor text — comments only. MCP `infrastructure_status` response over the real transport
contains no `inboxkit`. HELD (with the guard-scope gap recorded as #4).

**Integration item (c) — MCP non-Error throws.** `mcp-non-error-throw-leak.test.ts` genuinely
drives the real `handleMcpRequest` with real token resolution (only the DO namespace is
swapped), covers thrown strings, objects and blanked-name Errors, asserts the *positive*
generic body rather than mere absence, and proves a named class
(`NotFoundError`) still gets its own mapped body. The handler routes unconditionally through
`toErrorResponse` (`mcp/handler.ts:184`), with no `name !== ""` gate left. HELD.

**Integration item (d) — the `messages` field end to end.** Drove a real setup to a stuck-DNS
state, then `tools/call infrastructure_status` over the real `/mcp` transport: `messages[]`
present, populated, no vendor identity. Also checked REST/MCP parity —
`GET /infrastructure-status` carries `messages[]` too. HELD.

**Deploy/arm-time plumbing (lens 4).** `TENANT_DO_SCHEMA` runs in the DO constructor
(`tenant-do.ts:139`), so the new `mailbox_intents` and `tenant_messages` tables land for
already-instantiated tenants; `domains.connection_type` has its `addColumnIfMissing` backfill
(`tenant-do.ts:214`). No new D1 migration is required (`dunning_events` pre-exists). The cron
is genuinely armed (`wrangler.toml:107-108` `crons = ["*/5 * * * *"]`) and `scheduled.ts`'s
stale "commented-out" comment was corrected. HELD.

**vitest-green ≠ tsc-green.** Ran `npm run typecheck` across all 5 workspaces separately from
the test run. Clean. HELD.

---

## UNVERIFIABLE

1. **Whether InboxKit actually publishes `actual_nameservers` before flipping
   `dns_propagation_status` to a ready token.** No live vendor credentials in this
   environment. This is the single unproven link in finding #1 — it decides whether that
   finding is a live false-ready or a latent one. **Resolves by:** one live
   `POST /domains/list` poll of a mid-propagation domain in the real workspace, or a vendor
   doc/support answer on the two fields' semantics. Until then the safe-direction fix costs
   nothing.
2. **Real production DO/D1 state for Mordy's tenant.** I reproduced the described state
   (`connection_type` NULL, committed intent, `registrar:"adopted"`) from the brief rather
   than observing it. If his row differs (e.g. an intent key that doesn't match the
   idempotency key his agent will send), the resume branch won't engage and he gets a fresh
   buy. **Resolves by:** reading his live `domains` + `domain_intents` rows before deploy.
3. **The vendor's `status` vocabulary beyond `"active"`/`"pending"`.** The
   `READY_STATUS_TOKENS` allowlist is explicitly best-effort ("only 'pending' has been
   observed live"). Its fail-closed direction is correct, so this is a stall risk, not a
   money risk. **Resolves by:** the same live poll.

---

## NEW (out of scope — no verdict weight)

- **A recovered-then-re-failed tenant is never suspended again.** `cycle` is
  `billingFailureCount`; if it resets on recovery, a second dunning episode reaching cycle 4
  finds the *previous* episode's `dunning_events` row and skips
  (`ops-sweep.ts:80` `hasDunningEventForCycle` → `applied=false`). **Pre-existing** — the old
  `insertDunningEventIfNew` gate behaved identically, so this wave neither introduces nor
  worsens it. Worth its own ticket.
- **`reapStaleReservations` partial failure.** If the entry flip to `'released'` succeeds but
  the ledger decrement then throws, the reservation is leaked *and* no longer reapable (its
  status is no longer `'reserved'`). The new per-row `try/catch` doesn't introduce this; it
  makes an already-possible partial failure survivable for other rows.
- **`getInfrastructureStatus` writes on read.** One `MAILBOX_HEALTH_UNAVAILABLE`
  `deliverability_actions` row per degraded mailbox per poll
  (`infrastructure-status.ts:151-153`), on the endpoint the tool description tells agents to
  poll. Pre-existing; I flagged it in the msgchannel gate too.
- **`setDnsForConnectedDomain`'s `?? body.result?.[0]` fallback**
  (`inboxkit-domain-port.ts:263`) accepts a propagation verdict for a *different* domain when
  the name doesn't match. Pre-existing, and unreachable today (every domain we drive is
  `purchased`), but it becomes live the moment BYO/connected domains ship.
- **Worktree hygiene:** `git status` in the review worktree is clean of my changes (both
  `zz-gate-*` throwaway tests deleted, `HEAD` still `43f4e19`), but
  `.claude/agent-memory/bookkeeper/doc-convention-map.md` shows as modified. It was clean
  when I started and I never touched it — a concurrent sibling agent wrote it mid-review.
  Left alone (read-only git), flagged here.

---

## Ship condition

Fix finding **#1** (require the vendor's own `dns_propagation_status` verdict, or drop route 1)
and add a fixture expressing the intermediate propagation state so the two routes are
distinguishable. Findings #2, #3, #4 are recordable follow-ups and do not need to block this
deploy. Re-gate #1 only — the rest of the checklist is already proven.

---
---

# ROUND 2 — re-gate of finding #1

**Reviewer:** adversary (same context, round 2) · **Ran:** 2026-08-06
**Ground ref:** `git rev-parse HEAD` = **`8e55bfcb759272d0d7f14bcc898807fbe4f4fe1f`**, one commit atop
round 1's `43f4e19`. Diff reviewed: `git diff 43f4e19..8e55bfc` — exactly the 4 files stated
(`inboxkit-domain-port.ts`, `fixtures/inboxkit.ts`, `domain-connection-type.test.ts`,
`provisioning-orphan-acceptance.test.ts`), +147/−21.

**Scope discipline:** re-gated **finding #1 only**, against the round-1 ship condition as
written ("require the vendor's own `dns_propagation_status` verdict, or drop route 1" + "add a
fixture expressing the intermediate propagation state"). Findings #2/#3/#4 were not re-scored.
Anything I found outside that condition is filed under NEW below and carries **no verdict weight**.

**Re-derived baseline at `8e55bfc`:** `npx vitest run` → **140 files / 1271 tests passed**
(+3 vs round 1, matching the 3 added tests); `npm run typecheck` → clean across all 5 workspaces.

## Finding #1: **FIXED**

### (1) The round-1 repro, re-run verbatim through the real REST route — now fails closed

Same vendor state that produced the round-1 defect (`status:"active"`,
`nameservers==actual_nameservers`, `nameserver_match_status:"matched"`,
`dns_propagation_status:"pending"`), same real `POST /setup-infrastructure` path:

| | round 1 (`43f4e19`) | round 2 (`8e55bfc`) |
|---|---|---|
| HTTP status | **202** | **502** (not 202) |
| `/mailboxes/buy` | **1** | **0** |
| `/warmup/add` | **1** | **0** |
| billable `mailboxes` rows | **1** (`sender11@gonsonly.com`) | **0** (`[]`) |
| `domains.dns_status` | **`ready`** | **`pending`** |

The thrown error is the honest one: *"domain gor2nsonly.com is registered and recorded, but its
DNS has not finished propagating yet. No mailboxes were purchased onto it. Nothing was lost —
retry to finish it."* — retryable, domain preserved, no spend.

**CONTROL (same run):** the fully-propagated state still returns **202**, buys exactly **1**, and
flips `dns_status` to `ready`. The fix did not brick the happy path.
**Verification:** EXECUTED (throwaway test, real route + real adapter, deleted after).

### (2) Attacking the new surface — the full signal matrix

Drove `RealInboxKitDomainPort.setDns` against 11 hand-built vendor records. Eight behaved exactly
as predicted, all fail-closed:

- fully ready → READY · **NS-matched + DNS-pending → not ready** (the fixed defect)
- DNS completed + NS pending → not ready · DNS completed + NS token **absent** → not ready
- **both tokens absent** while nameservers agree → not ready (the deleted route's exact input, now inert)
- both tokens empty string → not ready · `status:"expired"` with both verdicts ready → not ready
- case/whitespace noise (`"  COMPLETED "`, `" Matched  "`) → READY (normalisation intact)

No combination of the three signals produces a false ready **within the recognised vocabulary**.
Two token-vocabulary observations fell out and are filed as NEW (not verdict-bearing) below.

### (3) Is deletion — rather than a third conjunct — sound? Yes.

The brief's own question: did the NS-match route guard anything the two vendor verdicts do not?
I attacked this directly and the answer is **no, not as evidence**:

- `actual_nameservers` arrives in the **same** `/domains/list` response as the two verdicts. We
  never query DNS ourselves. So the route substituted the vendor's raw input for the vendor's
  conclusion — strictly less information from the identical source. The shipped
  "FIRST-PARTY PROOF" framing was simply false, and the new comment says so.
- Nameserver delegation is a **precondition** of mail-DNS propagation, not a substitute. The
  mailbox buy depends on the latter.
- `nameserver_match_status` is the vendor's verdict on precisely the comparison the route
  re-derived — two derivations of one fact at different thresholds, which is what produced the
  disagreement.

The one thing the route did provide was an accidental **fallback** if the vendor's ready-token
vocabulary were unrecognised. Losing that is a *stall* risk, not a money risk, and stalling is
the direction round 1 demanded. Sound. (Weight of that trade recorded under NEW.)

### (4) Do the 3 new tests actually pin the defect? Verified by revert-fail, not by claim.

I did not take the commit message's "RED 3-failed/14-passed" on trust. I materialised `8e55bfc`
into a sandbox, restored **only** `inboxkit-domain-port.ts` from `43f4e19` (keeping every new test
and fixture), and ran the two affected files:

```
× NS delegation landed but mail DNS still pending: 202-with-a-billed-mailbox must NOT happen
× NS delegation landed but mail DNS still pending reads NOT ready — the false-ready bug
× a matching nameserver set cannot override an unrecognized propagation token either
Tests  3 failed | 14 passed (17)
```

Exactly the 3 new tests fail; nothing else regresses. They would catch a re-introduction of the
short-circuit. The acceptance test fails on `expect(countOf("/mailboxes/buy")).toBe(0)` —
i.e. on the **money** assertion, the right reason.

The fixture gap round 1 identified is genuinely closed: `IK_DOMAINS_LIST_PURCHASED_NS_MATCHED_DNS_PENDING`
makes the intermediate state first-class, and the acceptance fake's new `matchNameservers()`
transition (separate from `propagate()`) makes it reachable through the real route — so the
lockstep-fixture problem that hid the bug cannot recur for this predicate.

### (5) Spot-check — nothing else changed

Read all four file diffs in full. Source change is confined to `purchasedDomainIsReady`
(one line deleted), the `nameserversMatch` helper (removed, not orphaned), and the doc comment.
`isReadyStatus`, `READY_STATUS_TOKENS`, `dnsRecordSet`, the connected-domain handshake, the
paging walk and `normalizeConnectionType` are **untouched**. `grep` confirms zero surviving
references to `nameserversMatch` in source or tests. `RawDomainRow.nameservers` /
`actual_nameservers` remain as wire-shape declarations only — documentation of the vendor
contract, not dead logic. Test changes are additive apart from one renamed test title.

---

## VERDICT (wave as a whole): **SHIP**

Round 1's single BLOCKING finding is fixed, proven by re-running the original money-moving repro
end to end, by a revert-fail proof of the new tests, and by a fail-closed sweep of the predicate's
whole signal matrix. The happy path is intact (control buys exactly 1). Full suite 1271/1271,
typecheck clean x5. No new BLOCKING finding.

Findings #2, #3 and #4 from round 1 remain open as recorded NON-BLOCKING follow-ups and do not
gate this deploy.

---

## NEW (round 2, out of scope — no verdict weight)

1. **`READY_STATUS_TOKENS` contains generic words that are ambiguous in a *propagation* field.**
   EXECUTED: `dns_propagation_status:"active"` (and `"ok"`) with the same value in
   `nameserver_match_status` reads **READY**. In a `status` field "active" means live; in a
   propagation field it plausibly means *actively propagating* — i.e. not done. This allowlist is
   **unchanged by the fix** (it exists identically at `43f4e19`), so it is not a regression, and
   there is no causal argument that the vendor uses these words this way — unlike round 1's
   finding, which was causally certain. Cheap hardening: drop `active`/`ok` from the allowlist,
   since neither has been observed live.
2. **Round-1 UNVERIFIABLE item #3 is now load-bearing.** With the second route deleted, the token
   allowlist is the *sole* path to ready. EXECUTED: a genuinely-finished domain reporting
   `"synced"` (outside the allowlist) reads **not ready, forever** — a silent permanent stall,
   which is the failure shape this module's own comments warn about, just fail-closed. Only
   `"pending"` has ever been observed live; `"completed"`/`"matched"` are informed guesses.
   **This is the one thing worth doing before or immediately after deploy:** a single live
   `POST /domains/list` against a fully-propagated domain in the real workspace confirms the two
   ready tokens. If they are not in the allowlist, the paying customer's domain never provisions.
   Fail-closed and one-line-recoverable, so it does not block the ship — but it should be the
   first live check.
3. **The acceptance test's `expect(held.status).not.toBe(202)` is weaker than it reads.** In that
   fixture a mailbox buy still yields a non-202 (the buy is accepted but `status:"scheduled"`, so
   `awaitMailboxReady` throws), which is why the pre-fix run failed on the buy-count assertion
   rather than the status one. The test is sound because the money assertion follows immediately;
   noted only so nobody later trims it to the status check.
4. **Stale `apps/platform/dist/index.js` still contains the pre-fix `nameserversMatch`.** Checked
   and harmless: `dist` is gitignored, and `wrangler.toml:6` sets `main = "src/index.ts"`, so
   `wrangler deploy` bundles from source and never consumes `dist/` (which is only a
   `--dry-run --outdir` artifact).
5. **Worktree hygiene:** my throwaway `zz-gate-r2.test.ts` is deleted, `git status` shows no
   change of mine, HEAD is still `8e55bfc`. `.claude/agent-memory/bookkeeper/doc-convention-map.md`
   remains modified by a concurrent sibling agent — same note as round 1, left alone.
