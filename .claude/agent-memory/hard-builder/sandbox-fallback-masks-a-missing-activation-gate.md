---
name: sandbox-fallback-masks-a-missing-activation-gate
description: "CLASS: when a missing activation gate falls back to a SANDBOX adapter instead of the real vendor, a test that counts vendor/wire calls passes on the broken code — the harm is a fabricated 'sent'/success row, so assert the ROW's own status, not the call count."
metadata:
  type: feedback
---

CLASS: if the code path behind a missing gate degrades to a SANDBOX adapter rather than
erroring, then "no vendor call happened" is TRUE on both the fixed and the broken code.
A test asserting the vendor was not called passes either way and proves nothing. The
actual harm is that the product records a FABRICATED success for work that never left
the building — so the assertion has to be on the persisted row/state, not on the wire.

**Concrete instance (2026-08-06, ColdStart wave-2 Inc-D, send-pipeline activation
predicate):** leg 3 of the predicate blocks a `past_due` / `screening='review'` tenant.
The RED proof (predicate removed, cp-backed) showed the leg-3 tests still PASSING. Cause:
every leg-3 state also flips `readActivationState().activated` to false, and
`buildAdapters()` keys the real-vs-sandbox choice on exactly that — so without the gate
the tenant gets a `SandboxEmailPort`, the fake engine records ZERO calls, and
`expect(engineCalls).toEqual([])` is satisfied by the BROKEN code. The row was being
marked `'sent'` with a fabricated message id. Adding
`expect(statuses.sort()).toEqual(["pending","sent"])` took the RED from 4 failures to 6.

**Why:** this is the repo's own G3 "confident-wrong" hazard (a paid tenant whose real
send path isn't live silently gets a sandbox port and sees successful sends that never
left) reappearing as a TEST blind spot rather than a product one. Counting outbound
calls measures the vendor boundary; the customer-visible lie lives in the database.

**How to apply:**
- Any gate whose absence routes to a sandbox/no-op/stub adapter: assert BOTH (a) no
  vendor call AND (b) the durable row is still in its pre-effect state.
- When a revert-proof shows FEWER failures than expected, do not conclude "belt covers
  it" — find the mechanism first. Here 4 of 6 leg-3 states genuinely were covered by
  `runTick`'s own `isLifecycleFrozen` belt (suspended/canceling/canceled/disputed) and 2
  were not (`past_due`, `screening`), and only probing told them apart.
- Probe technique that settled it without patching source: call the gated RPC and the
  ungated one back to back on the same fixture (`runScheduledTick()` -> `{ran:false}` vs
  `tick()` -> `{sent:1}`).

**SECOND FACE OF THE SAME BRANCH (2026-08-18, continuity design gate B2):** the sandbox
branch does not only mask a missing gate, it makes whole INPUT FIELDS inert.
`selectSetupDomainPort` early-returns `if (bundle.kind !== "real")` (`tenant-do.ts:776`), so
on any sandbox fixture `registerDomains` has NO effect at all. A convergence guard built to
prove "the recommended call actually works" was therefore structurally blind to the ONE field
whose omission made that call 503 in production. **How to apply:** before trusting a guard that
executes a real code path on sandbox adapters, list the fields the sandbox short-circuit
discards, and add a NEGATIVE fixture on the real branch (strip the field → the guard must FAIL)
to prove the guard can see it at all.

Related: [[code-with-no-production-driver-passes-every-test]] (same family — green tests
over a path production never exercises), [[polling-check-error-is-indistinguishable-from-negative]],
[[absent-field-means-opposite-things-on-read-and-write]] (the field B2 could not see).
