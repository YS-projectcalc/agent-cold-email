# Adversarial review — pre-send intent log BUILD (frozen record, 2026-07-27)

- **Reviewer:** adversary (fresh context)
- **Target:** UNCOMMITTED build in worktree `.claude/worktrees/agent-af7e6ba4ef61f14ca` (branch `worktree-agent-af7e6ba4ef61f14ca`), implementing `docs/research/pre-send-intent-log-design-2026-07-27.md` incl. the B1 danglings amendment + 6 adversarial amendments. Design review it answers: `docs/adversarial/pre-send-intent-log-design-review-2026-07-27.md` (SHIP-AFTER-FIXES).
- **Ground:** `git rev-parse HEAD` = `a0249705a7800565e861e8315501e5f1c1cdbaa6` (worktree) — MATCHES the design's + design-review's grounding ref `a024970`. Main repo HEAD is `e4a3fec` (ahead; the build is not yet folded in). Reviewed the worktree copy, read-only git only.
- **Governing rule under test:** DROP one send rather than EVER duplicate one.

## VERDICT: SHIP

The B1 design gap (live compaction discarding an in-flight dangling → re-opened double-send) is CLOSED: the v2 snapshot carries `danglings` verbatim incl. `submitted{providerRef}`, replay reconstructs them, and BOTH B1 tests (substrate + end-to-end engine-level interleaving) are genuine RED proofs — I independently reproduced the RED (mutated `compact()` to drop `danglings` in a sandbox copy; both tests failed on `expected false to be true` at `isBlocked("B")`; restored). Every other attack in the brief HELD. Batteries re-run green by me (typecheck 5/5 workspaces; full `npm test` exit 0; engine 125 passed / 4 skipped; docker-free kill-e2e passed with exactly ONE `messages.send` across a real SIGKILL). One NON-BLOCKING residual (a narrow new gmail-only alive-path double-send window under a transient fsync error) — does not re-open the crash class this build closes and falls within the design's accepted alive-process at-least-once non-goal; noted for a cheap follow-up guard.

No BLOCKING finding survives self-refutation.

---

## NON-BLOCKING

### NB1 · lens 6/7 — a gmail `appendSubmitted` fsync failure on the ALIVE path can clear the dangling and let the Worker retry re-send (transient-IO-only; gmail-only)

**Scenario.** gmail_api send. `gmail.submit()` returns 200 + id ⇒ the message IS on the wire. The engine then calls `onSubmitted` → `store.appendSubmitted` (store.ts:195), whose `log.append` fsync THROWS (an IO error at that instant). The throw propagates out of `dispatchSend` into the catch at `engine.ts:137-148`, whose comment asserts *"dispatch failed ⇒ nothing went out ⇒ the intent is NOT a dangling"* — which is FALSE here (the message went out). The catch calls `appendAttemptFailed` (store.ts:222), which appends an attempt-failed line and then `delete this.state.danglings[key]`.
- If the IO error is **persistent** (ENOSPC/EDQUOT — the overwhelmingly common "append fails" cause): `appendAttemptFailed`'s OWN `log.append` also throws (store.ts:225), the swallowing `catch{}` at engine.ts:144 eats it, and `delete danglings[key]` is SKIPPED (append precedes delete). Dangling survives ⇒ the Worker retry hits `isBlocked` ⇒ **424 ⇒ DROP. Safe.**
- If the IO error is **transient** (a momentary EIO that clears before the immediately-following `appendAttemptFailed` fsync): the dangling is deleted; the Worker retry sees no block ⇒ re-appends intent ⇒ **second `messages.send` ⇒ double-send.**

**Verification.** Traced engine.ts:132-148 + dispatchSend gmail branch (engine.ts:262-264) + store.ts appendSubmitted/appendAttemptFailed (append-first ordering confirmed by reading, store.ts:195/225). Not runtime-reproduced (needs a transient-fsync-then-success injection the current doubles don't model).

**Why NON-BLOCKING (self-refutation).** (a) The dominant realistic append-failure cause (persistent disk-full) is SAFE by the append-before-delete ordering. (b) Requires an fsync error precisely at `appendSubmitted` that clears within microseconds — rare on a real volume. (c) gmail-only (SMTP/Graph have no submitted step). (d) It is a NEW member of the design's EXPLICIT non-goal *"alive-process transport ambiguity … the pre-existing at-least-once residual"* — the sibling "SMTP throw after DATA accept" is already accepted. It does NOT re-open the crash-after-accept class (durably closed, independently proven). Net safety vastly improved.

**Cheap guard (optional, follow-up).** In the `dispatchSend` catch, do not `appendAttemptFailed`-clear a dangling once `onSubmitted` has fired (the message provably went out) — leave it dangling so boot reconciliation handles it (gmail with a durable `submitted` finalizes; without one, parks). Equivalently: the "nothing went out" comment at engine.ts:138 is wrong for the post-submit sub-path and should not drive a dangling-clear. A test that injects a submitted-append throw after a successful submit and asserts the retry is 424 (not a 2nd submit) would lock it.

---

## Attacks that FAILED (why this SHIP is meaningful)

- **B1 compaction discards in-flight dangling (the whole point).** `compact()` serializes `{version:2, ...this.state}` including `danglings` (store.ts:311); `loadState` reads `danglings` (store.ts:411); `fold` reconstructs from log on top (idempotent). Independently RED-proven: sandbox-mutated `compact()` to strip `danglings` ⇒ both `intent-log.test.ts` B1(substrate) and `reconcile.test.ts` B1(end-to-end) FAIL at `isBlocked("B") === true`; restored ⇒ pass. HELD.
- **Compaction crash-consistency.** Ordering write-tmp→fsync→rename→dir-fsync→rotate: crash at every point replays snapshot(+un-rotated log) idempotently; `fold` idempotency verified per line-type; snapshot written to a tmp + atomic rename (never torn in place). Danglings preserved at every crash point. HELD.
- **Torn-tail heal destroying a durable line (brief #1).** `append` loops `writeSync` then `fsyncSync`, so a returned fsync ⇒ the terminating `\n` is durable ⇒ a file not ending in `\n` means the last line's fsync never returned; heal truncates to the last `\n` (byteLengthOfCleanPrefix), preserving every fsync'd line. A torn NON-final line is unreachable by a normal crash ⇒ fail-loud is a real-corruption defense. send-log tests (torn-final heal, writeSync-loop short-write, non-final fail-loud, rotate-discards) pass. HELD.
- **rotate() truncate-in-place.** `ftruncateSync(fd,0)` on an O_APPEND fd ⇒ next append writes at EOF=0; fsync + dir-fsync after. Only invoked after the snapshot is durably renamed. HELD.
- **Send-path 424 TOCTOU (brief #1).** `claimSend` (sync) precedes `isBlocked` (sync, no await between) inside the claim; a concurrent live retry is stopped at claimSend→409; on fresh boot `inFlight` is empty so every replayed dangling is without-live-claim ⇒ 424. HELD.
- **appendIntent APPEND-FIRST vs recordSend MEMORY-FIRST asymmetry (brief #1).** Node single-threaded + every store method fully synchronous (no await inside) ⇒ compaction fires only at a recordSend boundary where memory is consistent; no intra-method interleaving exists. appendIntent append-first ⇒ a failed intent append leaves NO dangling ⇒ fail-closed 503, retry genuinely re-sends. recordSend memory-first ⇒ a failed recorded append still returns 200 off memory (getSend hits), dangling reconciles at boot. HELD.
- **Aggregate reconcile deadline vs a hung verifier (brief #2).** `gmail.lookup` is hard-bounded by a 15s AbortController (gmail.ts:146); deadline checked between keys ⇒ worst-case boot ≈ 120s (default) + ≤30s trailing verify = ~150s, bounded not indefinite. smtp/graph/intent-only park synchronously (no network). 150s ≪ the ~25min needed to exhaust MAX_SEND_ATTEMPTS=5 (5-min reclaim TTL) ⇒ NB2's attempt-exhaustion does not bite. HELD.
- **gmail 404-after-submitted ⇒ sent (brief #2).** `submitted{providerRef}` exists only if `submit()` got a 200 with an id (engine.ts:263 `if (gmailId)`), and gmail send is synchronous create+send ⇒ 200 proved it was sent; a later 404 = purged-after-creation ⇒ finalize minted, never re-send. HELD.
- **SIGTERM drain vs docker kill (brief #3).** `docker stop -t 150` (ACTIVATION runbook) SIGTERMs then SIGKILLs at 150s; `STOPSIGNAL SIGTERM` set (Dockerfile). Drain waits ≤140s + a 3s hard-stop = ≤143s < 150s ⇒ no window where docker's kill beats the drain; and a SIGKILL mid-send is itself safe (dangling→park→drop). New sends refused 503 (retryable) during drain, so a drained send appends no intent. HELD.
- **Platform honesty / zero behavior change (brief #4).** `email-port.ts` diff is 6 added COMMENT lines only; `RETRYABLE_ENGINE_STATUSES = {409,422}` unchanged ⇒ 424 grades permanent by the existing `res.status>=500 || set.has` logic (email-port.ts:116) ⇒ row lands 'failed' + ops event, no requeue. `statusFor` maps SendUnverifiedError→424 (errors.ts). wire.ts drift guard untouched (only `intentResolveRequestSchema` added). config.ts (+SendTransport type) and mailbox-store.ts (loadJsonStateFile import moved to json-store.js) are pure refactors; typecheck-green confirms no dangling importer. `/health` gains a `parked` field but email-port never calls /health (engine-internal, external prober only). `X-Coldrig-Send-Token` parity claim TRUE: `buildRawMessage` (message.ts:53) routes through `buildMailOptions`, so gmail/graph raw bytes carry it identically to SMTP. HELD.
- **Deviations not load-bearing (brief #6).** Sequential reconcile (vs concurrent-with-cap): bounded ~150s by the aggregate deadline, drop-direction on overflow-park ⇒ safe. verified-absent omitted: the SAFE direction (v1 parks, no resend judgment exists to be wrong). No lockfile/package.json change in the diff (no new runtime deps; send-log/reconcile/store import only node builtins + internals). None re-open a hole.

## Batteries (re-run by me, from the worktree)

- `npm run typecheck` — GREEN, all 5 workspaces (dashboard/engine/platform/cli/shared), no errors.
- `npm test` (root, all workspaces) — exit code 0.
- `npx vitest run` (apps/engine) — **Test Files 16 passed | 2 skipped; Tests 125 passed | 4 skipped.** B1 substrate + B1 end-to-end + all send-log/reconcile tests confirmed RUN and PASS (verbose reporter).
- Independent B1 RED proof — sandbox copy with `danglings` stripped from `compact()`: **both B1 tests FAIL** at `isBlocked("B")`; unmutated: pass.
- `ENGINE_KILL_E2E=1 npx vitest run test/gmail-kill.e2e.test.ts` (docker-free, real child SIGKILL post-submitted/pre-record) — **1 passed**, exactly ONE `messages.send` across kill+restart+retry.

## UNVERIFIABLE (never folded into the verdict)

- **Real power-loss fsync durability** on the actual DO block storage — design concedes it is spy-asserted + manual-check, not CI-provable. Resolves at host stand-up (power-cut / fsync syscall trace). The `[dark-unarmed]` ACTIVATION entry correctly names this as a gating step before the residual is closed.
- **NB1's transient-fsync double-send** — not runtime-reproduced (the doubles model a hard first-append throw, not a throw-then-immediate-success). Resolvable with a targeted fault-injection double.
- **GreenMail e2e** (`ENGINE_E2E=1`) — Docker-gated, not run here (self-skips without Docker).

## NEW (out-of-scope, no verdict weight)

- **`X-Coldrig-Send-Token` header on every outbound email** is currently INERT (its only consumer, the SENT-scan, is deferred to increment 5) — mild YAGNI, but the design scheduled it in increment 2 for parity-by-construction. Separately: a static, brand-fingerprintable custom header (`X-Coldrig-…`) on every cold email is a minor deliverability/footprint consideration for a product where blending in matters. Also note the "Coldrig" spelling vs the "ColdStart" product name — confirm intended before increment 5 greps for it.
- **ACTIVATION residual (1) is correctly marked `[dark-unarmed]`, NOT flipped closed** — respects the project rule that closure waits for merge + verified live arming (incl. the power-loss check). Good.

---

## DELTA re-check (2026-07-28) — NB1 guard landed: **DELTA-SHIP**

The builder implemented the NB1 guard. `dispatchSend` now takes an `onAccepted(providerRef?)` callback fired the instant ANY transport resolves (engine.ts:269 smtp, :279 gmail, :284 graph); it sets `sentOnWire = true` BEFORE the possibly-throwing `appendSubmitted` (engine.ts:141-142), and the dispatch catch downgrades to `appendAttemptFailed` ONLY when `!sentOnWire` (engine.ts:145) — once on the wire the key stays dangling (424 on the alive retry; boot reconcile finalizes via a durable `submitted{id}`, or parks). Verified against the two delta questions:

1. **No remaining `sentOnWire===false but bytes went out` path beyond the pre-existing non-goal.** For every transport `onAccepted` fires only AFTER the transport call RESOLVES; if the transport itself THROWS (smtp throw-after-DATA, gmail 5xx-ambiguous submit, graph send throw), `onAccepted` is never reached ⇒ `sentOnWire` false ⇒ attempt-failed ⇒ retry — which is EXACTLY the pre-existing accepted alive-process at-least-once non-goal (transport-delivery ambiguity), UNCHANGED by this build. The guard closes only the distinct case it was for: transport ACCEPTED, then our own `appendSubmitted` threw (flag already true ⇒ dangling kept). No new gap introduced.
2. **`onAccepted` for smtp/graph is a pure flag-set, no new append.** smtp branch (engine.ts:268-270) and graph branch (:283-285) call `onAccepted()` with no providerRef; inside, `if (providerRef)` is false ⇒ NO `appendSubmitted`. Happy path unchanged (recordSend runs as before). gmail keeps the same submitted-append, now with the flag set first and order preserved (submitted before wireId read-back). No behavior change.

Both submitted-append fault sub-modes are now safe: `after-fsync` (bytes land, fsync throws transiently) ⇒ dangling kept ⇒ boot finalizes via messages.get; `before-write` (nothing lands) ⇒ dangling intent-only ⇒ park. Neither duplicates.

**Independently verified.** New `after-fsync` FaultMode in crash-doubles.ts faithfully models the exact "throw-then-immediate-success" gap (writeSync lands, an armed one-shot fsync throws). The NB1 locking test (reconcile.test.ts:239) asserts exactly ONE `messages.send` across throw → alive-retry-424 → boot-finalize → cached-retry. RED-proven by me: sandbox-copied the engine, replaced `if (!sentOnWire)` with `if (true)` (guard removed) ⇒ the NB1 test FAILS ("promise resolved instead of rejecting" — the alive retry re-sends); restored ⇒ pass. Batteries re-run: engine typecheck GREEN; `vitest run` **16 files passed / 2 skipped, 126 passed / 4 skipped** (was 125 — the +1 is the NB1 test); worktree engine.ts confirmed unmutated. NB1 is now CLOSED, not merely narrowed. My SHIP verdict stands, strengthened.
