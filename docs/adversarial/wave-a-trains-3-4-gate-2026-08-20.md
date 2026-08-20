# Wave A (trains 3 + 4) — combined adversary gate

**Date:** 2026-08-20
**Target:** worktree `.claude/worktrees/integrate-wavea`, branch `integrate/wave-a-2026-08-20`, HEAD `7f1b50c`
(ground re-derived at review time: `git rev-parse HEAD` = `7f1b50ca755f54ba3a8fee6d3c80cc57418b96b2`, tree clean).
**Diff reviewed:** `1b624d9..7f1b50c` — 81 files, +2946/−194.
**Reviewer posture:** refute-by-default, read-only git, all probes executed in an rsync sandbox
(`--exclude node_modules`, node_modules symlinked to the MAIN checkout — the worktree's own
`node_modules` is empty and `npx` walks up to `/Users/yaakovscher/dev/coldstart/node_modules`).

---

## VERDICT: **FAIL** — 1 BLOCKING, 6 NON-BLOCKING.

The wave is substantially correct and the battery is genuinely green. The blocker is not in what
the wave failed to fix — it is in the wave's own headline deliverable. The parent-class ruling this
whole program is graded against is *"an outcome must carry its own provenance"*, and its concrete
vehicle is `Collapsed<T>`'s `deduplicated` flag. Two of that flag's three consumers were proven, by
execution, to report the wrong provenance. One of them does so on the irreversible money path, on
the exact retry sequence the tool's own description instructs an agent to perform.

---

## Battery — re-run by me, real (non-piped) exit codes

| Leg | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` (repo root) | **exit 0**, all 5 workspaces (dashboard, engine, platform, cli, shared) |
| platform | `npx vitest run` from `apps/platform` | **223 files / 2153 passed / 1 skipped — exit 0** |
| dashboard | `npx vitest run` from `apps/dashboard` | **31 files / 164 passed — exit 0** |
| engine | `npx vitest run` from `apps/engine` | **17 files / 144 passed / 4 skipped — exit 0** |
| cli | `npm test -w packages/cli` (`node --test`) | **12 pass / 0 fail — exit 0** |

The battery told me nothing, for the sixth consecutive gate on this project. Both proven findings
came from driving the real functions in a sandbox, not from reading the diff.

---

## Deploy shape — enumerated FIRST, per the brief

**No arm-time plumbing changes at all.** `git diff 1b624d9..7f1b50c -- '**/package.json'
'**/wrangler.toml' '**/env.ts' '**/migrations/**'` is **empty**. No new env var, no new secret, no
new binding, no numbered D1 migration.

Every schema delta reaches live tenants through DO-side `addColumnIfMissing`, both correctly ordered
after the `CREATE TABLE IF NOT EXISTS` block:

- `sent_message_keys.epoch INTEGER NOT NULL DEFAULT 0` (`tenant-do.ts:361`). NOT NULL with a DEFAULT,
  so SQLite accepts the ALTER. Pre-existing rows read `0`, which is exactly the value the new code
  treats as "the bare lookup key" — semantics preserved.
- `tenant_messages.last_occurred_at INTEGER` (nullable) (`tenant-do.ts:367`). Deliberately **not**
  backfilled, and every reader is `COALESCE(last_occurred_at, created_at)`
  (`next-steps.ts:309`). This is the correct handling of the NULL-column class that produced a
  customer P0 on 2026-08-19 — I checked the one new reader and it does not substitute a default.

**IN-15 does NOT change a UNIQUE constraint.** The brief described it as a "UNIQUE constraint fix";
the implementation (`admin/db.ts:244-280`) leaves `UNIQUE(tenant_id, action)` untouched and
accumulates later reasons into the existing row's `evidence_json`. The in-code comment says so
explicitly and gives the right reason (a SQLite constraint drop needs a full table rebuild, which
none of this repo's 18 migrations has ever done, and `countTerminatedTenants` reads
one-row-per-terminated-tenant off that constraint). **There is no DDL risk here.** The brief's
"blocking by default" framing for IN-15 does not apply.

**`clock_multiplier` removal is safe.** It was dropped from `CREATE TABLE IF NOT EXISTS
tenant_profile` and from the `INSERT` — which cannot alter a live DO's existing table, so the column
survives on every live tenant as `NOT NULL DEFAULT 1`. The new INSERT omits it (default applies) and
the new SELECT does not read it. `initTenant` is one-shot (`if (this.tenantId) return`), so no live
tenant re-runs it. Grep confirms zero remaining `clock_multiplier` references in `apps/`, `packages/`
or `migrations/`. The "dead config" premise is independently corroborated by
`wave2-design-review-2026-08-05.md` N3 and `sweep-completeness-pass-2026-08-17.md` C-M3.

**Deploy requirements:** Worker deploy (full build) + site/Pages deploy (openapi.yaml, llms.txt,
server-card.json, 9 HTML surfaces changed) + dashboard bundle (new lazy `MessagesPage` route). No
migration step, no secret step, no flag to arm.

---

## BLOCKING

### B1 · lens 2 (run it) + lens 7 (regression ring) · `remove_mailboxes` reports `deduplicated: true` on a call that irreversibly released real mailboxes

**Mechanism.** `deduplicated` is wired to `intent.replayed` (`engine/billing.ts:1086`), and
`replayed` means only *"a recorded intent already existed for this key"*
(`engine/remove-intents.ts:114` — `if (recorded.length > 0) return { members: recorded, replayed: true }`).
It does **not** mean "this call did no work". The call between them
(`billing.ts:1064`, `await releaseMailboxes(...)`) re-attempts every still-live member of the
recorded set and **discards its return value**, which is precisely the `{releasedCount, failedCount}`
tally that would answer the question.

**Why this is the ordinary path, not an edge case.** The tool's own description
(`mcp/tools.ts:189`) instructs: *"A call that came back with failedCount above zero did NOT finish,
so its key is not frozen: resend the identical request with the same key until failedCount is 0."*
Wave 1+2 round 2 deliberately made `failedCount > 0 ⇒ nonTerminal` so that this retry re-runs the
function rather than replaying a frozen result. So the documented, designed retry always lands on
`replayed: true`.

**The claim it contradicts.** The same description states: *"`deduplicated: true` means this call did
NOT re-perform the downgrade — every count above describes an EARLIER call's already-recorded outcome
under the same idempotencyKey, **not new work done just now**."* And `Collapsed<T>`'s own contract
(`packages/shared/src/provenance.ts:55-62`) defines the flag as *"Was this response produced fresh,
or is it an earlier one handed back?"*

**Failure scenario, EXECUTED** (probe: 5 live mailboxes, `count: 3`, a mailbox port that refuses one
address then heals — the shape of any transient vendor refusal):

```
CALL 1: released=2 failed=1 unreleased=["m3@stragglerco.com"] deduplicated=false
CALL 2: released=3 failed=0 unreleased=[]                    deduplicated=true
release calls to vendor: ["m5@...","m4@...","m3@...","m3@..."]
live mailboxes after call 2 = 2 (started at 5)
```

Call 2 made a fourth vendor release call, irreversibly destroyed `m3@stragglerco.com`, and reported
`deduplicated: true` — "no new work done just now". An agent that trusts the published semantics
records a destructive, unrecoverable operation as a no-op replay.

**Direction of harm.** Under-reporting destruction on the one path whose mistakes are irreversible.
This is the same axis the wave exists to fix, inverted: the sibling finding (NB1) has the flag say
"fresh" when it collapsed; this one has it say "collapsed" when it was fresh.

**Verification method.** Executed in an rsync sandbox against the real `removeMailboxes`
(`apps/platform/src/engine/billing.ts:1050`) via `withTenantContext`, with the repo's own
partly-stuck-port idiom (`test/lifecycle-hol.test.ts:32`). Not traced — run.

**Not covered by the wave's own tests.** `test/remove-mailboxes-collapse-disclosure.test.ts` asserts
three cases — key reused after ageout (`true`), new key (`false`), unkeyed (`false`) — and never a
same-key retry with `failedCount > 0`. The fixture set has no partial-failure member, so the guard
is green by omission.

**Cheap, exact fix (naming it, not applying it).** The value needed is already computed and thrown
away one line up: capture `releaseMailboxes`'s result and use
`deduplicated: intent.replayed && outcome.releasedCount === 0`. Note this is the *third* time
`releaseMailboxes`'s grown return type has been destructured away at this call site — the wave-1+2
gate's CLASS 3 finding was the same discarded value at what is now `billing.ts:1064`.

---

## NON-BLOCKING

### NB1 · lens 2 · IN-7: the 30-day row eviction resets `epoch` to 0, re-mints the ORIGINAL vendor key, and the reply is silently swallowed while reporting `deduplicated: false`

**Mechanism.** `replyToThread` derives the vendor key as `lookupKey` when `epoch === 0` and
`${lookupKey}:e${epoch}` otherwise, where `epoch = persisted.epoch + 1`
(`engine/threads.ts:176-193`). The epoch is derived **from the row** — which is correct for the
crash-retry case the design targets, and is why "epoch 0 = bare key" is stated as a virtue. But the
same function evicts rows older than `SENT_MESSAGE_KEY_TTL_MS = 30 days`
(`threads.ts:224`), tenant-wide, on **every** reply. Once the row is gone the epoch recomputes to 0
and the bare key — the one the first send already spent — goes back to the vendor.

The vendor remembers it. `apps/engine/src/store.ts` never prunes `state.sends`: `getSend(key)`
(`store.ts:151`) reads a map that compaction snapshots whole (`store.ts:310-322`) with no TTL and no
delete path. The sandbox port is the same shape (`vendors/sandbox/email-port.ts:33-46`, a `Map` with
no TTL, cached for the DO's lifetime per `tenant-do.ts:191-198`).

**Failure scenario, EXECUTED:**

```
day0  reply  "Following up on this."      -> mid=<c44e8cdb-…@sandbox.local>  dedup=false  sentEvents=2
day31 reply  "A completely different…"    -> (its DELETE sweep evicts the day-0 row; rows=[only the new hash])
day31 reply  "Following up on this."      -> mid=<c44e8cdb-…@sandbox.local>  dedup=false  sentEvents=3
SAME_MESSAGE_ID_AS_DAY0=true
```

The day-31 repeat added **zero** sent events — no email left the building — returned HTTP 201, the
day-0 `messageId`, and `deduplicated: false`.

**What is new vs pre-existing.** The *swallow* is pre-existing: before this wave the row was
believed for its full 30-day life and the same eviction hole existed beyond it. The wave strictly
improves the common case (a 3-day repeat now genuinely sends). What is **new** is two affirmative
false claims on this path:
1. `deduplicated: false` means "produced fresh" per `provenance.ts:55-62`. It is not.
2. `mcp/tools.ts:133` now tells agents the body hash is *"matched for 10 minutes only"*. The
   platform's table matches for 10 minutes; the vendor's cache matches forever.

**Graded NON-BLOCKING** because the customer-visible harm is pre-existing and unchanged in
magnitude, reachability requires a >30-day gap plus an identical body on the same thread plus an
intervening reply, and the wave moves the needle the right way. But **the IN-7 class-closure claim
must be qualified rather than recorded as closed** — the class is "a genuine repeat reply is
silently swallowed and reported as success", and a reachable member survives.

The root shape worth naming for a follow-up: `sendWithGuards`/`EmailPort` returns
`{messageId, sentAt}` with no field saying whether the vendor collapsed the call. Every
`deduplicated` value on this path is therefore inferred from our own table rather than observed. That
is the same substitution B1 makes.

### NB2 · lens 5 (fixture realism) · `dtoParity.test.ts` is not additive — an 18th hand-mirrored DTO lands unguarded

C-M1's whole premise is "the 9th hand-mirrored DTO copy drifted". The guard closing it is a
hand-maintained 17-entry `PARITY_CASES` list (`apps/dashboard/test/dtoParity.test.ts:77-95`) with
**no companion assertion that every mirrored interface in `types.ts` appears in it** — unlike its
sibling G1, which has exactly that (`tool-claim-binding.test.ts:220`, *"tool 29 can't land without
one"*).

**Proved:** I appended an 18th interface to the sandbox's `apps/dashboard/src/api/types.ts` —
`export interface WebhookSummary { id: string; bogusFieldThatDoesNotExistOnTheServer: number }` —
a hand-mirror of `engine/webhooks.ts`'s 8-field `WebhookSummary` with completely wrong fields.
`npx vitest run test/dtoParity.test.ts` → **17 passed, green.**

I did verify the list is *currently* exhaustive: `types.ts` declares 26 exported types = 17 listed +
8 named exclusions (`InfrastructureStatus` + the 7 no-server-counterpart wire shapes) +
`ActivationSurfaceState` (a string-literal union, not a mirror). So this is a future hole, not a
present miss. The `InfrastructureStatus` exclusion itself is **justified** — it is a narrower client
view, and W-M5 routes message rendering through `GET /messages` rather than widening it, which is
the CLAUDE.md rule (i) answer.

### NB3 · lens 8 · IN-15's "bounded by DISTINCT reasons" is false; it is bounded by *consecutive*-distinct reasons

`admin/db.ts:271-274` compares the incoming reason against **only the last** entry
(`const latestReason = subsequent.length > 0 ? subsequent[subsequent.length - 1]!.reason : existing.reason;`
then `if (latestReason === params.reason) return false;`). Reasons alternating A, B, A, B… append on
every call, so the in-code claim *"Bounded by DISTINCT reasons, not by call volume"* is wrong.

This is notable less for its blast radius than for its provenance: it is the **same two-state
comparison** the builder's own agent-memory file committed in this very wave
(`.claude/agent-memory/hard-builder/changed-detail-escape-storms-on-alternation.md`) says is wrong,
and for which they correctly *deferred* IN-17 to Wave B as a design increment ("a per-episode
ANNOUNCED SET, not a comparison against the last detail"). The lesson was written down and then not
applied one file over.

**Reachability is genuinely small:** the only non-test caller is `admin/terminate.ts:36`, behind
`ADMIN_TOKEN` — a single human operator. Growth is per admin toggle, into a D1 TEXT column. Reported
as a false load-bearing invariant sentence (what the next edit will trust), not as a live risk.

### NB4 · lens 1 (spec-vs-code) · `listSurfacedTenantMessages`'s docstring still describes the pre-fix world

`engine/tenant-messages.ts:284-286` justifies the F9 operator-first ordering with: *"`emitTenantMessage`'s
dedup branch RE-STAMPS `created_at` on every re-trigger, so a tenant with five or more domains each
refreshing a per-domain `retry_setup` pushes a human operator's reply out of the preview entirely."*
IN-3 removed that re-stamp in this same wave (`tenant-messages.ts:157`).

The **decision** survives (a burst of genuinely NEW per-domain rows still displaces a cap-5
newest-first preview, so operator-first is still right); the **stated mechanism** is now dead code
prose. Grading the two separately because a false invariant sentence attached to a correct decision is
what the next edit builds on.

### NB5 · lens 5 · G1's `extra:` is an unfenced escape hatch (no live false claim today)

`RESULT_TYPES[*].extra` (`tool-claim-binding.test.ts:141-210`) is a hand-written list of field names
that satisfies the claim-binding check with no independent oracle — nothing checks that an `extra`
field is ever actually returned. Adding a bogus field to a description plus to `extra` is green by
construction.

I checked every current `extra` entry against its real return site rather than assuming: `pausedAll`
(`routes/campaigns.ts:35`), `provisionedAfter`/`projectedMonthlyCents`/`formula`
(`MailboxBilling`, `billing.ts:986`), `currentRev`/`currentLayout` (`error-response.ts:34,135`),
`deduplicated` (`threads.ts:177,253`, `contact-operator.ts:73,150`, `billing.ts:1086`).
**All resolve. No false claim is currently hidden.** This is a guard-design note, not a defect.

### NB6 · lens 5 · the IN-14 source guard's window and reply-block check are narrower than their titles

`test/dsn-metadata-refresh.test.ts:106-121` pins the opt-in set by scanning `block.slice(0, 600)` for
`refreshMetadataOnRepeat: true`, and asserts absence on `replyBlocks[0]` only. A DSN block whose
literal grows past 600 chars fails in the safe direction (false RED), but a *second* reply block
would go unchecked. Minor; named so the next edit knows the bound exists.

---

## Rulings requested

**1. The four train-3 sweep UNCERTAINs.**

- **(a) `AGENTS.md:9` "you call 28 intents over HTTP, the hosted MCP endpoint, or the
  `agent-cold-email` CLI" — RULE: REAL (minor) claim drift, an IN-class member of train 3's own
  family. Settle it in-repo; no founder ask needed.** The CLI dispatches **nine** REST-facade
  subcommands (`packages/cli/src/index.ts:49-67`: demo, signup, setup, status, campaign, inbox,
  metrics, pause, account) plus `mcp`. All 28 intents are reachable through the CLI *only* via
  `agent-cold-email mcp`, the stdio bridge — and `commands/mcp.ts:1-6` says so itself: *"This is the
  only command in the CLI that talks MCP JSON-RPC instead of the REST facade… the other nine
  commands."* Honest phrasing: "…or the `agent-cold-email` CLI's `mcp` bridge (its nine direct
  subcommands cover the common path)."
- **(b) `terms.html:75` `support@epiphanymade.com` vs routed `support@coldrig.dev` — RULE: NOT DRIFT.**
  Repo evidence is decisive and consistent: EpiphanyMade is the named operating entity
  (`terms.html:91`, `privacy.html:89`, `aup.html:41`), and **every** entity/legal contact on the site
  is `@epiphanymade.com` — `legal@`, `privacy@`, `abuse@`, and this `support@`. The deliberate
  legal-contact vs product-support split is real, not an oversight. **One residual that IS a
  ROADMAP-ASK:** whether `support@epiphanymade.com` is actually monitored/routed is an operational
  fact no repo artifact can settle — confirm the mailbox, don't change the page.
- **(c) `contact-operator.ts`'s `list_messages`-or-`infrastructure_status` disjunction — RULE: ACCURATE,
  no change.** An operator reply is `source='operator'`, and `listSurfacedTenantMessages` sorts
  `(source = 'operator') DESC` before the cap-5 (`tenant-messages.ts:301`), so it cannot be evicted by
  system churn; `listMessagesPage` is the complete surface. The two are not equivalent (unread cap-5
  preview vs full paginated history incl. acked), and the descriptions already say so at both sites.
- **(d) `AGENTS.md:85` unbounded "poll `infrastructure_status` until ready" — RULE: ROADMAP-ASK
  (wording), not a blocker.** It sits inside the sandbox/demo walkthrough, where the fault-injecting
  sandbox does converge. But `setup_infrastructure`'s own description now warns that
  `capacity_pending` means *"polling will NOT progress until an operator raises it"*, so the
  unqualified "poll until ready" is the weaker of two co-resident claims. Cheapest correction: add
  "…or until `nextSteps` says otherwise" — same sentence, no new surface.

**2. The `sweep-signals.test.ts` overturn — LEGITIMATE SPEC CHANGE, not defect-as-spec.** The test
was named *"an intermittent leg never produces an alternating alert/recovery pair"* and asserted
`legSubjects(mailer)).toEqual([])` — total silence over 12 real failures, which is strictly stronger
than its own name and is IN-8 written down as the requirement. The replacement asserts the property
the name states (exactly one UNHEALTHY, zero RECOVERED) and I verified the mechanism composes
correctly across both layers: on a good tick the new `gradeStreak` returns `null` (HOLD), the caller
pushes **no** `CheckResult`, so `decideAlert` is never called with `healthy: true` and
`healthyState()` cannot zero `unhealthyObs`. The anti-storm property therefore survives at both the
grader and the policy layer. I also confirmed the "RECOVERED email for an incident never announced"
class stays closed: `watchtower-policy.ts:222` emits `recovered` only when `episode.alertCount > 0`,
else the silent `healthy`.

**3. IN-1 key left coarse — RATIFIED.** Disclosure genuinely closes the customer-facing half: the
collapse now returns `deduplicated: true` (`contact-operator.ts:73`) and the description names the
limitation in the agent's own vocabulary (*"This is a TEXT match, not an intent match"*) plus two
working escapes (vary the wording; raise urgency, which always files). Narrowing the key would
remove the rate control the guard exists for — each admission can cost an ops email, and the cap is
5/hour with `retryAfter` surfaced on the 429. I checked the disclosure is honest in both directions:
`contact_operator` is the one `Collapsed<T>` consumer with **no** wrong-provenance path — the
`duplicate` arm returns before filing anything, and every filed ticket returns `false`.

**4. IN-18 NOT-A-DEFECT — RATIFIED, and the implementation shape is the right one.** `POST
/api/waitlist` is unauthenticated by design, so the sweep's own G1 "disclose the collapse" remedy
would convert a marketing form into an email-enumeration oracle at one probe per address (CORS
constrains browsers, not curl). The fix makes `insertWaitlistEmail` return `void`
(`db.ts:288`) rather than returning the boolean and dropping it at the call site — correct, because
it removes the value a later "helpful" edit could forward. Responses are byte-identical
(`routes/waitlist.ts:82`, one `json({ ok: true }, 200, origin)` for both paths) and pinned by
`test/waitlist-nondisclosure.test.ts`. Residual, stated for completeness and not actionable: a
timing side-channel between an `INSERT` and an ignored `INSERT` exists in principle and is not
measurable across D1 + network.

**5. The Wave-B deferral set (IN-9/10/11/12/17 + U-2) — CONFIRMED, nothing deferred is a NOW-blocking
ship risk.** All six are ops-side under-alerting (the founder learns late), never customer-facing,
and none is a regression introduced here. Two specifics worth recording:
- **IN-9 is now *less* reachable, not more.** The layer-2 debounce zeroes `unhealthyObs` on a healthy
  observation — but the IN-8 fix means an intermittent leg emits **no result at all** on a good tick,
  so nothing zeroes it and the two layers compose correctly. IN-9 remains open only for checks that
  report a verdict every tick (`d1`, `engine`, `do_storage`), exactly as before this wave.
- **IN-17's deferral reasoning is sound and is the same reasoning NB3 above says was not applied to
  IN-15.** The builder's committed rationale — a changed-detail escape needs a materiality key plus a
  durable per-episode announced set, i.e. a design increment — is right, and Wave B should treat
  `admin/db.ts`'s `subsequentActions` as a member of that increment rather than a settled item.

---

## Attacks that FAILED (this is what makes the non-findings meaningful)

- **Dangling openapi `$ref`s** (my highest-prior class here — this repo shipped 6 dangling refs on a
  previous count sweep, and this wave adds a `/remove-mailboxes` path). Parsed `site/openapi.yaml`,
  collected `components.{schemas,responses,parameters,requestBodies,headers}`, regexed all refs:
  **74 refs / 74 pool / 0 dangling / 0 unreferenced, 36 paths.** Clean.
- **G1 does not actually bind (positive control).** Planted `Returns { messages, nextCursor,
  totalUnackedCount }` on `list_messages` without touching `extra` → guard went **RED** naming the
  exact field: *"list_messages claims field(s) not on its declared result type: totalUnackedCount"*.
  The guard is real.
- **MessagesPage XSS / untrusted-content rendering.** `message.body` is a plain JSX text child
  (`MessagesPage.tsx:42`); no `dangerouslySetInnerHTML` anywhere in the file. React auto-escapes.
  The DOMPurify/sandbox idioms in this dashboard are for email HTML, a different surface.
- **`created_at` immutability un-protects rows from a retention sweep.** My leading hypothesis was
  that freezing `created_at` would let `pruneTenantMessages` delete an actively-recurring row.
  Refuted by reading it: the prune keys on `expires_at` and `read_at` only
  (`tenant-messages.ts:591-598`), never `created_at`. Each leg is also aged on its own column's clock
  (`realNowMs()` vs `ctx.clock`), which is the correct cross-domain handling.
- **The two re-aged continuity fixtures are weakened.** They are not: both now age `created_at` **and**
  `last_occurred_at` to the same backdated value, which is what "genuinely stale" always meant (first
  seen long ago AND not recurred since). The wave also added the exact test the r3 gate said was
  missing — *"does NOT expire a resolved row that RECURRED inside the grace, however old it is"*.
- **The synthetic message-id reaches the wire.** Swept every `inReplyToMessageId` producer: the only
  two non-test sites are `threads.ts:217` and `tick.ts:449`, both hard-coded `null`. The claim holds
  structurally at HEAD.
- **Synthetic-id collision between two distinct replies.** `sha256(rawSource)` over the full RFC 5322
  bytes; two genuinely distinct replies differ in at least `Date`/`Received`. The degenerate
  empty-source case cannot arrive because `resolveOriginal(source, …)` must match In-Reply-To /
  References first. The residual the code documents (byte-different refetches → duplicate reply) is
  the over-count direction, which is the safe one.
- **`gradeStreak` storms in either direction.** Traced both with the real thresholds
  (`LEG_ALERT_AFTER_SWEEPS = 3`, `LEG_RECOVER_AFTER_SWEEPS = 3`): alternating bad/good alerts once at
  t5 and then only re-alerts on the existing backoff ladder; full recovery still requires 3
  consecutive clean ticks and correctly clears; a never-announced episode ends silently via
  `alertCount > 0`. `healthy` is still zeroed on every bad tick, so the recovery hysteresis is intact.
- **IN-6 (severity silently downgraded by a shared dedup key) is still open.** It is closed at HEAD:
  the keys are namespaced by outcome — `pending:` / `retry:` / `failed:`
  (`provisioning.ts:796,830,880`) — so an `info` note can no longer overwrite an unread
  `action_required` in place. The surviving `tenant:<id>` fallback is a deliberate scoping (one
  condition when there is no in-flight domain) and is documented as such.
- **IN-13 and IN-4 ALREADY-FIXED dispositions** (2 of my 3 spot-checks, IN-6 above being the third).
  IN-13: `setup_infrastructure`'s description now states outcomes carrying `provisioning` and
  quoteOnly previews are *not* recorded against the key, so the same-key retry re-runs. IN-4:
  `listSurfacedTenantMessages` sorts operator-first before the cap-5, and IN-19's disclosure text
  admits a 6th distinct unacked message can still fall off. Both genuinely fixed.
- **`refreshMetadataOnRepeat` moves `ts` or escapes tenant scope.** It does neither: the UPDATE is
  `WHERE tenant_id = ? AND type = ? AND message_id = ?`, matching the unique index exactly, `ts` is
  untouched by design, the function still returns `false` so no webhook re-fires, and the
  `messageId !== null` conjunct is correct because SQLite NULLs are distinct in a unique index.
- **`JSON.parse(existing.evidence_json)` can throw and brick terminate.** The column is
  `NOT NULL DEFAULT '{}'` (`migrations/0003_lifecycle.sql:28`) and
  `insertEnforcementActionIfNew` is its only writer, always via `JSON.stringify`.
- **`listMessagesPage`'s keyset cursor loses rows under a mid-drain ack.** An acked row moves to the
  read partition, where `(read_at IS NULL) < cursor.unacked` matches the first disjunct, so it is
  re-emitted, not skipped — an over-count, the safe direction, and pre-existing.

---

## UNVERIFIABLE (not folded into the verdict either way)

- **Whether the live paying tenant's replies traverse `RealEmailPort` (engine daemon, `sends` map
  durable forever) or `SandboxEmailPort` (in-memory, DO-lifetime).** `useRealEmail = !isDemoOrFree &&
  activated && engineConfig !== undefined` (`vendors/factory.ts:137`) is a runtime conjunct I cannot
  evaluate from the repo. It changes NB1's residual window from "until the DO is evicted" to
  "forever", not whether the defect exists. **Resolves by:** `wrangler deploy --dry-run` for the
  binding manifest, plus the tenant's `activated` state.
- **A second NB1 mechanism I could not close: cross-clock-domain `sent_at`.** The new comparison
  `now - persisted.sent_at < CONTENT_HASH_REPLAY_WINDOW_MS` puts `ctx.clock.now()` against a
  vendor-supplied `sentAt`. For a paid tenant whose clock migration failed
  (`tenant-do.ts:311-321` keeps the VirtualClock and retries next construction), that would be
  virtual-vs-real. I could not establish reachability: the same comment says "auto-send stays gated
  off" for that state, and I could not determine whether a *manual* reply is covered by the same
  gate. **Resolves by:** naming the gate that gates manual replies on a failed clock migration.
- **Whether `support@epiphanymade.com` is monitored** (ruling 1b). No repo artifact can answer it.

---

## NEW (out of scope, no verdict weight)

- `apps/platform/src/mcp/tools.ts:74` (`setup_infrastructure`) is a single ~4,600-character string
  literal. It is the surface train 3 is grading for truth, and at that length no reviewer — human or
  guard — can hold it. G1 only checks the fields inside `Returns { … }`; every other factual claim in
  those 4,600 characters is unbound. Worth a structural answer (a composed description built from
  per-claim fragments each bound to its source) rather than another prose pass.
- `packages/cli` remains a `node --test` suite while everything else is vitest. `npx vitest run` there
  reports a false red. Not this wave's doing; recorded because it repeatedly costs a gate cycle.

---

## Harness notes for the next gate on this branch

- The worktree's `node_modules` is **empty** (1 entry). `npx` walks up to the MAIN checkout's
  `/Users/yaakovscher/dev/coldstart/node_modules`. An rsync sandbox must symlink there, and at
  `apps/platform`, `apps/dashboard`, `apps/engine` as well — symlinking only the sandbox root gives
  `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'` from the vitest config timestamp file.
- The workers pool still swallows `console.log`. Collect into a module-level array and dump it
  through a deliberately failing `expect(dump.join("\n")).toBe("@@DUMP@@")`.
- `npx vitest run` from the REPO ROOT reports ~192 failed files on a perfectly green tree. Run from
  `apps/<name>`.
- Read `git diff base HEAD -- .claude/agent-memory` first. The builder's own committed memory named
  the mechanism behind NB3 in this very wave.
