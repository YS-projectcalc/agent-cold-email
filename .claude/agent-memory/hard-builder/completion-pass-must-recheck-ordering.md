---
name: completion-pass-must-recheck-ordering
description: "A reconcile/completion pass added to close guard-before-effect REOPENS an ordering defect one door down unless it re-applies the same staleness rule — 'finish the crashed work' resurrects state a newer event already superseded."
metadata:
  type: project
---

Closing guard-before-effect on the ColdStart Stripe webhook (dedup claim commits, then an
awaited vendor call throws, so the retry no-ops as a duplicate and the tenant stays
HALF-APPLIED) needs a durable in-flight marker plus a completion pass: on a duplicate
whose marker survived, RE-RUN the (idempotent) handler instead of returning early.

That completion pass is a second write path to the same state, and it silently bypasses
whatever guards the first path has. Concretely: checkout crashes mid-handler at T1 ->
`customer.subscription.deleted` at T2 applies (billing_state='canceled', plan='free') ->
Stripe redelivers the T1 checkout -> the completion pass "finishes" it -> plan='managed',
billing_state='active'. A canceled tenant resurrected by a fix for a different bug.

**Why:** every guard on the primary path (ordering watermark, sticky-freeze, caps) is a
property of the STATE TRANSITION, not of the delivery. A completion pass re-runs the
transition, so it inherits the obligation to justify it.

**How to apply:** when adding any reconcile / retry-completion / catch-up path, enumerate
the guards the primary path runs BEFORE its effects and re-apply each one, or state in a
comment why it cannot apply. For staleness specifically: superseded work is not worth
finishing — drop the marker and return, do not complete it. Test it explicitly
(crash -> newer event -> redelivery must not regress), because neither the F2 test nor
the F3 test catches this interaction on its own. Related:
[[persist-before-confirm-cross-boundary]], [[compaction-snapshot-must-carry-inflight-state]].

Also from this build: make the re-run genuinely idempotent by keying appended rows on the
EVENT id (`ledg_${event.id}` + `INSERT OR IGNORE`), never a fresh `newId()` — otherwise
the completion pass double-writes the ledger. And a new PER-DO table added to
`TENANT_DO_SCHEMA` needs NO `tenant-do.ts` edit (the constructor execs the whole schema,
and `CREATE TABLE IF NOT EXISTS` reaches existing DOs); only ADD COLUMN needs
`addColumnIfMissing` — useful when another lane owns tenant-do.ts.
