---
name: resolution-predicate-inherits-its-reason-sets-coverage
description: ⚠️ "no reason in set S is owed" used as "the alert/message RESOLVED" silences every condition S fails to cover — check the EMIT site's state against each member's predicate, not the set's name.
metadata:
  type: project
---

A re-derivation that clears a durable customer-facing record by testing "is anything in
`SETUP_FAMILY_REASONS` owed?" is not testing resolution — it is testing COVERAGE. Its truth value
is `∃ member whose predicate fires`, so any state the emitter can reach that NO member's predicate
matches reads as RESOLVED, and the record is silenced and then deleted.

**Why:** ColdStart `next-steps.ts` B2 (build gate r2, 2026-08-19). `retry_setup` is emitted on
`err instanceof VendorError && err.retryable`. Its mailbox leg leaves intent `committed`, the
`domains` row written, DNS `ready` and SOME slots persisted (`provisionMailboxesForDomain` runs
slots through `forEachIsolated` and rethrows only after all of them ran). Against that state all
four members were false by construction — `ordinal_incomplete` needs `live === null`,
`domain_dns_incomplete` a non-ready DNS, `paid_seats_unprovisioned` `billable === 0`,
`setup_capacity_held` `capacity_pending` — so `owedCount` hit 0, the message was expired, the prune
DELETED it, and the same zero disarmed `seat_headroom_free`'s guard, the `customer_progress_*`
checks and the nudge. 2029 tests were green: the fixture that "proved" the expiry was 2+2 mailboxes
at billed 5, byte-identical to the slot-failed state because NOTHING then read the coordinate
(`domain_intents.inboxes_each`) that distinguishes them.

**How to apply:** when a set of predicates is used as the complement of a "the condition is gone"
claim, walk the EMIT site's surviving state through each member's predicate and write down which
one fires. If none does, the set has a hole — add the missing member, do not narrow the emit. Then
make the distinguishing coordinate load-bearing in the fixtures, or a finished state and a failed
state stay indistinguishable to the whole suite. Related: [[classifier-cannot-see-an-undiscriminated-return]],
[[return-type-destroys-the-terminal-distinction]], [[fixture-born-with-the-code-restates-its-premise]].
