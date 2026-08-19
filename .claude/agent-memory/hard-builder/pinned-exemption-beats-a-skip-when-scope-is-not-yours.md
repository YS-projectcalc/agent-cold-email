---
name: pinned-exemption-beats-a-skip-when-scope-is-not-yours
description: When a class guard reddens on a member outside your brief, PIN the violation (assert it at its exact sites) instead of skipping it — the pin reddens the moment someone fixes it, and it keeps the scope decision with its owner
metadata:
  type: feedback
---

A class guard written over a DERIVATION will find members the brief did not name. The scope call
belongs to the orchestrator (CLAUDE.md Bug Response step 3: "never let a builder decide what's
in-class"), so you cannot fix it — but you also cannot ship a red suite, and a `skip` normalizes
the defect and rots.

**The shape that satisfies both:** assert the violation at its exact sites.

```ts
expect(violations.filter(v => v.reason === UNFIXED_MEMBER).map(v => v.text),
  "if this list is now EMPTY the defect is fixed — delete UNFIXED_MEMBER and this assertion",
).toEqual([ /* the exact strings, one per site */ ]);
```

Fixing the defect EMPTIES the list, reddens the block and forces its own deletion. An exemption
that cannot outlive the defect it documents.

**Why:** ColdStart r5 (2026-08-19). The guard for the r4 gate's NEW-1 found a third member the
diff-scoped adversary could not see. I asked the orchestrator for IN/OUT, committed in writing to
OUT-if-unanswered, got no reply in time, shipped the pin, and reported. The orchestrator then ruled
IN and the pin was deleted one commit later — total cost of having been conservative: one small
commit. Cost of having expanded unilaterally: the ruling would have been made after the fact.

**How to apply:** ask ONCE with executed evidence, state the default you will take absent an answer,
then honour that default — the value is that the decision stays reversible either way. And keep
executing while you wait: prove the member's blast radius rather than describing it. Here the
difference between "same class, probably mild" and "+$20/mo, $99→$119, the only member reachable in
production" is what made the ruling obvious, and I only had it because I built the fixture instead
of reasoning about `fillDistribution`. See [[seam-carries-the-claim-and-drops-the-money-field]].
