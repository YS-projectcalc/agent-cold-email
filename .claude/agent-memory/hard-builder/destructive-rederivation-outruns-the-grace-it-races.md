---
name: destructive-rederivation-outruns-the-grace-it-races
description: ⚠️ a re-derivation sweep on a SHORTER cadence than the grace window of the reason that would justify it always wins the race — split "stops counting" (cheap) from "banked durably" (destructive) and gate only the second on that same grace.
metadata:
  type: project
---

When a sweep re-derives "this record is resolved" every N minutes while the reason that would
contradict it only matures after a grace of M >> N, the sweep destroys the record M/N times over
before the contradiction can ever fire. Two records with different reversibility were being written
by one decision.

**Why:** ColdStart r2 gate probe case 2 (2026-08-19). A `dangling` ordinal is covered by
`ordinal_incomplete` only past `PROVISIONING_ORPHAN_GRACE_MS` = 30 min; `opsSummary` re-derives on
the `*/5 * * * *` cron. So the `retry_setup` row was expired inside the grace, and when the grace
opened and `ordinal_incomplete` finally fired, `message_action_required` never came back — the row
was gone. Second half of the same finding: `pruneTenantMessages` gave READ rows 30 days of
retention and EXPIRED rows none, i.e. the half a HUMAN performs deliberately was recoverable for a
month and the half the PLATFORM infers on its own was unrecoverable within one sweep. The grace
belongs on whichever half can be wrong.

**How to apply:** split the decision — ceasing to COUNT reverses itself on the next pass and needs
no gate; stamping a durable marker does. Gate the durable half on the SAME bound the contradicting
reason ages against (read it from the snapshot, never a second constant — it is the exact race
being lost), and age the anchor through the project's clamp helper, since a `ctx.clock`-stamped
`created_at` can be future-dated. Name the returned field for what the caller may DO
(`expirableSystemMessageIds`), not for what the pass concluded, or the next caller writes the
difference. Related: [[persist-before-confirm-cross-boundary]],
[[ctx-clock-anchors-are-virtual-domain-forever]], [[confirmation-guard-deletes-one-shot-signals]].
