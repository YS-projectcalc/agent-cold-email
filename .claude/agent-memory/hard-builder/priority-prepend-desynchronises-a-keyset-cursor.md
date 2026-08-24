---
name: priority-prepend-desynchronises-a-keyset-cursor
description: ⚠️ adding a "do these first" prepend to a loop whose progress count feeds a KEYSET cursor makes the count mean two things at once — and a spent deadline that covers ONLY the prepend nets to an advance of 0, which a `covered === 0 ? restart` cursor reads as "wrap", pinning the rotation at its head forever.
metadata:
  type: project
---

ColdStart `admin/tenant-slice.ts`, paying-tenant-first, 2026-08-24. Two defects
in one small feature, both found by building the tests before believing the code.

**(a) The count stops matching the page.** `commitSweepCursor` does
`slice.ids[covered - 1]`. Prepending priority items to the list a leg iterates
makes `prefix` count them too, so the cursor advances by items that are not on
its page at all — skipping exactly `priorityCount` rotation members per tick,
forever. Fix: carry the prepend length on the per-tick struct
(`SweepFanout.priorityCount`) and net it out where the accumulator is written,
not at the call sites.

**(b) The "always attempt index 0" rule is now one item short.** With a prepend,
a tick whose deadline is already spent covers only priority items → netted
rotation advance 0 → `covered === 0 ? null` restarts the rotation → the head is
re-swept every tick and nothing else ever is. The guard has to become
`index <= priorityCount` (the whole prepend PLUS the first rotation item), which
at `priorityCount = 0` is literally the old `i > 0`.

**Two more things that shape the fix:**
- **De-duplicate from the PREPEND, never from the page.** Dropping a duplicate
  out of the page shifts every id after it and the cursor lands short. Do the
  filtering ONCE, where the count is set, or the offset and the actual prepend
  length diverge.
- **A prepend that REALLOCATES is not extra spend.** Shortening the rotating
  slice by the actual prepend count means `slice + priority` is the original
  slice; pricing the prepend as an additional `ownFanout` term DOUBLE-COUNTS it.
  An independent restatement of the worst-case tick in the test caught that
  (`expected 650 to be 685`). Only the floor case (`max(1, slice - p) + p`)
  genuinely adds.

**(c) THE REAL FIX FOR (b) IS AT THE CURSOR, NOT THE LOOP.** Widening the
always-attempt set works but its overrun scales with the prepend, and a derived
deadline with zero slack cannot absorb that (at concurrency 1 it was ~18.9s past
a 300s period). Better: make `covered === 0` HOLD the cursor rather than wrap it
— stamp `updated_at` (the freshness tell) without moving `last_tenant_id`. Then
clamp the prepend to the CONCURRENCY so the overrun stays one round trip. The two
are coupled: clamping alone re-opens the pin, holding alone leaves the overrun
scaling.

**(d) `rotationOffset(now, period, n)` STRIDES BY ONE.** Using it to rotate a
WINDOW of w re-serves w-1 of the same items every tick and takes n ticks to reach
everyone, not ceil(n/w). Multiply by the window (`offset = rot(...,groups) * w`)
so consecutive ticks serve disjoint groups.

**How to apply:** before adding priority/ordering to any bounded loop, ask what
consumes its progress COUNT and whether that consumer indexes by it. Related:
[[concurrency-breaks-the-prefix-a-cursor-assumes]],
[[cursor-restart-on-full-page-pins-the-rotation]].
