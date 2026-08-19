---
name: remedy-computed-in-different-coordinates-than-the-defect
description: A step whose params come from one function and whose claim comes from another is a lie in both directions — a no-op-forever remedy and a money-spending escalation shipped under "creates exactly the missing ones", green the whole time.
metadata:
  type: project
---

`ordinal_slot_shortfall` measured the defect **per-ordinal against each ordinal's own `inboxes_each`** and computed its remedy as `fillDistribution(snap, max(billedQuantity, 5))` — a **flat total packed 3-per-domain**. Two different coordinate systems, one sentence claiming they agree ("repeating the setup call creates exactly the missing ones"). The real planner, run on the emitted params, said:
- asked `[3,3]`, 5 live, billed 5 → emitted `[3,2]` → `{newDomains:0, newMailboxes:0}` — a **total no-op**, forever: the agent executes, gets success, re-derives, sees the identical step.
- asked `[5]` on one domain, 4 live, billed 5 → emitted `[3,2]` → `{newDomains:1, newMailboxes:2}` — **buys a new domain**, never fills slot 4, raises the live count so the next fill target grows: a spend loop up to the 60-mailbox ceiling.

**Why:** `inboxes_each` is bounded 1..10 and `MAILBOXES_PER_DOMAIN` is 3, so the two systems diverge routinely. The suite was green because the wave's own fixture was grain-matched to the single shape where they coincide (2 ordinals asking 3+2, fill target landing on exactly `[3,2]`).

**How to apply:** the fix is not a better distribution, it is **one seam that builds the params and runs the planner on THOSE params**, with the claim derived from the returned effect:
- build the distribution in the DEFECT's coordinates (each ordinal's own persisted ask, over the prefix `0..deepestShort` — positional planners give no way to address ordinal N without naming 0..N);
- run the real `planFor` on the exact emitted `{persona, distribution}` — the same persona string the params carry, or the plan is about a different call again;
- emit the actionable tool call **only** when the computed effect IS the defect (`newDomains === 0 && newMailboxes === missingTotal`); otherwise emit the FACT with `via: "none"` and say what the closest constructible call would actually do. A "close enough" remedy re-creates addresses the predicate just decided are not owed — i.e. it silently undoes the customer's own downgrade, re-entering through the remedy the defect the predicate exists to prevent.
- route the sibling reason through the same helper, or the next drift lands there.
- `waitingOn` must be READ OFF the action (`via === "none"` → `"operator"`), never asserted beside it: `waitingOn: null` is the contract's "the agent can act right now".

Test it by EXECUTING, never by shape: assert `planFor(snapshot, step.action.params)` equals the claim. See [[recommendation-must-be-executed-not-shape-checked]].
