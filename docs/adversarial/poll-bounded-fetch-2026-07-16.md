# Adversarial review — /v1/poll unbounded-first-fetch fix

- **Date:** 2026-07-16
- **Reviewer:** adversary (fresh context)
- **Ground truth:** `git rev-parse HEAD` = `bf3a927e2869d038f201b315de146735e477708f`, branch `main`; working-tree diff vs HEAD.
- **Scope:** `apps/engine/**` only — `src/imap.ts`, `src/engine.ts`, `test/engine.test.ts`, `test/router.test.ts`, `test/greenmail.e2e.test.ts`, `README.md`. `apps/platform/**` working-tree changes ignored (different agent mid-build); `reply-processor.ts` read for grounding only.
- **Verification:** engine suite `64 passed | 3 skipped`; `npm run typecheck` exit 0; production `EmailEngine.poll` driven directly through the consumer loop in a scratch sandbox (tsx + repo node_modules).

## VERDICT: NO-SHIP

One BLOCKING event-loss finding demonstrated against real code, plus a corroborating BLOCKING test-integrity finding. The current BYO pilot mailbox (`founder@authorpitchdesk.com`, has history) is **unaffected** — the defect is guaranteed only for mailboxes that are empty at first poll (any freshly-provisioned mailbox). Main loop owns the ship-scope decision given the BYO caveat.

## Findings (most severe first)

### 1 · BLOCKING · Lens 1b — Guaranteed loss of the FIRST inbound on every empty mailbox (cursor-0 sentinel collides with empty)
`poll_cursor` is `INTEGER NOT NULL DEFAULT 0` (`schema.ts:85`, `tenant-do.ts:131`) and `runPollInbox` passes it straight to `poll()` (`reply-processor.ts:286`). `sinceCursor === 0` is overloaded as BOTH "never polled" AND the natural state of a freshly-provisioned empty mailbox (UIDNEXT=1 → `mailboxHighWaterUid = max(0, 1-1) = 0` → cursor 0). So:

- Tick 1 (empty): `poll(email, 0)` → first-contact branch (`engine.ts:136`) → `{events:[], cursor:0}`. Consumer persists 0.
- A real reply/bounce arrives at UID 1.
- Tick 2: `poll(email, 0)` is STILL first-contact (persisted cursor never left 0) → sets cursor=1, fetches nothing → **UID 1 is skipped and the cursor advances past it. Permanent loss.**

**Demonstrated against production `EmailEngine.poll`** (scratch driver, real engine.ts/store.ts/classify path):
```
[A: empty provisioned mailbox]  arrived UID 1  -> fetchRange calls: []      -> NEVER FETCHED (LOST)
[B: BYO w/ 5 history msgs]      arrived UID 6  -> fetchRange {5,6}          -> FETCHED (delivered)
```
This is a REGRESSION, not inherited semantics: the old `${sinceUid+1}:*` (= `1:*`) code DID catch the first message on an empty mailbox (UID 1 > 0). It violates the README's own headline contract ("the next poll redelivers the same events … instead of dropping them forever"). A lost first reply → stop-on-reply never fires (keep cold-mailing a responder); a lost first hard bounce → address never suppressed. Builder's disclosure ("skipped once") is accurate but undersells it: it is not a race, it is a **guaranteed** loss of the first inbound on the empty-mailbox class, and it is framed as benign "history" semantics.
**File:** `apps/engine/src/engine.ts:136-138`. **Root cause:** cursor 0 cannot distinguish "never polled" from "polled, empty." **Fix direction (flag only):** a sentinel distinct from a valid empty cursor (e.g. `-1`/NULL for never-polled), or a separate "initialized" flag, so an empty mailbox pins its watch-start exactly once and takes the incremental branch thereafter.

### 2 · BLOCKING (integrity) · Lens 4 — greenmail e2e priming is illusory on an empty mailbox; the only real-wire coverage would time out if run
`beforeAll` primes `senderCursor = (await engine.poll(SENDER, 0)).cursor` on a FRESH GreenMail where SENDER's INBOX is empty (nothing is sent to SENDER before prime; test 1 sends SENDER→LEAD, landing in LEAD's box). Empty → UIDNEXT=1 → `primed.cursor = 0`. `pollUntil` then re-polls with the fixed `sinceCursor=0` every iteration (`greenmail.e2e.test.ts:44-49`), which stays in first-contact forever and never returns the injected reply/DSN → throws "timed out" after 30 tries. The e2e is `describe.skipIf(!RUN)` (Docker-gated, ENGINE_E2E=1), so `npm test` is green while the sole imapflow-wire coverage is silently broken. The priming comment ("initializes the cursor at the mailbox's current high-water") gives false confidence that first-poll ordering was validated. Live run UNVERIFIABLE here (docker run denied) but the trace is airtight and shares the finding-1 root cause. **File:** `apps/engine/test/greenmail.e2e.test.ts:58-69, 44-49`.

### 3 · NON-BLOCKING · Lens 1a — cursor advances past a still-existing message whose body fetch returns no source
`fetchRange` skips any `msg` where `!msg.source` (`imap.ts:81`) but iteration completes normally and `poll` sets `cursor: throughUid` regardless (`engine.ts:156`). Old code set `cursor = max-returned-UID`, so a skipped UID was retried next poll; new code advances past it. Realistic trigger is concurrent expunge (loss moot — message already gone); a transient body-fetch failure on a still-present message would be lost. Genuine mid-iteration connection errors DO throw (`UpstreamTransientError`) → cursor not advanced → safe redelivery, so this is narrow. Trade-off is intentional (bounded range requires `cursor=throughUid` to avoid expunge-gap stalls), but the residual should be tracked.

### 4 · NON-BLOCKING (pre-existing) · Lens 2 — UIDVALIDITY change strands the cursor
Neither `currentUidNext` nor `fetchRange` reads UIDVALIDITY. If the mailbox is rebuilt, the persisted cursor references a dead UID space; new low-UID arrivals sit below the cursor and `throughUid = min(newHighWater, cursor+CAP)` collapses to `throughUid <= sinceCursor` → nothing fetched until the new space climbs past the old cursor. Present in the OLD code too (`N:*` quirk + `msg.uid > sinceUid` filter) → PRE-EXISTING, not introduced by this diff; the fix doesn't address it.

### 5 · NON-BLOCKING · Lens 5 — the anti-stall property (the fix's headline rationale) is untested
The stated reason for `cursor: throughUid` is "a gap of deleted/expunged UIDs can never stall forward progress." No new test exercises `throughUid > max(returned UID)` (top-of-range expunged): every fixture is dense (max present UID == throughUid), and the gap-at-6 case yields max-returned==throughUid==7. Traced: reverting `cursor: throughUid` → `cursor: max-returned` would PASS all four new tests. The added `uidNextByMailbox` override can express an expunged top but no test uses it that way. (First-contact regression IS caught — `imap.fetched` length 0; CAP+1 IS caught — asserts `throughUid===301` exactly.)

### 6 · NON-BLOCKING · Lens 6 — README wording
"initializes the cursor at the mailbox's CURRENT UIDNEXT" — it initializes at UIDNEXT-1 (high-water); the engine.ts comment is correct. More materially, the README presents first-contact purely as "never pulls history" and omits the empty-mailbox first-inbound loss (finding 1).

## Attacks that FAILED (PASS is meaningful)
- **Lens 1c (range off-by-one):** `fetchRange(sinceUid, throughUid)` → `${sinceUid+1}:${throughUid}`, filter `uid>sinceUid && uid<=throughUid`, `cursor=throughUid`; next poll starts at throughUid. No gap, no overlap at either end. First-contact cursor = uidNext-1 correctly treats the message at that UID as history and catches uidNext next tick. HELD.
- **Lens 1d (retransmission/reclaim):** engine advances NO durable state; `poll(same cursor)` re-derives the same range → same events. Redeliver test passes. HELD.
- **Lens 3 (paging double-classification):** pages fetch disjoint `(sinceCursor, throughUid]` ranges, cursor persisted per page, next page starts at throughUid → no UID in two pages; cap test proves 301→601→800 with exactly-CAP pages. `classify.ts` byte-unchanged (not in diff). Worker message_id dedupe is a backstop. HELD.
- **Lens 2 (STATUS/UIDNEXT upper-bound race):** a message arriving between STATUS and fetch gets a UID above `throughUid` → picked up next tick, not lost. HELD.
- **Cap boundary (CAP+1):** `sinceCursor + POLL_BATCH_CAP` with `fetchRange` filter yields exactly CAP messages; the test asserts `throughUid===301` exactly → a 302 regression would fail. HELD.

## UNVERIFIABLE
- **Live greenmail e2e run** — `docker run` denied in sandbox. Finding 2 rests on trace (airtight, shares finding-1 root cause). Resolve: `ENGINE_E2E=1` run against a fresh `greenmail/standalone:2.1.3` — expected to time out on the reply test.
- **imapflow partial-fetch-without-throw** (finding 3 real-world frequency) — needs a flaky live IMAP server; not reproducible here.

## Ledger cross-ref
Same class as the original engine-HOST NO-SHIP: "missed REPLY does NOT self-heal → keep cold-mailing a responder." Prior arc closed the lost-RESPONSE window (consumer-owned cursor); this fix reopens a lost-FIRST-EVENT window on the empty-mailbox path.

---

# ADDENDUM — Round-2 re-verdict (2026-07-16, same day)

- **Ground:** HEAD unchanged `bf3a927e2869d038f201b315de146735e477708f` (working-tree only). Scope: `apps/engine/**` + poll_cursor hunks of `apps/platform/src/{engine/provisioning.ts,schema.ts,tenant-do.ts}` + `test/idempotency.test.ts`. Webhook lanes explicitly out of scope.
- **Verification:** engine `68 passed | 3 skipped`; platform `407 passed (62 files)`; engine + platform `typecheck` both exit 0; my OWN reproduction driver re-run against the fixed code (both `-1` and `0` starts).

## VERDICT: SHIP

Both round-1 BLOCKING findings are genuinely closed, the finding-5 test-gap is closed, the finding-6 README off-by-one is fixed. No new blocking issue found.

### Finding 1 (empty-mailbox first-inbound loss) — CLOSED
`-1` is now the never-polled sentinel; `0` is an ordinary incremental cursor. Wired end-to-end: `wire.ts` `sinceCursor: z.number().int().min(-1)`; `schema.ts`/`tenant-do.ts` DEFAULT `-1`; `provisioning.ts` INSERTs `-1` explicitly; `engine.ts:136` first-contact only on `=== -1`. **My round-1 reproduction now FAILS (attack defeated):** empty mailbox, first inbound at UID 1 → `fetchRange {0,1}` → FETCHED, for BOTH the new `-1` provisioning start AND an existing-`0` row. Discriminating regression test `engine.test.ts:266-294` (poll(-1)→cursor 0; reply at UID 1 → poll(0) asserts event + cursor 1) — would fail under the round-1 `0`-sentinel.

### Finding 2 (greenmail e2e priming illusory) — RESOLVED (structurally; live run UNVERIFIABLE)
`beforeAll` primes `poll(SENDER, -1)` → cursor = high-water (0 on empty). `pollUntil` then re-polls `sinceCursor=0`, which is incremental (`fetchRange(0,1)` catches the injected reply at UID 1). Trace-sound. Live `ENGINE_E2E=1` run still not executed — `docker run` denied in sandbox.

### Finding 5 (anti-stall property untested) — CLOSED
`engine.test.ts:362-378`: messages through UID 305, UIDNEXT=500, poll(10) with cap → `throughUid=310`, asserts `cursor===310`. Max-returned would be 305 → the test now discriminates `cursor=throughUid` from `cursor=max-returned`. My round-1 "revert-still-passes" claim is dead.

### Finding 6 (README off-by-one) — FIXED
README now reads "initializes the cursor at the mailbox's CURRENT high-water (`uidNext - 1`)" and discloses the `-1`/`0` distinction. No new inaccuracy.

## New-semantics probes (all held)
- **`0` unambiguous everywhere:** grep confirms nothing special-cases cursor `0`; the only sentinel check is `=== -1` (engine.ts). No UI/reporting reads `poll_cursor` — only `reply-processor.ts` (passes to poll) and the idempotency test. No `poll_cursor` reset-to-`-1` path exists, so a mailbox goes `-1 → >=0` once and never regresses to first-contact.
- **Existing-`0` migration reasoning — SOUND (no loss):** an existing `0`-row is treated as incremental-from-UID-1, bounded/capped — never re-primed as first-contact. Empty `0`-row correctly catches its first inbound (driver scenario B: `fetchRange {0,1}` → FETCHED). A `0`-row with large history would page 300/tick (bounded memory, no OOM, no loss) — at worst catch-up latency, and only hypothetical: BYO mailboxes now provision at `-1` (first-contact skips history), and the engine is dark/never-armed so no live `0`-with-history exists. Conservative no-loss choice over the faster re-init-to-`-1`; defensible.
- **Sandbox `-1` leak — inert:** sandbox `poll` echoes `sinceCursor` unchanged (`vendors/sandbox/email-port.ts:116`) and delivers from its in-memory queue regardless of cursor, so a sandbox mailbox holding `-1` forever loses nothing; on a future upgrade to the real engine, `poll(-1)` correctly first-contacts.
- **idempotency test math (`-1+10=9`):** the stub port returns `sinceCursor+10`; start `-1`→`9`→`19`, `seen=[-1,9]`. Still asserts the real contract (consumer-owned cursor, pass-STORED-not-fixed, persist-returned). The `+10` is an arbitrary stub advance, not an engine-math claim.

## Carried NON-BLOCKING (unchanged from round 1)
- Source-less-message cursor-advance (`imap.ts:81` skip + `engine.ts:161` cursor=throughUid) — narrow; realistic trigger concurrent-expunge = moot; real errors throw → safe redelivery.
- UIDVALIDITY unhandled — PRE-EXISTING (present in old code too).

## UNVERIFIABLE
- Live greenmail e2e (`ENGINE_E2E=1`) — docker run denied. Finding-2 resolution rests on trace. Resolve with a manual run against fresh `greenmail/standalone:2.1.3` (expected: reply + DSN tests now PASS).

---

# ADDENDUM 2 — Re-ground after HEAD advanced (2026-07-16, same day)

**HEAD moved `bf3a927` → `3d7d27d` mid-session (a sibling COMMITTED the fix).** Re-verified against the current tree per read-only-git discipline (a review of stale code is a false PASS).

- **Fix is now COMMITTED and byte-identical to what ADDENDUM 1 reviewed.** `git diff bf3a927 -- <poll files>` shows the same `-1`-sentinel content (engine.ts `sinceCursor === -1` first-contact, imap.ts `fetchRange`, wire.ts `min(-1)`, provisioning.ts explicit `-1` INSERT, idempotency.test.ts `-1`/`9`/`[-1,9]`). Live `poll_cursor` DEFAULT is `-1` in `schema.ts:97` and `tenant-do.ts:149` — NOT clobbered by the uncommitted webhook edits.
- **The ONLY remaining uncommitted changes to the in-scope files (`schema.ts`, `tenant-do.ts`) are the WEBHOOK lane** (webhook_subscriptions/deliveries tables + imports/methods) — out of scope, owned by a separate adversary, correctly ignored. The poll_cursor hunks are committed.
- **`-1` never reaches `fetchRange` as a numeric bound (the raised edge) — PROVEN.** `engine.ts:145` returns `{events:[], cursor:highWater}` on `sinceCursor === -1` BEFORE the `fetchRange` call at `:154`; `fetchRange`'s `sinceUid` is therefore always `>= 0`, so its range is always `${sinceUid+1}:${throughUid}` >= `1:…` (never `0:…` or negative). Driver evidence: the `-1`-start scenario's only `fetchRange` call is `{sinceUid:0, throughUid:1}` (from the subsequent poll(0) tick), never `sinceUid:-1`.
- **Re-verification on the current tree:** finding-1 driver re-run → ATTACK FAILS (first inbound FETCHED for both `-1`-start and `0`-start); engine typecheck 0, engine `68 passed | 3 skipped`; platform typecheck 0, platform `407 passed (62 files)`.

## VERDICT (re-ground): SHIP — unchanged. Fix is committed, intact, and all attacks re-run and held.
