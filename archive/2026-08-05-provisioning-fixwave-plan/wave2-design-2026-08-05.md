# WAVE 2 DESIGN — auto-send, real clock, poll driver, credstore F1/F2, OAuth verify

> Produced 2026-08-05 by the wave2-designer lane (read-only, against main @ ef1c2db; line numbers approximate — sibling worktrees were active). Founder rulings honored: real clock for ALL non-sandbox tenants; auto-send BUILD+ARM NOW; OAuth both-in-parallel. Status: AWAITING ADVERSARY ATTACK before build. This is a frozen wave artifact, not a living doc — conclusions fold into SPEC/ARCHITECTURE/ROADMAP at build time.

## CRITICAL DISCOVERY (changes the migration shape)
Every tenant signs up as plan "demo" (`routes/signup.ts:49-57`), so `initTenant` (`tenant-do.ts:381-386`) sets `clock_multiplier=1440`. The checkout upgrade (`billing.ts:251` simulated, `:369` webhook) flips `plan` but NEVER touches `clock_base/clock_offset/clock_multiplier`. So a paid tenant's frozen VirtualClock reads `base(signup) + offset(all pre-upgrade demo-run advances × 1440)` — Mordy's frozen "now" may be WEEKS-TO-YEARS IN THE REAL FUTURE (up to 20 demo runs × ~30 virtual days each), not merely stuck at signup. The migration must handle delta = realNow − frozenNow in BOTH signs. Any design that assumes "frozen ≈ signup" is wrong.

Second discovery: the REAL vendor ports already stamp real wall time (`vendors/real/mailbox-port.ts:62` provision `Date.now()`, `:99-100` startWarmup `Date.parse(vendor)`; engine `sentAt` is droplet `Date.now()`). So real-provisioned rows are ALREADY on the real time base even under a frozen ctx.clock — the migration must NOT shift them. Discriminator: `mailboxes.slot_counted=1` marks real-plan-slot rows (schema.ts:274-281).

## DECISION 1 — Driver: cron leg, NOT DO alarms
New leg appended LAST in `runScheduledOpsSweep` (`scheduled.ts:27-68`): `runSendPipelineAllTenants(env)` — for each tenant id, per-tenant try/catch (the `ops-sweep.ts:141-151` pattern; composes with the dunning-P0 leg-isolation fix), call `stub.runScheduledPoll()` then `stub.runScheduledTick()` (poll BEFORE tick so replies/stop-on-reply land before send decisions).

Rationale:
- **Fan-out cost:** the 5-min cron ALREADY fans out ~5 DO-RPC legs across all tenants; one more leg is +O(N) RPCs on DOs already being woken. 63 tenants today, 1 real. Alarms save nothing now and add per-DO wake billing.
- **Isolation of a wedged DO:** per-tenant try/catch isolates throws; hangs are bounded because every engine fetch already carries `AbortSignal.timeout` (`vendors/real/email-port.ts:101`, `engine-mailbox-client.ts:94`). Builder must VERIFY `inboxkit-client.ts` has the same timeout and add it if absent — the one remaining unbounded-hang vector in the leg. Alarms would isolate perfectly but introduce three new failure classes (re-arm-after-throw, alarm lost on error, constructor re-arm for existing DOs) whose failure mode is a silently-never-sending tenant — strictly harder to detect than a loud cron leg error.
- **Cadence:** cold-email sends are day-granular (caps 5→40/day) and hour-granular (UTC send windows, `scheduler.ts:11-18`); 5-min worst-case latency is immaterial. 5-min reply polling is fine (engine poll is UID-capped at 300/batch).
- **Re-arm failure modes:** cron re-fire is platform-guaranteed; alarms are self-re-arming state machines with no existing test surface in this repo. The repo's own posture agrees (engine/README.md §"Why the tick/poll are directly-callable methods, not real alarms").
Revisit trigger for alarms (record in ROADMAP): sweep wall time approaching the 300s period, or a customer needing sub-5-min cadence.

Accepted redundancy: `runTick` internally re-runs `runDeliverabilitySweep` + `runWarmupCancellationSweep` (`tick.ts:157-175`) which the cron also runs as separate legs — both threshold/marker-idempotent; do NOT refactor tick internals this wave.

**No D1 pre-filter:** `tenants_index.plan` is stale by design (Mordy reads 'demo' there). A D1 plan filter would exclude the only paying customer. The predicate lives ONLY inside the DO.

## DECISION 2 — Clock: RealClock for plan ∉ {demo, free}, selected in TenantDO, with a persisted migration interlock
- `tenant-context.ts:11` type widens `VirtualClock` → `Clock` (factory.ts:110 already takes `Clock`). The only `advanceVirtual` consumers are `demo.ts:36` and `tenant-do.ts:975` — both already plan-gated to demo/free; add `requireVirtualClock(clock): VirtualClock` in `clock.ts` (throws — structural guard) and narrow there.
- New column `tenant_profile.clock_mode TEXT NOT NULL DEFAULT 'virtual'` via `addColumnIfMissing` + schema.ts. `'real'` is stamped ONLY after the one-shot migration commits — the driver predicate requires it (interlock: the send driver can never run against an unmigrated tenant; L4+L5 coupling enforced structurally, not by deploy choreography).
- Clock selection helper `clockForTenant(plan, row)` at all four swap sites:
  1. Constructor rehydrate (`tenant-do.ts:141-151`): paid + clock_mode≠'real' → run migration (synchronous SQL, commits with the constructor turn) → stamp 'real' → RealClock. Self-applies to Mordy's live DO on first touch after deploy. Wrap in try/catch per the `ensurePartialDedupeIndex` precedent (:352-366): on failure, log loud, KEEP VirtualClock + 'virtual' (status quo, no new harm), retry next construction — the predicate interlock keeps the driver off.
  2. `initTenant` (:381-386): paid → RealClock, clock_mode='real' at insert (no migration needed).
  3. `completeCheckoutSimulated` (:759-766) and 4. `handleStripeWebhook` (:768-772): after upgrade, call `this.switchToRealClock()` (migration + stamp + swap) AND null `this.sandboxAdapters` — the cached sandbox bundle (:133,:424) holds the old VirtualClock and would keep stamping virtual times into rows.
- Demo/free tenants: byte-identical behavior (VirtualClock, advanceClock, demoRun unchanged).
- Plan never downgrades paid→demo (only `SET plan` sites are the two upgrades) — one-way virtual→real, no reverse migration.

## MIGRATION PLAN — every virtual→real boundary crossing, enumerated
Let frozenNow = VirtualClock(base,offset,multiplier).now() from the persisted row; delta = Date.now() − frozenNow (either sign).

**SHIFT by delta** (stamped exclusively by ctx.clock; preserves relative offsets):
- `scheduled_sends.send_at` WHERE status='pending' AND campaign is_demo=0 (writer `campaigns.ts:83` is the sole stamper)
- `scheduled_sends.sending_since` WHERE status='sending' (then the FIRST real tick's existing TTL-reclaim path (`tick.ts:190-227`) handles them uniformly: attempts bump, engine idempotency `send:${tenantId}:${row.id}` returns the cached messageId if it ever went out — reuse, don't hand-roll)
- `request_idempotency.created_at` (all rows; `idempotency.ts:26,85` — without the shift, a future-stamped 'pending' claim is UNRECLAIMABLE until real time catches up = a permanently wedged setup key; 'done' rows shift so 30-day eviction works)
- `domains.first_send_eligible_at`, `domains.dns_first_checked_at` (non-null only; BYO gates, ctx.clock-stamped — preserves remaining wait)

**RESET to flip time** (conservative, not shifted):
- `mailboxes.warmup_started_at = realNow` WHERE released_at IS NULL AND slot_counted=0. Sandbox-origin rows with zero real sending history; shifting would hand a day-N (possibly 40/day + sendReady) cap to a mailbox that never sent a real email — the exact day-9000 hazard — AND make the cron-live `warmupCancelSweep` immediately fire `cancelWarmup` → `resolveMailboxUid` fails ×5 → false "may still be billing" give-up alerts. Reset = honest day 1.
- Rows with slot_counted=1 (real vendor mailboxes): warmup_started_at is ALREADY real (vendor-stamped) — touch nothing. Known residual: deferred-wave F6 says slot_counted can be written post-warmup, so a crash-window real row could read slot_counted=0 and get reset — safe direction (cap too LOW), document.

**TERMINALIZE** (prevents real-engine sends to demo-seed leads):
- pending `scheduled_sends` of is_demo=1 campaigns → 'skipped'; is_demo=1 campaigns status → 'paused'. Without this, a newly-real tenant's first cron tick attempts leftover demo rows against the REAL engine (UnknownMailbox → instant permanent 'failed' spam).

**LEAVE, with reasoning recorded** (adversary probes each):
- `sent_today_epoch_day`/`sent_today`: self-heals — first `refreshMailboxWarmupState` under real clock sees virtual epochDay ≠ real epochDay → rolledOver → one clean reset (`mailbox-state.ts:44,99-106`).
- Audit stamps (events, ledger_entries, created_at columns, checkout_sessions, webhook_events, teardown ts, screening ts, soft_bounces.last_ts, mailbox_cred_pushes *_at, last_polled_at, warmup_cancel markers, thread_labels/dashboard ISO strings): display/audit only, no now-comparison on a load-bearing path.
- Deliverability lookback windows (`deliverability.ts:281,400`, `deliverability-actions.ts:95`): post-flip real now → frozen-past events fall outside windows (clean start — safe); FUTURE-stamped demo events would sit inside every window, but they attribute only to sandbox mailbox/domain ids via the message-id join — cannot pause a real mailbox. Contained.
- `domains.purchased_at` (feeds only the teardown liability estimate — cosmetic skew for virtual-stamped adopted rows).
- Webhook deliveries + spend-reap + demo throttle already run on RealClock (`tenant-do.ts:682,946`, `scheduled.ts:28`) — the flip UNIFIES the DO onto one time base.

Idempotence/crash-safety: whole migration is synchronous SQL inside one DO turn (single commit); marker `clock_mode='real'` written in the same turn; re-entry impossible (marker checked first); failure → status-quo + retry next boot.

Also: `test/helpers.ts:~55` (`withTenantContext`) constructs a VirtualClock unconditionally — must branch on clock_mode or paid-tenant tests silently test the wrong clock.

## ACTIVATION PREDICATE (auto-send)
Enforced INSIDE TenantDO in new methods `runScheduledTick()` / `runScheduledPoll()` (cannot be bypassed by any future route/tool; the cron is a dumb driver). Fresh SQL reads every call (no caching). Existing `tick()`/`pollInbox()` RPCs stay untouched (tests + demo path).

`runScheduledTick` sends only when ALL hold:
1. `this.plan ∉ {demo, free}` — structural.
2. `clock_mode = 'real'` — the L4/L5 interlock (fresh read).
3. `readActivationState(sql, tenantId).activated` — the EXACT existing predicate (paid ∧ billing_state='active' ∧ ¬isLifecycleFrozen ∧ screening='clear'). No parallel copy.
4. `realSendPathLive(env)` (`activation.ts:98` — ENGINE_* ∧ INBOXKIT_* armed). Without it a paid+activated tenant gets a SandboxEmailPort and cron would mass-produce fake "sent" events.
5. **Credential-readiness defer:** no live-mailbox pending cred push — `NOT EXISTS (SELECT 1 FROM mailbox_cred_pushes p JOIN mailboxes m ON m.email=p.email AND m.tenant_id=p.tenant_id AND m.released_at IS NULL WHERE p.tenant_id=? AND p.status='pending')`. Rationale: an uncredentialed mailbox makes the engine throw UnknownMailboxError = PERMANENT VendorError → tick marks due rows 'failed' INSTANTLY (`tick.ts:389-421`) — first arming would drain a launched campaign to permanent 'failed' while manual grants are still being minted. Deferring is quiet, self-healing (5-min reconcile drives pushes). Static-config-only tenants have zero rows → pass. Whole-tenant granularity — simpler, honest, short-lived; documented tradeoff.
6. Leg-level kill switch: env `AUTOSEND_DISABLED` unset (checked once in `runSendPipelineAllTenants`; log when tripped). Ships enabled per founder ruling; this is the ops emergency brake. Categorize non-spend-arming for the env coverage test.
Then `runTick`'s own internal freeze guard (`tick.ts:147-155`) remains as the belt.

`runScheduledPoll`: legs 1-4 + 6 (no cred-defer — polling an uncredentialed mailbox must not block others; instead add per-mailbox try/catch INSIDE `runPollInbox` (`reply-processor.ts:254-286` currently lets one mailbox's throw abort the whole tenant's poll; cursor stays un-advanced on the failed one — no event loss)).

## DOUBLE-SEND SAFETY AT FIRST ARM
Four independent existing layers — the design adds no new send path:
1. DO-side atomic claim `pending→sending` with rowsWritten check before any await (`tick.ts:314-319`); overlapping sweeps serialize on the DO input gate.
2. Engine idempotency cache on `send:${tenantId}:${row.id}` (`engine.ts:87-88`) — a reclaimed/retried row returns the SAME messageId. Historical stuck-'sending' rows handled by shifting `sending_since` + existing TTL-reclaim + cache.
3. Engine in-flight claim → retryable SendInProgressError for a racing duplicate (`engine.ts:100-102`).
4. Pre-send WAL intent + 424 gate + boot reconcile (`engine.ts:109-124`, merged `608c80a`) — crash-window duplicates park, never re-dispatch.
First-arm burst: rebased step-1 rows due immediately (correct — never sent), bounded by day-1 caps + send window + cred-defer. Attack in review: two concurrent `runScheduledOpsSweep(env)` over a due backlog with a counting fake engine — exactly-once per row.

## CREDSTORE F1 — monotonic push sequence (must land BEFORE minter arms)
Content-hash is dedup, not ordering. Fix = Worker-owned monotonic sequence:
- Platform: new column `mailbox_cred_pushes.push_seq INTEGER NOT NULL DEFAULT 0`. In `pushRecordedMailbox` (`mailbox-credential-push.ts:107`): synchronously `UPDATE ... SET push_seq = push_seq + 1` then SELECT BEFORE the first await (DO single-thread ⇒ race-free claims; the audit's >30s-slow-push race gets distinct seqs). Send on the wire.
- Engine wire (`wire.ts:48-52`): optional `pushSeq: z.number().int().nonnegative().optional()`.
- Store (`mailbox-store.ts:111-154`): persist pushSeq per record; incoming.pushSeq < stored.pushSeq → new outcome `'stale'`, NO write; equal seq + same hash → 'unchanged'; equal + different content → BadRequest (two claims one seq = caller bug); absent pushSeq → legacy behavior. `remove()` keeps nothing; revive continuity from the Worker column, which survives status flips ⇒ seq monotonic per email forever.
- Worker treats `'stale'` response as SUCCESS (goal state holds) → row marked 'pushed'.
- RED test = the audit's proven attack verbatim (push v1 → rotate v2 → replay stale v1 ⇒ must stay v2).

## CREDSTORE F2 — teardown tombstone + revive
- `releaseMailboxes` (`lifecycle.ts:158-170`): after `revokePushedMailboxCredentials`, same per-mailbox iteration: `UPDATE mailbox_cred_pushes SET status='revoked', updated_at=? WHERE email=? AND tenant_id=? AND status IN ('pending','pushed')`. Reconcile selects 'pending' only → post-cancel resurrection dead. Ordering: tombstone AFTER revoke, BEFORE released_at mark (crash between ⇒ retry re-runs both; idempotent).
- Revive on legitimate re-provision: `recordProvisionedMailboxForPush` (:78-88) is `INSERT OR IGNORE` — a 'revoked' row would silently swallow the new record. Change to `INSERT ... ON CONFLICT(email) DO UPDATE SET status='pending', attempts=0, last_error=NULL, updated_at=excluded.updated_at WHERE mailbox_cred_pushes.status='revoked'` — revives terminal rows only, never resets a live 'pushed' row.

## OAUTH — safe live-verify plan (minter DARK until this passes + F1 merged)
Manual mint remains Mordy's path. Programmatic verify on a throwaway, driven DIRECTLY against InboxKit (scratchpad script, founder key) — never through a customer tenant:
0. Prereqs (founder asks): Google OAuth client id/secret from the 07-19 manual pilot; wallet headroom ~$15; explicit go for one throwaway domain + 1 mailbox.
1. Buy throwaway lookalike domain (never dmhadvisor — scheduled_for_deletion; never goauthorpitchdesk — Mordy's) → poll propagation (Wave-1 gates are the playbook).
2. Buy 1 mailbox → poll listable.
3. READ-ONLY FIRST: `GET /mailboxes/{uid}/credentials` → freeze RAW response shape (redact secrets) — independently verifies the `showMailboxCredentials` guess (`mailbox-port.ts:212-226`) before any OAuth mutation.
4. `POST /mailboxes/client-id-request/initiate` then `initiate-consent-request` (`oauth-mint.ts:96-101`) → freeze raw shapes. ABORT if any response implies workspace-wide (not per-domain) grant scope — blast-radius tripwire (shared workspace with Mordy's assets).
5. Prove the token REAL: refresh→access against Google, gmail_api self-send, read back via step-3 IMAP creds (live-proves the IMAP shape end-to-end).
6. Teardown: cancel warmup, release mailbox, remove domain, revoke test refresh token at Google.
7. Evidence → `docs/research/oauth-mint-live-verify-2026-08-XX.md`; zod-ify verified shapes; THEN a separate small increment swaps the minter behind env (`OAUTH_MINTER=inboxkit` + GOOGLE_OAUTH_CLIENT_ID/SECRET in `buildCredentialPushDeps`), adversary-gated before arming. Hard ordering: F1 merged → live-verify SHIP → swap → arm.

## FILE-BY-FILE CHANGE MAP
Platform (`apps/platform/src/`): `clock.ts` (requireVirtualClock guard, doc) · `tenant-context.ts` (type → Clock) · `tenant-do.ts` (clock selection at constructor/initTenant; switchToRealClock() from both checkout paths + sandboxAdapters=null; runScheduledTick/runScheduledPoll + predicate; advanceClock narrows; stale :817 comment) · `schema.ts` (clock_mode, push_seq + addColumnIfMissing) · `engine/clock-migration.ts` (NEW ~100 lines — one-shot rebase/reset/terminalize, pure SQL) · `scheduled.ts` (send-pipeline leg LAST; header refresh) · `admin/ops-sweep.ts` (runSendPipelineAllTenants: per-tenant try/catch, AUTOSEND_DISABLED, poll→tick order) · `engine/reply-processor.ts` (per-mailbox try/catch) · `engine/mailbox-credential-push.ts` (push_seq claim + wire field; 'stale'→pushed; ON CONFLICT revive) · `engine/lifecycle.ts` (tombstone) · `env.ts` (AUTOSEND_DISABLED, later OAUTH_*; categorized) · `test/helpers.ts` (clock branches on clock_mode) · `vendors/real/inboxkit-client.ts` (VERIFY AbortSignal.timeout; add if absent).
Engine (`apps/engine/src/`): `wire.ts` (pushSeq) · `mailbox-store.ts` (pushSeq persistence + 'stale') · `router.ts` (likely no change).
Docs: ARCHITECTURE #4 (clock law) · SPEC §6 (tick driver = cron) · ACTIVATION (arming order; kill-switch runbook) · engine README §directly-callable (historical) · demo.ts:3 comment · ROADMAP (close :33 ASK; drain Wave-2 on completion).

## TEST PLAN — fault-inject the REAL entry points
Every fix ships a test that FAILS on old code (revert-fail-restore on load-bearing ones):
1. Clock selection: paid initTenant ⇒ ctx.clock.now() ≈ Date.now; demo unchanged; paid advanceClock throws; demoRun on real-clock tenant impossible.
2. Migration (RED on old code): seed a paid DO the OLD way for BOTH delta signs ⇒ send_at rebased offsets preserved; demo rows skipped/paused; warmup reset day 1 for slot_counted=0, UNTOUCHED for slot_counted=1; idempotency claim reclaimable after 10 real minutes; second construction no-op; injected migration failure ⇒ virtual kept + driver refuses (interlock).
3. Driver at the real entry point: `runScheduledOpsSweep(env)` with a fault-capable fake engine ⇒ activated real-clock tenant's due rows SEND; one RED case per predicate leg (demo, free, past_due, suspended, canceling, disputed, screening=review, engine-unarmed, inboxkit-unarmed, clock_mode='virtual', pending cred push, AUTOSEND_DISABLED) — each sends NOTHING; a throwing DO doesn't abort others.
4. Cred-defer semantics (RED on naive design): launched campaign + pending push ⇒ rows stay 'pending' (NOT 'failed'); flip to 'pushed' ⇒ next sweep sends.
5. Double-send battery: two concurrent sweeps over a due backlog + counting fake engine ⇒ exactly one wire send per row; stuck-'sending' reclaim ⇒ cached messageId, zero second sends; SendInProgressError path exercised.
6. Poll isolation: mailbox A throws ⇒ B polled, A's cursor un-advanced.
7. F1 (engine, RED = audit's attack): v1(seq1)→v2(seq2)→stale v1 ⇒ store keeps v2, outcome 'stale'; equal-seq conflict rejected; legacy path unchanged.
8. F2 (RED = audit's attack): push→teardown→reconcile ⇒ no resurrection; re-provision after cancel ⇒ row revived 'pending' and pushes.
9. Guard rails: clock-provenance test — no `new VirtualClock(` outside clock.ts/tests/blessed DO sites; env coverage test categorizes new vars.
Battery per increment: full engine + platform suites (never filtered), workspace typecheck script (never raw tsc), build before deploy.

## INCREMENTS (ONE integration branch → ONE PR; build only after Wave 1 merges — provisioning.ts/ops-sweep.ts collide)
- Inc-A (engine lane, independent): F1 store+wire+tests.
- Inc-B (platform lane, independent): F2 tombstone+revive + Worker push_seq stamping + tests.
- Inc-C (hard-builder tier — the risky one): L5 clock selection + migration + type widening + guards + helpers.
- Inc-D (after C): L4+L6 drivers + predicate + kill switch + poll isolation + scheduled wiring + tests 3-6.
- Inc-E: docs/comment sweep + ledger updates → fresh-context adversary gate on the COMBINED diff (attack surface: migration both-signs, predicate completeness, first-arm burst, cred-defer starvation) → ONE PR → Yaakov merges → deploy → ARM VERIFICATION (live): watch one cron cycle's sweep log; confirm Mordy's DO flipped clock_mode='real' with sane opsSummary/infrastructure_status; confirm zero sends (he has no campaigns) — quiet-correct is the pass.
- Inc-F (parallel, no merge dependency): OAuth live-verify runbook (founder-gated spend) → evidence doc → minter-swap increment, separately gated, armed only after F1 live.

## RESIDUALS / ACCEPTED
- An async saga in flight across the flip stamps virtual times post-migration — bounded to one call; scheduled_sends' only writer (launchCampaign) is fully synchronous so no pending-send row affected.
- Ticking tenants run deliverability/warmup-cancel twice per cycle (idempotent; accepted for minimal diff).
- Whole-tenant cred-defer can briefly hold sends for partially-credentialed fleets; self-heals via 5-min reconcile.
- slot_counted=0 crash-window real row gets a too-LOW warmup reset (safe direction).
- purchased_at liability-estimate skew on virtual-stamped adopted domains (cosmetic).
- Cron fan-out O(N tenants) — alarm revisit trigger recorded.

---

# WAVE 2 DESIGN v2 — REVISION DELTA (2026-08-05, responds to docs/adversarial/wave2-design-review-2026-08-05.md NO-SHIP)

> Delta only; v1 above stands except where replaced below. Designer re-verified every verdict citation against main @ ef1c2db before revising: 422 graded RETRYABLE Worker-side (email-port.ts:43-53), ENGINE_REQUEST_TIMEOUT_MS = 3*60*1000 (:38), listAllTenantIds no ORDER BY (admin/db.ts:133-136), inboxkit-client 30s AbortSignal (inboxkit-client.ts:31,:75), BYO insert has no slot_counted and no engine push (byo-mailbox-composition.ts:106-107), sent_message_keys evicted on ctx.clock (threads.ts:169), reclaim doesn't touch send_at (tick.ts:200-205). All confirmed; the verdict is right on all 8.

## §1 — Findings 1+2+3 (interlocked): send-eligibility becomes PER-MAILBOX; leg 5 (whole-tenant cred-defer) is DELETED

**What changes.** v1's predicate leg 5 is removed. Its rationale was false (422 = unknown mailbox is deliberately retryable at the Worker — the tick reverts and retries under the 5-attempt cap). It was simultaneously too narrow (sandbox mailboxes have NO push row — maybePushProvisionedMailbox early-returns on provider 'sandbox' — so the hazard population passes the guard) and too broad (one un-grantable or N4-defect 'pending' row starves the whole tenant forever, silently). Replaced by three mechanisms:

**(a) New provenance column + per-mailbox eligibility in the tick's capacity picker.**
- New column `mailboxes.provider TEXT NOT NULL DEFAULT ''` (schema.ts + addColumnIfMissing). Write path going forward: insertProvisionedMailbox records provisioned.provider (the ports already return 'sandbox' vs 'google' — currently dropped at insert); connectByoMailbox writes 'byo'.
- The tick's candidate query (tick.ts:273-282) gains, for PAID tenants only (ctx.plan ∉ {demo,free}; demo/free behavior byte-identical):
  `AND m.released_at IS NULL` (explicit, no longer incidental via 'paused')
  `AND m.provider NOT IN ('sandbox','')` (phantom sandbox rows can never be picked, even if retirement missed one)
  `AND m.source != 'byo_connected'` (temporary: this build wires NO engine credentials for BYO mailboxes; lift when the BYO→engine push lane ships)
  `AND NOT EXISTS (SELECT 1 FROM mailbox_cred_pushes p WHERE p.email = m.email AND p.status = 'pending')` — per-mailbox exclusion of known-not-yet-credentialed mailboxes. NOT-pending (not requires-pushed) polarity is deliberate: a mailbox with NO row at all is the operator-static-config emergency path which the Worker cannot observe and must not block; every platform-provisioned real mailbox always gets a 'pending' row before push, including the N4 claim-outlives-teardown row — which sits excluded and inert instead of starving anyone. One slow-minting mailbox out of N costs exactly that mailbox's capacity; the other N−1 send.
- Rows with no eligible mailbox defer (picked=null → deferred++, stay 'pending') — never burn attempts against a mailbox we know isn't ready.

**(b) Migration retirement of sandbox-origin mailboxes on the paid flip (replaces v1's slot_counted-guarded warmup RESET — N1 fold).** Classification backfill inside the migration: provider := 'byo' where source='byo_connected'; 'google' where slot_counted=1; else 'sandbox'. Then retire the 'sandbox' set: released_at = realNow, deliv_status='paused' (no vendor call — nothing at the vendor). Kills finding 1 at the root; incidentally fixes NEW-2 (warmup-cancel's doomed resolveMailboxUid attempts + false give-up alerts on demo-era rows reading send-ready under the frozen clock); removes their forever-poll cost; stops NEW-1's domain-aggregate pollution growing. Billing: billableMailboxCount drops but syncMailboxQuantity's max(5, count) floor holds Mordy at 5 — honest, documented. v1's warmup_started_at RESET now applies to NOTHING (sandbox retired; slot_counted=1 rows keep real vendor stamps; byo rows keep their ramp). The ''-provider ambiguity for real rows predating the column is gated by §9-U2's pre-arm read; any real-but-classifies-sandbox row blocks arming until a one-line operator reclassification.

**(c) The alerts the "quiet" choice omitted.** Two watchtower checks (existing state machine — dedup + 6h cooldown) fed by new read-only opsSummary fields: (1) aging pending push — any mailbox_cred_pushes row 'pending' with updated_at older than 30 min on an activated tenant → founder alert naming the mailbox; (2) send-starved tenant — activated tenant with >0 due non-demo 'pending' scheduled_sends and zero eligible mailboxes under (a)'s predicate → founder alert. Digest keeps its pendingCredentialPushes line.

**Files:** schema.ts, tenant-do.ts (addColumnIfMissing), engine/tick.ts (picker), engine/provisioning.ts + engine/byo-mailbox-composition.ts (provider at insert), engine/clock-migration.ts (backfill + retirement), engine/ops-summary.ts, admin/watchtower.ts.
**Tests:** RED reproducing finding 1 exactly — paid tenant with 2 sandbox + 2 real-credentialed mailboxes, due rows, fault-capable fake engine: old code routes to the sandbox row and drains to 'failed'; new code sends only from the real rows. Per-mailbox starvation test: 1 pending-push mailbox + 1 pushed → sends flow from the pushed only. N4-shaped row → excluded, others send. Static-config shape (no push row, provider 'google') → eligible. BYO row → not picked. Watchtower: both alerts fire once + cooldown; clear when resolved. Demo tenant picker byte-identical (regression).

## §2 — Finding 4: SHIFT list fix
The migration shifts send_at for status IN ('pending','sending') (and sending_since where non-null, unchanged). Rationale: the TTL reclaim restores status only (tick.ts:200-205 — never touches send_at); a 'sending' row under a future-frozen clock would otherwise dead-letter until real time catches up, and the one-shot migration forecloses correction. Terminal rows stay untouched (audit).
**Files:** engine/clock-migration.ts. **Tests:** seed a 'sending' row with future-frozen send_at + sending_since; post-migration it reclaims on the first tick AND its send_at is due-comparable now (RED on v1's list).

## §3 — Finding 5: migration idempotence via explicit transaction + persisted delta
The entire migration — provider backfill, retirement, SHIFTs, TERMINALIZE, and the clock_mode='real' stamp — runs inside ONE `this.ctx.storage.transactionSync(() => {...})` block. A throw anywhere rolls back everything including the marker: the retry re-enters a genuinely virgin state, so double-shift is structurally impossible; U3 becomes moot. Two audit columns persist inside the same transaction: clock_migration_delta_ms INTEGER and clock_migrated_at INTEGER — the applied delta is on disk for forensics/correction. v1's ensurePartialDedupeIndex precedent citation is withdrawn (safe only where partial application is tolerable; here it is corrupting). Failure handling: catch → log loud → keep VirtualClock + 'virtual' → predicate interlock keeps the driver off → retry next construction, against clean state.
**Files:** engine/clock-migration.ts, tenant-do.ts, schema.ts (audit columns). **Tests:** fault-inject a throw mid-migration: assert FULL rollback (send_at unshifted, clock_mode='virtual', no retirement), then a clean re-run applies exactly once (RED on v1: partial apply + re-run double-shifts). A transactionSync availability probe in the miniflare suite.

## §4 — Finding 6: the flip closes over a DELEGATING clock
**Decision: context epoch via delegation.** TenantDO holds `private currentClock: Clock`; every TenantContext receives a ~10-line DelegatingClock whose now() reads this.currentClock.now() at CALL time. switchToRealClock() swaps currentClock; every in-flight saga's very next ctx.clock.now() reads real time — the accessor class of the hole is dead outright, including the verdict's concrete harm (post-flip request_idempotency claim stamped ~600 days ahead: the claim row of a saga already in flight was written synchronously pre-flip and is covered by the SHIFT; post-flip claims read real). Bonus vs v1: the cached sandboxAdapters bundle holds the delegate too, so v1's cache-invalidation-on-flip requirement is withdrawn. requireVirtualClock narrows against currentClock.
Rejected alternatives: (b) gating saga starts cannot reach a saga already in flight; DOs cannot enumerate/drain in-flight RPCs. (c) detect+repair adds a standing sweep for a transient window and leaves a wedged-key interval.
**Bounded residual, enumerated:** values captured into locals BEFORE the flip and written after — exactly two async engine functions capture `const now = ctx.clock.now()` then await: provisioning.ts:76 (created_at-class stamps — cosmetic) and threads.ts:136 (one reply's sent_message_keys stamp — next reply re-derives real). withRequestIdempotency's local is used only in its synchronous prefix (verified) — no load-bearing local survives an await. Build-note: audit for new `const now = ctx.clock.now()` + post-await writes when touching engine files.
**Files:** clock.ts (DelegatingClock + requireVirtualClock), tenant-do.ts. **Tests:** start a fake multi-await saga holding a ctx, flip mid-flight, assert its post-flip ctx.clock.now() reads real (RED on v1) and a post-flip idempotency claim from a NEW call is real-stamped.

## §5 — Finding 7: wall-clock budget + rotation for the send-pipeline leg
- **Per-tenant budget:** each tenant's poll+tick pair runs under Promise.race with a 60s deadline; on expiry log {tenantId, phase, elapsed} and move on. The abandoned RPC keeps running server-side (DO RPCs aren't cancellable) — safe via row-claim + engine-idempotency; next-cycle overlap serializes on the DO input gate.
- **Leg deadline:** 150s total, checked between tenants; on expiry log skipped count and stop. U4 stays open, but the leg degrades to "some tenants this cycle" instead of "tail tenants never."
- **Rotation:** start offset = Math.floor(Date.now()/300_000) % tenantIds.length — stateless, deterministic; without it a stalled tenant permanently heads the stable queue.
- **Corrections folded (N4):** inboxkit-client timeout EXISTS (30s) — v1 line withdrawn. "Hangs are bounded" corrected to: bounded per-REQUEST at 180s/engine-call — precisely why the leg needs an aggregate budget (10 due rows on a wedged-but-accepting engine = 30 min of leg time without one).
**Files:** admin/ops-sweep.ts. **Tests:** fake stalled tenant (never-resolving RPC): leg completes within budget, others processed, skip logged; rotation test across two simulated cycles (tail tenant processed in cycle 2); leg-deadline with N slow tenants.

## §6 — Finding 8: tombstone BEFORE revoke; engine remove() keeps a pushSeq tombstone
**Worker half:** per-mailbox order in releaseMailboxes: (1) tombstone UPDATE (synchronous SQL, before any await); (2) vendor release; (3) engine revoke; (4) mark released_at. v1's after-revoke rationale withdrawn — retry semantics are identical either way (loop driven by released_at IS NULL, marked last; tombstone UPDATE idempotent, revoke re-runs), and tombstone-first closes the reconcile-in-the-await-gap window.
**Engine half (closes the in-flight case):** remove() deletes credentials but retains tombstones[email] = last seen pushSeq in the state file. upsert with no live record consults the tombstone: incoming pushSeq ≤ tombstone → 'stale', no write; pushSeq > tombstone → 'created' + tombstone cleared; seqless push against a tombstone → 'stale' (resurrection is the harm; the prod pushed path always carries a seq after this wave). Legitimate post-cancel re-provision works: the Worker-side push_seq counter survives the status flip, the revive bumps it, fresh push carries seq > tombstone.
**Files:** engine/lifecycle.ts; engine mailbox-store.ts (+ state-shape tolerance in the loader). **Tests:** RED = the verdict's exact race (reconcile between revoke and old-order tombstone → resurrection; closed under tombstone-first); engine RED = push in flight when remove() lands → old 'created', new 'stale'; revive-after-cancel accepted; seqless-vs-tombstone → 'stale'.

## §7 — Refuted-claim corrections + non-blocking dispositions
- **N1 (folded into §1b):** all provenance decisions run on the provider column with backfill; the RESET that hit BYO ramps is gone.
- **N3 correction:** the skew mechanism is raw virtual milliseconds via advanceVirtual() (demo.ts:36, tenant-do.ts:975) — the 1440 multiplier is consumed only by advance(), zero non-test callers. Magnitude ≈ ~32 virtual days per demo run × up to 20 runs; both delta signs remain required. v1's "×1440" mechanism claim withdrawn.
- **N4:** folded into §5.
- **N5 (sent_message_keys) — LEAVE, residual recorded:** mixed-base table (sandbox rows stamp ctx.clock, real-port rows stamp droplet time) — shifting would corrupt real rows. The flip REPAIRS the pre-existing self-purge pathology. Residual: sandbox-era future-stamped rows outlive their TTL; effect is a dedupe entry surviving longer — stale-return-without-send is the dedupe working as designed, just longer. Recorded.
- **N6 — root cause adopted:** runPollInbox's mailbox query gains AND released_at IS NULL (CLAUDE.md rule f), in addition to the per-mailbox try/catch.
- **N7 — build-note (Inc-D):** stamp sending_since with a fresh ctx.clock.now() at the claim statement, not the tick-start now. Test: simulated long tick, late-claimed row not reclaimed by a concurrent sweep.
- **N8 — F1 framing corrected:** push_seq orders CLAIMS, not content. The guarantee: a push CLAIMED earlier can never overwrite one claimed later. Benign on both mint paths. Stated in the store doc comment.
- **N9 — OAuth runbook reordered:** the grant-scope question is answered OUT-OF-BAND (InboxKit docs/support) BEFORE any mutation; no client-id-request/initiate until the answer is in hand. Same ticket asks for the client-id de-registration path (if none exists, the teardown's domain deletion is the assumed cleanup, stated as an assumption). Ledger-divergence statement added: the direct-API run's spend (~$15) and slot consumption bypass vendor_spend_ledger and vendor_slot_state; manual ledger note + post-teardown reconciliation against the vendor console.

## §8 — NEW-3 + increment-plan delta
- Inc-D's scheduled.ts edit lands TOGETHER with the pending R2 warmup-cancel-below-watchtower reorder (ROADMAP 2026-08-02 fast-follow) — same file, one change, ledger R2 satisfied in the same commit.
- Inc-C grows: provider column + backfill + retirement + transactionSync migration + DelegatingClock (§1b, §3, §4). Inc-D grows: picker eligibility + budgets/rotation + N6/N7 + watchtower alerts + opsSummary provenance fields (§1a, §1c, §5). Inc-B gains tombstone-first + engine tombstone (§6). Inc-F gains the reordered runbook (§7-N9). Everything else in the v1 increment plan stands, including ONE integration branch → ONE PR and the fresh-context re-gate on the combined diff before arm.

## §9 — U1/U2 as build-lane verification steps
- **U1 (Inc-C):** miniflare probe binding NaN to mailboxes.warmup_started_at (INTEGER NOT NULL). Regardless of outcome, add the cheap hardening now: Number.isFinite clamp on RealMailboxPort.startWarmup's Date.parse result (throw VendorError on non-finite — fail loud at the port, per N2's proven ramp math where NaN/null ⇒ cap 40 + instant warmup-cancel) and a finite-guard floor in computeWarmupDay. The probe decides whether a backfill sweep is ALSO needed (cannot be today — zero real mailboxes ever provisioned — but the probe closes the class).
- **U2 (pre-arm gate, Inc-D):** extend admin-authed opsSummary with a read-only per-mailbox provenance array {email, source, slot_counted, provider, released_at, warmup_started_at}; the arm-verification runbook reads Mordy's tenant BEFORE arming and confirms (i) classification labeled every row correctly, (ii) which demo-era rows the migration retired. Any real-but-classified-sandbox row blocks arming until a one-line operator reclassification. The field stays as standing ops visibility.
