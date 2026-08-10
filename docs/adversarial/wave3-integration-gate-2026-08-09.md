# Wave-3 combined-diff adversary gate — 2026-08-09

**Target:** `integrate/2026-08-09-wave3` @ `5e42e103a2990bfc59c21963943c838deb21c3ab`
(verified with `git rev-parse HEAD` at review start; matches the ref in the brief).
**Scope:** `git diff main...HEAD` — 5 merged lanes + one dashboard-bundle rebuild
(130 files, +6356/-674).
**Method:** read-only git; executed fault-injection probes in a scratch vitest file
(`test/zz-adversary-wave3-probe.test.ts`, created, run, and DELETED — the tree is
clean at freeze time). No source was modified.

---

## FINAL VERDICT (after ROUND 2): **SHIP** — 0 blocking

Round 1 ruled SHIP-AFTER-FIXES on one blocker (B-1). The fix landed as `414b58e`
and B-1 is **CLOSED** — re-attacked with 11 executed probes against the real
webhook route, all of which failed to break it. NB-4 is also closed. The four
remaining non-blockers (NB-1, NB-2, NB-3, NB-5) were never ship gates and are
carried forward as stated. Round-2 detail is the last section of this document.

---

## ROUND 1 VERDICT: **SHIP-AFTER-FIXES** — 1 BLOCKING, 5 non-blocking, 1 NEW out-of-scope

The wave is strong. Every headline claim I attacked head-on held up under
re-derivation: the D1-outage alert genuinely sends through the *real* cron entry
point, the 413 byte cap genuinely survives a chunked body and a lying
`Content-Length`, the N-1 two-independent-disputes fix genuinely does what it
says, B3's rotation purge is genuinely atomic, and the campaign guard's
"synchronous therefore unraceable" argument is genuinely correct. The one
blocker is a **new** permanent-freeze path opened by the N-1 exemption — the
exact question the brief asked me to answer, answered in the affirmative for one
delivery ordering.

**Ordered fixes required before ship:**

1. **B-1** — narrow the `charge.dispute.created` staleness exemption so it cannot
   apply a dispute whose own resolution has already been processed.

---

## BLOCKING

### B-1 · lens 6 (design) + lens 1 (spec-vs-code) · the `charge.dispute.created` staleness exemption permanently bricks a tenant when a dispute's `created` is delivered after its own `closed(won)`

**File:** `apps/platform/src/engine/billing.ts:452`
(`if (event.type === "charge.dispute.created") return false;` inside
`isStaleBillingEvent`)

**Failure scenario (EXECUTED).** Stripe does not guarantee event ordering — which
is the entire reason `isStaleBillingEvent` exists. For a single dispute `D`:

1. `charge.dispute.closed` (status `won`, `created = T+500`) is delivered first.
   `UPDATE disputes ... WHERE dispute_id = D` writes 0 rows (no row yet), the
   freeze-lift `UPDATE` writes 0 rows (tenant is already `active`), and the
   `dispute` lane watermark advances to `T+500`.
2. `charge.dispute.created` for the same `D` (`created = T+100`) is delivered
   late. The exemption returns `false` before either staleness condition is
   evaluated, so it applies: `UPDATE tenant_profile SET billing_state =
   'disputed' WHERE id = ?` — unconditional, no state guard.
3. `D` has no further events. The tenant is `billing_state = 'disputed'`
   **forever**.

`'disputed'` is terminal here. I grepped every `billing_state` writer in `src/`:
the only statement that can leave `'disputed'` is `billing.ts:768`
(`charge.dispute.closed` with `won`), and that event for `D` has already been
consumed and deduped by `webhook_events`. Every other writer explicitly excludes
the state — `billing.ts:252`, `:613`, `:678`, `:696` all carry
`billing_state != 'disputed'` / `NOT IN ('disputed', ...)`. I confirmed this by
execution as well as by grep: after step 3 I posted a fresh paid
`checkout.session.completed`, which is the recovery path
`billing-state.ts:57` tells the customer to use verbatim ("reactivate via POST
/checkout first"), and the tenant stayed `disputed`.

A frozen tenant sends nothing, provisions nothing and launches nothing
(`isLifecycleFrozen`, `assertNotLifecycleFrozen`). There is no alert on this
transition and no self-heal. The only exit a customer has is to cancel.

**Executed snapshot** (scratch probe, real routes via `postDisputeWebhook`):

```
afterClosed:      "active"
createdRes:       { applied: true, duplicate: false, frozen: true, received: true }
afterCreated:     "disputed"
afterReCheckout:  "disputed"     <-- the documented recovery path does not work
```

**Counterfactual — the exemption is the sole cause.** I measured
`billing_event_order` in the tenant's DO immediately before the late `created`
event landed:

```
lane "dispute", last_event_created = 1786000500     (event.created = 1786000100)
billing_state = "active"                            (intendedBillingState = "disputed")
```

Both refusal conditions in `isStaleBillingEvent` are satisfied — (1)
`event.created < row.last_event_created`, and (2) `intended !== current`. Line
452 is the only statement that returns before they are evaluated. Without the
exemption this event is refused as stale and the tenant stays `active`. This is
a regression introduced by this wave, not a pre-existing condition.

**Why this is not "just revert N-1".** N-1 was a real fix and it works — see
"attacks that failed" #3, where two genuinely independent disputes behave
correctly. The exemption is simply *broader than the state it protects*. Its own
justification — "applying it can only lose time (until its own dispute.closed
lifts it)" — is false precisely when that `dispute.closed` has already been
processed. The `disputes` table is the natural discriminator: the exemption
should not apply to a dispute whose resolution is already on record. (Note that
in the ordering above, `dispute.closed` currently writes **no** `disputes` row at
all, because its `UPDATE ... WHERE dispute_id = ?` finds nothing — so closing
this properly likely means making the closed branch upsert. Naming the shape, not
prescribing the patch; the fix is the builder's.)

---

## NON-BLOCKING

### NB-1 · lens 4 (arm-time plumbing) · the dead-man cannot detect a cron that has NEVER fired, and its compensating control is an open founder click

`WatchtowerDO`'s alarm is armed in exactly one place —
`recordSweepHeartbeat` (`watchtower-do.ts`), whose only caller is the cron sweep
(`scheduled.ts`, last leg). **EXECUTED:** with the DO's storage cleared and no
heartbeat ever recorded, `storage.getAlarm()` is `null` and no alarm exists to
fire. So "cron stopped after running at least once" is genuinely closed (the
lane's own tests prove it, and I re-ran them), but "cron never started" is not —
and `WatchtowerDO` is a brand-new class whose storage is empty at this deploy,
so the window opens the moment this wave ships.

That case is exactly one of the four the deadman test's own header names ("a
deploy that drops `[triggers]`"). Its only backstop is `GET /status`'s new
`sweep_stale` 503, which requires the external prober — and
`ACTIVATION.md:100` still reads "**7. External prober — STILL OPEN** … Not yet
added", corroborated by `ROADMAP.md:181`.

Not blocking because it is a narrow window with a real, already-built compensating
surface. But it is an **arming-checklist item, not a code item**: after deploy,
confirm (a) the `WATCHTOWER` singleton has a non-null alarm, and (b)
`GET /status` returns `sweepAgeSeconds` under 900. Relatedly, the deadman test
header also claims coverage of "a Worker that fails to start" — a DO alarm cannot
run if the Worker cannot start, so that clause over-claims. The module doc in
`watchtower-do.ts` is honest ("see the README/report for the limits of that
independence"); the test comment is not.

### NB-2 · lens 5 · `watchtower_state` growth is still unbounded, and the rewrite widened it

The alerting audit's own closing observation — "`watchtower_state` grows
unbounded, full-table SELECT every 5 min" — is inherited, not fixed. There is no
`DELETE FROM watchtower_state` anywhere in `src/` or `migrations/` (grep-verified).
Every sweep does two full-table reads (`readWatchtowerState`,
`readReportedCheckNames`, `watchtower.ts:390,395`), and the rewrite adds a fifth
per-entity name prefix, `tenant_do_wedged:<tenantId>`
(`watchtower-alerts.ts`), alongside `mailbox_provisioning:`, `mailbox_rebuy:`,
`cred_push_aging:` and `send_starved:`. Rows are per mailbox address and per
tenant and never reclaimed. Harmless at current scale; it is a growth curve, not
a bug.

### NB-3 · lens 2 · B3 covers a tenant DO that THROWS, not one that HANGS

`scanTenants` (`watchtower.ts`) awaits `opsSummary(sinceMs)` per tenant
sequentially with no `AbortSignal` and no timeout, inside a `try/catch` that only
catches a throw. A wedged-but-not-throwing DO stalls the entire watchtower leg
and every leg after it in `scheduled.ts` — including the heartbeat leg, which is
deliberately last. The dead-man then fires, so this is not silent; but its email
says "The 5-minute Cron Trigger appears to have stopped", which is the wrong
cause and points the founder at the wrong thing. B3's stated requirement ("a
wedged tenant DO must be visible, not silently dropped") is met for the shape the
audit executed.

### NB-4 · lens 7 (merge residue) · unused import left by the `mcp/tools.ts` conflict resolution

`apps/platform/src/mcp/tools.ts:16` still imports `RemoveMailboxesInput` from
`@coldstart/shared`. Counted occurrences in the file: **1** — the import itself.
The tool now uses `RemoveMailboxesToolInput` (`schemas.ts`). Typecheck passes
(`noUnusedLocals` is evidently off), so nothing catches it. CLAUDE.md rule (a).
The rest of the conflict resolution is correct: both `MessageIdInput` and
`RemoveMailboxesToolInput` are imported and each used twice, and the 27-tool
count guard passes in the integrated tree.

### NB-5 · lens 5 (guard scope) · the body-cap coverage guard is narrower than the class it pins

`body-cap-coverage.test.ts` globs `../src/routes/*.ts` and
`../src/{mcp,ofac,admin}/*.ts` plus `validate.ts`. Unscanned: top-level
`src/*.ts`, `src/engine/*.ts`, `src/billing/*.ts`, `src/vendors/**`, and any
nested `src/routes/**/` subdirectory (the glob is not recursive). The guard is
otherwise well built — it has an explicit non-vacuity assertion and a comment
stripper with quote-state tracking, both of which I checked. **No straggler
exists today**: I grepped all of `src/` for `req.text()`, `req.json()`,
`req.arrayBuffer`, `req.formData`, `parseBody`, `blob` and `raw.body`, and every
hit is either inside `validate.ts` or a comment. This is a "the guard will not
catch the next one" note, not a live defect.

---

## Attacks that failed (this is what makes the SHIP-AFTER-FIXES meaningful)

1. **Lens 2 — B1, D1 outage against the REAL entry point.** Ran
   `runScheduledOpsSweep(envWithDeadDb(), { mailer })` — the actual cron function
   from `scheduled.ts`, not a leg in isolation — and got exactly one
   `[coldrig] D1 database: UNHEALTHY` email. 24 sweeps across 2 simulated hours
   of sustained outage: still one email. Re-alert at the 6h boundary, then
   RECOVERED. The ordering fix is real and the send path (`RealOpsMailer`,
   `send_email` binding only) genuinely never touches D1. **Held.**
2. **Lens 2 — the 413 actual-bytes cap.** Three shapes against unauthenticated
   `/signup`: (a) a 200 KB body streamed as a `ReadableStream` with **no**
   `Content-Length` — 413; (b) a 200 KB body with a **lying**
   `Content-Length: 42` — 413; (c) an under-cap streamed body — 201, so the cap
   is counting bytes, not rejecting streams. Plus the grep sweep above found no
   route still on the old `{ok,...}` / `c.req.json()` shape. **Held.**
3. **Lens 1 — N-1 with TWO INDEPENDENT disputes** (the documented
   single-dispute-fixture blindness). D1 created@T+100 → `disputed`; D1 won@T+500
   → `active`; D2 (a genuinely distinct chargeback) created@T+200, delivered late
   → `disputed`; D2 won@T+900 → `active`. The exemption does what it was written
   to do, and the monotonic per-lane upsert correctly refuses to pull the
   watermark backwards. **Held.**
4. **Lens 1 — N-2 reader completeness + claim-first ordering.** Grepped every
   `webhook_events` reference in `src/`: `ops-summary.ts:203` is the *only* reader
   that treats the table as a failure count, and `admin/dunning.ts` is a pure
   function over the value it returns. No sibling reader was missed. Claim-first
   ordering is preserved — the `INSERT OR IGNORE` claim still precedes the
   staleness check on both paths; only a marking `UPDATE` was added after it, so
   the OFAC fail-open stays closed. **Held.**
5. **Self-refuted candidate (reported here rather than padded into findings).** I
   pursued "a *fully applied* event whose in-flight marker survived a crash gets
   `applied = 0` on a superseding redelivery, erasing a genuine dunning strike."
   The state is constructible, but every superseding event that makes an older
   `invoice.payment_failed` stale by condition (2) must leave the tenant in
   `active`/`canceled`/`canceling`/`disputed` — and both `active` paths
   (`checkout.session.completed`, `customer.subscription.updated` → active) call
   `recordDunningCycleBasis`, which moves the cycle basis past the erased row
   anyway. The remaining paths are on already-frozen tenants where the strike
   count is inert. **Not a defect.**
6. **Lens 8 — B3 token rotation.** Purge + swap ride one `env.DB.batch()` (a
   single D1 transaction), so neither the purge-first nor the swap-first hole
   exists. No session is exempt, including the caller's — which is correct, since
   the audit showed a stolen cookie can itself rotate. The mint cap (10) evicts on
   `(created_at DESC, rowid DESC)`, a total order that survives same-millisecond
   mints. **Held.**
7. **Lens 5 — B2 `/remove-mailboxes`.** The `releaseInFlight` latch is an
   instance field on a per-tenant DO, checked and set synchronously with no await
   between, so no concurrent RPC can slip past it. MCP and HTTP both reach
   `TenantDO.removeMailboxes(input, key)` and share the `remove_mailboxes:`
   namespace, so the two transports cannot desynchronize. `withRequestIdempotency`
   deletes the claim on throw, so a genuine failure stays retryable. The Stripe
   set-to-N mirror (`stripe-client.ts:290`) is untouched and unaffected: a replay
   does not re-run the function, and set-to-N self-heals on the next reconcile.
   **Held.**
8. **Lens 5 — campaign double-submit guard.** `campaignFingerprint`, the
   duplicate `SELECT` and the `INSERT` are all synchronous, so there is no DO
   input-gate reopen for a concurrent submit to exploit — the comment's reasoning
   is correct, and the concurrency is not merely "tested", it is structurally
   impossible. `content_hash TEXT NOT NULL DEFAULT ''` never equals a hex
   fingerprint, so rows predating the column are inert. `launched_at_real` uses
   `new RealClock().now()`, immune to the 1440x virtual tenant clock — the trap
   the schema comment calls out is genuinely avoided. **Held.**
9. **Lens 4 — WatchtowerDO deploy plumbing, and the constructor-DDL brick class.**
   All four pieces present and consistent: `[[durable_objects.bindings]] name =
   "WATCHTOWER"`, `[[migrations]] tag = "v3" new_sqlite_classes =
   ["WatchtowerDO"]`, `export { WatchtowerDO }` in `index.ts`, and the
   `Cloudflare.Env` augmentation. The constructor does **no** DDL — it only calls
   `createOpsMailer(env)`, which is a total function (`env.OPS_EMAIL ? Real :
   Sandbox`) and cannot throw. The B3-brick class is avoided. **Held.**
10. **Lens 1 — msgchannel F1 re-derivation.** The gate doc named
    `listSurfacedTenantMessages` (tenant-messages.ts:187-202) as the defective
    reader, and that is precisely where the fix landed: `AND read_at IS NULL` in
    the WHERE, and the now-dead `(read_at IS NULL) DESC` sort key dropped — the
    gate's own prescribed option. `listMessagesPage` deliberately still returns
    acked history, which matches its own tool description at `mcp/tools.ts:348`,
    so this is not the ack-writer/preview-reader mismatch it superficially
    resembles. **Held.**
11. **Lens 6 — F2's inverse hole.** Removing `assertNotLifecycleFrozen` from
    `emitOperatorMessage` does not open a reachable hole. The write is reachable
    only from `POST /admin/tenants/:id/messages` behind `ADMIN_TOKEN`, gated by a
    `getTenantIndexById` 404 check, with `kind` a single-value enum
    (`operator_notice`), `severity` a two-value enum, and `body` bounded at 2000
    chars. It spends nothing, sends no email, and cannot reach another tenant.
    Reaching a suspended/canceling/canceled tenant is the channel's ratified
    purpose. **Held.**
12. **Lens 7 — the merge itself.** `tenant-do.ts` auto-merged from three lanes: I
    read the merged result. The three regions are disjoint — column adds in
    `ensureColumnMigrations` (order-independent by construction), the
    `removeMailboxes` rewrite, and the msgchannel facade plus `ping()`. No
    interleaving damage. Tool count 27 verified by its own guard passing *in the
    integrated tree*, not by the lane's word.
13. **Lens 4 — the dashboard bundle rebuild (`5e42e10`).** Verified the chain end
    to end rather than trusting the commit message:
    `public/app/index.html` → `index-C3vBhsDo.js` → `SettingsPage-BOCGByz_.js`,
    and that file contains the new "Rotating signs out every browser session"
    copy. No stale `SettingsPage-*.js` sibling is left in `assets/`. The SPA also
    correctly freezes polling once a token is on screen
    (`useInfrastructureStatus(..., !rotated)`), which is load-bearing — without it
    B3's own session purge would 401 the page and tear down the one and only
    display of the new token.
14. **Lens 5 — lane 5 (byo-teardown) spot-check.** `lifecycle-byo-teardown.test.ts`
    passes unchanged in the integrated tree (part of a 5-file / 139-test run,
    all green). Its diff regions were not touched by the other lanes' merges.

---

## UNVERIFIABLE (not folded into the verdict)

- **The real Stripe second read.** `getDeclineCode`'s network behaviour under a
  genuine Stripe 5xx / timeout could not be driven — the hermetic test env
  neutralizes `STRIPE_SECRET_KEY`, so `resolveDeclineCode` returns `null` before
  any fetch. I verified the *grading* by code trace (never throws, `null` ⇒
  transient ⇒ four-strike grace preserved) and the lane's own tests cover the
  injected-fetch variants. **Resolves with:** one test-mode Stripe call against a
  deliberately-failing endpoint at activation.
- **The WatchtowerDO alarm on Cloudflare's real alarm scheduler.** I exercised it
  only through Miniflare's `runDurableObjectAlarm`. **Resolves with:** after
  deploy, confirm `getAlarm()` is non-null on the `WATCHTOWER` singleton and that
  `GET /status` reports `sweepAgeSeconds < 900`.
- **Whether the external prober is live.** The repo says it is not
  (`ACTIVATION.md:100`). **Resolves with:** founder confirmation of the
  monitoring-service entry. This is what NB-1 leans on.
- **Live-surface drive (lens 3).** No running service or staging deploy is
  reachable from this worktree, so the dashboard rotate-and-copy flow was
  verified by bundle inspection and source, not by driving a browser.

---

## NEW — out of scope, no verdict weight

### N-1 · a late `charge.dispute.created` on a CANCELED tenant, plus that dispute's win, restores `billing_state = 'active'`

**EXECUTED**, real routes:

```
afterCancel:            "canceled"    (customer.subscription.deleted @ T+400)
afterDispute:           "disputed"    (charge.dispute.created @ T+200, delivered late)
afterWonBillingState:   "active"      (charge.dispute.closed won @ T+800)
afterWonStatus:         "active"
```

`billing.ts:747` writes `billing_state = 'disputed'` with **no** state guard,
unlike every sibling writer, so it overwrites `'canceled'`; the win at
`billing.ts:768` then finds `'disputed'` and lifts to `'active'`. The tenant is
no longer lifecycle-frozen and `assertNotLifecycleFrozen` stops rejecting
provisioning and launches. This is the outcome `billing.ts:551`'s own comment
names as the thing to prevent ("resurrecting a canceled tenant").

**Why this is NOT counted against wave 3:** at the moment the late `created`
arrives, the `dispute` lane has no `billing_event_order` row at all, so
`isStaleBillingEvent` returns `false` at the `row === undefined` check —
*before* line 452 is even reached. The N-1 exemption is not load-bearing here;
the behaviour is identical on `main`. It is a consequence of the per-lane
watermark shipped in wave 2. Reported so it is not lost; it belongs in its own
lane with its own fix (a state guard on the `dispute.created` write is the
obvious shape, since both `'canceled'` and `'disputed'` freeze anyway).

---

## Ledger note

Two classes from this review worth carrying forward: **an exemption carved into
an ordering guard inherits none of the guard's failure-direction reasoning — walk
the exempted type's OWN lifecycle, not just the cross-entity case it was written
for** (B-1); and **a dead-man armed by the thing it watches covers "stopped", not
"never started"** (NB-1).

---
---

# ROUND 2 — re-attack of the B-1 fix

**Ref:** `git rev-parse HEAD` = `306261dda89b7a82f2bed03bd54462df9a2ce138`
(`306261d` agent-memory chore, on top of `414b58e` the fix, on top of round 1's
`5e42e10`). Diff `5e42e10..HEAD` is 6 files: `billing.ts` (+67/-11),
`mcp/tools.ts` (1 line), `schema.ts` (comment only), the lane's own test file,
and two agent-memory files. **No scope creep** — nothing outside the B-1 fix and
NB-4 moved.

**Judged against the round-1 checklist, not re-scored on evolving taste.** The
only round-1 ship gate was B-1. NB-1/2/3/5 were explicitly non-blocking in round
1 and are not re-litigated here.

## ROUND 2 VERDICT: **SHIP** — B-1 CLOSED, NB-4 CLOSED, 0 blocking

11 executed probes against the real `POST /webhooks/stripe` route, every one
designed to break the new bound. All 11 failed. Independent verification at the
new HEAD: 160 tests across the 8 most relevant files pass, and
`npm run typecheck` exits 0.

### (a) The original B-1 repro no longer bricks — and the refusal is loud

Same sequence as round 1 (`closed(won)` @T+500 delivered first, then that
dispute's own `created` @T+100):

```
afterClosed:          "active"
disputeRowAfterClosed: [{ dispute_id: "dp_R2A", status: "won", closed_at: <set> }]   <-- the UPSERT half
createdRes:           { applied: false, duplicate: false, stale: true, received: true }
afterCreated:         "active"      <-- round 1 was "disputed", permanently
afterReCheckout:      "active"      <-- the recovery path is alive again
alerted:              true
```

The alert is real, not a response field: Miniflare's `send_email` binding was
actually invoked with `From: "coldrig ops" <ops@coldrig.dev>`, `To:
yaakovscher@gmail.com`, `Subject: [coldrig] unroutable Stripe webhook —
charge.dispute.created`. I verified the mechanism as well as the effect —
`routes/webhooks.ts` fires `alertUnroutableStripeEvent` on `result.stale`, so
the refusal rides the wave-2 anti-silence path. Its wording ("a newer event in
the same lane already superseded this state transition") is still accurate for
this case: the dispute's own `closed` *is* a newer event in the dispute lane.

Both halves of the fix are genuinely load-bearing and I confirmed each
independently rather than trusting the commit message's "proved by partial
revert": the snapshot above shows the UPSERT produced a row where round 1's
plain `UPDATE` wrote zero, and that row (`closed_at` non-null, `status != 'lost'`)
is exactly the witness `isDisputeSettledWithoutFreeze` consumes.

### (b) Attacks on the new bound — all failed

| Attack | Result | Verdict |
|---|---|---|
| `closed(lost)` first, then late `created` | applies, `frozen: true`, → `disputed` | D5 intact — **held** |
| `closed(warning_closed)` first, then late `created` | `stale: true`, stays `active`, row `status='closed'` | **held** |
| N-1: settled D1 + genuinely new D2 delivered late | D2 `frozen: true` → `disputed`, then D2's win → `active` | N-1 survives the bound — **held** |
| Mixed interleave (see below) | correct at every step | **held** |
| `created` with `id` deleted | not settled → applies → `disputed` | biased toward applying — **held** |
| `created` with a numeric `id` | not settled → applies → `disputed` | **held** |
| Replay the refused `created` ×3 | 1st `stale`, 2nd/3rd `duplicate: true`, state never moves | **held** |

The **mixed interleave** was my best shot and deserves spelling out, because it
is the one shape where a refused event could plausibly leave residue. D1 arrives
closed-first (settled); D2 is a genuinely new chargeback that freezes the tenant;
D1's late `created` then arrives *while the tenant is legitimately frozen by D2*;
finally D2 wins.

```
afterD2:      "disputed"   (D2 correctly froze)
d1late:       { applied: false, stale: true }   (refused even though the tenant is already frozen)
afterD1Late:  "disputed"
final:        "active"     (D2's win lifts it — D1's refused event left NO residual hold)
```

This is the property that matters: refusing D1's `created` does not merely avoid
a new freeze, it avoids creating a second, unliftable claim on the freeze that
would outlive D2's resolution.

### (c) Nothing else moved

- **Ordinary ordering unchanged:** `created` → `disputed`, `closed(won)` →
  `active`. The `ON CONFLICT` clause correctly leaves `created_at` alone — the
  row shows `created_at` strictly earlier than `closed_at`, so the UPSERT did not
  clobber the open-row timestamp.
- **Claim-first ordering untouched:** the diff does not move the
  `INSERT OR IGNORE INTO webhook_events` claim; `isDisputeSettledWithoutFreeze`
  runs inside `isStaleBillingEvent`, which is still called *after* it. The OFAC
  fail-open stays closed. Confirmed by executed probe too: a stale
  `dispute.closed(won)` against a newer freeze is still refused (`stale: true`,
  state stays `disputed`).
- **No self-block on the half-applied path:** a `dispute.created` that died
  mid-effects wrote its row with `status='open'` and `closed_at` NULL, so the new
  check returns `false` on redelivery and the completion pass still finishes.
  Traced; the branch is reachable and correct.
- **The out-of-scope canceled-tenant path (round-1 N-1) is byte-identical.**
  Re-ran it and compared against the round-1 snapshot: `canceled` / `disputed` /
  `active` / `active` / `free` — unchanged in every field. Not fixed here (it was
  never in scope), and provably not made worse: that path has no `disputes` row,
  so `isDisputeSettledWithoutFreeze` returns `false` at its `row !== undefined`
  test and behavior is identical.
- **No new reader surface.** I grepped every reference to the `disputes` table:
  it is written and read *only* inside `engine/billing.ts`. No digest, ops
  summary, admin route or dashboard query consumes it, so a "born closed" row
  cannot surprise a downstream consumer. The missing tenant scoping in the new
  `SELECT` is consistent with every existing writer and is not an isolation gap —
  `disputes` has no `tenant_id` column because it is per-DO.

### (d) NB-4 closed

`grep -c "RemoveMailboxesInput" src/mcp/tools.ts` → **0**. The one-line import
removal is the only change to that file in this round, and the 27-tool count
guard plus `mcp.test.ts` both pass.

### Round-2 verification (re-derived, not accepted)

- `npx vitest run` over `stripe-webhook-boundary`, `site-tool-count-claims`,
  `mcp`, `dunning-decline-code`, `watchtower-d1-outage`, `watchtower-deadman`,
  `watchtower-tenant-visibility`, `body-cap-coverage`: **8 files / 160 tests
  passed**.
- `npm run typecheck` (the workspace script, not raw `tsc` — raw `tsc` reads
  stale `.d.ts` in this monorepo): **exit 0**.
- Scratch probe `test/zz-adversary-r2-probe.test.ts` created, run, and DELETED.
  `git status` clean apart from this document. Read-only git throughout.

### Carried forward (unchanged from round 1, non-blocking)

NB-1 (dead-man cannot detect a cron that never fired — **post-deploy arming
check required**: confirm the WATCHTOWER singleton's alarm is non-null and
`/status` reports `sweepAgeSeconds < 900`), NB-2 (`watchtower_state` unbounded),
NB-3 (a hung tenant DO stalls the sweep and misattributes the dead-man alert),
NB-5 (body-cap guard scan roots narrower than the class). Plus the NEW
out-of-scope canceled-tenant resurrection, which needs its own lane.

### Ledger note (round 2)

The fix is a good instance of the right shape for this class: **bound an
exemption by a per-OBJECT witness rather than a timestamp.** Because a dispute is
always created before it is resolved, "its own resolution is on record" is a
stronger and order-independent test — which is why the guard could be moved
*above* the `created === undefined` short circuit and still be correct for an
unordered event.
