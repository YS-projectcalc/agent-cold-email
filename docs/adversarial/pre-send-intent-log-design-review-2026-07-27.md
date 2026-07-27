# Adversarial review — pre-send intent log DESIGN (frozen record, 2026-07-27)

- **Reviewer:** adversary (fresh context)
- **Target:** `docs/research/pre-send-intent-log-design-2026-07-27.md` (a DESIGN, not code — a design claim that misreads the code is itself a blocking finding, per the brief).
- **Ground:** `git rev-parse HEAD` = `a0249705a7800565e861e8315501e5f1c1cdbaa6` — MATCHES the design's stated grounding ref `a024970`. Code is fresh, not stale. Reviewed the main worktree (not the two `.claude/worktrees/agent-*` copies).
- **What this closes:** ACTIVATION.md:27 residual (1) — crash-after-transport-accept-before-record ⇒ redelivery double-send — founder-accepted for the PILOT ONLY; a durable pre-send intent log is REQUIRED before GA sending volume. Governing rule: DROP one send rather than ever duplicating one.

## VERDICT: SHIP-AFTER-FIXES

The shape is right (write-ahead intent → per-transport reconcile → park-on-uncertainty, enforcing drop-not-duplicate). Every file:line grounding claim in the design verifies against the code. The 424-no-requeue contract holds end-to-end with genuinely zero platform edits. **One BLOCKING gap survives self-refutation: the live compaction/rotation path, as specified, discards an in-flight dangling intent — re-opening the exact double-send this design exists to close.** It is a localized under-specification of the snapshot shape, not a wrong shape, so the fix is enumerable and the verdict is SHIP-AFTER-FIXES.

---

## BLOCKING

### B1 · lens 3 (compaction/rotation) + lens 6 (design) — Live compaction discards an in-flight dangling intent, re-opening the crash double-send

**The gap.** The v2 snapshot is specified as `{version:2, sends, threads, parked}` (design line 31). That shape has **no slot for a dangling intent** — a key whose latest log line is `intent` (or `submitted`) with no terminal `recorded`/`parked`/`resolved`. Compaction is stated to run "boot + every ~500 recorded lines," ordered "write snapshot → fsync file → rename → fsync dir → THEN rotate the log," with "Replay (snapshot + full log re-apply) is idempotent." But rotation **discards the old log**, and "full log re-apply" re-applies only the post-rotation (fresh) log. So any dangling intent that lived in the pre-rotation log and is not captured in the snapshot is lost from BOTH durable sources.

**Failure scenario (concrete).**
1. Engine at GA volume, multiple concurrent sends. Send A's `recordSend` appends the 500th recorded line → triggers live compaction.
2. At that instant, Send B (a different key, SMTP) has appended its `intent` line and is awaiting the SMTP transport (mid-dispatch). B's dangling exists in the in-memory index + `inFlight` Set + as an `intent` line in the log — but B has NO entry in `sends`/`threads`/`parked`.
3. Compaction serializes `{sends, threads, parked}` (B absent), fsyncs, renames, dir-fsyncs, then **rotates the log** — discarding B's `intent` line. B's intent is now durably nowhere; it survives only in volatile memory.
4. B's SMTP transport accepts the message (250). The engine process **crashes** before `recordSend`.
5. Reboot: replay = snapshot (no B) + fresh log (no B). B is absent from the index; `inFlight` is empty (memory reset). Reconcile finds no dangling for B.
6. Platform orphan-reclaim reverts B's `scheduled_sends` row to `pending`, retries `send()` for key B. Engine: `getSend(B)` miss → `claimSend` ok → the send-path 424 check finds **no index entry** for B (dangling was lost) → treats B as a **fresh key** → dispatchSend → **SMTP sends the lead the same email a second time.**

This is byte-for-byte the crash-after-accept-before-record double-send the design is built to eliminate, re-opened through the live-compaction window. The window is (compaction-fires → that dangling's recordSend), and compaction firing correlates with high send volume — i.e., GA conditions.

**Why the design's own defenses don't save it.** The send-path 424 check (correct and TOCTOU-free in isolation) depends on the in-memory index containing the dangling; the index is rebuilt at boot from snapshot+log; compaction removed the dangling from both. The idempotency claim ("snapshot + full log re-apply is idempotent") only recovers lines that ARE in the post-rotation log — it cannot recover a line that was rotated away and never snapshotted.

**Second-order (folds into the same fix): gmail auto-heal degrades even if danglings-as-intent are preserved.** A gmail dangling carries a `submitted{providerRef}` (the gmailId) that reconcile needs for `messages.get`. If compaction preserves danglings only as bare `intent` (dropping `submitted{providerRef}`), a gmail dangling that HAD a submitted line loses its gmailId across compaction → reconcile can no longer `messages.get` → must PARK (safe, drop-direction) instead of auto-finalizing. So the snapshot must preserve the dangling's LAST state including `submitted{providerRef}`, not merely "there is a dangling."

**Verification method.** Traced the send-path (engine.ts:82-126), the store's in-memory-only claim (store.ts:44-55), and the stated snapshot shape/compaction ordering (design lines 21, 31, 35) against the platform's reclaim+retry (tick.ts:177-214, 361-409) and the send-path 424 rule (design line 35). Boot compaction is safe (runs after reconcile clears all danglings); the LIVE "every ~500 recorded lines" compaction is the reachable window. The dangling data is available in memory at compaction time (it powers the 424 check) — only the snapshot serialization omits it — which is why this is a localized fix.

**Required fix (any one closes B1; first two are the real fixes):**
- (a) The compaction snapshot MUST include the full set of un-resolved intents (each with its last-known line: `intent` or `submitted{providerRef}`), and replay MUST reconstruct danglings from the snapshot; OR
- (b) rotation MUST carry forward (re-append to the head of the new log) every log line for a key still un-resolved at compaction time; OR
- (c) (weakest) gate live compaction to run only when there are zero un-resolved danglings — fragile at high volume (compaction may rarely fire, unbounding log growth), so only acceptable paired with (a)/(b).

The design doc — the artifact under review — is wrong/incomplete on the single most load-bearing invariant (never forget an un-resolved intent). Amend line 31's snapshot shape and the replay/rotation spec before build.

---

## NON-BLOCKING

### NB1 · lens 2 — Synchronous `writeSync`+`fsyncSync` blocks the event loop; GA throughput ceiling unanalyzed
The design specifies the append as `writeSync`+`fsyncSync` (design line 21) — synchronous libuv calls that block the WHOLE event loop for the fsync duration. That serializes ALL engine request handling (every send, every poll, `/health`) behind each fsync. Cost: 2 fsyncs per SMTP send (intent + recorded), 3 per gmail send (intent + submitted + recorded). On the single mandated droplet (DO block storage, fsync ~ single-digit-to-tens of ms), that is a real single-instance throughput/latency ceiling — and multi-instance is an explicit non-goal, so GA volume lands on ONE instance. Correctness is unaffected (the sync append also buys free atomicity vs concurrent appends). Consider an async `fs.promises.fsync` behind a serialized write queue (the existing `store.ts:114-123` `writeChain` pattern) to keep durability without head-of-line-blocking every request. At minimum, the design should acknowledge the ceiling and plan a load test at target volume.

### NB2 · lens 5 — Reconcile-before-listen has a per-key bound but NO aggregate bound
Design line 39: "15s/2-try bound per verify." That bounds each key (≤~30s) but not the AGGREGATE. A mass crash stranding N danglings, verified serially, delays `server.listen` by up to ~30s×N — during which the engine is DOWN, the platform gets connection-refused (transient, retries), and a `scheduled_sends` row can exhaust `MAX_SEND_ATTEMPTS=5` across ticks and land terminal `failed` (dropped) before the engine ever comes up. Safe direction (drop, never duplicate) but an availability/loss cost. Add: concurrent verifies with a cap + a GLOBAL reconcile deadline after which the remainder are PARKED and the engine comes up.

### NB3 · lens 4 — Parked-key operator recovery is largely inert against the platform
By the time a key is parked, the platform's orphan-reclaim retry has usually ALREADY driven the `scheduled_sends` row to terminal `failed` (verified: `failed` has no requeue — due query selects `pending` only tick.ts:227, reclaim selects `sending` only tick.ts:180, and `failed` is read only by ops-summary/watchtower COUNTs). So `POST /v1/intents/resolve → re-sendable` heals nothing at the platform layer — the row will never be re-driven. Only a resolve-as-SENT that wins the race against the next tick can flip the row to `sent` (engine key becomes recorded → `getSend` hit → platform records `sent`). The design's resolve ergonomics (line 46) are racy/under-specified; state honestly that legitimate re-send is a CAMPAIGN-LEVEL re-drive (new row, new key), not an intent-resolve action.

### NB4 · lens 4/6 — Old→new migration exposure can't be closed by the new SIGTERM drain; runbook must say PLATFORM-pause
Design line 56 is honest that the one-time exposure is sends in-flight during the upgrade restart. But the mitigation "drain first" cannot use the new SIGTERM graceful drain — the OLD code (index.ts today has no SIGTERM handler at all) lacks it. "Drain first" for the cut MUST mean PLATFORM-side send pause (pause campaigns / stop the tick) before the restart, not engine drain. Separately: the existing runbook (ACTIVATION.md:51) uses a bare `docker stop engine` (10s default) — the design's `docker stop -t ≥150` (line 53) must actually REPLACE that line, or muscle-memory truncates the drain at 10s. (Even a truncated drain is safe — SIGKILL mid-send → dangling → park → drop, never duplicate — so this is robustness, not correctness; state the platform-pause step explicitly in the runbook edit.)

### NB5 · lens 7 — SENT-scan-deferral risk framing understates the intent-only Gmail window
Design line 42 calls the intent-only Gmail window "tiny anyway: one HTTP roundtrip." It is not: an intent-only Gmail dangling occurs on a crash anywhere between the intent fsync and the `submitted{}` append — which spans the ENTIRE `gmail.submit()` (OAuth token fetch + `messages.send` POST + any `apiSend` backoff retries), i.e. seconds, not one roundtrip. v1 parking of these is still SAFE (no verified-absent judgment exists in v1 → no double-send). Only the frequency framing is optimistic. At GA, each crash during a live Gmail POST strands a send as parked→424→`failed`→manual re-drive.

### NB6 · lens 8 (non-goals) — "harmless park" understates GA operator burden
Every crash-stranded SMTP send, every graph dangling, and every intent-only Gmail dangling becomes parked→424→`failed` with NO auto-resend and NO platform requeue (both explicit non-goals). At GA volume with periodic restarts/crashes this is a steady trickle of SILENTLY-DROPPED sends needing manual campaign re-drive. Correct per the drop-direction rule, but "a spurious-but-harmless park for smtp" (design line 35) understates the ongoing GA ops cost. The `/health {parked:N}` prober (Increment 3) is the right hook — pair it with a documented re-drive procedure and name this as a known GA limitation, not a harmless edge.

## NITs

- **N1 (lens 1):** design line 16 cites the reclaim as `tick.ts:167-199`, but the reclaim loop's at-cap `failed`-event insert runs to ~tick.ts:214; the cited range stops before the at-cap branch. Cosmetic; every other file:line citation is precise.
- **N2 (impl caveat for Increment 1):** the fsync'd append MUST loop `writeSync` until all bytes are written — `fs.writeSync` may short-write. A naive single `writeSync` that short-writes would produce a torn NON-final line under NO crash → the loader's fail-loud on non-final corruption would refuse to boot (a false-corruption self-DoS). Not a design flaw, but the torn-tail discipline's soundness depends on it; make it an explicit unit test.

---

## Attacks that FAILED (why this PASS-with-one-fix is meaningful)

- **424 permanent-grade + zero platform edits, end-to-end (brief #4).** `email-port.ts:112` grades any non-{409,422} 4xx permanent (424 → `retryable:false`); tick.ts's permanent branch marks the row `failed` + ops event, no requeue. Verified NO platform path resurrects `failed`: `scheduled_sends` rows are created ONLY at campaign launch (campaigns.ts:76), all sequence steps scheduled up-front (so a parked step-1 is never re-created and step-2 is a DIFFERENT email, not a duplicate); `failed` is read only by ops-summary/watchtower COUNTs; no resend/requeue/reschedule surface exists for `scheduled_sends`. "Zero platform edits" HELD.
- **Cloudflare Tunnel intermediary emitting a 4xx/5xx (brief #4).** A CF-emitted 4xx → platform drops (safe direction; CF does not emit 424 — it uses 403/429/52x/5xx). A CF-emitted 5xx → platform grades transient → retries → engine idempotency (`getSend` cache / `claimSend` 409 / parked 424) catches the retry → no double-send. The design does not WEAKEN the pre-existing all-non-{409,422}-4xx-permanent grade. HELD.
- **gmail `messages.get` 404 ⇒ "treat as sent" (brief #5).** The `submitted{gmailId}` line exists ONLY if `messages.send` returned 200 (creation+send proven — Gmail's send is synchronous create). A later 404 can only mean post-creation deletion/retention-purge/vault removal — the message WAS sent. Recording it (minted-id fallback, since the wire id is now unreadable) and NOT re-sending is the correct drop-direction. I could construct no case where `submitted{}` exists yet the message was never sent. HELD.
- **Torn-tail tolerance vs persistent-fd fsync discipline (brief #2).** Per-append `fsyncSync` on the persistent fd flushes data + inode (file size); dir-fsync only at create/rotate is CORRECT because appending to an existing file changes no directory entry. Synchronous `writeSync`+`fsyncSync` (single-threaded Node) serializes appends with no byte-interleaving, and each line's fsync returns before the next append starts ⇒ a torn line can only be the FINAL line, and torn-final ⇒ fsync-never-returned ⇒ intent-gate-never-resolved ⇒ dispatch-never-started ⇒ safe to drop. A torn NON-final line is unreachable by a normal crash, so the loader's fail-loud on it is a genuine-corruption defense, not a normal-path false positive (given N2's writeSync-loop impl). HELD.
- **Send-path 424 TOCTOU (brief #2/#3).** `claimSend` (sync) precedes the in-memory-index dangling check (sync, no await between). A concurrent retry of a still-LIVE send is stopped at `claimSend` → 409 (existing `SendInProgressError`), never reaching the index check; only a claim-SUCCEEDING send reaches it, where `dangling-intent-without-live-claim` → 424. On a fresh boot `inFlight` is empty so every replayed dangling is "without-live-claim." TOCTOU-free. HELD (contingent on B1 — the index must actually still CONTAIN the dangling, which B1 shows compaction can defeat).
- **recorded-append-fails-after-submit (brief #3).** `recordSend` updates memory before the append, so an alive retry hits `getSend` → no re-send; a crash → dangling → reconcile (gmail heal via submitted / smtp park). Disk-full then also fails the NEXT intent-append → 503 → engine stops sending (self-limiting, fail-closed). No double-send. HELD.
- **Disk-full / append-failure fail-closed (brief #2).** Intent-append fsync failure ⇒ 503 BEFORE any wire I/O ⇒ engine stops sending; never sends-without-logging. Correct direction. HELD.
- **Prior-review ratified structures not weakened (brief context).** Consumer-owned poll cursor: the v2 snapshot still holds NO cursor (`{sends,threads,parked}`) — engine stays cursor-stateless (matches engine-host-review-2026-07-14 R2). Claim-TTL / inactivity-timeouts / attempts-ceiling: unchanged (non-goals preserve them). Wire-Message-ID read-back: the gmail submit()/wireId() split preserves the `fetchWireMessageId` read-back (gmail.ts:113-136). None weakened. HELD.

## UNVERIFIABLE (never folded into the verdict)

- **Real power-loss fsync durability.** The design itself concedes (line 64) this is spy-asserted + manual-check, not CI-provable. Resolves at host stand-up (manual power-cut / `fsync`-syscall trace on the actual DO volume).
- **Real Gmail `messages.get` 404 semantics and custom-header (`X-Coldrig-Send-Token`) preservation** for the v2 SENT-scan — no live Gmail OAuth creds here; and the SENT-scan is out of v1 scope (Increment 5, flagged optional) so it carries no v1 verdict weight.
- **Single-instance GA throughput under the synchronous-fsync discipline (NB1).** Needs a load test at target volume on the actual DO block storage; cannot be proven in this environment.

## NEW (out-of-scope, no verdict weight)

- ACTIVATION.md:27 residual (1) will need its flip (residual → closed) sequenced to AFTER B1's fix is built + adversary-re-reviewed, not on design approval. The design's Increment 4 already plans the ACTIVATION.md edit; ensure it doesn't flip the residual until arming is verified (per the project's `[dark-unarmed]` ≠ done rule).
