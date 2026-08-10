---
name: guard-scoped-wider-than-the-state-it-protects
description: "⚠️ CLASS: an ordering/dedup/staleness guard keyed GLOBALLY when the thing it protects is per-lane silences every independent state machine that shares the key — a routine subscription renewal made a real chargeback freeze a permanent no-op. Scope the guard to the state it protects, and refuse only on an ACTUAL conflict."
metadata:
  type: project
---

⚠️ CLASS (I shipped this one; caught by the wave-2 integration gate, 2026-08-06,
BLOCKING). My F3 fix stored ONE watermark row and refused any handled Stripe
event whose `created` was below it. But the six subscribed event types are
INDEPENDENT state machines on independent Stripe objects (a Dispute, a
Subscription, an Invoice) with no causal ordering between them. Monotonic +
global meant: once ANY event at time T applied, EVERY event emitted before T was
refused forever, IN EVERY LANE. A routine `customer.subscription.updated` at
T+300 — which the platform generates on its own schedule via syncMailboxQuantity
— made a real `charge.dispute.created` emitted at T+120 return
`{applied:false, stale:true}`. The D5 chargeback freeze never fired, with no
alert and no self-heal (Stripe re-sends the same `created`, so every retry is
refused; and the later `dispute.closed(won)` is scoped `WHERE
billing_state='disputed'`, so it no-ops too). A paid `checkout.session.completed`
could be dropped the same way with `screened_at` NULL — reopening the exact
compliance fail-open my guard-before-effect fix had just closed.

**Why I got it wrong:** I DID consider the cross-type case while designing and
talked myself out of it in one line ("disputes are stickier anyway. Fine.") — I
checked the direction where the dispute arrives FIRST and never checked the
reverse. A design note that says "ordering within the billing-state lane" and an
implementation that keys on nothing are not the same thing, and the gap is
invisible to every same-lane test.

**How to apply:**
1. Before writing any staleness/dedup/ordering guard, name the STATE it protects
   and key the guard on exactly that. If the key is broader than the state, every
   other consumer of that key is silently in scope.
2. Refuse only on an ACTUAL CONFLICT, not on ordering alone: (1) older than the
   newest applied event IN ITS OWN LANE **and** (2) applying it would CHANGE the
   state a newer event established. Condition (2) is what lets a late-but-harmless
   event's OTHER effects land (a late checkout writes the 'active' that is already
   there, but it is the only carrier of the OFAC screen, the ledger credit and the
   item capture) while still refusing a stale checkout after a cancellation and a
   stale `dispute.closed(won)` that would lift a NEWER freeze. Both conditions are
   independently load-bearing — revert either and a different repro fails.
3. Bias the rule toward APPLYING: a wrong apply here can only be an event whose
   write agrees with current state (no state change, idempotent side effects); a
   wrong refuse silently drops a control.
4. A refusal that returns 200 must ALERT. "Usually correct and invisible" is how
   the whole class started. Grep your own new guard for the silent-return path.
5. Test the reverse order of every pair you reason about, and specifically test a
   guard against an event type it was NEVER meant to govern.

**SECOND ITERATION, 2026-08-06 (gate residual N-1).** The fix — one watermark
PER LANE instead of one global — was still not keyed to the state. The `dispute`
lane holds every dispute OBJECT, so dispute A's WIN moved the lane mark past a
DIFFERENT, genuine chargeback B emitted earlier, and condition (2) read B's
'disputed' against the 'active' A's win had restored as a real conflict: the
second chargeback was refused and that tenant never froze. **Narrowing a guard's
key one level is not the same as keying it to the state** — ask whether the new
key still spans independent objects. The fix that held: EXEMPT the direction
that cannot regress (`charge.dispute.created` — a freeze only ever costs time,
and its own `dispute.closed` lifts it) and keep ordering on the direction that
can (`dispute.closed(won)` must never lift a NEWER freeze). Per-dispute-id
keying was the other candidate and is WRONG: it would put a stale won in its own
empty lane and let it lift another dispute's freeze — the repo's existing
"stale dispute.closed(won)" test is what proves it.

Related: [[completion-pass-must-recheck-ordering]] (the other half of this same
build — a second write path that bypasses the primary path's guards),
[[guards-inline-in-a-loop-are-not-a-policy]] (guard scoped too NARROW — the
mirror error), [[refusal-path-added-to-claimed-record-table]] (what the refusal
this guard introduced did to a downstream counter).
