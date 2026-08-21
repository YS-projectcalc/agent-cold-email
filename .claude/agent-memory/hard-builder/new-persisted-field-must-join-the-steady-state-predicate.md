---
name: new-persisted-field-must-join-the-steady-state-predicate
description: A write-skipping "nothing changed" predicate silently reverts any NEW state field it does not compare — the write is skipped, the next read restores the old value, and the effect repeats forever.
metadata:
  type: project
---

`admin/watchtower.ts`'s `isSteadyState(prev, next, detail)` skips the D1 upsert
when a tick changed nothing (scale audit S5, measured: 20 writes over 5 ticks
for one mailbox + one domain). It compares field by field.

**The trap:** add a field to `AlertState` and forget to add it here, and a tick
that changed ONLY that field reports "steady" → no write → the next read returns
the stale value. For the alert-state increment that would mean a banked
materiality key silently reverting, so the same condition announces on EVERY
tick — the exact storm the ledger exists to bound. Same for `healthyObs` (the
recovery confirmation never advances) and `realertCount` (the ladder rung never
climbs).

**How to apply:** any new column on `watchtower_state` needs THREE edits, not
one — `readWatchtowerState`'s SELECT, `upsertWatchtowerState`'s INSERT/UPDATE,
and `isSteadyState`'s comparison. Arrays need a length + element compare, not
identity. Related: [[insert-only-column-null-for-pre-column-population]].
