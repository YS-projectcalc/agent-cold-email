---
name: staleness-exclusion-needs-severity-scope-not-just-kind
description: "Stop counting a stale system message" scoped by KIND alone also silences that kind's operator_pending form — which is NOT re-derivable from the same state and means a live blocker.
metadata:
  type: project
---

`retry_setup` / `setup_failed` rows are re-derivable: `deriveNextSteps` already computes, from
state, whether the setup family is owed, so when it is empty the row's condition no longer holds
and it must stop feeding `owedCount`. Applying that exclusion to every BLOCKING severity of those
kinds also dropped the `operator_pending` rows — which produce `setup_operator_blocked`, i.e. "the
platform has STOPPED on something only an operator can clear" (a held vendor wallet). No state
this derivation reads records that, so it is NOT re-derivable, and excluding it silences a live
blocker on any fleet whose domains happen to be complete. An existing test caught it.

**Why:** "the condition is re-derivable" is a property of (kind × severity), not of kind. Two
severities of one kind can describe two different conditions, only one of which the derivation can
check.

**How to apply:** when adding an auto-resolution rule for a message/alert, enumerate the exact
(kind, severity) pairs the emitters actually write (grep the `emitTenantMessage` call sites) and
state which of them the derivation can re-check. Bank the exclusion durably with `expires_at`,
NEVER `read_at` — `ackMessage` is that column's only writer and the operator surface renames it
`ackedAt`, so a system stamp there reports an acknowledgement that never happened.

**The knock-on, and its closure.** Removing a stale row's owed-ness also removes the accidental
MASKING it was doing for gaps in the reason list. That was deferred here rather than disclosed as a
residual, and the r2 gate found it as a BLOCKING: the gap was the slot-level partial, and the
expiry silenced AND deleted a live `retry_setup` about it. CLOSED 2026-08-19 by
`ordinal_slot_shortfall` + a min-age gate on the durable expiry + retention for expired rows —
see [[resolution-predicate-inherits-its-reason-sets-coverage]] and
[[destructive-rederivation-outruns-the-grace-it-races]]. The standing lesson: a masking effect
removed is a coverage claim made; enumerate the gaps in the SAME change, or disclose them as
residuals in the report — never in a memory file only.
