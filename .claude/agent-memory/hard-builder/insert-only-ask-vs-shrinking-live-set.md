---
name: insert-only-ask-vs-shrinking-live-set
description: An INSERT-only "what was asked for" column compared against a live set that shrinks reports every deliberate removal as a platform failure; the discriminator must be a record that survives the removal, and the idempotency claim is NOT it.
metadata:
  type: project
---

An INSERT-only ask (`domain_intents.inboxes_each`, written `INSERT OR IGNORE`, no writer that lowers it) compared against a set that SHRINKS and MOVES (`mailboxes WHERE released_at IS NULL`) cannot say *why* the gap exists. `ordinal_slot_shortfall` read the gap as "never created" and got a PERMANENT false `owed` on four reachable paths: a deliverability burn (autonomous, no customer action), a customer downgrade reported back inside `removeMailboxes`'s own response, a persona change, and the one real per-slot vendor failure.

**Why:** the gap has one shape and four causes, and the schema stores nothing that separates "never created" from "created, then removed" — the design gate's own rule ("if the system stores nothing that separates the defect from a legitimate terminal preference, the signal is unshippable as `owed`") reopened one table over. `inboxes_each` never coming down is what makes it PERMANENT rather than transient.

**How to apply:** before shipping any owed/unfinished signal derived from `stored ask − live count`, enumerate every writer that shrinks the live side and ask which record survives it. Three discriminators closed this one, and each answers a different question the gap cannot:
1. *Can this resource carry the work today?* — `domains.status = 'active'`, not the platform-wide `status != 'released'` (a burn sets `'burning'`, the clock migration sets `'retired'`; both look live to the wider predicate).
2. *Was this address ever created?* — the **soft-deleted row**. A `mailboxes` row is inserted only after the vendor confirms readiness and NO production path deletes one (`releaseMailboxes` marks `released_at`; every remover funnels through it). The two obvious alternatives both fail exactly when needed: the `provision:mbx:` **request-idempotency claim is DELETED on every release** by `markMailboxIntentsReleased`, dropped table-wide by teardown, and evicted at 30 days; a `mailbox_intents` row is written BEFORE the purchase, so it exists for a slot that FAILED and would mute the true positive.
3. *Is the ask already covered?* — as a CAP, not only a gate. `ask − liveCount` bounds the shortfall; the gate form kills the persona-drift false positive, the cap form kills its partial cousin (drift leaves the domain short by one while the ADDRESS walk counts three, and that remedy is exact, executable, and two mailboxes' worth of bill too big).

Related: [[return-type-destroys-the-terminal-distinction]], [[two-valued-grade-for-a-three-valued-refusal]], [[orphan-detection-blind-to-the-row-never-created]] — the mirror case (that one cannot see the row never created; this one cannot see the row deliberately removed).
