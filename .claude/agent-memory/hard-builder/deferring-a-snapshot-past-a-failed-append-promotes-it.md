---
name: deferring-a-snapshot-past-a-failed-append-promotes-it
description: Deferring a compaction/snapshot off the call that triggers it converts an UPDATE-MEMORY-FIRST write whose durable append FAULTED into a durable success — the inline timing was load-bearing, not incidental.
metadata:
  type: project
---

⚠️ CLASS. A store that (a) updates memory BEFORE its durable append and (b) periodically snapshots MEMORY has an invariant hiding in the *timing*: compacting INLINE with the triggering write captures memory and log while they still agree. DEFER that compaction by even one macrotask and it captures memory AFTER a faulted append has already advanced it — writing the in-memory success into the snapshot and rotating the un-recorded intent away. A failed durable write is thereby PROMOTED to a durable success, and the fail-closed evidence (a dangling/parked marker) is erased.

**Why:** ColdStart engine S7, 2026-08-20. `EngineStore.recordSend` is documented UPDATE-MEMORY-FIRST ("if the recorded append throws AFTER a successful submit, memory is already updated … the dangling reconciles at next boot"). Moving `maybeCompact` to `setTimeout(…, 0)` to take the 1.1s stringify+fsync "off the request path" (the audit's own fix class) broke `reconcile.test.ts`'s B1 end-to-end case: `expected false to be true` at `store2.isBlocked("B")`. Key B's SMTP send was ACCEPTED, its `recorded` append faulted, memory had already deleted the dangling — and the deferred snapshot persisted that. Reverted; retention (the other half) shipped alone.

**How to apply:** before rescheduling ANY periodic snapshot/compaction, ask what memory can contain that the durable log does not. If the writer is memory-first, the snapshot must be taken in the same synchronous block as the write, or the snapshot needs to know which log prefix it actually covers (prefix-only rotation) — which is a durability-core change, not a scheduling change. The audit's real answer past ~50 MB is a different datastore; say so instead of approximating it. Siblings: [[compaction-snapshot-must-carry-inflight-state]], [[persist-before-confirm-cross-boundary]].
