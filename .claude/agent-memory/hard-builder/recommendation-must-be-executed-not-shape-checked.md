---
name: recommendation-must-be-executed-not-shape-checked
description: ⚠️ a machine-readable recommendation must be EXECUTED by its guard, not shape-asserted — omitting one REQUIRED input field makes the platform's own advice 400 at its own boundary
metadata:
  type: project
---

Any feature that emits a call for a caller to execute needs a guard that RUNS
the emitted call against the real entry point. A test that asserts the shape of
`params` cannot see a missing required field, a stale enum, or a validator the
emitter did not know about.

**Confirmed 2026-08-18, ColdStart I5/I7.** `deriveNextSteps` emitted a
`setup_infrastructure` recommendation carrying `domains` + `distribution` but no
`inboxesEach` — which the input schema still REQUIRED. Every shape test passed.
The G5 convergence guard, which POSTs the emitted params verbatim, is what found
it: the platform's own recommended call failed at the platform's own boundary.
Fix was contract-side (`inboxesEach` optional when `distribution` is supplied,
with a refinement requiring one of the two), not emitter-side.

Two guard properties that carried their weight:

- **Execute against the REAL bundle.** `selectSetupDomainPort` early-returns for
  a non-real bundle, so on sandbox fixtures `registerDomains` has NO effect at
  all — a guard on sandbox adapters is blind to the one field whose omission
  breaks the recommendation. Arm `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID` +
  `REGISTRAR_PROVIDER` and stub the vendor HTTP layer.
- **A MANDATORY NEGATIVE fixture.** Strip the load-bearing field from an emitted
  step and assert the call FAILS. Without it, a guard that cannot see the field
  passes for the wrong reason and is evidence for nothing.

**How to apply:** for any emitted-call contract, the acceptance test is
derive → execute → re-derive → assert progress, plus one stripped-field negative.
Related: [[code-with-no-production-driver-passes-every-test]],
[[sandbox-fallback-masks-a-missing-activation-gate]].
