# WAVE 2 DESIGN — adversary review (2026-08-05)

> Fresh-context adversarial attack on `archive/2026-08-05-provisioning-fixwave-plan/wave2-design-2026-08-05.md`.
> Ground: main @ `ef1c2db` (`git rev-parse HEAD`), branch `main`, working tree clean except ` M ROADMAP.md` + the untracked design doc.
> Read-only: no writes outside this file, no state-changing git/shell. Sibling worktrees at `../coldstart-wt-*` were NOT read — every citation below is from the main tree at `ef1c2db`.

## VERDICT: **NO-SHIP** (8 BLOCKING)

---

## FINDINGS

### 1. BLOCKING — The tick will assign every send to a demo-era SANDBOX mailbox, and the activation predicate cannot see it

**Failure scenario.** Every tenant signs up as plan `demo` (design's own CRITICAL DISCOVERY). `setupInfrastructure` has **no plan gate** (`apps/platform/src/tenant-do.ts:503`), and `createVendorAdapters` hands demo/free tenants the sandbox bundle (`apps/platform/src/vendors/factory.ts:140`, `useSandbox = isDemoOrFree || …`). So a tenant who explores before paying gets real `mailboxes` rows with `provider='sandbox'`, `slot_counted=0`, `source='provisioned'`, `deliv_status='healthy'`, `released_at IS NULL`. Nothing at upgrade releases them — `billing.ts`'s only `releaseMailboxes` call is the customer-initiated downgrade (`apps/platform/src/engine/billing.ts:686`).

The tick's capacity picker query filters on **only** `deliv_status != 'paused'` and `first_send_eligible_at` (`apps/platform/src/engine/tick.ts:277-286`) — no `released_at`, no `slot_counted`, no `source`. `pickMailboxWithCapacity` returns the **least-loaded** candidate (`apps/platform/src/engine/scheduler.ts:27-31`). A sandbox row's `sent_today` never increments, because the increment (`tick.ts:428`) is downstream of a `send()` that throws. So the sandbox row sits at `sent_today = 0` forever and is **strictly** least-loaded from the second real send onward — and wins ties from the first, since it is earlier in table order and the reduce uses `<`.

Result: with auto-send armed, every due row in every tick is assigned to a mailbox the engine has no credentials for, gets HTTP 422, and after `MAX_SEND_ATTEMPTS = 5` (`tick.ts:33`) lands terminal `'failed'`. The real mailboxes send **nothing**. The campaign drains to failure in ~25 minutes of cron.

**Why the design's guard misses it.** Predicate leg 5 defers on `mailbox_cred_pushes.status='pending'`. A sandbox mailbox **never gets a push row at all** — `maybePushProvisionedMailbox` returns early on `mailbox.provider === "sandbox"` (`apps/platform/src/engine/mailbox-credential-push.ts:146`), and `deps` is `undefined` while unarmed anyway. So `NOT EXISTS(pending)` is TRUE and leg 5 waves the tenant through. The guard is keyed to a strictly narrower population than the hazard it names.

The design already holds the right discriminator (`slot_counted`) and uses it for the warmup RESET, but never applies it to send eligibility.

**Verification:** traced by reading (tick.ts picker + scheduler.ts + factory.ts + tenant-do.ts:503 + mailbox-credential-push.ts:146); the picker-order behavior confirmed against the reduce's strict `<`.

**Required change:** the migration must retire sandbox-origin mailboxes (or the picker must exclude them). Note the caveat: `slot_counted INTEGER NOT NULL DEFAULT 0` (`schema.ts:281`) means a real mailbox provisioned before that column existed also reads 0 — retiring purely on `slot_counted=0` needs a guard for that population.

---

### 2. REFUTED-CLAIM + BLOCKING — Leg 5's entire rationale is false: unknown-mailbox is graded **RETRYABLE**, deliberately

Design: *"an uncredentialed mailbox makes the engine throw UnknownMailboxError = PERMANENT VendorError → tick marks due rows 'failed' INSTANTLY (`tick.ts:389-421`)."*

`UnknownMailboxError.status = 422` (`apps/engine/src/errors.ts:29-35`, mapped through `statusFor` at `errors.ts:86`). `RealEmailPort.call` grades `retryable = res.status >= 500 || RETRYABLE_ENGINE_STATUSES.has(res.status)` with `RETRYABLE_ENGINE_STATUSES = new Set([409, 422])` (`apps/platform/src/vendors/real/email-port.ts:53, :117`). The comment directly above that set says why, in the design's own words inverted:

> `422 — unknown mailbox: the operator adds the mailbox to the engine creds file, after which a retry succeeds. Terminal-failing here would burn the whole due queue (no requeue path) on a fixable misconfiguration.` (`email-port.ts:43-46`)

So the tick reverts the row to `'pending'` and retries under the cap — it does **not** fail instantly. The design cites the exact line range containing the code that refutes it.

The consequence is not "no guard needed" — after 5 attempts the row does go terminal. But the design must re-derive the guard from the true behavior, and the true behavior points at **per-mailbox** exclusion (don't pick an uncredentialed mailbox), which also closes finding 1. Whole-tenant deferral is simultaneously too broad (finding 3) and too narrow (finding 1).

**Verification:** read both files; grading is a pure function of the HTTP status, no branch escapes it.

---

### 3. BLOCKING — Whole-tenant cred-defer is a permanent, silent zero-send state on the manual mint path

The design calls leg 5 "quiet, self-healing (5-min reconcile drives pushes)" and "short-lived." Neither holds on the path this wave actually ships.

- **What creates `'pending'`:** `recordProvisionedMailboxForPush` (`mailbox-credential-push.ts:78-88`), one row per real-provisioned mailbox.
- **What clears it:** only a successful push (`:118-123`). Nothing else.
- **The mint:** `buildCredentialPushDeps` wires `ManualOAuthMinter` reading the static `GMAIL_OAUTH_GRANTS` secret (`:63`). The programmatic minter stays DARK per the design's own Inc-F ordering. A mailbox with no grant in that secret throws at mint time on every reconcile, forever, until an operator edits a Worker secret.

So one un-granted mailbox out of N holds **the entire tenant's** sends at zero, indefinitely, with no alert — the design explicitly chose "quiet." For the platform's only paying customer, whose entire purchased function is sending, a silent permanent zero-send is the worst available failure shape.

It composes with a known open defect: ROADMAP `## Open` line 28 carries **N4 — "claim-outlives-teardown billable-row-no-vendor-mailbox."** Such a row is live (`released_at IS NULL`, so the design's join matches it) and its `fetchCredentials` → `resolveMailboxUid` can never succeed. That is a `'pending'` row that is unclearable **by construction**, and under leg 5 it starves the tenant forever.

**Verification:** traced every writer/reader of `mailbox_cred_pushes.status` in `mailbox-credential-push.ts`; confirmed no other clearing path exists (`grep` for the table across `apps/platform/src`, non-test).

*(Attack that failed, in the tenant's favor: a `'pending'` row with **no** matching live mailbox cannot starve the tenant — the design's join requires `m.released_at IS NULL`, and `releaseMailboxes` sets `released_at` for every release path. The join is correct; the granularity is not.)*

---

### 4. BLOCKING — The migration is ONE-SHOT and its SHIFT list strands `'sending'` rows' `send_at`

`send_at` is shifted only `WHERE status='pending'`; `sending_since` only `WHERE status='sending'`. But a `'sending'` row carries **both** columns, and the TTL reclaim the design leans on returns it to `'pending'` **without touching `send_at`** (`tick.ts:200-205` — `SET status='pending', sending_since=NULL, attempts=?`).

For the design's own headline case (frozen clock in the future, delta negative), that row's `send_at` is a real timestamp up to ~600 days ahead. The due query is `ss.status='pending' AND ss.send_at <= ?` (`tick.ts:240`). The row is dead-lettered until real time catches up. The design's claim that the reclaim path "handles them uniformly" is false: the reclaim restores a status, not a schedule.

Reachability is low today (no prod send driver ⇒ few stuck `'sending'` rows), but the design itself asserts it handles "historical stuck-'sending' rows," and **the migration cannot be re-run** — `clock_mode='real'` forecloses a correction. Every enumeration gap in a one-shot irreversible migration is permanent.

**Fix:** shift `send_at` for `status IN ('pending','sending')`, or drop the status filter entirely.

---

### 5. BLOCKING — The idempotence argument rests on unstated atomicity; a partial failure DOUBLE-SHIFTS

The design: *"whole migration is synchronous SQL inside one DO turn (single commit); marker `clock_mode='real'` written in the same turn; re-entry impossible (marker checked first); failure → status-quo + retry next boot."*

Those two sentences are in tension. The marker is written **on success**, and the failure path explicitly keeps `'virtual'` and **retries next construction**. If any statement in the SHIFT/RESET/TERMINALIZE sequence throws after earlier ones applied — and nothing here is wrapped in an explicit transaction — the retry recomputes `delta = Date.now() − frozenNow` (`frozenNow` is unchanged, so delta is ~identical) and **re-applies it to already-normalized columns**. Two shifts of −600 days puts `send_at` ~1,200 days in the past (everything instantly due) and `request_idempotency.created_at` far past the 30-day eviction cutoff (`REQUEST_IDEMPOTENCY_TTL_MS`, `idempotency.ts:9`), mass-evicting provision claims that exist to prevent re-buys.

The design's cited precedent does not transfer. `ensurePartialDedupeIndex` (`tenant-do.ts:352-366`) is safe **because** partial application is tolerable there — its own comment says "continuing without it this boot." A delta shift is corrupting on partial application. Citing a partial-tolerant precedent to justify a partial-intolerant operation is the defect.

**Fix:** persist the applied delta (or write the marker as the FIRST statement and make the migration corrective/idempotent against a recorded delta), rather than asserting atomicity at a constructor boundary.

---

### 6. BLOCKING — The RESIDUAL "bounded to one call" understates a permanent send-blocker: an in-flight saga straddling the flip

Residual: *"An async saga in flight across the flip stamps virtual times post-migration — bounded to one call; scheduled_sends' only writer (launchCampaign) is fully synchronous so no pending-send row affected."*

The `scheduled_sends` half is correct (`campaigns.ts:76-86` is the sole INSERT — verified by grep). The bound is not. `switchToRealClock()` fires inside `completeCheckoutSimulated` / `handleStripeWebhook`, both async RPCs. The DO input gate opens at every await, and the codebase relies on exactly this (`tick.ts:311-314`: "the real EmailPort's fetch() opens the DO input gate"). A concurrently-running `setupInfrastructure` — a multi-minute vendor saga — holds a `TenantContext` captured **before** the swap and keeps stamping `ctx.clock.now()` afterward. A Stripe `checkout.session.completed` webhook arriving mid-setup is the *normal* ordering, not an exotic one.

Post-migration virtual stamps into columns the migration normalizes are permanent (one-shot). Concretely: a `request_idempotency` row stamped ~600 days in the future is unreclaimable — `now - created_at` is negative, therefore `< REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS` (10 min, `idempotency.ts:26`, check at `:85`) — i.e. a permanently wedged setup key. That is the *exact* harm the design's own SHIFT of `request_idempotency.created_at` exists to prevent, reintroduced on the other side of the flip.

---

### 7. BLOCKING — The cron leg has no wall-clock budget; one stalled engine starves every tenant behind it, permanently

Design: *"hangs are bounded because every engine fetch already carries `AbortSignal.timeout`."* That bounds a **request**, not the leg.

- `ENGINE_REQUEST_TIMEOUT_MS = 3 * 60 * 1000` — **180 s per engine call** (`email-port.ts:38`).
- `runPollInbox` loops **every** mailbox sequentially, one awaited `poll` each (`reply-processor.ts:254-286`).
- `runTick` loops **every** due row sequentially, one awaited `send` each (`tick.ts:250+`), plus `runDeliverabilitySweep` and `runWarmupCancellationSweep` with their own 30 s vendor calls.
- `runSendPipelineAllTenants` loops **every** tenant sequentially — `listAllTenantIds` is `SELECT id FROM tenants_index` with **no ORDER BY** (`apps/platform/src/admin/db.ts:133-136`), i.e. a stable practical ordering.

Against an engine that is *up but wedged* (accepts the connection, never answers — the case a timeout exists for), one tenant with 10 due rows consumes 30 minutes of leg time. The cron period is 5 minutes. Because the tenant order is stable, every subsequent sweep re-hits the same stall at the same position: tenants after it are starved **on every tick, indefinitely**. The per-tenant `try/catch` the design inherits from `ops-sweep.ts:141-151` catches throws, not slowness.

**Fix:** the design needs a deadline/budget (per-tenant call cap and an overall sweep deadline), and/or a rotating start offset so a stalled tenant cannot permanently occupy the head of the queue.

---

### 8. BLOCKING — F2's tombstone-after-revoke ordering leaves the resurrection window open, and its stated rationale is wrong

Design: *"Ordering: tombstone AFTER revoke, BEFORE released_at mark (crash between ⇒ retry re-runs both; idempotent)."* and *"Reconcile selects 'pending' only → post-cancel resurrection dead."*

The per-mailbox loop in `releaseMailboxes` (`lifecycle.ts:158-170`) is `await release` → `await revoke` → `UPDATE … released_at`. Each await opens the input gate. `reconcileMailboxCredentialPushes` runs inside the `deliverabilitySweep()` RPC (`tenant-do.ts:857, :863`) — driven by the cron's **first** leg every 5 minutes — and selects `status='pending'` with no lifecycle gate. A concurrent reconcile landing **after** the revoke and **before** the tombstone pushes credentials that will never be revoked again. The tombstone then marks the row `'revoked'`, so nothing retries the removal. Resurrection is reduced from "repeats forever" to "happens once and sticks" — an improvement, not the claimed closure.

The stated crash-safety rationale does not favor this order: the loop is driven by `mailboxes WHERE released_at IS NULL`, and `released_at` is marked **last**, so a tombstone-**first** ordering has identical retry semantics (the tombstone UPDATE is a no-op on retry, the revoke still re-runs) *and* closes the race.

The same window is open on the engine side: F1 specifies `remove()` "keeps nothing," so a push already in flight when `remove()` lands finds no stored `pushSeq` to compare against and is `created` — resurrection with no seq guard. Both halves were designed to close resurrection; for the in-flight case neither does.

**Fix:** tombstone before revoke, and have the engine's `remove()` retain the last `pushSeq` as a tombstone so a late push grades `'stale'`.

---

## NON-BLOCKING

**N1 — REFUTED-CLAIM: `slot_counted=1` is not a real-vs-sandbox discriminator; the RESET hits BYO mailboxes.**
`connectByoMailbox` inserts a mailbox with `source='byo_connected'` and **no** `slot_counted` in the column list ⇒ DEFAULT 0 (`byo-mailbox-composition.ts:105-118`; `schema.ts:281`). A BYO mailbox is a real, customer-owned, real-sending mailbox that consumes no InboxKit plan slot. The design's `warmup_started_at = realNow WHERE released_at IS NULL AND slot_counted = 0` therefore resets a genuine BYO ramp to day 1 (cap 5 for another 28 days), and the design's justification ("sandbox-origin rows with zero real sending history") does not describe that population. Safe direction, wrong classification — and the design's RESIDUAL ("slot_counted=0 crash-window real row") understates its own scope: the affected set is crash-window rows **plus every BYO mailbox plus every real row predating the column**. Use `source` (and/or an explicit provenance marker) rather than `slot_counted` alone.

**N2 — Pre-arm hardening: a non-finite `warmup_started_at` yields cap 40.** `RealMailboxPort.startWarmup` returns `Date.parse(subscription.started_at ?? subscription.createdAt)` with no validation (`mailbox-port.ts:99-100`). I ran the ramp math: `warmup_started_at = NaN` → `computeWarmupDay` = NaN → `warmupDailyCap` = **40**, `status='warming'`; `= null` → day 20672 → cap **40**, `isSendReady` **true** (which also makes the warmup-cancel sweep cancel the paid subscription immediately). All the cap thresholds are `<=` comparisons, and every comparison against NaN is false, so the function falls through to the fully-warmed branch. Reachability of a non-finite value into a `NOT NULL INTEGER` column is UNVERIFIED (see UNVERIFIABLE U1) — but arming auto-send is what makes any such row a live 40/day blast from a brand-new mailbox. Add a finite-value clamp at the port and/or a floor in `warmupDailyCap` before arming.

**N3 — REFUTED-CLAIM: the multiplier is never applied.** The design says a paid tenant's frozen clock reads `base + offset(all pre-upgrade demo-run advances **× 1440**)`. `clock_multiplier=1440` at `initTenant` is correct (`tenant-do.ts:381-386`), but the multiplier is only consumed by `VirtualClock.advance()`, which has **zero non-test callers**. Both live advance sites use `advanceVirtual()`, which bypasses it (`tenant-do.ts:975`, `demo.ts:36`). So the skew is raw virtual ms (~32 days per demo run), not 1440× that. The design's *conclusion* survives — the offset is still large and in the future, both delta signs are still required — but the stated magnitude and mechanism are wrong, and the design flags this as load-bearing.

**N4 — REFUTED-CLAIM: `inboxkit-client.ts` already has the timeout.** The design instructs the builder to "VERIFY `inboxkit-client.ts` has the same timeout and add it if absent — the one remaining unbounded-hang vector." It is present: `signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)` with `REQUEST_TIMEOUT_MS = 30_000` (`inboxkit-client.ts:31, :75`). The remaining hang vector is aggregate, not per-request (finding 7).

**N5 — Enumeration gap: `sent_message_keys` appears nowhere in the migration's four lists.** `threads.ts:169` evicts on `sent_at < ctx.clock.now() - SENT_MESSAGE_KEY_TTL_MS` while rows are stamped `result.sentAt` (real droplet time on the real port, virtual on sandbox). Its disposition is probably LEAVE — the migration actually *repairs* a pre-existing pathology here (under a future-frozen clock the eviction cutoff exceeds every real-stamped row, so the manual-reply dedupe table self-purges on every write) — but a residual survives: sandbox-era rows stamped ~600 days ahead outlive their TTL and can make a later identical manual reply return a stale `messageId` without sending. Enumerate it and record the disposition.

**N6 — `runPollInbox` treats the symptom, not the cause.** The per-mailbox `try/catch` the design adds is right, but the root cause of the throws it wraps is that `runPollInbox`'s mailbox query has **no `released_at IS NULL` filter** (`reply-processor.ts:245-247`) — unlike the tick's picker, which excludes released mailboxes only incidentally via `deliv_status='paused'`. With the cron driving poll every 5 minutes, every released mailbox costs a doomed engine round-trip forever (up to 180 s each on a stalled engine — feeds finding 7). Per CLAUDE.md rule (f), add the filter as well as the catch.

**N7 — `sending_since` is stamped with the tick's START time, not the claim time.** `const now = ctx.clock.now()` is captured once at `tick.ts:176` and reused for the claim at `:315`. In a long tick, a row claimed 20 minutes in is recorded as if claimed at minute 0, so a concurrent sweep's reclaim (`sending_since < now - SEND_CLAIM_TTL_MS`, TTL = 5 min, `tick.ts:42`) can reclaim a send that is still in flight. The four double-send layers hold the wire (verified below), but `attempts` inflates and a row can carry a `'failed'` event alongside a final `'sent'` status. Dormant today; the cron makes long ticks reachable.

**N8 — F1: `pushSeq` orders *claims*, not *content*.** The seq is claimed before `assembleEngineCredentials` runs, so a lower-seq push can carry content fetched later than a higher-seq push's. Benign on both current mint paths (manual grants are deterministic; concurrent programmatic mints both yield valid refresh tokens), but the design's framing "content-hash is dedup, not ordering — fix = monotonic sequence" should say what the sequence actually orders.

**N9 — OAuth runbook: the blast-radius tripwire fires after the irreversible act, and teardown has no matching un-registration.** Design step 4 posts `client-id-request/initiate` **then** `initiate-consent-request`, and only then says "ABORT if any response implies workspace-wide grant scope." Step 1 is itself a mutation registering our OAuth client id against a domain in the workspace that holds the paying customer's assets (`oauth-mint.ts:95-99`); by the time the response can be inspected, it has happened. Step 6's teardown revokes the Google refresh token but there is no client-id de-registration — no such endpoint is wired in `oauth-mint.ts`. Separately, the runbook drives InboxKit **directly** from a scratchpad script, so its ~$15 spend and its plan-slot consumption bypass `vendor_spend_ledger` and `vendor_slot_state` entirely — the platform's ceiling and slot counters will under-count reality for the duration. Get the scope answer out-of-band (docs/support) before the first mutation, and state the ledger divergence in the runbook.

---

## ATTACKS THAT FAILED (why the surviving parts of the design hold)

- **Spend ceiling / period key under the flip.** Hypothesis: flipping the clock changes `periodKey` and resets the monthly $ ceiling. **Held** — `withSpendCeiling` uses `ledgerNow()` = `new RealClock().now()`, never `ctx.clock`, and `spend-ceiling.ts:103-112` documents this as a deliberate H7 incident fix. Correctly outside the migration.
- **Webhook delivery timers.** Hypothesis: rows enqueued on the virtual clock but pruned/retried on the real one. **Held** — `recordEventIfNew` passes `new RealClock().now()` into `enqueueEventWebhooks` (`events.ts:79`), and `runWebhookDeliveries` defaults to `new RealClock().now()` (`tenant-do.ts:682`). The design's LEAVE is right.
- **`soft_bounces.last_ts` as a hidden window.** **Held** — stamped from `ev.receivedAt` and never compared to `now`; only the streak counter gates (`reply-processor.ts:176-186`). LEAVE is right.
- **`request_idempotency` SHIFT necessity.** **Held, and the design is right for the right reason** — with a future-frozen `created_at`, `now - created_at` is negative, therefore `< PENDING_CLAIM_TTL (10 min)`, so the claim is held for the full delta. The SHIFT is required.
- **`campaigns.ts:83` "sole stamper" of `send_at`.** **Held** — grep confirms exactly one `INSERT INTO scheduled_sends` (`campaigns.ts:76`); every other statement is an UPDATE that never touches `send_at`.
- **Cross-tenant revive via `ON CONFLICT(email)`.** **Refuted as a threat** — `mailbox_cred_pushes` lives in per-tenant DO SQLite (`TENANT_DO_SCHEMA`, `schema.ts:735`), so `email PRIMARY KEY` cannot collide across tenants; `tenant_id` is constant within a DO. The clause is safe as written.
- **`push_seq` reset defeating monotonicity.** **Held** — grep found **no** `DELETE FROM mailbox_cred_pushes`, no `deleteAll`, no `DROP TABLE` anywhere in `apps/platform/src`. The Worker-side counter genuinely survives every status flip, so F1's continuity claim is sound.
- **Double-send at first arm, all four layers.** All four exist as cited: atomic conditional claim with `rowsWritten` check and no await between the read and the claim (`tick.ts:313-318`); engine send cache (`engine.ts:86-88`); in-flight `claimSend` → `SendInProgressError` (`engine.ts:100-102`); WAL intent + `isBlocked` 424 gate (`engine.ts:104-124`). I attacked the stalest interleaving I could build — tick A claims a row late in a long tick, tick B's reclaim frees it mid-flight, tick B re-claims and re-sends — and the wire is still protected: B's send hits either `SendInProgressError` (retryable) or the cache, returning the same `messageId`. The residual is bookkeeping only (N7), not a duplicate email.
- **`this.plan` staleness reaching the predicate.** **Held** — leg 1 reads the cached `this.plan`, but leg 3's `readActivationState` re-reads `plan` from SQL on every call (`activation.ts:66-76`), and `plan` has exactly two writers, both upgrades (`billing.ts:251`, `:369` — grep-verified), so a stale cached value can only be *more* restrictive.
- **Predicate leg enumeration.** Walked `past_due` / `suspended` / `canceling` / `canceled` / `disputed` / `screening='review'` / `plan='free'` / unarmed-env: each is blocked by leg 3 or leg 4. `capacity_pending` sends, correctly (it gates provisioning, not sending). The only "sends when it shouldn't" I found is finding 1 — a fully-legitimate tenant sending to a phantom mailbox.
- **A `'pending'` push row with no matching mailbox row.** Not producible: `recordProvisionedMailboxForPush` always follows the row insert, and no path deletes `mailboxes` rows (release sets `released_at`). The design's join is correctly written.
- **`runTick` reachability bypass.** **Held** — grep confirms `runTick` has exactly two callers: `tenant-do.ts:820` (the DO RPC) and `demo.ts:130/137`. No route, MCP tool, or alarm reaches it, so enforcing the predicate in the new `runScheduledTick` cannot be bypassed.
- **Deliverability windows attributing demo events to a real mailbox.** **Held** — bounce/complaint attribution joins `events.message_id → scheduled_sends.mailbox_id` (`deliverability.ts:279-300`), so demo events land on the sandbox mailbox id. (But see NEW-1: the *domain* aggregate is a different story.)
- **Real vendor ports stamping real wall time.** **Held** — `provision` returns `provisionedAt: Date.now()` (`mailbox-port.ts:62`) and `startWarmup` returns `Date.parse(vendor)` (`:99-100`), both independent of `ctx.clock`. The design's second discovery is correct as far as `warmup_started_at` goes.

---

## UNVERIFIABLE

- **U1 — Can a non-finite `warmup_started_at` actually land in the column?** The ramp math is proven (N2, ran it), but `warmup_started_at INTEGER NOT NULL` (`schema.ts:253`) may reject a NaN bind in the DO SQLite driver rather than storing it. Resolving this needs a `workerd`/miniflare probe binding `NaN` to that column — worth 10 minutes in the build lane, since it decides whether N2 is a hardening ask or a live defect.
- **U2 — Does Mordy's DO actually hold demo-era sandbox mailbox rows?** Finding 1 is certain as a *class* (any tenant who ran `setup_infrastructure` before upgrading), but I have no prod read access to confirm the specific rows in `ten_91aab24a`. A read-only `SELECT id, email, source, slot_counted, released_at FROM mailboxes` against his DO before arming would settle both the severity and the migration's retirement predicate.
- **U3 — Cloudflare's commit semantics for synchronous SQL in a DO *constructor*.** Finding 5 does not depend on the answer (the design's own retry-on-failure path re-runs the shift regardless), but if constructor writes are genuinely all-or-nothing the fix is cheaper. Not determinable from this repo.
- **U4 — Cron invocation wall-clock/CPU ceiling for `scheduled()`.** Finding 7's starvation conclusion holds either way (killed invocation ⇒ tail tenants never run; completed long invocation ⇒ overlapping sweeps), but the exact ceiling would size the budget the design needs to add.
- **U5 — InboxKit OAuth client-id grant scope (per-domain vs workspace-wide).** This is the runbook's own open question and cannot be answered without a live call — which is exactly why N9 argues the tripwire must move ahead of the mutation.

---

## NEW (out of scope, no verdict weight)

- **NEW-1 — Demo-era sandbox mailboxes already pollute *domain*-level deliverability aggregates.** `gatherDomainStats` groups by domain string over all-time per-mailbox signals (`deliverability.ts:392-410`). The deliverability sweep already runs on the live cron for every tenant, so demo-seeded bounces/complaints can already push a domain toward a burn decision — and `REPLACE_DOMAIN` spends real money. Pre-existing, not introduced by this design, but adjacent to finding 1.
- **NEW-2 — The warmup-cancel sweep is likely already firing on demo-era mailboxes today.** `runWarmupCancellationSweep` excludes `source='byo_connected'` but not sandbox-origin rows (`warmup-cancel.ts:76-80`), and demo runs advance the virtual clock 29+ days, so those rows read send-ready under the *current* frozen clock. For an armed paid tenant that means five doomed `resolveMailboxUid` attempts and a false give-up alert per demo mailbox. The design's RESET incidentally fixes it; worth confirming in the arm-verification step.
- **NEW-3 — `scheduled.ts` ordering rule.** ROADMAP `## Open` (2026-08-02 warmup fast-follow, item R2) requires the warmup-cancel lane to move below `runWatchtower`. The design appends the send leg last without reconciling that pending reorder; the two edits touch the same file and should land together.

---

## Justification

The design is strong on the parts it examined closely — the delta-both-signs discovery is real and correct, the `request_idempotency` shift is necessary for exactly the reason given, the four double-send layers all exist and survive the nastiest interleaving I could construct, and the `push_seq` continuity argument holds against the deletion attack. But three of its load-bearing factual claims do not survive contact with the code: unknown-mailbox is graded **retryable** (the codebase says so in a comment written to prevent precisely the "burn the due queue" outcome the design invokes), `slot_counted` does not discriminate real from sandbox (BYO mailboxes and pre-column rows both read 0), and the multiplier it treats as the skew mechanism has no live caller. Those misreads propagate: the activation predicate's credential guard is keyed to a population (`mailbox_cred_pushes` rows) that excludes the largest hazard (sandbox-origin mailboxes with no push row at all), so arming auto-send would route every send at a phantom mailbox and drain the customer's first campaign to `'failed'` in about 25 minutes while the real mailboxes sit idle. Compounding that, the migration is one-shot and irreversible, yet its SHIFT list misses `send_at` on `'sending'` rows, its idempotence rests on an atomicity guarantee it asserts rather than establishes (with double-shift as the failure mode), and its own "bounded to one call" residual understates a concurrent-saga path that can permanently wedge a setup key. None of these are hard to fix — most are a predicate or an ordering — but they must be fixed **in the design**, because the migration cannot be re-run and the arming step is what makes them live.

---
---

# ROUND 2 — re-attack of the v2 REVISION DELTA (2026-08-05)

> Target: the "WAVE 2 DESIGN v2 — REVISION DELTA" section appended to `archive/2026-08-05-provisioning-fixwave-plan/wave2-design-2026-08-05.md`.
> Re-grounded: `git rev-parse HEAD` = `ef1c2db` (unchanged from round 1). Working tree now also shows ` M .claude/agent-memory/spec-builder/MEMORY.md` and this review file as untracked — no source file moved under me.
> Every closure below was re-derived from the code, not accepted from the delta's text.

## VERDICT: **SHIP-AFTER-FIXES** (0 BLOCKING, 8 NON-BLOCKING)

---

## PART A — did the delta actually close the 8 blocking findings?

**Finding 1 (sandbox mailboxes picked) — CLOSED, and the defense in depth is real.** Two independent mechanisms, both verified. §1b's retirement writes `released_at` **and** `deliv_status='paused'`; I checked whether anything can undo the second — `grep` for every `deliv_status = ` writer returns only `'throttled'` and `'paused'` (`deliverability-actions.ts:58, :72, :83`) and `lifecycle.ts:165`. **There is no path anywhere that writes `deliv_status` back to `'healthy'`**, so the retirement is sticky. §1a's picker predicate then excludes the same rows a second way. I also attacked the surface the picker does *not* cover: the manual-reply path selects its mailbox by thread history (`resolveSendingMailbox`, `threads.ts:95-105`) with no eligibility filter at all, so a paid tenant replying to a demo-era thread would resolve a retired sandbox mailbox — but `sendWithGuards` refuses a paused mailbox with a structured `SendBlockedError` (`guarded-send.ts:77-95`). The `deliv_status='paused'` half is therefore **load-bearing for the manual path**, not decorative; a build that sets only `released_at` reopens this. Worth a sentence in the design so it survives refactoring.

**Finding 2 (422 retryable) — CLOSED.** Leg 5 deleted, false rationale withdrawn and correctly restated.

**Finding 3 (whole-tenant starvation) — CLOSED.** Per-mailbox exclusion means one un-grantable mailbox costs one mailbox's capacity. The N4 claim-outlives-teardown row is now inert rather than tenant-fatal. The §1c alerts fix the "quiet" choice that made it undetectable. Residuals R1 and R4 below.

**Finding 4 (`send_at` on `'sending'` rows) — CLOSED.** `status IN ('pending','sending')` is the right predicate; re-confirmed the reclaim restores status only and never touches `send_at` (`tick.ts:200-205`).

**Finding 5 (double-shift) — CLOSED, and the API is real.** I verified `transactionSync` rather than trusting it: `transactionSync<T>(closure: () => T): T` is declared on `interface DurableObjectStorage` (`node_modules/@cloudflare/workers-types/index.d.ts:717` for the interface, `:753` for the method), and `apps/platform/tsconfig.json:5` puts `@cloudflare/workers-types` in `types`. The migration's operations are all synchronous (`ctx.storage.sql.exec` + `Date.now()` + the profile read) — no `await` can appear, and the delta correctly leaves the async `syncMailboxQuantity` to the next cron reconcile rather than pulling it inside. Marker inside the transaction makes rollback genuinely all-or-nothing, so the double-shift is structurally dead and U3 does become moot. The withdrawal of the `ensurePartialDedupeIndex` precedent is correct. Two build-lane notes: the delta's own miniflare probe should confirm `transactionSync` works **inside a constructor** specifically, and the `ALTER TABLE`s run outside the transaction (correct and safe — additive with defaults — but see R8).

**Finding 6 (in-flight saga) — CLOSED for the accessor class, and I re-derived the load-bearing sub-claim.** `DelegatingClock` is the right shape. The delta asserts "withRequestIdempotency's local is used only in its synchronous prefix (verified)" — I verified it independently and it **holds**: `const now` at `idempotency.ts:70` feeds the SELECT, the pending-TTL comparison (`:85`), the reclaim UPDATE (`:98`), the fresh-claim INSERT (`:104`) and the eviction DELETE (`:110`), all before `await fn()` at `:114`; the post-await UPDATE and DELETE (`:116, :124`) carry no timestamp. The concrete round-1 harm — a post-flip idempotency claim stamped ~600 days ahead — is genuinely dead. The *enumeration* around it is not (R2).

**Finding 7 (no budget) — CLOSED in substance.** Per-tenant budget + 150 s leg deadline + rotation converts "tail tenants never run" into "some tenants this cycle, all tenants across cycles." On the delta's abandoned-RPC claim: I could not verify whether an abandoned DO RPC survives its caller (the delta asserts it does), but **the design is safe in either branch** — if it keeps running, the row claim plus engine idempotency make the overlap harmless; if the runtime cancels it, rows are left `'sending'` and fall into the existing 5-minute TTL reclaim, where the engine's send cache or its 424 intent gate prevents a duplicate. And the input gate does not make the budget cosmetic: it opens across `fetch` I/O, so a stalled prior-cycle RPC does not serialize-block the next cycle's call. Parameter incoherence noted at R5.

**Finding 8 (tombstone ordering) — CLOSED.** Tombstone-first as a synchronous UPDATE before any await closes the reconcile-in-the-gap window on the Worker side; the engine-side `pushSeq` tombstone closes the in-flight case that the Worker half structurally cannot reach. Both halves were required and both are present. The withdrawal of the crash-safety rationale is correct — the loop is driven by `released_at IS NULL`, marked last, so retry semantics are identical either way.

**All eight close. No blocking finding survives.**

---

## PART B — NEW findings against the delta's own surface

### R1 · NON-BLOCKING · REFUTED-CLAIM — "every platform-provisioned real mailbox always gets a 'pending' row before push" is not a universal

This sentence is the entire justification for §1a's NOT-pending polarity, and it is conditional, not universal.

- Push arming: `isCredentialPushConfigured` = `INBOXKIT_API_KEY && INBOXKIT_WORKSPACE_ID && ENGINE_BASE_URL && ENGINE_AUTH_SECRET` (`mailbox-credential-push.ts:48`).
- Real-mailbox arming: `useSandbox = isDemoOrFree || !activated || !inboxKitConfig` (`vendors/factory.ts:140`) — **`engineConfig` is not a conjunct**, and `buildAdapters` passes both configs independently (`tenant-do.ts:457-462`).

So in the window where INBOXKIT_* is armed and ENGINE_* is not, a mailbox is really bought at the vendor (`provider='google'`) while `maybePushProvisionedMailbox` early-returns on `!deps` and writes **no** push row. Once ENGINE_* later arms, that mailbox passes §1a's predicate (provider not sandbox, not BYO, not released, no pending row), the engine has no credentials for it, and we are back in finding 1's failure mode through a different door — **invisible to both new alerts**: alert (1) needs a pending row that does not exist, and alert (2) needs zero eligible mailboxes when this one is eligible. All three new mechanisms are keyed to the same table, so a mailbox that never enters it is invisible to all three.

**Self-refutation (why NON-BLOCKING, not blocking):** `ACTIVATION.md:60` records that `ENGINE_BASE_URL` and `ENGINE_AUTH_SECRET` are both already set in production (founder-run, `wrangler secret list`-confirmed 2026-07-27), and the delta's own §9-U1 states zero real mailboxes have ever been provisioned. The window is currently empty and re-entering it requires *un*-setting ENGINE_* while INBOXKIT_* stays. Real, but not live.

**Fix (cheap and structural):** move `recordProvisionedMailboxForPush` **above** the `if (!deps …) return undefined` guard in `maybePushProvisionedMailbox` (`mailbox-credential-push.ts:144-148`), keeping the sandbox early-return. The row is the durable "this mailbox needs credentials" fact; the push is the action. That makes the universal true by construction and makes alert (1) fire for exactly this case. The same change also covers two adjacent instances the delta does not address: migration-backfilled `provider='google'` rows that predate the push path, and engine state-file loss (Worker rows read `'pushed'`, engine holds nothing, and nothing ever re-pushes a `'pushed'` row).

### R2 · NON-BLOCKING · REFUTED-CLAIM — "exactly two async engine functions capture `const now = ctx.clock.now()` then await"

At least six. I enumerated from the full `clock.now()` call-site list and read each:

- **`warmup-cancel.ts:58` — the one with teeth.** `now` is captured before the candidate loop and then used *after* `await cancelWarmup` both as a **decision** (`isSendReady(computeWarmupDay(mailbox.warmup_started_at, now))`, `:92`, on every iteration after the first) and as a **write** (`warmup_cancel_gave_up_at = now` at `:113`, `warmup_cancelled_at = now` at `:135`). A stale future `now` carried across the flip makes a not-yet-ramp-complete mailbox read send-ready, cancels a paid warmup subscription early, and stamps the marker whose whole documented contract is "the vendor confirmed."
- `lifecycle.ts:143` (`released_at = now` after `await release` / `await revoke`) and `:202` (teardown) — the value is only ever tested `IS NULL`, so cosmetic.
- `reply-processor.ts:252` (`last_polled_at = now` after `await poll`) — display only.
- `tick.ts:176` — the delta's own N7 fixes `sending_since`, but the same local also drives the due-window check and the `first_send_eligible_at` comparison for every row after the first await.

Exposure is confined to the once-per-tenant demo→paid flip window, so actual harm is low. The problem is that the delta uses the "exactly two" completeness claim to **bound** the residual — a builder auditing against that list will not open `warmup-cancel.ts`. Correct the enumeration and add warmup-cancel to the fix list (re-read the clock per candidate rather than hoisting).

### R3 · NON-BLOCKING — §1a's `NOT EXISTS` subquery drops the tenant scope v1 had

v1: `… p.email = m.email AND p.tenant_id = m.tenant_id … WHERE p.tenant_id = ?`. v2: `SELECT 1 FROM mailbox_cred_pushes p WHERE p.email = m.email AND p.status = 'pending'`. Harmless in per-tenant DO SQLite, but CLAUDE.md rule (h) makes tenant_id scoping mandatory in every query, and this repo applies it deliberately even where redundant — `lifecycle.ts:196` carries an explicit "belt-and-suspenders tenant scope even though a DO is single-tenant" comment. Restore `AND p.tenant_id = m.tenant_id`.

### R4 · NON-BLOCKING — §1c's "zero eligible mailboxes" alert must SHARE the picker's predicate, not restate it

The predicate lives in the tick's picker; the alert lives in `opsSummary`. Two hand-maintained copies of an eligibility rule drift, and the drift mode here is the worst one available: the alert computes "you have eligible mailboxes" while the picker finds none, producing a silent zero-send with the alarm asleep — precisely the state §1c exists to make visible. Extract one shared SQL fragment or helper (CLAUDE.md rule c, "no duplicated logic") and add a test asserting both call sites return the same set against a fixture holding one row of each class (sandbox, retired, BYO, pending-push, eligible).

*(Feasibility checked and fine: `runWatchtower` already iterates `listAllTenantIds` and calls `opsSummary` per tenant — `admin/watchtower.ts:117-120` — so §1c fits the existing state machine without new plumbing.)*

### R5 · NON-BLOCKING — the 60 s per-tenant budget sits BELOW the 180 s per-request engine timeout

`ENGINE_REQUEST_TIMEOUT_MS = 3 * 60 * 1000` (`email-port.ts:38`) versus the new 60 s `Promise.race`. A single stalled send therefore guarantees the tenant is abandoned having completed zero work, on every cycle — the budget can never be spent productively against a slow-but-alive engine either. There is an existing documented ordering ladder right above that constant (`email-port.ts:31-36`: the engine timeout "MUST stay below the stuck-'sending' reclaim TTL (5 min)"); the new budget inserts a value below the timeout without extending the ladder. Either raise the budget above one request timeout, or lower `ENGINE_REQUEST_TIMEOUT_MS` (~45 s) so a tenant gets at least one complete attempt, and record the new ordering rule next to the existing comment rather than in a separate design doc.

### R6 · NON-BLOCKING — rotation offset needs a zero-guard and will stutter

`Math.floor(Date.now()/300_000) % tenantIds.length` yields `NaN` when `tenantIds.length === 0`. Separately, because cron fire times drift around the 300 000 ms boundary, two consecutive cycles can land on the same offset (a repeat) or skip one. Self-correcting and harmless, but the fairness test should assert *eventual coverage across N cycles* rather than strict +1 stepping, or it will be flaky.

### R7 · NON-BLOCKING — §6's "seqless push against a tombstone → 'stale'" has no discoverable escape

After this wave the prod path always carries a seq, so no live caller breaks. But an operator's manual `curl` re-push is seqless, and against a tombstone it is silently refused with no way to read the tombstone value back. This sits in slight tension with §1a's NOT-pending polarity, whose stated justification is preserving an operator emergency path. The tension is narrower than it looks — the real emergency path is the droplet's static `MAILBOX_CREDENTIALS` config, and the engine resolves from config **or** the pushed store (`engine.ts:354-358`), so the static path is unaffected. Record that in the runbook explicitly: recovery for a tombstoned email is (a) static config, or (b) a seq-bearing push. Also add a retention note — `tombstones[email]` retained forever grows the JSON state file monotonically across tenant churn.

### R8 · NON-BLOCKING — a rolled-back migration leaves `provider=''` on every row, i.e. zero eligible mailboxes

The `ALTER TABLE`s run in `ensureColumnMigrations()` outside the transaction, so a rolled-back migration leaves `provider` defaulted to `''` everywhere while `clock_mode` stays `'virtual'`. §1a then excludes every mailbox. This is **correct and consistent** — leg 2's interlock already blocks the driver for an unmigrated tenant, and §1c alert (2) surfaces it — but the coupling is implicit and load-bearing. State it in the design, so a later reader does not "fix" the `''` exclusion as an apparent bug and thereby un-gate unclassified rows.

---

## ATTACKS THAT FAILED (round 2)

- **`transactionSync` doesn't exist / is experimental-only.** Failed — declared on `DurableObjectStorage` in the stable `index.d.ts` (`:753`), and the platform tsconfig loads those types.
- **The migration hides an `await` that would break `transactionSync`.** Failed — every operation the delta lists is `sql.exec` plus `Date.now()`; the one async neighbour (`syncMailboxQuantity`) is deliberately left to the cron reconcile.
- **`withRequestIdempotency`'s local crosses an await.** Failed — re-derived line by line (`idempotency.ts:70-124`); the delta's "verified" is accurate.
- **The retirement bypasses `releaseMailboxes` and leaks a G4 plan slot.** Failed — the classification assigns `'google'` before `'sandbox'`, so every retired row has `slot_counted=0` by construction and there is nothing to decrement.
- **Retirement causes an unattended bill-RAISING change.** Failed — `syncMailboxQuantity` sets `desired = max(5, provisioned)` with `proration_behavior:"none"` on decreases and is active-only and non-throwing (`billing.ts:538-560`). The retirement can only lower or hold the bill, which is the direction the ratified rule permits.
- **`released_at` is assumed elsewhere to imply a vendor release happened.** Failed — every consumer tests `released_at IS NULL` as a filter (`releaseMailboxes`, `warmup-cancel.ts:78`, `billableMailboxCount`); nothing reads the value or infers a vendor call from it, and teardown simply skips already-retired rows.
- **Something un-pauses a retired mailbox.** Failed — no writer of `deliv_status='healthy'` exists anywhere in `apps/platform/src`.
- **The manual-reply path bypasses the new eligibility rules.** Failed in effect — `resolveSendingMailbox` really has no filter, but `sendWithGuards` refuses a paused mailbox (`guarded-send.ts:77-95`), and retirement sets paused. (Flagged above as a coupling to preserve, not a hole.)
- **`source != 'byo_connected'` needlessly benches a working product surface.** Failed — grep confirms no path reads `transport_json` to push BYO credentials to the engine (`byo-mailbox-composition.ts:87` says so outright), so BYO mailboxes genuinely have no engine credentials and the exclusion is correct. §1c alert (2) makes a BYO-only tenant visible rather than silent.
- **`provider NOT IN ('sandbox','')` misbehaves on NULL.** Failed — the column is `TEXT NOT NULL DEFAULT ''`, so SQL's NULL-poisoning of `NOT IN` cannot arise.
- **The abandoned RPC makes the budget cosmetic via the input gate.** Failed — the gate opens across `fetch` I/O, so a stalled prior-cycle RPC does not block the next cycle's call; and both possible runtime behaviours (survives / is cancelled) land in already-safe territory.
- **`paid-only` predicate scoping reads a stale `this.plan`.** Failed — `plan` has exactly two writers, both upgrades (`billing.ts:251, :369`), so a stale cached value can only be more restrictive, and leg 3 re-reads it from SQL anyway.

## UNVERIFIABLE (round 2)

- **`transactionSync` inside a DO *constructor*.** The type exists and the SQLite backend is in use; whether the runtime permits it at construction time is a workerd question. The delta already schedules a miniflare probe — that probe should assert the constructor case specifically, not just method-context usage.
- **Whether an abandoned DO RPC keeps executing after its caller returns.** Analysed as safe in both branches (above), so it does not gate the verdict, but the delta states it as fact and should mark it as an assumption.
- **U1/U2 from round 1 remain open** and the delta correctly routes both into build-lane steps (§9). U2's checklist should gain one item from R1: confirm every `provider='google'` row has a corresponding pushed credential, not just that classification labelled rows correctly.

## NEW (out of scope, no verdict weight)

- **NEW-4 — §1b's "stops NEW-1's domain-aggregate pollution growing" is right about growth, wrong about the standing pollution.** `gatherMailboxHealth` selects `FROM mailboxes WHERE tenant_id = ?` with **no** `released_at` filter (`deliverability.ts:283-288`), so retired sandbox rows keep contributing their all-time demo bounce/complaint counts to both per-mailbox and per-domain aggregates. The sibling sandbox `domains` rows are not retired either, so a phantom domain can still reach a burn decision. Cheap completion inside the same migration: retire the sandbox `domains` rows alongside the mailboxes, and/or add `released_at IS NULL` to `gatherMailboxHealth`. I did not trace burn → `REPLACE_DOMAIN` → real domain buy to a spend conclusion, so this flags the aggregate, not an asserted spend.

---

## Justification

Every one of the eight blocking findings is genuinely closed, and I re-derived each closure rather than accepting it — including the two the delta could most easily have hand-waved. `transactionSync` is real (`workers-types/index.d.ts:753`, on `DurableObjectStorage`, with the platform tsconfig loading it), which makes the double-shift structurally impossible rather than rhetorically improbable; and the delta's most load-bearing sub-claim, that `withRequestIdempotency`'s captured `now` never crosses an await, holds line by line. The fixes are also better than the minimum: the sandbox-mailbox hazard is closed twice over by independent mechanisms, the DelegatingClock kills the whole accessor class instead of patching the one instance I named, and the tombstone fix correctly recognised it needed an engine-side half the Worker could not reach. What the delta got wrong is confined to two completeness claims it uses to bound its own residuals — "every platform-provisioned real mailbox always gets a pending row" is conditional on an env-arming order rather than structural, and "exactly two" stale-local sites is at least six, with `warmup-cancel.ts:58` being the one that can cancel a paying customer's warmup subscription on stale time. Neither is live today (production already has ENGINE_* armed per `ACTIVATION.md:60`, zero real mailboxes have ever been provisioned, and the flip window is once per tenant), which is why they are non-blocking rather than blocking. But both are exactly the kind of assertion a builder will trust instead of re-checking, so they belong in the design text before the increments are cut — along with R3's tenant scope, R4's shared predicate (a "zero eligible mailboxes" alert that drifts from the picker is worse than no alert), and the R8 coupling note. Fold those five into the increment specs and this is buildable.

