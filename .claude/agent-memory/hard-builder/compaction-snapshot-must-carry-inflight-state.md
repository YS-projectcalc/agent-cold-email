---
name: compaction-snapshot-must-carry-inflight-state
description: A periodic compaction snapshot that discards its source log MUST serialize every un-resolved in-flight entry, not just terminal state — else rotation silently drops in-flight work.
metadata:
  type: project
---

CLASS: when a durable WAL/log is periodically COMPACTED into a snapshot and then ROTATED (old log discarded), the snapshot must serialize EVERY un-resolved / in-flight entry verbatim — not just the terminal/settled state. If compaction runs while an entry is mid-flight and the snapshot omits it, rotation deletes the only other copy → the in-flight work is durably lost on a subsequent crash.

**Why:** ColdStart pre-send intent log (2026-07-27). The v2 snapshot `{version:2, sends, threads, parked}` had NO slot for a `dangling` (a key whose latest log line is `intent`/`submitted`, no terminal). Live compaction (every ~500 recorded lines) could fire while send B was mid-dispatch: snapshot omits B → rotation discards B's `intent` line → B accepts on the wire → crash before record → reboot's index has no B → the 424 gate sees a FRESH key → re-send → the exact crash double-send the log exists to close. This was the adversary's single BLOCKING finding (B1). Fix = the snapshot carries a `danglings` map (each with its last-known line incl. `submitted{providerRef}` so gmail can still auto-finalize).

**How to apply:** any compaction/snapshot+rotate durable store — assert (with a test that FAILS if the in-flight slot is dropped) that an entry mid-flight at compaction time survives snapshot+rotation. Force it deterministically: a low `compactEveryRecorded`, a `ControllableSmtp` that stalls key B while key A completes and trips the threshold, then a fresh store over the same dir must still see B. Related durability class: [[persist-before-confirm-cross-boundary]], [[json-store-corrupt-catchall-silent-empty]].
