---
name: seam-carries-the-claim-and-drops-the-money-field
description: A helper seam introduced to stop a CLAIM from drifting carried params+plan but not the co-travelling money field, so both callers shipped `effect: null` over calls that buy billable resources
metadata:
  type: project
---

A refactor seam built to unify two co-travelling fields leaves the THIRD free to drift, and
the seam's own docstring reads as if it closed the class.

ColdStart `apps/platform/src/engine/next-steps.ts`: gate r3 found `ordinal_slot_shortfall` and
`ordinal_incomplete` describing a `setup_infrastructure` call they had not planned, so
`executeSetupCall` was introduced — one distribution producing BOTH the emitted `params` and the
executed `plan`, with the docstring "the caller has no way to name an effect without holding the
plan that produced it". True of the PROSE. The `effect` field was left at its literal `null` at
both emit sites, so the fix turned a call that bought nothing into a call that buys real mailboxes
and kept the money field saying the bill does not move (+$10/mo per mailbox at/above the floor,
consumer = an unattended agent executing the params verbatim).

**Why:** the seam's parameters were chosen from the DEFECT being fixed (params vs claim), not from
the set of fields that describe the same call. `effect` travelled beside them and nothing in the
type system ties it to the plan.

**How to apply:** when a fix introduces a seam so that two outputs cannot disagree, enumerate every
OTHER field the same call emits and either route it through the seam or write down why it is
independent. Here the fix was to return `effect` FROM the seam's helper (`shortfallRemedy`) rather
than compute it beside the call. Related: [[classifier-cannot-see-an-undiscriminated-return]],
[[caller-side-effect-gated-on-callee-result-field]].

**And the guard shape that found the rest of the class:** write the invariant over the DERIVATION,
not over the reason — walk every step the derivation emits across the fixtures the suite already
has, run the REAL planner on each step's own emitted params, and assert the money field from the
plan. Written that way it immediately named a THIRD member (`domain_dns_incomplete`) that the
diff-scoped adversary could not see because it predates the diff. A per-reason test cannot find a
class whose members are other reasons. See [[recommendation-must-be-executed-not-shape-checked]].
