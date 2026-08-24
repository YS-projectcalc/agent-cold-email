---
name: concurrency-breaks-the-prefix-a-cursor-assumes
description: ⚠️ a keyset cursor advanced as `ids[covered - 1]` silently assumes the covered set is a CONTIGUOUS PREFIX — free sequentially, a live constraint the moment the loop goes concurrent; the abandon-on-deadline discipline leaves a hole and skips exactly the SLOW tenant for a whole rotation.
metadata:
  type: project
---

Found while measuring bounded-concurrency fan-out for ColdStart's cron sweep
(lane `feat/sweep-capacity-2026-08-24`). `admin/tenant-slice.ts:208`:

```ts
const next = covered === 0 || complete ? null : (slice.ids[covered - 1] ?? null);
```

`covered` is a COUNT; indexing by it treats it as a prefix LENGTH. Sequentially
those coincide. Concurrently they only coincide under one of the two obvious
deadline disciplines:

- **claim** — the deadline stops handing out NEW items; in-flight work is awaited.
  Workers claim indices in order and every claimed index completes, so the covered
  set is always `{0..k-1}`. SAFE, and provable as a property test.
- **abandon** — each item races the deadline, unfinished work dropped. Tighter
  wall clock, and it holes: one slow item at index 0 behind five fast ones
  (C=3, 900ms vs 20ms, deadline 300ms) gives `visited > 0, prefix === 0`. The
  cursor lands PAST an item never processed, and `WHERE id > ?` means it is
  skipped for the whole rotation — specifically the SLOW one, i.e. the sick one
  the sweep exists to notice.

**How to apply.** Before making any bounded loop concurrent, grep for who consumes
its progress count and check whether they INDEX by it. Have the primitive return
`prefix` as a field distinct from `visited` and feed the cursor only the prefix; a
single number named "covered" is how the two get conflated. Demonstrate the hole
with a kept NEGATIVE control rather than asserting it cannot happen.

Same family as [[cursor-restart-on-full-page-pins-the-rotation]] and
[[published-coverage-latency-must-use-the-achieved-advance]]: a predicate reading
one quantity as if it carried another.
