---
name: coldstart-engine-crash-injection-idiom
description: How to write deterministic in-process (and one out-of-process) crash tests for the ColdStart engine's durable send log.
metadata:
  type: project
---

Deterministic crash tests for the ColdStart engine durable stores (apps/engine, `test/crash-doubles.ts`):

- **Model a crash at the durability layer, not via a thrown error.** Inject a faulty log via `EngineStore(dir, { makeSendLog: (p) => new FaultySendLog(p, (line) => line.type === "recorded") })` so a specific append throws; then DISCARD store1 and build a FRESH `EngineStore` over the SAME tmpdir. The "crash" IS the discard+rebuild-from-disk — so whether `engine.send()` swallowed the append error (returns 200 off memory) or threw is irrelevant; the disk state (intent present, recorded absent → dangling) is what the fresh store reconciles.
- **Force a live-compaction interleaving (B1).** `compactEveryRecorded: 1` + a `ControllableSmtp(B_LEAD)` that stalls sends to B while resolving A. `const bSend = engine.send(...B)` runs synchronously up to `await smtp.send` (intent already fsync'd), then `await engine.send(...A)` completes → A's recorded trips compaction while B is dangling. Everything between claimSend and the first transport await is synchronous, so no interleaving sneaks in.
- **Append ORDER is asymmetric and load-bearing:** `appendIntent` = APPEND-FIRST (disk-full ⇒ throw ⇒ no dangling ⇒ send fails closed 503, retry re-sends — nothing went out). `recordSend` = MEMORY-FIRST (recorded-append-fail after a successful submit ⇒ getSend hits ⇒ return 200 off memory, dangling reconciles at boot). Reversing either re-opens a double-send or drops a sent record.
- **REVERT-PROOFs that matter here:** (1) no-op `appendIntent` → the headline crash test observes the retry RE-SEND (resolves instead of 424). (2) drop `danglings` from the compaction snapshot → both B1 tests fail (`store2.isBlocked("B")` false). Both quoted RED→GREEN.
- **Out-of-process SIGKILL (gmail):** `test/gmail-kill.e2e.test.ts` behind `ENGINE_KILL_E2E=1`; the child harness (`gmail-kill-child.mjs`) imports `../dist/` (a real killed OS process can't use vitest's TS transform, and the src's `.js` import specifiers don't resolve under node type-stripping) — so `npm run build -w @coldstart/engine` first. A mock gmail accepts messages.send then BLOCKS the read-back (child provably post-`submitted`/pre-record for ≤15s), kill inside the window, restart in-process → reconcile finalizes via messages.get.
