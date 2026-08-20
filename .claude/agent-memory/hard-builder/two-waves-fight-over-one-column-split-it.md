---
name: two-waves-fight-over-one-column-split-it
description: When a later wave DELIBERATELY relies on the behavior an earlier sweep calls a defect, the column is usually carrying TWO facts — split it instead of picking a side.
metadata:
  type: feedback
---

**A "conflict" between a sweep and a shipped design is often one column answering
two different questions. Split it; do not revert either side.**

**Why:** ColdStart IN-3 said `emitTenantMessage`'s dedup branch must stop
re-stamping `created_at` (it destroyed the first-occurrence time AND, because
`created_at` is an ORDER BY column *and* part of `listMessagesPage`'s keyset
cursor, moved live rows above already-issued cursors — measured: 20 messages,
re-emit one mid-drain, 19 come back). The customer-continuity wave's NB-3 said the
re-stamp is deliberate: its min-age expiry gate must measure *time since the
platform last OBSERVED the failure* so a still-recurring condition is never
expired. Both were right. `created_at` was carrying "first seen" and "last seen".

Fix: `created_at` immutable + a new `last_occurred_at` bumped by the dedup branch;
the expiry gate reads the new column, every `sinceMs` an agent sees reads the old
one. Nullable and `COALESCE(last_occurred_at, created_at)` on read — a pre-column
row's `created_at` IS its last-observed time, so a backfill would be wrong, not
just unnecessary (cf. [[insert-only-column-null-for-pre-column-population]]).

**Two things this predicts:**
- The later wave's fixtures will red-line, because they age rows by direct UPDATE
  on the old column. That is a FIXTURE fault, not a regression — age both columns,
  which is what "stale" already meant (first seen long ago AND not recurred since).
- The later wave's own gate note often says "nothing exercises this path". That
  missing test is the one to write, and it is the proof the reconciliation holds.

**How to apply:** before reporting CONFLICT-NEEDS-RULING on a sweep-vs-shipped-design
clash, check whether the two sides are reading the same field for different facts.
If so, splitting satisfies both citations and needs no ruling.
