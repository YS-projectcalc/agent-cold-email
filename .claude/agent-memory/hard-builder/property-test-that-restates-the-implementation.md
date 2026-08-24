---
name: property-test-that-restates-the-implementation
description: ⚠️ a property assertion whose two sides are both produced by the code under test cannot fail — `expect(prefix).toBe(visited)` stayed green under a planted defect because the shipped discipline makes them provably equal; the oracle has to be computed by the TEST from its own observations.
metadata:
  type: feedback
---

Found by the adversary gate on my own ColdStart sweep-capacity build, 2026-08-24:
planting `prefix := visited` into the shipped worker pool left **22/22 green**.

**Why.** Under the claim discipline the two quantities ARE equal, so an assertion
comparing them restates the implementation instead of checking it. It is not a
weak test, it is a test with no failure mode. Worse, the only executable oracle
for the real constraint lived in a NEGATIVE CONTROL that ran the *experiment's*
copy of the primitive, not the shipped one — so the day someone adds a per-item
timeout to the shipped path, the hole reopens with the suite green.

**Why:** the same shape as an isolated grader test passing on a defect in the
real wiring ([[isolated-grader-test-blind-to-its-own-guard]]) — a comparison is
only an oracle if ONE side comes from somewhere the code under test does not
control.

**How to apply:** three replacements that do bite:
1. **Have the test compute the expected value from its own observations** — e.g.
   record which callbacks actually ran and derive the expected prefix from that
   set, rather than comparing two of the primitive's own return fields.
2. **Assert the awkward case explicitly** — an item that ERRORED must still be
   inside the prefix (excluding it would strand it a whole rotation); that is a
   real decision, not a restatement.
3. **A source tripwire for the mechanism you rejected** — red if the shipped
   function grows `Promise.race` / `setTimeout`, with a message saying what must
   be true instead. Cheap, and it is the thing that catches the future edit.

Verify each by planting: `prefix := n` must red (1), and inserting the rejected
machinery must red (3). Related: [[recommendation-must-be-executed-not-shape-checked]],
[[concurrency-breaks-the-prefix-a-cursor-assumes]].
