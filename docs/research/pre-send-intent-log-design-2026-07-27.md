# Pre-send intent log — design (2026-07-27)

> Status: ADVERSARY VERDICT **SHIP-AFTER-FIXES** (frozen: `docs/adversarial/pre-send-intent-log-design-review-2026-07-27.md`) — fixes APPLIED below same day (see "Adversarial-review amendments"); cleared for build. Closes ACTIVATION Gate-2 residual (1): crash-after-transport-accept-before-record ⇒ redelivery double-send — founder-accepted for the pilot ONLY (ruling E, 2026-07-19); a durable pre-send intent log is REQUIRED before GA sending volume. Designed by the planning lane 2026-07-27, grounded file:line against HEAD `a024970`.

## Validated shape + two deliberate deviations

Write-ahead intent → submitted → recorded, plus boot reconciliation and per-transport verification rules — validated. Deviations from the naive shape:

1. **v1 does NOT do the Gmail SENT-folder token search** — it parks intent-only Gmail danglings and auto-finalizes only off the durable `submitted{gmailId}` line, because `messages.list?q=` is FORBIDDEN under the `gmail.metadata` scope we hold, and a false "verified-absent" is the one outcome that re-opens the double-send. The SENT-scan is a flagged follow-up increment (see Increment 5).
2. **The main JSON store becomes a compaction snapshot of the log** rather than gaining its own fsync discipline — the log is the only thing that must be power-loss-durable.

## Grounding (file:line)

- Crash window: `apps/engine/src/engine.ts:110-118` — transport accept (dispatchSend resolves) precedes recordSend; the in-flight claim is memory-only (`store.ts:44-55`, self-documented residual at `store.ts:50-53`). Named blocking-residual (a) in `docs/adversarial/engine-host-review-2026-07-14.md:46`, reaffirmed as the at-least-once residual in `docs/adversarial/engine-443-transports-2026-07-16.md:17`. Founder acceptance pilot-only: `ACTIVATION.md:27`.
- Store today: `store.ts:114-123` flush = writeFileSync + renameSync — atomic against torn REPLACEMENT and safe across process crash (page cache survives), but NO fsync ⇒ not power-loss/kernel-panic durable; sends+threads are written ONLY by recordSend (`store.ts:96-107`), which is what makes the WAL-over-snapshot refactor small. Loader is fail-loud on corrupt (`store.ts:126-181`).
- Worker contract: idempotencyKey = `send:${tenantId}:${row.id}` (`tick.ts:374`); SEND_CLAIM_TTL_MS=5min, MAX_SEND_ATTEMPTS=5, reclaim bumps attempts (`tick.ts:32-41,167-199`); ENGINE_REQUEST_TIMEOUT_MS=180s + RETRYABLE_ENGINE_STATUSES={409,422} (`email-port.ts:38-47`) — any OTHER 4xx is already graded permanent (`email-port.ts:112`), which the design exploits so parking needs ZERO platform code change.
- Gmail read-back: `gmail.ts:88-90` send returns gmailId then fetchWireMessageId (`gmail.ts:113-136`, metadata scope, 15s bound). Graph returns 202/no id, wire==minted (`graph.ts:16-21`). SMTP has no server-side sent record.

## Store schema

New append-only `send-log.jsonl` in ENGINE_STATE_DIR (same volume, `Dockerfile:28-32`), one JSON object per line, fsync'd via a persistent fd (writeSync+fsyncSync; dir-fsync at file creation/rotation only). Line types (all carry `v:1, key, ts`):

- `intent {attempt, transport, from, to, mintedId, threadId}`
- `submitted {providerRef}` — gmail_api only: the messages.send response id, appended BETWEEN POST-return and read-back
- `recorded {messageId, aliasIds, threadId, sentAt}` — == today's recordSend payload
- `attempt-failed {attempt, error}` — alive-process throw (current retry semantics preserved)
- `parked {reason}` / `verified-absent {basis}` / `resolved {by, outcome}`

**LOAD-BEARING INVARIANT:** dispatchSend may not begin until the intent append's fsync has RESOLVED (fail-closed: append failure ⇒ 503 before any wire I/O). That invariant is what makes the torn-tail rule safe: a torn FINAL line implies its fsync never returned implies its submit never started ⇒ loader drops a torn tail (warn + quarantine copy); garbage on a NON-final line stays fail-loud per the store's existing F5 discipline.

`engine-state.json` becomes the v2 snapshot `{version:2, sends, threads, parked, danglings}` — a compaction of the log (boot + every ~500 recorded lines): write snapshot → fsync file → rename → fsync dir → THEN rotate the log. Replay (snapshot + full log re-apply) is idempotent, so a crash anywhere in compaction is safe. v1 snapshot (no version field) loads as `{parked:{}, danglings:{}}` — backward compatible.

**B1 AMENDMENT (blocking fix from the design review):** `danglings` carries every un-resolved key (latest line = `intent` or `submitted`, no terminal line) VERBATIM — including the `submitted{providerRef}` payload — so LIVE compaction can never discard an in-flight send's intent. Without this slot, the adversary's scenario reproduces: send A's `recorded` trips the ~500-line compaction while send B is mid-dispatch with only an `intent` line → snapshot omits B → rotation discards B's line → B's SMTP accepts → crash before record → reboot's index has no B → the send-path 424 check sees a FRESH key → re-send → double-send. The build MUST include a crash test reproducing exactly this interleaving (compaction fires between another key's intent-append and its terminal line; assert the dangling survives snapshot+rotation and boot still parks/finalizes it) — the test must FAIL if `danglings` is dropped from the snapshot.

## Adversarial-review amendments (SHIP-AFTER-FIXES, applied 2026-07-27)

Blocking: the `danglings` snapshot slot above (B1). Non-blocking obligations folded into the build contract:
1. Boot reconciliation gets an AGGREGATE time bound (not just per-key 15s/2-try) — mass-crash must not hold `server.listen` past the Worker's retry budget; overflow keys park without provider-verify rather than delay boot indefinitely.
2. Migration/runbook language: "drain first" = PLATFORM-side pause (stop dispatching sends), NOT an engine-drain assumption; ACTIVATION's bare `docker stop` becomes `docker stop -t 150` (SMTP worst-case ≈100s) with STOPSIGNAL noted.
3. The fsync'd append must LOOP `writeSync` until the buffer is fully written — a short write would otherwise manufacture a false-corruption fail-loud boot (self-inflicted DoS).
4. Sync `writeSync+fsyncSync` event-loop blocking is an accepted single-instance throughput ceiling (multi-instance already a non-goal); load-test on real DO storage before GA volume is an arming-time obligation, not a design change.
5. Parked keys: `resolved→re-sendable` is engine-local only — the platform row is already terminal `'failed'` with no requeue, so operator recovery is campaign-level; the GA ops doc must say so plainly (no overclaiming "harmless park").
6. Cite fix: the reclaim/at-cap branch extends past `tick.ts:199` (~214); SENT-scan's intent-only window is the whole `submit()` span (seconds), not "one roundtrip" — v2-scan framing corrected.

## Send-path sequence (engine.ts)

getSend cache-check → claimSend (unchanged, guards ALIVE concurrency) → sync check of the log's in-memory index: last state parked or dangling-intent-without-live-claim ⇒ NEW `SendUnverifiedError` 424 (errors.ts + statusFor), no submit → append intent (await fsync) → dispatchSend → [gmail: append `submitted{gmailId}` before the read-back] → recordSend = update memory THEN append recorded. If the recorded-append fails after a successful submit: still return 200 off memory (Worker marks 'sent', never retries ⇒ no double-send while alive; the dangling intent reconciles at next boot — idempotent for gmail, a spurious-but-harmless park for smtp). 424 is NOT in RETRYABLE_ENGINE_STATUSES ⇒ row 'failed' + ops event carrying the engine message — correct loss direction (drop one send, never duplicate), ops-visible, zero platform edits.

## Boot reconciliation (before server.listen, index.ts)

For each dangling key (last line intent/submitted), 15s/2-try bound per verify, park on any uncertainty:

- **gmail_api + submitted{gmailId}:** messages.get (existing scope/mechanism) ⇒ finalize recorded with the WIRE Message-ID + minted alias (heals reply-matching too); treat 404 as sent (the 200 proved creation). NOTE: if the Worker still has attempts left, its retry now hits the recorded cache and the row lands 'sent' with the true id — reconciliation heals platform state, not just the engine.
- **gmail_api intent-only:** PARK (v1). The SENT-scan (labelIds=SENT listing + per-candidate metadata match on a new `X-Coldrig-Send-Token` header == mintedId; `q=` search is scope-forbidden and the minted Message-ID is rewritten so it is NOT searchable) is a follow-up increment with strict definitiveness criteria (internalDate window ≥ intent_ts − 15min skew, full pagination, any uncertainty ⇒ park). Window is tiny anyway: one HTTP roundtrip vs the 15s read-back window that `submitted{}` covers.
- **ms_graph:** park by default (Mail.Send-only grant can't read; 202 is an ASYNC accept so a not-found is never definitive). Optional per-mailbox `canVerify` flag: `$filter=internetMessageId eq mintedId` (Graph honors minted id) ⇒ found=recorded, not-found=STILL park in v1.
- **smtp:** park, always (nothing server-side to read). The safe default.

`verified-absent` (scan increment only) ⇒ key becomes re-sendable; `parked` ⇒ 424 until operator resolves.

## Increments (single builder, each lands green)

1. `send-log.ts` substrate: fsync'd append, torn-tail-tolerant replay, compaction/rotation ordering + unit tests (incl. fsync-called-by-spy, torn tail, non-final corruption fail-loud).
2. Wire into send path: state machine in EngineStore, intent-gate invariant, `gmail.ts` split submit()/wireId() so the engine appends `submitted` between them, `X-Coldrig-Send-Token` in message.ts (flows through the single builder to all wires — parity preserved by construction), 424 error class + router/statusFor + README boundary table. Tests: in-process crash simulation + the revert-fail proof.
3. Boot reconciliation: `reconcile.ts` + per-transport verifiers (mocked fetch), index.ts ordering, bounded verifies, `/health` gains `{parked: N}` for the watchtower prober.
4. Ops + migration: `GET /v1/intents` (authed, parked list) + `POST /v1/intents/resolve`; SIGTERM graceful drain (stop accepting sends, wait for inFlight, exit; Dockerfile STOPSIGNAL note + `docker stop -t ≥150` since SMTP worst-case ≈100s per `smtp.ts:18-25`); ACTIVATION.md: flip residual (a) + add the deploy-drain step; email-port.ts comment for 424.
5. (Optional, flagged) Gmail SENT-scan verified-absent + Graph canVerify.

Migration: first boot on old state = v1 snapshot loads, empty log, reconcile no-op. The one-time exposure is sends in flight during the upgrade restart itself (old code holds no intents) — deploy in a quiet window / drain first; stated honestly in the runbook.

## Test plan

- **Crash-injection, DETERMINISTIC in-process (primary, CI-runnable):** DI a transport double that resolves, fault-inject the recorded-append to throw CrashSignal, then construct fresh EngineStore+EmailEngine over the SAME tmpdir (the store tests' existing restart idiom, `store.test.ts:26-29`) and drive reconciliation. Assert: retry of the same key yields EXACTLY ONE transport submit + (smtp) parked/424 or (gmail w/ submitted) recorded-with-wire-id.
- **Deterministic OUT-OF-PROCESS for gmail** (docker/e2e-gated like greenmail): mock provider responds 200 to /send then BLOCKS the read-back request — child is provably post-accept/pre-record for up to 15s (`gmail.ts:35`) — SIGKILL inside that window, restart, assert one send. SMTP's out-of-process kill can't be made deterministic (250-to-record is microseconds), so SMTP determinism lives in-process; the GreenMail e2e gets a best-effort kill variant.
- **REVERT-FAIL proof** (same methodology as the 07-14 review): with the intent append no-op'd (models old code), the headline test observes TWO transport submits; restored, ONE.
- **Invariant tests:** append-failure ⇒ transport spy never called; recorded-append-failure-after-submit ⇒ 200 + no dangling double-send on retry; compaction crash points replay clean; existing engine and platform suites untouched-green; wire drift guard untouched.
- **Honest limit:** real power-loss fsync behavior is asserted by spy + documented manual check, not CI-provable.

## Non-goals

Alive-process transport ambiguity (SMTP throw after DATA, provider-delivered-but-timed-out — the pre-existing at-least-once residual, semantics unchanged); multi-instance coordination (single-daemon stands, `store.ts:26-31`); auto-resend of parked keys or a platform requeue for 'failed' rows; SQLite swap; poll-path changes (consumer-owned cursor already correct); Graph auto-resend on not-found.

## Top 3 anticipated adversarial attack surfaces

1. **"verified-absent ⇒ resend" definitiveness** — the ONLY judgment that can re-open the double-send. v1's answer: that judgment does not exist in v1 (park instead); the scan increment must survive: shared/human-used BYO mailbox with >page of sends during the outage, clock skew vs internalDate, label-application delay, pagination truncation. Criteria spelled out; any uncertainty ⇒ park.
2. **Durability ordering honesty** — snapshot-before-rotation fsync ordering, torn-tail-only tolerance, the un-fsynced legacy flush now being COVERED because the log (not the snapshot) is the durable truth, Docker volume actually on droplet disk. Attack: find any path where a recorded line is truncated while its snapshot isn't durable ⇒ replay idempotency is the defense; needs the compaction-crash tests.
3. **Alive-path edges** — recorded-append-fails-after-accept (return-200-off-memory rule), disk-full (fail-closed BEFORE submit — the whole engine stops sending, transient+ops-visible, never sends-without-logging), and any route by which a dangling/parked key reaches dispatchSend (the 424 check sits inside the claim-protected no-await section against an in-memory log index — TOCTOU-free). Also expect a probe of 424×'failed'-no-requeue: intended, dropped-not-duplicated, ops-visible.
