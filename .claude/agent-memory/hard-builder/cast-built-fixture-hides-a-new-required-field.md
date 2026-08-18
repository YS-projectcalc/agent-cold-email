---
name: cast-built-fixture-hides-a-new-required-field
description: ColdStart test gotcha — a fixture built with `as unknown as T` is invisible to the compiler when T grows a field, so typecheck passes and the code crashes at runtime on `undefined.find`.
metadata:
  type: reference
---

`apps/platform/test/send-pipeline-alerts.test.ts`'s `summaryWith()` returns `{...} as unknown as TenantOpsSummary`. Adding a required `credentialPushes` field to `SendPipelineSignals` therefore typechecked clean while `sendPipelineChecks` threw `Cannot read properties of undefined (reading 'find')` in two tests.

Two consequences worth remembering for this repo:

- **A green `npm run typecheck` says nothing about cast-built fixtures.** After widening any interface that a fixture models, grep the test tree for `as unknown as <Interface>` and update those fixtures by hand.
- **The full suite is the only detector**, and the platform suite is ~10 minutes / 1700 tests. Budget for it: targeted per-file runs during the build, one full run at the end, and never edit a test file while a background `vitest run` is in flight (it transforms lazily, so the results are a mix of both states — kill and re-run instead).

Also in the same family: `test/persisted-key-derivations.test.ts` pinned the `setup_infrastructure:<key>` namespace by driving a `quoteOnly` preview *because* it "returns before any vendor call" — which became precisely the outcome that records no row once non-terminal outcomes stopped being recorded. A test that observes a side effect through the cheapest no-op path breaks when that no-op stops having the side effect. Related: [[coldstart-vitest-binding-and-d1-isolation-gotchas]].
