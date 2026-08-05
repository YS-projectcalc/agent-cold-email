# Adversarial gate — the 2026-08-05 provisioning incident hotfix

**Grounding.** Base HEAD `47dd54e661a4c162cd3815af7f4aa60ec66646db`; all 14 hotfix members +
the site lane UNCOMMITTED in the live worktree (32 paths, `git status`). Read-only git
(`status`/`diff`/`show`/`log`) throughout. All execution ran in an isolated `rsync` copy of the
repo in the session scratchpad with `node_modules` symlinked; every file I mutated there for
revert-proofs was restored and `diff`-confirmed byte-identical against the live tree. No vendor
API calls of any kind. Nothing in `/Users/yaakovscher/dev/coldstart` was edited.

## VERDICT: NO-SHIP

Three BLOCKING findings survive self-refutation. The builder's green-suite and typecheck claims
are TRUE and independently reproduced (128 files / 1180 tests passed in 450s, zero skips;
`tsc --noEmit` clean; `openapi.yaml` parses with every `$ref` resolving). The suite is green
*with all three blockers live* — the same shape as the 1157-green run that preceded this incident.

Answering the brief's headline question directly: **Mordy is not unblocked.** His retry buys a
second domain instead of adopting the one he already paid for, and if that new domain loses the
same ~32s registration race his first one lost, his next retry provisions billable mailboxes onto
a domain with no DNS and returns HTTP 202 success.

---

## BLOCKING

### B1 · The retry the hotfix tells the customer to perform never completes the DNS step, and provisions billable mailboxes onto a dead domain

**Lens 2 (run it) + 1 (spec-vs-code) — verified by execution.**

`setDnsWithRetry` exhausts, leaves `dns_status='pending'`, and throws
`"…Nothing was lost — retry to finish it."` (`apps/platform/src/engine/provisioning.ts:368-371`).
The code comment states the recovery contract outright: *"the caller's retry (which now adopts
rather than re-buys) finishes the job"* (`provisioning.ts:330-331`).

It does not. On the retry, the convergence branch fires — `intent.status==='committed'` and the
`domains` row exists, because H2 records both BEFORE calling setDns — and it returns after
provisioning mailboxes, **never calling `setDnsWithRetry`**
(`provisioning.ts:418-435`; setDns is only reached at `:494`, below the early return).

Executed end-to-end through `runSetupInfrastructure`:

```
PROBE8 attempt1 error: domain goretrydns.com is registered and recorded, but its DNS setup
                       has not completed yet (...). Nothing was lost — retry to finish it.
PROBE8 attempt1 setDns calls: 2      after attempt1 domains: [{dns_status:"pending"}]  mailboxes: 0
PROBE8 attempt2 setDns calls: 0      <-- ZERO. The failed step is never re-run.
PROBE8 attempt2 result: {"jobId":"job_f0cd…","billing":{"provisionedAfter":2,"projectedMonthlyCents":9900}}
PROBE8 after attempt2 domains: [{"domain":"goretrydns.com","dns_status":"pending"}]  mailboxes: 2
```

There is no other re-drive: `setDnsWithRetry` has exactly ONE call site, and `dns_status` is
written in three places and **read by zero** (grep across `apps/`, `site/`). No sweep, no alarm,
no endpoint. The domain is permanently stuck at 'pending' with nameservers never pointed at
InboxKit, while two mailboxes are bought, warmup-subscribed, counted by
`syncMailboxQuantity`, and billed at $99/mo — under a 202 success response.

This is strictly worse than the incident it fixes: the incident failed loudly and spent $12.50;
this succeeds silently and spends $12.50 + 2 mailbox slots + 2 warmup subscriptions, monthly.

**Mordy-reachability: certain-adjacent.** His retry buys a NEW domain (see B2), which faces the
identical ~32s async-registration race his first domain lost.

### B2 · Adopt-before-buy cannot fire for the domain it was written to recover — the availability filter deletes its only input

**Lens 6 (attack the design) + 5 (fixture realism) — verified by execution.**

H3 recovers a domain the vendor already owns. H3b filters candidates the vendor reports as
unavailable (`provisioning.ts:653-654`). A domain the vendor account already owns is, by
definition, **not available** — the real port sets `available: body.available === true` from
`GET /domains/available` (`vendors/real/inboxkit-domain-port.ts:88-92`). So every adoptable
candidate is discarded before `findAdoptableDomain` can ever see it.

Simulating Mordy's exact live state (goauthorpitchdesk.com registered at InboxKit,
`assigned_mailboxes: 0`, no local `domains` row, no `domain_intents` row — the table did not
exist when his call failed), replaying his original key:

```
PROBE1 buy calls:  ["theauthorpitchdesk.com"]     <-- a SECOND $12.50 purchase
PROBE1 listOwned:  1                              <-- asked, but only about the new candidate
PROBE1 domains:    ["theauthorpitchdesk.com"]
PROBE1 intents:    [{key:"apd-setup-a-2mbx#0", candidate_domain:"theauthorpitchdesk.com", status:"committed"}]
```

`goauthorpitchdesk.com` stays orphaned and unreachable through the product; the $12.50 is not
recovered. The new customer-facing tool description asserts the opposite — *"A domain this
account already registered but that never landed in your account … is ADOPTED on the retry at
zero extra cost rather than bought again"* (`src/mcp/tools.ts:67`) — which is false for the only
domain in this state today.

**Why every test missed it:** all four adopt tests call the inner `provisionDomainWithMailboxes`
DIRECTLY (`test/provisioning-saga.test.ts:79-194`), bypassing the filter, and the adopt fixture
reports the vendor-owned domain as `available: true` — a state that cannot exist in production.

**The escape hatch, confirmed:** with a pre-seeded `domain_intents` row naming the stranded
domain, the adopt path DOES work through `runSetupInfrastructure` (`PROBE5 buys: []`, domain
recovered) — because `findAdoptableDomain` is called with `intent.candidate_domain`, not with the
filtered candidate (`provisioning.ts:443`). So adoption works for failures that happen AFTER this
deploys, and only for those. Two viable remedies: consult adopt BEFORE the availability filter,
or seed an intent row for the live orphan.

### B3 · The H4 unique index is exec'd raw in the DO constructor and can permanently brick a tenant DO

**Lens 4 (deploy/arm-time plumbing) — verified by execution.**

`tenant-do.ts:272-275` runs, inside `ensureColumnMigrations()` which the constructor calls
unguarded (`tenant-do.ts:136-138`):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_live_email
  ON mailboxes(tenant_id, email) WHERE released_at IS NULL
```

Executed against a DO carrying duplicate live rows:

```
PROBE2: {"threw":true,"message":"UNIQUE constraint failed: mailboxes.tenant_id, mailboxes.email:
         SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"}
```

A throw there escapes the constructor → the DO cannot instantiate → **every** request for that
tenant fails permanently, with no API repair path. The repo's own `ensureDedupeIndex`
(`tenant-do.ts:322-334`) exists for exactly this hazard — it DELETEs duplicates first AND wraps
the create in try/catch ("continuing without it this boot") — and was deliberately bypassed
("has no partial-index form", `tenant-do.ts:270-271`), dropping both safeties.

Is the precondition real? The frozen deep-dive's own **F12** proves duplicate live mailbox rows
are producible today on the BYO path (constant `domainKey` + `domainOrdinal:0` → identical local
parts → replay → N duplicate rows). This is a fleet-wide deploy risk, not a Mordy-specific one:
one affected tenant DO is bricked forever by a hotfix intended to unbreak provisioning. The
asymmetry decides it — a phantom billable row is recoverable, an unbootable DO is not.

---

## NON-BLOCKING

- **N1 · One idempotency key, two domain purchases.** The intent row keeps the candidate the FIRST
  attempt resolved, but a fall-through buy purchases `opts.domain` (the freshly generated name) and
  then marks THAT intent 'committed' (`provisioning.ts:462-486`) — the row permanently misnames what
  was bought. Proven: committed intent naming `go*` + no domains row + a `/domains/list` hiccup →
  buys `the*`; a later retry on the SAME key then adopts `go*` too. `PROBE6b domains:
  ["theauthorpitchdesk.com","goauthorpitchdesk.com"]`. Had `go*` not been adoptable, that is two
  real registrar charges under one idempotency key.
- **N2 · H6 turns a generic 500 into a verbatim vendor message on REST (new disclosure).**
  `VendorError → 502 {error: <raw adapter message>}` (`src/error-response.ts:114-120`). Proven
  bodies a tenant now receives: the operator's InboxKit **Stripe checkout URL**
  (`inboxkit-domain-port.ts:160`), `ENGINE_BASE_URL must be https (or localhost):
  http://10.0.0.7:8787` (`email-port.ts:88`), `connect ECONNREFUSED 10.0.0.7:8787`, and OAuth
  arming runbook text. The hotfix's own leak test lists `/ENGINE_BASE_URL/` in `INTERNAL_MARKERS`
  but only exercises `NotActivatedError` plus one hand-picked clean VendorError
  (`test/hotfix-h9.test.ts:187,222`). Same regex also emits junk `step` values ("unreachable",
  "manually-minted") that the helper's own comment says are worse than none.
- **N3 · Two false claims in the new customer-facing copy.** openapi: *"retried automatically on
  the platform's side"* — there is no background retry; `setDnsWithRetry` has one call site and
  nothing reads `dns_status`. Tool description + openapi: *"still returned by
  infrastructure_status with its dns state pending"* / *"poll GET /infrastructure-status"* —
  `InfrastructureStatus` exposes a domain COUNT only (`provisioning.ts:750-755`); there is no
  per-domain row and no dns field on any surface.
- **N4 · Re-provision after cancel inserts a billable row with no vendor mailbox.** The 30-day
  idempotency claim outlives teardown, so the replay returns the cached mailbox without a vendor
  call and then inserts a live row. `PROBE7 provisionCalls: 1` across two runs, rows
  `[{released_at:123},{released_at:null}]`. The H4 comment justifies keeping the INSERT outside the
  recorded unit on the grounds that this preserves legitimate re-provisioning
  (`provisioning.ts:119-127`) — the row inserts, but no mailbox is bought. Not a regression (the
  pre-fix path also re-fired startWarmup), but the stated rationale does not hold.
- **N5 · The real port silently caps candidates at 5.** `prefixes.slice(0, Math.max(1, count))`
  over a hardcoded 5-element list (`inboxkit-domain-port.ts:83-84`) ignores H3b's over-request. The
  sandbox gained numbered spillover, so tests are green while any real request for >5 domains — the
  schema allows 20, Scale tier allows 18 — hard-400s with "try a different brand", blaming the
  customer for our prefix list.
- **N6 · `pendingCredentialPushes` is structurally 0 whenever the push path is unarmed**
  (`maybePushProvisionedMailbox` returns before recording when deps are absent,
  `mailbox-credential-push.ts:150-151`). Same honest-zero-reads-as-healthy shape as the
  `provisioningFailureCount: 0` the deep-dive flagged (still literal at `admin/ops-sweep.ts:322`).
- **N7 · Coverage theater in the H9 file.** `"REST maps a vendor failure to 502 {code:'vendor_error',
  step, retryable}"` asserts a **404** on a missing thread (`test/hotfix-h9.test.ts:189-203`). No test
  drives a real 502 through the REST surface. Also `/setup-infrastructure` documents 400/401/502/503
  but not the 409 `RequestInProgressError` it can return.

---

## Attacks that FAILED (why these are not findings)

- **Full suite / typecheck claims.** Re-ran independently: 128 files, 1180 tests, 0 failed, 0
  skipped, 450s; `npm run typecheck` clean. The builder's numbers are exact.
- **H9 proofs are real, not vacuous.** cp-reverted the H5 try/catch → the H5 test FAILS. cp-reverted
  the H7 commit guard to the unguarded UPDATE → *"money booked is money RECORDED even if the entry
  row is gone"* FAILS. Both files restored byte-identical (`diff -q` against the live tree). The
  builder's admission is also correct: the first H7 test still PASSES reverted, so the deleted-row
  test is the one carrying the proof.
- **B1 money invariant (stale consent driving a buy).** Port selection reads
  `input.registerDomains ?? false` (`tenant-do.ts:527`) while the WRITE preserves persisted consent
  (`provisioning.ts:630-646`). Traced both: a call that omits the field gets
  `RegistrarUnarmedDomainPort` → throws on the first vendor touch → 503 + founder alert. A stale
  `register_domains=1` cannot fire a real buy for a call that did not ask. Holds.
- **`ledgerNow()` sweep completeness.** All three ledger timestamps converted; zero `ctx.clock.now()`
  remain in `spend-ceiling.ts`. `period_key` derives from the same wall-clock value, so bucketing is
  consistent; the ceiling comparison is unaffected.
- **Previously-mapped REST error shapes.** Diffed old `index.ts` onError against `toErrorResponse`
  case by case: ValidationError/NotFound/TenantIsolation/RateLimit/RequestInProgress/RegistrarUnarmed/
  IncompleteRegistrant/RevConflict/SendBlocked all preserve status + body keys. `CapacityPendingError
  extends VendorError` but is matched by `name` ahead of the VendorError branch, so no class is
  swallowed by the new fallthrough.
- **Keyless convergence.** Real, and documented in BOTH the tool text and openapi. A keyless repeat
  converges rather than double-buying; asking for MORE mailboxes on a converged call still provisions
  the additional ones (the per-mailbox keys differ). Correct call.
- **openapi integrity.** Parses; `#/components/parameters/IdempotencyKey` resolves; the
  CapacityPending `reason` enum matches the class's actual union
  (`packages/shared/src/errors.ts:96`).
- **Scope integrity.** F6 (slot leak), F7 (teardown sandbox flip), F8 (`provisioningFailureCount: 0`)
  are untouched, not half-touched. F9's verdict is still discarded, but moving `screenTenant` before
  the profile write (with the new `brand` override) is a strict improvement, not a regression.
- **H5 landmine completeness.** Walked every remaining leg of Mordy's path for a second
  `NotActivatedError`: `syncMailboxQuantity` catches everything, `maybePushProvisionedMailbox`
  swallows by design, all other vendor legs share the armed `InboxKitClient`. `recordUsage` was the
  only one.

## UNVERIFIABLE

- **Whether any live tenant DO currently holds duplicate live mailbox rows** (decides whether B3 is
  latent or immediate). Resolves with a read-only per-DO
  `SELECT tenant_id, email, COUNT(*) FROM mailboxes WHERE released_at IS NULL GROUP BY 1,2 HAVING COUNT(*)>1`
  across the fleet before deploy.
- **Whether InboxKit's `GET /domains/available` really answers `false` for a domain the caller's own
  workspace owns.** B2's proof assumes it does (the standard registry answer). One authenticated GET
  against `goauthorpitchdesk.com` settles it; if it answers `true`, B2 downgrades to a latent
  fixture gap rather than an active blocker. Nothing else in B2 changes.
- **End-to-end SENDING for Mordy.** Even with B1/B2 fixed, the credential-push/OAuth leg (deep-dive
  F5, deferred here) still cannot succeed on a first provisioning — the manual minter is keyed by
  mailbox emails that do not exist until provisioning creates them. H-alert surfaces the count to the
  founder; the manual grant-minting step remains a human prerequisite for actual sending. Not a
  hotfix regression, but "provisioned" ≠ "can send".

## NEW (out of scope, no verdict weight)

- `logAction(ctx, "USAGE_METERING_SKIPPED", …)` and `"MAILBOX_HEALTH_UNAVAILABLE"` write one action
  row per mailbox per `infrastructure_status` call — an endpoint the tool text tells agents to poll.
  Unbounded growth on a permanently-degraded mailbox.
- `findAdoptableDomain` swallows a listing failure to `null` by design; combined with N1 that is the
  precise trigger for the double-purchase chain.

---
---

# ROUND 2 — re-gate of the fix round (2026-08-05, same day)

**Grounding.** Base HEAD `11ad9988` ("ledger: hotfix-gate NO-SHIP (3 blocking…) fix round
dispatched"); the whole hotfix + fix round still UNCOMMITTED (34 paths). Isolated exec copy rebuilt
from the current tree; a recursive `diff -rq` of `apps/platform/src`, `apps/platform/test`,
`packages/` and `site/` confirms the copy I executed is byte-identical to the live tree, so this
verdict is not on stale code. Exactly four source files changed since round 1
(`provisioning.ts`, `error-response.ts`, `tenant-do.ts`, `inboxkit-domain-port.ts`) plus
`site/openapi.yaml` and a new `test/incident-gate-fixes.test.ts`. **Note:** the tree mutated during
this review — `site/openapi.yaml` grew 131→143 insertions and the class-sweeper/hard-builder ledger
markdown changed. All source verification below was re-run against the current bytes.

## VERDICT: SHIP

All three round-1 BLOCKING findings are closed, each verified by execution rather than by reading
the fix. N1, N5 and N7 are closed too. `129 files / 1189 tests passed, 0 failed, 0 skipped` (603s)
and `tsc --noEmit` clean — the builder's numbers reproduce exactly. Residuals below are
NON-BLOCKING and do not change the verdict; new items found while re-attacking are listed
separately, per convergence discipline.

### B1 — CLOSED · a pending domain now receives ZERO mailboxes

`provisioning.ts:458-461` re-drives `setDnsWithRetry` inside the convergence branch when
`dns_status !== 'ready'`, **before** `provisionMailboxesForDomain`. Executed as three attempts:

```
attempt1 (dns fails): domains [{dns_status:"pending"}]  mailboxes: 0   retryable throw
attempt2 (dns still fails): setDns calls 2, buys []      mailboxes: 0   retryable throw   <-- was 2 mailboxes + a 202
attempt3 (vendor healthy): setDns calls 1 -> dns_status "ready", then mailboxes: 2, 202
```

Round 1's exact failure — billable mailboxes onto never-pointed nameservers under a 202 — is gone,
and the retry now genuinely finishes the job its error message promises.

### B2 — CLOSED · adopt fires for Mordy's live orphan with no seeded intent row

`provisioning.ts:715-736` builds the adoptable set BEFORE the availability filter and rescues those
names from it; `:490-497` additionally checks `opts.domain` when it differs from the intent's name.
Replaying his exact state (goauthorpitchdesk.com owned + `assignedMailboxes:0` + **no** domains row
+ **no** domain_intents row + availability reporting it `false`) under key `apd-setup-a-2mbx`:

```
buys: []          domains: [{"goauthorpitchdesk.com","dns_status":"ready"}]
intents: [{key:"apd-setup-a-2mbx#0", candidate_domain:"goauthorpitchdesk.com", status:"committed"}]
mailboxes: 3
```

Zero spend, orphan recovered, intent naming the real resource. Attacked further and held: call 2
with a NEW key buys a *different* domain (`theauthorpitchdesk.com`) and does not re-adopt; a
`domains:2` call adopts one and buys one with two correct intents and no double-fire; an
already-recorded domain is excluded from the adopt pre-pass by `ownedDomainNames`.

### B3 — CLOSED · proven with a REAL forced DO reboot, not just the wiring test

The raw `CREATE UNIQUE INDEX` is gone from the constructor path (the only two raw CREATEs left are
inside `ensureDedupeIndex` and the new `ensurePartialDedupeIndex`, both in try/catch). The builder
disclosed that its behavioral test cannot force a re-boot; I forced one via `state.abort()`:

```
inserted 2 duplicate LIVE rows, dropped the index, abort("adversary forced reboot")
after reboot: booted OK, rows=[{"n":1}]      <-- constructor re-ran, collapsed the dupe, served the request
```

That is the exact brick scenario from round 1, now survivable. Dedupe-collapse completeness
attacked separately and correct: it keeps `MIN(rowid)` of each live group, **preserves** duplicate
*released* rows (outside the predicate, so outside the index), and leaves case-variant addresses
alone — consistent with the index's own BINARY collation, so no residual conflict. `mailboxes.email`
is `NOT NULL` (`schema.ts:191`), so the missing `IS NOT NULL` guard that `ensureDedupeIndex` carries
cannot cause the NULL-group over-deletion it exists to prevent.

### N1 / N5 / N7 — CLOSED

- **N1** `markDomainIntent(..., purchased.domain)` (`provisioning.ts:542`) records what was actually
  acquired. Replaying the round-1 chain (committed intent naming `go*`, no row, `/domains/list`
  outage) now buys `the*` **and renames the intent to `the*`**, so the healthy retry CONVERGES with
  zero buys. Final state: one domain under one key. Round 1 ended with two.
- **N5** the real port's numbered spillover serves exactly `count` unique candidates — executed at
  counts 1/5/6/12/24 against a stubbed client, one availability probe per candidate, no duplicates.
- **N7** `hotfix-h9.test.ts:189` now drives a genuine `VendorError` out of the real InboxKit adapter
  through the REST surface (fetch mocked at the network boundary) and asserts `502` +
  `code:'vendor_error'` + absence of the adapter's operator text. The 404-under-a-502-name theater
  is gone.

### N2 — CLOSED for `VendorError`, with one unswept sibling (see NEW-1)

Seven real adapter strings driven through `toErrorResponse`: the Stripe checkout URL, the
`ENGINE_BASE_URL` 10.x line, `ECONNREFUSED` with an internal IP, the OAuth runbook wording,
"already owned by your team", the DNS-pending text and the credentials-shape error **all** collapse
to one of two generic sentences, with `step` present only for allowlisted vendor operations
(`domains/register` kept; "unreachable"/"manually-minted" dropped). `retryable` still splits the two
messages so an agent can branch. `index.ts` still `console.error`s the full error at ≥500, so
operators lose nothing.

### N3 — HALF CLOSED (non-blocking)

`site/openapi.yaml:106-117` now states the truth plainly: no autonomous background retry, retry the
same key to finish DNS, and *"There is no per-domain DNS field to poll: GET /infrastructure-status
reports a domain count, not per-domain detail."* But the **MCP tool description was not updated** —
`apps/platform/src/mcp/tools.ts` still tells the calling agent a pending domain is *"still returned
by infrastructure_status with its dns state pending"*, which remains false (`dns_status` is still
read by nothing; `InfrastructureStatus` still exposes only a count). The two customer-facing
surfaces now contradict each other, and the MCP one — the text an agent reads at call time — carries
the false half. Practical harm is small now that B1 surfaces the condition as a retryable error
rather than a poll-for-progress state. The clause immediately after it ("can be completed by
retrying — it is never lost") became TRUE with B1.

### Deferred items confirmed untouched

N4 received a comment correction only (`provisioning.ts:128-135` now says plainly that the
re-provision row is unbacked and pre-existing) with no behavior change; N6's
`pendingCredentialPushes` and `ops-sweep.ts:322`'s literal `provisioningFailureCount: 0` are
unchanged. Nothing was half-touched.

## NEW (found while re-attacking the fixes; no verdict weight)

- **NEW-1 · `CapacityPendingError` bypasses N2's generic treatment.** It is a `VendorError` subclass
  but is matched by name earlier (`error-response.ts:94`) and still passes `message` verbatim:
  `{"error":"provisioning held: InboxKit plan-slot capacity reached (12/15)"}` and
  `{"error":"provisioning held: monthly vendor-spend ceiling reached (500000¢)"}` — the vendor's
  identity plus the operator's internal slot counts and monthly COGS ceiling, to a tenant. Like
  VendorError, H6 is what newly exposed it (pre-hotfix REST returned a generic 500). No credentials,
  URLs or hostnames, hence non-blocking — but it is the same class N2 was written to close.
- **NEW-2 · Adoptable candidates are not preferred over buyable ones.** `usable` keeps the
  generator's order, so when the orphan is not the first candidate the code buys the cheaper-ranked
  free name and leaves the paid-for domain stranded. Proven: with `my*` as the orphan and `go*` free,
  it bought `go*`. Mordy is unaffected (his orphan IS candidate 0). A sort putting adoptables first
  recovers the spend.
- **NEW-3 · The adopt pre-pass makes O(candidates) identical `listOwnedDomains` calls.** Measured 6
  for a `domains:1` request; a `domains:20` request would make ~25, each fetching the same
  account-wide list and walking up to 10 pages, all sequential inside one DO turn — plus one
  `DOMAIN_ADOPT_LOOKUP_FAILED` action row per candidate during a vendor outage. One call reused
  across candidates would be equivalent.
- **NEW-4 · `dns_status='ready'` still means "setDns did not throw", not "propagated".** The real
  port returns per-record propagation flags that `setDnsWithRetry` discards
  (`provisioning.ts:354-355`). B1's new guard keys off that flag, so mailboxes can still land on a
  domain whose nameservers have not propagated — defensible as a product choice (waiting would block
  every first provisioning) but the column overstates what it knows.
- **NEW-5 · Test hygiene:** the new REST-502 test does `Object.assign(env, {REGISTRAR_PROVIDER,
  INBOXKIT_API_KEY, INBOXKIT_WORKSPACE_ID})` and never restores them (`vi.restoreAllMocks()` only
  covers `fetch`), arming the registrar env for anything later in that isolate. No leak observed —
  the suite is green — but it is a live grenade for the next test added to that file.

## UNVERIFIABLE (carried forward, unchanged)

Whether InboxKit's `GET /domains/available` really answers `false` for a domain the caller's own
workspace owns — B2's fix makes this question **moot for correctness** (adoptable names are now
rescued regardless of the availability answer), so it is no longer gating; it only affects whether
the round-1 blocker was active or latent. Whether any live tenant DO currently holds duplicate live
rows is likewise no longer gating now that the collapse+catch is in place. The OAuth/credential-push
leg still cannot succeed on a first provisioning (deep-dive F5, deferred), so "provisioned" still
does not mean "can send" — a manual grant-minting step remains a human prerequisite.
