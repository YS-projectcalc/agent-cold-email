---
name: shrinking-a-global-bound-reds-other-suites-positive-controls
description: Lowering a shared capacity constant (batch/slice/page size) reds unrelated suites at their POSITIVE CONTROLS, not their subject assertions — tests that seeded N fixtures into a shared table were silently relying on one pass covering all of them.
metadata:
  type: project
---

Recalibrating ColdStart's `ASSUMED_DO_RPC_MS` took `SWEEP_TENANT_SLICE` from 37
to 3. The targeted suites stayed green; the FULL platform suite reddened 8 tests
in two unrelated files (`send-pipeline-driver`, `warmup-cancel`).

**Where it reds is the tell.** Not on the assertion the test is named for — on
its positive control. `send-pipeline-driver`'s helper asserts
*"fixture must be send-capable before a leg is broken, or the zero below proves
nothing"*, and THAT is what failed. Every "a suspended tenant is never driven"
assertion below it would have passed vacuously if the control had not existed.
A suite without positive controls would have gone green and meant nothing.

**Why:** in `@cloudflare/vitest-pool-workers`, `env.DB` writes are NOT rolled
back per test ([[coldstart-vitest-binding-and-d1-isolation-gotchas]]), so a
file's `tenants_index` accumulates across its tests. With an oversized slice one
tick reached every accumulated fixture; at the real slice it reaches 3.

**How to apply:** when you lower a shared bound, budget for the full net rather
than the touched suite, and expect the diagnosis to be *test isolation*, not
your change. Fix by making the test drive the guarantee the system actually
makes — a FULL ROTATION,
`ceil(await countTenants(env) / SWEEP_TENANT_SLICE)` ticks — rather than by
seeding fewer fixtures or asserting less. Do NOT re-widen the bound to keep
tests green: that inverts the fix. Related:
[[published-coverage-latency-must-use-the-achieved-advance]],
[[isolated-grader-test-blind-to-its-own-guard]].
