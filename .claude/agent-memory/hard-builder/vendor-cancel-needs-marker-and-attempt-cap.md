---
name: vendor-cancel-needs-marker-and-attempt-cap
description: "A recurring-charge vendor cancellation driven off a computed state transition (day-29 ramp completion) needs a PERSISTED marker (transition is recomputed every tick, not an edge) AND an attempt cap, or it re-bills a vendor call forever."
metadata:
  type: project
---

A one-shot vendor action triggered by a **computed** state transition needs a persisted
marker, not the transition itself. `computeWarmupDay(...) > 28` is TRUE on every tick from
day 29 onward — it is a predicate, not an edge — so "cancel when the ramp completes" without
a marker fires one vendor HTTP call per tick forever. Proven: removing the
`warmup_cancelled_at IS NULL` clause made the exactly-once test fail with a second call.

**Member (ColdStart, founder ruling 2026-08-02):** InboxKit warmup-pool auto-cancel at ramp
completion. `engine/warmup-cancel.ts` + `mailboxes.warmup_cancelled_at` /
`warmup_cancel_attempts`.

**Three things that made it correct, each of which was a live trap:**
- **Marker persisted AFTER vendor confirmation**, never before — a crash between the call and
  the write re-tries (safe: cancel is repeatable) instead of marking a still-billing
  subscription as cancelled. See [[persist-before-confirm-cross-boundary]] for the inverse.
- **Attempt cap.** "Retry next tick on failure" with no ceiling is a NEW infinite-retry path,
  which this repo already closed once as A4 CLASS A (`MAX_SEND_ATTEMPTS`). At the cap, mark +
  emit an ops-visible give-up row — a silently-uncancelled subscription is a live recurring
  charge. Do NOT instead string-match the vendor's "no such subscription" message: this
  adapter already deleted one `/already exists/i` substring match as fragile.
- **The sweep could NOT live in `refreshMailboxWarmupState`** even though that function
  computes the very same day transition — it is SYNCHRONOUS and the send path calls it
  mid-guard-sequence, where the sync shape is what makes the capacity reserve atomic. A
  vendor `await` inside it would reopen the DO input gate between a cap check and its
  reserve. Put vendor I/O in a separate async sweep called from the tick, wrapped so it can
  never delay a send.

**Also worth reusing:** the InboxKit adapter resolves the vendor uid on demand via
`resolveMailboxUid` (exact-match asserted, fails loud on a fuzzy keyword hit) and NO consumer
persists it. Adding a new uid consumer does not justify a new schema column — follow the
existing four consumers. And `/warmup/cancel` answers **200 for a BATCH with per-mailbox
outcomes**, so a 200 alone does not mean your mailbox was cancelled: branch on
`results.success[]` containing your uid.

Related: [[guards-inline-in-a-loop-are-not-a-policy]],
[[backtick-inside-template-literal-sql]] (hit again writing the schema comment —
backtick-quoting an identifier inside `TENANT_DO_SCHEMA` breaks the template literal).
