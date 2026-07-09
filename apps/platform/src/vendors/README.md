# src/vendors

Implements the `VendorPort` interfaces from `@coldstart/shared` twice:

- `sandbox/` — **active**, in-memory, deterministic simulators. This is what
  every tenant uses today (test-mode go-live, SPEC.md §0.1/§0.4). Notably
  `sandbox/email-port.ts` decides bounce/reply/silence by the recipient
  local-part (`bounce`/`reply` substrings) — see the comment at the top of
  that file for the exact contract; it's what the E2E tests key off of.
- `real/` — **typed stubs only**. Every method throws `NotActivatedError`
  immediately. Coded against the vendor shapes now so a later real
  implementation is a drop-in, but nothing here ever makes a network call.

`factory.ts` is the single choke point that decides which bundle a tenant
gets (`createVendorAdapters(plan, clock, realAdaptersActivated)`). Demo/free
plans are forced to `sandbox` unconditionally, before the activation flag is
even consulted — see `test/demo-adapter-guard.test.ts` in `apps/platform`
for the guardrail test that fails if this is ever weakened.

## How to run

Part of `apps/platform`; no standalone build. Exercised by
`apps/platform/test/*.test.ts` via `npm test` (workspace root or this app).

## Depended on by

`src/tenant-do.ts` (constructs a `VendorAdapterBundle` per tenant via
`factory.ts` and uses it for `setup_infrastructure`, warmup, send, and poll).
