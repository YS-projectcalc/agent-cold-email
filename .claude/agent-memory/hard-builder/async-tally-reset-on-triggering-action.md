---
name: async-tally-reset-on-triggering-action
description: resetting a counter on the SAME action that asynchronously feeds it (soft-bounce streak DELETE'd on every send) makes the escalation threshold unreachable; reset only on an independent POSITIVE signal
metadata:
  type: reference
---

ColdStart soft-bounce streak (engine round-2). A tally (`soft_bounces.streak`) was
reset by the very action that produces its next increment: `tick.ts` DELETE'd the
row on every successful SEND, but a soft bounce is polled ASYNC AFTER the send
(receiptless EmailPort). Steady state per lead: send→DELETE(0)→bounce(1)→send→
DELETE(0)→bounce(1)… max streak = 1, so the suppress-at-3 threshold was
UNREACHABLE for a real single lead. The old test only "passed" by loading one
address as 3 separate leads so ONE tick fired 3 resets then ONE poll stacked 3
bounces — a fixture that encoded the bug.

Rule: when a counter is fed ASYNCHRONOUSLY by an action, do NOT reset it on that
action. Reset only on an INDEPENDENT positive signal (here: a REPLY — the only
liveness evidence a receiptless arch can observe). The tally becomes cumulative-
until-positive-signal BY DESIGN. Clear the (now-moot) row when the address is
permanently suppressed (hard bounce / escalation) so no dead rows linger.

What would have caught it: a REAL single-lead over-time trace (one lead, alternating
tick→poll cycles across the sequence) instead of a single-tick multi-lead fixture.
Sibling of [[coldstart-per-tick-recompute-clobbers-control-state]] (both are
one-writer-clobbers-another-writer's-state on a shared column), but the twist here
is TEMPORAL: sync reset races an async increment. Also relates to
[[sandbox-port-masks-real-server-contract]] — the receiptless poll model is the
root reason absence-of-bounce is unobservable.
