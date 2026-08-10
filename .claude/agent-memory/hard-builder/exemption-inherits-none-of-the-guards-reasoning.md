---
name: exemption-inherits-none-of-the-guards-reasoning
description: "⚠️ CLASS: an EXEMPTION carved into an ordering/staleness guard to fix a cross-OBJECT false-refusal silently exempts the same-OBJECT case too — the exempted type's own reverse delivery order then writes a terminal state nothing can lift. Bound the exemption to the entity's OWN recorded lifecycle, not to its type."
metadata:
  type: project
---

⚠️ CLASS (wave3-integration-gate-2026-08-09 B-1, on top of my own N-1 fix).
`isStaleBillingEvent` refused out-of-order Stripe events; my N-1 fix exempted
`charge.dispute.created` wholesale, because the per-lane watermark carried EVERY
dispute object, so one dispute's win refused a DIFFERENT genuine chargeback.
Correct for every other dispute — and the exemption's own written justification
("applying a freeze can only lose time, until its own dispute.closed lifts it")
is FALSE for the dispute's own reverse order. Stripe orders nothing WITHIN one
dispute either: `closed(won)` delivered before `created` was consumed and
deduped, then the late `created` wrote `billing_state='disputed'` with no state
guard. 'disputed' is terminal (only that dispute's closed(won) leaves it), so
the tenant sent/provisioned/launched nothing FOREVER, with no alert, and the
recovery the product prints ("reactivate via POST /checkout") is itself scoped
`billing_state != 'disputed'`.

**The tell I missed:** an exemption is a second guard with a second failure
direction, and it inherits NONE of the reasoning that justified the first. I
reasoned about the cross-OBJECT case the exemption was written for and never
walked the exempted type's OWN two-event lifecycle in both delivery orders.
Same shape as [[guard-scoped-wider-than-the-state-it-protects]] one level in:
there the KEY was too broad, here the EXEMPTION is.

**How to apply:**
1. Bound an exemption by the entity's OWN recorded lifecycle, not by its type.
   The per-object witness beats the timestamp: a dispute is always created
   before it is resolved, so "this dispute's resolution is on record" is a
   stronger ordering fact than any `created` field — and it holds even for an
   event with no timestamp.
2. The witness has to EXIST. `dispute.closed` UPDATEd a row that a closed-first
   delivery had not created yet, writing 0 rows and recording nothing to match
   against — the guard half is useless without the UPSERT half. Whenever a fix
   reads durable state, check the write path that produces it under the SAME
   reordering, and prove both halves by partial revert.
3. Do not narrow to the reported instance: the gate showed closed(WON)-first,
   but a non-won close (`warning_closed`) writes no billing_state at all and
   bricks by the identical mechanism. Refuse on every terminal outcome that does
   not itself warrant the state — keep 'lost' applying, since there the freeze
   IS the intended terminal state and the late `created` is its only carrier.
4. Keep the refusal LOUD. Routing it through the existing stale path gave it
   `applied=0` (no dunning strike) plus the ops alert for free, which is the
   safety valve if a refusal is ever wrong.

Related: [[completion-pass-must-recheck-ordering]] (the same guard, second
write path), [[false-recovery-disarms-cooldown-dedup]] (clearing state on the
wrong signal).
