---
name: false-recovery-disarms-cooldown-dedup
description: CLASS — reporting "recovered" on a vendor ACCEPTING a retry (not on the resource existing) both lies and silently disarms a cooldown-based alert dedup, because the healthy transition resets the state machine so the next failure alerts again instead of being suppressed.
metadata:
  type: project
---

CLASS (ColdStart, self-inflicted + caught by my own tests during the guarded
mailbox re-buy, 2026-08-06): an incident is cleared on the **acknowledgement of a
remedial action** rather than on the **remedied condition**. Two damages, and the
second is the non-obvious one:

1. It is a false claim. In ColdStart the whole premise is `provision()` returning
   means the vendor SCHEDULED a mailbox, not that one exists — so reporting the
   re-buy's ACCEPTANCE as recovery reported success for the exact failure being
   recovered from.
2. **It disarms the dedup.** A healthy→ report flips `watchtower_state` to
   'healthy'; `reconcileAlerts` suppresses a repeat alert only while the prior
   state is 'unhealthy'. So the next tick's unhealthy report is a fresh
   healthy→unhealthy TRANSITION and emails again. A 6h cooldown that reads as
   airtight becomes an alert-per-retry storm, and nothing in the state machine
   looks wrong — the bug is entirely in the caller's choice of when to say
   "resolved".

**How to apply:** clear an incident flag at the ONE point the desired state is
proven (ColdStart: after `awaitMailboxReady` returns ready), never at the point
the remedy was dispatched/accepted. If a remedy's outcome must also be reported,
give it its OWN check name — the same-name failure report seconds after a stuck
alert is swallowed by the very cooldown you want (that is why the re-buy outcome
uses `mailbox_rebuy:<email>` while the stuck state uses
`mailbox_provisioning:<email>`). Symptom to grep for when a dedup "isn't
working": an intervening healthy report, not a broken cooldown.

Also: an event-driven caller sharing a cron state machine must stay SILENT about
a check it never raised (read the row first, return if absent), or every ordinary
success files a healthy row and buries the handful of real platform checks.

Relates to [[guards-inline-in-a-loop-are-not-a-policy]] (the guard is fine; the
call site defeats it) and [[persist-before-confirm-cross-boundary]].
