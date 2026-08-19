---
name: emitter-writes-into-the-set-that-keys-its-own-dedup
description: "⚠️ a one-shot keyed on a derived SET re-arms itself forever when its own emission adds a member to that set; key the episode on a timestamp the emitter cannot move, and exclude self-written rows from the sustaining signal."
metadata:
  type: project
---

⚠️ A dedup/one-shot key computed from a **derived set** is safe only while the emitter does not
write into that set. The moment it does, emitting changes the key, which re-arms the one-shot —
a closed loop that no cap around it can stop, because it is reached *through* the cap rather than
around it.

**The instance (ColdStart continuity nudge, caught at design gate R2):** the planned key was the
sorted set of owed `NextStepReason`s, inherited from the Inc5 `contact-operator-guard` dedup —
which is correct there, because that guard keys on a set the emitter does not write. Here the
loop was: nudge writes a `tenant_messages` row → `unackedBlockingMessages` selects
`severity IN ('action_required','operator_pending') AND read_at IS NULL` → the row qualifies →
`message_action_required` becomes a new owed reason → the owed set changed → the key changed →
re-arm → repeat.

**The fix, both halves needed:**
1. Key the episode on something the emitter cannot move — the watchtower's own
   `AlertState.sinceTs` (episode onset), compared `>` against a stored
   `continuity_nudge_episode_ts`. Monotone, so exactly-one-per-episode needs no counter.
2. **Exclude self-written rows from the SUSTAINING signal too**, or the check never clears even
   though the one-shot no longer re-fires. Here: `unackedBlockingMessages` excludes
   `kind = 'continuity_nudge'`.

**Invariant worth stating in any design with this shape:** *no reason whose source is a row this
feature writes may participate in the episode key, or sustain the check.* It is assertable as a
property in the convergence guard ("no new reason appeared whose source is a row this wave
writes"), which is stronger than a convention.

**Adjacent trap in the same area:** `emitTenantMessage`'s dedup branch does NOT skip — it
UPDATEs `severity, body, action_hint, created_at, expires_at` (`tenant-messages.ts:129`).
Re-stamping `created_at` makes a re-emitted message look brand new and re-sort to the top of the
5-row capped preview, so "exactly one" cannot be implemented as re-derive-and-dedupe; it must be
emit-once-on-transition. Never build aging logic on a column a refresh re-stamps.

Related: [[guard-scoped-wider-than-the-state-it-protects]],
[[async-tally-reset-on-triggering-action]] (same family — a counter fed by the action it gates),
[[confirmation-guard-deletes-one-shot-signals]].
Design: `docs/research/customer-continuity-design-2026-08-18.md` §7.12.
