# Class sweep — head-of-line blocking in multi-item loops (2026-08-17)

**Ground ref:** `9d3ec7e9021eb234c6f633540f0cca2aaa99cf2b`
(`9d3ec7e audit: agent-channel product readiness — PRODUCT-READY:NO, F1-F11`).
Working tree at sweep start AND end: only `.claude/agent-memory/spec-builder/*` and
`docs/research/backlink-outreach-targets-2026-08-17.md` dirty — **zero drift in
`apps/platform/src`, `apps/engine/src`, `packages/` during the sweep**.

Scope swept: `apps/platform/src`, `apps/engine/src`, `packages/cli/src`,
`packages/shared/src`, `apps/dashboard/src`. Sibling-agent worktrees under
`.claude/worktrees/` excluded.

---

## 1. Class definition

The brief's class name is **correct in mechanism but one clause too narrow**. It says
"one item's persistent failure permanently starves the remaining items — no skip, no
reorder, no per-item isolation." Two corrections, both load-bearing for what counts as a
member:

**(a) "failure" must include STALL, not just throw.** The brief itself says
"throw/stall", but the natural reading of "no per-item isolation" is "no try/catch". In
this repo the highest-value stall member *has* a per-item try/catch and is still fully
in-class: `reply-processor.ts`'s per-mailbox poll is individually guarded, but every
mailbox draws on ONE shared `SEND_PIPELINE_TENANT_BUDGET_MS` (135s) and the mailbox list
has no `ORDER BY`, so a single mailbox that consumes the 120s
`ENGINE_REQUEST_TIMEOUT_MS` starves every mailbox behind it *on every cycle forever*. A
sweep that greps for "loop without catch" misses it.

**(b) The permanence comes from DETERMINISTIC RE-SELECTION, not from the loop.** The
loop only starves items *within one call*. What makes starvation permanent is that the
next call re-derives the same ordered item list and re-fails at the same head. So the
mechanism is a conjunction of three properties, and a site is IN only if it has all
three:

> **Mechanism (one sentence):** a sequential loop over a durably-selected, stably-ordered
> item list, where one item consumes the whole call (by throwing past the loop or by
> eating a shared budget), and the next invocation re-selects the same list in the same
> order — so the head item's persistent failure is a permanent, silent denial of service
> to every item behind it, with no skip, reorder, quarantine or replace path.

`OUT` therefore means *at least one* of: per-item isolation that lets the loop continue;
a bound/give-up marker that removes the item from future selection; rotation that changes
the order; or an item list that self-drains (successful items leave the queue).

**Corollary the instance shows and the class name doesn't:** F1b is worse than "later
ordinals wait", because the item that blocks is one the *system* chose (an
ordinal-derived domain), not one the caller passed. The customer cannot edit their input
to skip it. That is the property that separates the real members below from the
caller-input loops classified OUT.

---

## 2. Search coverage

### Lexical

All run from `apps/platform/src` unless noted; `--glob '!*.test.ts'`.

```
rg -e '\bfor\s*\(' -e '\bfor await\b' -e '\bwhile\s*\(' -e '\.forEach\(' \
   -e 'Promise\.all\(' -e 'Promise\.allSettled\(' -e '\.map\(async'      # 112 hits / 54 files
rg 'Promise\.all|Promise\.allSettled|\.map\(async'                        # 7 hits
rg 'runDeliverabilitySweep|applyActions|runWarmupCancelSweep|pumpWebhookDeliveries|
    runProvisioningReconcile|reconcileCredentialPushes|runTick\('          # call-site map
rg 'ENGINE_REQUEST_TIMEOUT_MS|ordering ladder|async poll\('
rg 'head-of-line|skip.*ordinal|blocks every later|starv'   ROADMAP.md
rg 'other mailboxes are unaffected|does not block|independently|one domain'
   mcp/tools.ts ../../../site/openapi.yaml docs/for-agents
rg 'reconcile\(' apps/engine/src ; rg 'simpleParser' apps/engine/src/classify.ts
```

Two AST-ish scripts (brace-matched loop bodies, `/private/tmp/.../scratchpad/loops*.py`),
because a flat grep cannot tell a loop *containing* an await from one that merely follows
one:

- `loops.py` — every loop in `apps/platform/src` whose brace-matched body contains
  `await`: **32 sites**.
- `loops2.py` — widened to loops whose body contains `await` **OR** a durable write
  (`sql.exec(INSERT|UPDATE|DELETE)`, `.prepare(...)`, `logAction(`, `emitTenantMessage(`),
  to catch the synchronous-write variant: **45 sites**.
- `loops3.py` — same over `apps/engine/src`, `packages/cli/src`, `packages/shared/src`,
  `apps/dashboard/src`, flagging whether the body contains `catch`: **6 sites**.

### Semantic (surfaces lexical search cannot reach)

Covered per the standing coverage ledger, plus new ones this class needs:

| Surface | Why it can hide a member | Result |
|---|---|---|
| **Call-chain composition** — a guarded loop nested inside an unguarded one | `applyActions` has no per-action catch, so `applyReplaceDomain`'s *internal* catch is irrelevant to the loop above it | found IN-3 |
| **Awaits placed OUTSIDE a function's own try** | `deliverability-actions.ts:166` `await releaseMailboxes(...)` sits above the `try {` at :168 that everyone reads as "this is isolated" | found IN-3 |
| **Cross-service (`apps/engine`)** — the platform's loop is guarded, the engine's is not | `reply-processor` catches per mailbox; the throw originates in `apps/engine/src/engine.ts`'s per-message loop and the platform's cursor is consumer-owned, so the starvation is on the engine side | found IN-7 |
| **Shared wall-clock budgets, not just exceptions** | the 5-rung ordering ladder in `vendors/real/email-port.ts:35-61` — a budget is a starvation mechanism with no `catch` to grep for | found IN-9 |
| **Anchor-row placement** in a multi-step teardown | `teardownTenant` writes `teardown_records` only at the END, so a mid-loop throw means the *whole* teardown re-runs and re-dies at the same domain | found IN-5 |
| **Vendor-port adapters** (`vendors/real/*`) — one network call per candidate inside a loop the engine never sees | `inboxkit-domain-port.ts:124` | found IN-8 |
| **Compliant-but-DARK reconcilers** | `provisioning-reconcile.ts` is the textbook per-item-isolated loop AND is unarmed in prod (audit F5) — so it does not mitigate any member today | noted |
| **Cron lane vs. engine entry point** (ledger) | `scheduled.ts` `runLeg` + `ops-sweep.ts` per-tenant catches: cross-tenant isolation is solid; the class lives strictly *inside* one tenant | all OUT |
| **Claim surfaces** (ledger: "docs CLAIM the missing mechanism") | `mcp/tools.ts:74` promises shortfall-resumption that F1b makes false | found IN-CLAIM |
| **ROADMAP `## Open`** | line 46's "Deadlock-class detector" ORDER is adjacent (a `'unknown'`-connection-type domain waiting forever) but is a *detection* item, not this class | not a member |
| **`wrangler.toml` `[triggers] crons`** | one 5-min cron; the budget ladder is sized against it — config is coherent, no member | OUT |
| Migration SQL / `tools/` / CI | no loops; `tools/` holds `aeo-panel`, `buyer-panel`, `indexnow`, `sdn-relay` — no tenant-item loops | OUT |

**Total classified: 56 loop/fan-out sites + 1 claim surface.**

---

## 3. Inventory

### IN — 9 loop members + 1 claim surface

| # | Site | Reason it exhibits the mechanism |
|---|---|---|
| **1** | `apps/platform/src/engine/provisioning.ts:585-613` | **The confirmed instance.** Sequential per-ordinal loop, no per-item catch; each ordinal's DNS throw gates its own mailbox buy at `:262-264` and propagates out of the loop. Item list is re-derived identically every call (`domainIntentKey(tenantId, ordinal)`). **Scenario:** ordinal 0 = a dead purchased domain ⇒ ordinal 1's healthy domain never gets a mailbox, forever, while the tenant is billed the $49 platform fee + minimum-5 mailbox floor for 0 working mailboxes. |
| **2** | `apps/platform/src/engine/deliverability-actions.ts:406-434` (`applyActions`) — with `:166` and `:241` | No per-action isolation. `applyReplaceDomain`'s `await releaseMailboxes(ctx, {domainId})` at **:166 is OUTSIDE its own `try` (:168)**, and `:241` deliberately re-throws any non-`VendorError`. Either escapes `applyActions`, escapes `runDeliverabilitySweep`, and escapes **`tick.ts:165`, which is unwrapped** (only the warmup sweep below it is wrapped). **Scenario:** tenant has a burning domain A (REPLACE_DOMAIN, emitted first at `deliverability.ts:194`) and a degrading mailbox on healthy domain B (PAUSE, emitted at `:213`). One mailbox on A that the vendor won't release ⇒ B's mailbox is never paused, A's HARD_PAUSE never applies, **and the tenant's entire send loop never runs** — every cycle, while its reputation burns. |
| **3** | `apps/platform/src/engine/lifecycle.ts:203-229` (`releaseMailboxes`) | `await ctx.adapters.mailbox.release(...)` at `:217` is unguarded; list is `ORDER BY created_at DESC` — stable. A mailbox the vendor permanently 404s/403s blocks release of every mailbox behind it. Those rows keep `released_at IS NULL`, so they keep counting toward `syncMailboxQuantity` and the G4 slot counter. **Scenario:** a cancelling customer is billed monthly, indefinitely, for mailboxes the platform believes it still holds — and each retry re-dies on the same head row. Reached from BOTH teardown and REPLACE_DOMAIN. |
| **4** | `apps/platform/src/engine/lifecycle.ts:303-339` (`teardownTenant` domain loop) | `await ctx.adapters.domain.release(...)` at `:308` unguarded, plus `await alertUnresolvedDomainConnectionType(...)` at `:329`. Worse than #3 because the **idempotency anchor `teardown_records` is written only after the loop**: a throw leaves no anchor, so the early-return at `:268-269` never fires and the *entire* teardown (domains, mailbox release, campaign stop, liability ledger) restarts from zero and re-dies at the same domain. **Scenario:** an abuse-terminated or cancelled tenant never completes teardown; vendor resources and liability booking are permanently stranded. |
| **5** | `apps/platform/src/engine/mailbox-provisioning.ts:132-171` (`provisionMailboxesForDomain`) | Per-mailbox loop, no per-item catch; four awaits (`withRequestIdempotency`, `meterProvisionedMailbox`, `maybePushProvisionedMailbox`). Addresses are **deterministic** (`persona{ordinal+1}{index+1}@domain`), so a vendor that permanently rejects one address, or a mailbox intent that exhausts `MAX_BUY_DISPATCHES`, fails identically on every retry. **Scenario:** `inboxesEach:3`, address #1 permanently rejected ⇒ addresses #2 and #3 never bought — and via #1, no later *domain* ordinal is reached either. The two members compose into a single permanent stall at whatever the first bad item is. |
| **6** | `apps/platform/src/admin/watchtower.ts:354-361` (`reconcileAlerts`) | **Verified still present at this ref.** `await upsertWatchtowerState(...)` (D1 write) and `alertEmailFor`/`decideAlert` are unguarded inside the per-result loop; only `trySend` is wrapped. `runWatchtower`'s early return at `:378` covers a *wholly* down D1, not a partial/intermittent write failure. **Scenario:** the first result's D1 upsert fails ⇒ every later check — including `send_starved`, `domain_dns_aging`, `cred_push_aging`, `tenant_do_wedged` — is neither evaluated for alerting nor state-advanced. The founder's only monitoring channel goes silent on the exact tick something is wrong. (Already named by the alert-policy audit as the D1-outage batch abort; unchanged on main.) |
| **7** | `apps/engine/src/engine.ts:237-243` + `apps/engine/src/classify.ts:99` | Per-message loop over one poll batch; `await classifyMessage(...)` is unguarded and `classifyReply` calls `await simpleParser(source)` (mailparser) with no try. Cursor semantics make it permanent: the platform owns the cursor (`reply-processor.ts:271-275`) and leaves it un-advanced on a failed poll **by design**, so the same UID range is re-fetched forever. **Scenario:** one malformed inbound MIME message in a prospect's mailbox ⇒ that mailbox's replies, bounces and complaints are never processed again — stop-on-reply never fires, so the platform keeps mailing a prospect who already answered, and bounce-driven suppression silently stops. The platform-side per-mailbox catch (`reply-processor.ts:305`) contains the blast radius to one mailbox but does nothing to un-block it. |
| **8** | `apps/platform/src/vendors/real/inboxkit-domain-port.ts:124-129` | One real network call per candidate, unguarded, inside `searchLookalikes`. Candidates are deterministic from the brand slug (fixed prefix list + numbered spillover at `:120-122`). A single candidate name the vendor answers with a permanent 4xx (over-long label, reserved name) throws out of the whole search. **Scenario:** the loop returns nothing usable ⇒ `setup_infrastructure` fails at plan time for that brand, on every retry, even though candidates 2..N are fine. Same permanence shape as #1, one layer earlier. |
| **9** | `apps/platform/src/engine/reply-processor.ts:262-308` **(stall variant — the loop IS guarded)** | Per-mailbox catch is present and correct for *throws*. The mechanism here is the **shared budget**: `runScheduledPoll` + `runScheduledTick` share one `SEND_PIPELINE_TENANT_BUDGET_MS` (135s, `ops-sweep.ts:352`), a single engine poll may consume `ENGINE_REQUEST_TIMEOUT_MS` (120s, `email-port.ts:62`), and the mailbox query at `:251-256` has **no `ORDER BY` and no limit** — stable insertion order. **Scenario:** one mailbox whose IMAP host black-holes connections burns 120s of the 135s budget; `withTenantBudget` abandons the pair; mailboxes 2..N are never polled **and the tick never runs at all**, so the tenant sends nothing. Every 5-minute cycle, permanently. `ops-sweep.ts:344-350` reasons about this only for a *wholly* wedged engine ("the tick could not have sent anything either") — that argument does not hold when exactly one mailbox is wedged. |
| **CLAIM** | `apps/platform/src/mcp/tools.ts:74` (`setup_infrastructure` description) | Not a loop; a claim surface that asserts the missing mechanism, which per the coverage ledger is part of the inventory. It tells the agent *"each call keeps and resumes what this account already has and buys only the shortfall, so to provision MORE you ask for a LARGER number (domains:2 after a call that provisioned one buys the second)"*. Under #1 that is **false**: raising `domains` re-enters ordinal 0 and aborts there. Any fix to #1 must correct this sentence or it becomes a lie in the other direction. |

### UNCERTAIN — 5 (none dropped; each with what settles it)

| # | Site | Why unresolved / what settles it |
|---|---|---|
| **U1** | `apps/platform/src/engine/tick.ts:386` (`await buildListUnsubscribe`, inside the due-row loop, **after** the atomic claim at `:338`) | The only unguarded await in the loop other than the graded `send`. It reaches `signUnsubscribeToken` → `crypto.subtle.importKey("raw", encode(TOKEN_HASH_PEPPER), HMAC)`. If the pepper is *unset*, `TextEncoder` coerces to `"undefined"` and it succeeds; if it is the **empty string**, zero-length HMAC key material is a `DataError` per WebCrypto. A throw here aborts every remaining due row with no per-row grading, no `'failed'` event, and no alert — silent total send stoppage. **Settles it:** a 3-line workerd test asserting whether `importKey("raw", new Uint8Array(0), {name:"HMAC",hash:"SHA-256"}, …)` throws, plus a grep for any boot-time non-empty validation of `TOKEN_HASH_PEPPER` (I found none — `env.ts:19` only *types* it as `string`). |
| **U2** | `apps/platform/src/engine/webhook-enqueue.ts:42-73` | Synchronous fan-out loop; `JSON.parse(sub.event_types_json)` at `:44` is unguarded. One subscription row holding non-JSON aborts the fan-out for every later subscription, on **every event, forever** — and it is reachable inside the tick's event path. **Settles it:** confirm `event_types_json` has exactly one writer, that it always goes through `JSON.stringify` of a validated array, and that no migration/backfill ever wrote the column raw. |
| **U3** | `apps/engine/src/reconcile.ts:56-75` | Per-dangling loop at **boot**, no per-item catch. `gmail.lookup` provably never throws (`gmail.ts:162-164` catch-all → `uncertain`), so the only throw surfaces are `deps.store.park` / `deps.store.recordSend` (JSON-store appends). `index.ts:64` awaits `reconcilePendingSends()` with no try, and `main().catch` does `process.exit(1)` — so a throw is a **boot crash loop**, starving every dangling *and* all sends and polls for every tenant. **Settles it:** read `json-store.ts`'s append path for whether a write error throws or is swallowed, and whether a partially-written line can make the *same* item fail every boot. |
| **U4** | `apps/platform/src/engine/suppression.ts:91-115` | Synchronous per-lead loop inside `unsubscribe()`. Each iteration calls `recordEventIfNew`, which carries the webhook fan-out (U2). A throw mid-loop leaves the opt-out partially applied and 500s the unsubscribe route — a CAN-SPAM-relevant surface. Typically 1 item (leads sharing an email), so blast radius is usually nil. **Settles it:** U2's answer; if `event_types_json` cannot be malformed, U4 is OUT. |
| **U5** | `apps/platform/src/engine/tick.ts:257-501` (the due-send loop, latency variant) | No per-tenant row budget inside the loop; the whole tick shares the 135s budget with the poll. Rows are `ORDER BY send_at ASC`, so the queue is FIFO and **sent rows leave it** — self-draining, which is normally an OUT. But a head row that consumes the full 120s engine timeout on each attempt means one row per cycle. `MAX_SEND_ATTEMPTS` + the `SEND_CLAIM_TTL_MS` reclaim do bound it. **Settles it:** compute the worst-case drain time for a realistic due queue where the head rows all time out (rows × `MAX_SEND_ATTEMPTS` × 5-min cycles) and decide whether that bound is acceptable or is de-facto permanent. |

### OUT — 42

Grouped by why each is immune. Every one was read, not inferred from the grep.

**Per-item try/catch that lets the loop continue (the in-repo compliant idiom — 16):**
`engine/provisioning-reconcile.ts:97` (per-domain catch → `deferred`/`errors`; **note: DARK
in prod, audit F5, so it mitigates nothing today**) · `engine/warmup-cancel.ts:87`
(catch + `warmup_cancel_attempts` cap + `warmup_cancel_gave_up_at` give-up marker — the
best template in the repo) · `engine/spend-ceiling.ts:410` · `engine/reply-processor.ts:305`
(throw-isolation only; see IN-9 for the budget) · `engine/infrastructure-status.ts:110`
(guarded `Promise.all` — a prior fix of this exact class) ·
`admin/ops-sweep.ts:49,187,225,291,325,473,542` (all seven per-tenant) ·
`admin/watchtower.ts:191` (per-tenant, and a *wedged* tenant is reported rather than
silently skipped) · `scheduled.ts:47` (`runLeg` per-leg) · `ofac/screening-recovery.ts:36`.

**Callee swallows its own failure — the loop never sees a throw (3):**
`engine/mailbox-credential-push.ts:255` (`pushRecordedMailbox` catches internally and
returns `{pushed:false}`) · `engine/webhook-delivery.ts:90` (`realWebhookDeliverer`
returns a `DeliveryOutcome` on every path, incl. `url_rejected`; plus backoff +
auto-disable at 5 consecutive failures makes the queue self-draining) ·
`engine/provisioning.ts:541` (`findAdoptableDomain` catches its own vendor error → `null`).

**Single-item retry/backoff loops — no second item to starve (10):**
`engine/domain-dns.ts:293` · `engine/mailbox-acquisition.ts:109` ·
`engine/mailbox-provisioning.ts:415` · `vendors/real/inboxkit-domain-port.ts:162`
(paged walk, bounded, permanent-graded overflow) · `vendors/real/mailbox-port.ts:241` ·
`packages/cli/src/client.ts:81` · `apps/engine/src/api-send.ts:49` ·
`apps/engine/src/index.ts:114` (drain wait) · `validate.ts:66` ·
`engine/webhook-security.ts:230`.

**Chunked execution of ONE logical operation — the "items" are not independently
completable (4):** `ofac/sdn-list.ts:123` · `admin/db.ts:111` ·
`engine/contact-operator-guard.ts:229` · `engine/demo.ts:86`.

**Synchronous, no await, no throw-prone call — a DO commits the turn atomically (8):**
`engine/tick.ts:204` (orphan reclaim) · `engine/deliverability-actions.ts:328` ·
`engine/mailbox-state.ts:96` · `engine/provision-intents.ts:409` ·
`engine/legacy-domain-intent-keys.ts:171` · `engine/infrastructure-status.ts:163` ·
`engine/campaigns.ts:127` and `:154` (also caller-supplied input: the customer *can* edit
the bad row out, which is exactly the skip path the IN members lack).

**Fan-out where all-or-nothing is the correct semantic (2):**
`billing/stripe-client.ts:205` (price-slug lookup — a partial price table is worse than
none) · `routes/admin-support.ts:41` (two unrelated queries, not an item loop).

**Stream read inside a single mailbox's fetch (1):** `apps/engine/src/imap.ts:79` — one
mailbox, one bounded UID range; its failure mode is IN-7's, counted there.

---

## 4. Systemic guard

Two layers. The first makes the class un-writable by accident; the second proves the
inventory above stays closed.

### 4a. A shared isolation primitive + a source-scanning tripwire

Add `apps/platform/src/engine/isolated-loop.ts` exporting one helper (name illustrative):

```ts
forEachIsolated(items, fn, { onItemError, quarantine })   // sequential, per-item catch
```

with a mandatory `onItemError` (so a member cannot be written that swallows silently) and
an optional `quarantine` hook that stamps a give-up/attempt column — the idiom
`warmup-cancel.ts` (`warmup_cancel_attempts` + `warmup_cancel_gave_up_at`) and
`provision-intents.ts` (`MAX_BUY_DISPATCHES`) already use, so this is consolidation, not
new abstraction (CLAUDE.md rule c/i).

Then a **tripwire test** in the repo's own established shape —
`test/send-governance-coverage.test.ts` and `test/spend-ceiling-coverage.test.ts` already
do exactly this with `import.meta.glob("../src/**/*.ts", { query: "?raw" })` — call it
`test/loop-isolation-coverage.test.ts`. It parses every source file, finds each
brace-matched loop body containing `await` **or** a durable write, and asserts each is
either (a) routed through `forEachIsolated`, (b) a body containing its own `try`/`catch`,
or (c) present in an explicit `ALLOWED_UNISOLATED_LOOPS` map with a written reason —
mirroring `ALLOWED_SEND_CALL_SITES`. Two mandatory properties learned from this sweep, or
the tripwire is a coverage lie (the ledger's `spend-ceiling-coverage` lesson):

1. The glob must span `apps/engine/src` and `packages/*/src`, not just
   `apps/platform/src` — IN-7 lives in the engine.
2. The allowlist must carry the **retry-loop and chunk-loop** entries explicitly (the 14
   OUT sites in those two groups), so the list documents *why* each is exempt instead of
   the detector silently not matching them.

The tripwire does not catch IN-9 (a budget, not a missing catch). That one needs its own
assertion, below.

### 4b. Failing-test sketches (each must FAIL on the current code)

**T1 — head-of-line, the F1b instance (`test/provisioning-hol.test.ts`)**

```
Given a tenant with domains:2, inboxesEach:1
  and a domain adapter whose setDns THROWS non-retryably for D0 only (D1 always ready)
When  setupInfrastructure runs, then is retried with a fresh idempotency key
Then  D1 has been bought and has 1 provisioned mailbox
  and the recorded probe shape is setDns=[D0,D1], mailbox.provision=[D1's address]
```
On the current code this fails with `setDns=[D0,D0]`, `mailbox.provision=[]` — the exact
probe the audit recorded. This is the revert-fail-restore anchor.

**T2 — per-item isolation, generalized (one case per IN member, same shape)**

```
Given N durable items where item[0]'s vendor call throws persistently
When  the loop runs twice
Then  items[1..N-1] each reached their effect at least once
  and item[0] is recorded as failed/quarantined (an attempt counter or give-up marker)
  and the summary reports it (errors > 0), rather than the call throwing
```
Instantiate for: `applyActions` (assert the PAUSE lands when the REPLACE_DOMAIN release
throws — and separately that `runTick` still sends), `releaseMailboxes`,
`teardownTenant`, `provisionMailboxesForDomain`, `reconcileAlerts` (assert check #2's
state is upserted when check #1's D1 write rejects), `searchLookalikes`, and the engine's
`poll` (assert a poison message is skipped and the cursor advances past it).

**T3 — the stall variant (IN-9), which no try/catch test can express**

```
Given 3 mailboxes where mailbox[0]'s poll never resolves within ENGINE_REQUEST_TIMEOUT_MS
When  the send pipeline runs for 3 consecutive cycles with rotation seeded by nowMs
Then  every mailbox was polled at least once across the 3 cycles
  and runScheduledTick ran at least once
```
This fails today (mailbox[0] burns the budget every cycle; the tick never runs). The fix
is the one the repo already invented one layer up: **per-mailbox rotation offset + a
per-mailbox sub-budget**, exactly `runSendPipelineAllTenants`'s
`offset = floor(nowMs / CRON_PERIOD_MS) % n` + `withTenantBudget` pattern
(`ops-sweep.ts:463-503`), pushed down inside the tenant. `test/send-pipeline-budget.test.ts`
already asserts the ladder, so T3 belongs beside it.

**T4 — the claim surface.** Extend `test/site-claim-surface-scope.test.ts` (or add to the
tools-description guard) so the `setup_infrastructure` "raising `domains` buys the next
one" sentence is asserted against T1's observed behavior, not just present in the string.

---

## 5. Confidence

What I verified directly: every one of the 56 sites was read in source at
`9d3ec7e9`, and the tree did not move under me. The call chains for IN-2
(`applyActions` → `runDeliverabilitySweep` → `tick.ts:165`), IN-7
(`classify.ts:99` → `engine.ts:237` → cursor semantics at `reply-processor.ts:271`) and
IN-9 (the 5-rung ladder) were each traced end-to-end rather than pattern-matched.

What a second sweep with more time should check, and I could not:

1. **U1–U5 are genuinely open**, not soft IN calls. U1 and U3 in particular are cheap to
   settle (one workerd test; one read of `json-store.ts`) and both have severe blast
   radius if they land IN — U1 is silent total send stoppage, U3 is an engine boot crash
   loop.
2. **I did not run the suite.** Everything above is static reading; no test was executed
   and no probe was run. The F1b probe result is quoted from the audit, not re-executed
   by me. Nothing here is "verified passing" — it is verified *present in source*.
3. **Existing tests may already encode the defective behavior.** The ledger's standing
   lesson (a test that pins the bug) applies: before fixing IN-1/IN-5, grep
   `test/provisioning-saga.test.ts` and `test/provisioning-reconcile.test.ts` for
   assertions that *expect* the loop to abort at the first bad ordinal. I listed the test
   files but did not read them.
4. **Concurrency interactions were out of scope.** Every member here assumes a single
   in-order invocation. Whether two overlapping cron cycles change any of these
   conclusions (particularly IN-6's D1 state machine and IN-9's abandoned-but-still-running
   RPC, which `withTenantBudget:384-390` explicitly leaves in flight) is unexamined.
5. **`apps/dashboard`** contributed zero loop sites with awaits — plausible for a React
   client, but I did not separately audit its data-fetching hooks for a client-side
   equivalent (e.g. a list render that aborts on one bad row).
