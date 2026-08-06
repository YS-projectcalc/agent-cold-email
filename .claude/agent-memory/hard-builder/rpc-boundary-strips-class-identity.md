---
name: rpc-boundary-strips-class-identity
description: CLASS — an error thrown inside a Durable Object arrives at the Worker with its own properties but NO prototype, so `instanceof` silently fails at the HTTP surface; branch on `err.name` / duck-type instead.
metadata:
  type: project
---

CLASS (ColdStart, caught in development 2026-08-05 provisioning wave 1): an error
thrown inside the DO and rethrown by the Worker has crossed a Workers RPC
boundary. It arrives **structurally equivalent** — `message`, `name`, and every
own property intact — but its PROTOTYPE is gone, so `err instanceof VendorError`
is **false at exactly the surface that matters most** (the HTTP response body).
The error object also gains `remote: true`, which is the giveaway in a dump.

`error-response.ts` has always branched on `error?.name === "VendorError"` and
read `.retryable`/`.step` as plain properties — that was not a style choice, it
is the only thing that works there. Any NEW helper that grades or classifies an
error and is called from the response path MUST do the same.

**How it surfaced:** a new `customerSafeVendorFailure(err)` used
`err instanceof VendorError ? err.retryable : false`. Unit tests and every
in-process engine test passed (in-process throws keep their prototype). Only the
end-to-end test driving the REAL `POST /setup-infrastructure` route caught it:
`step` came back `undefined`, and the same code path would have graded every
genuinely-retryable vendor failure as `retryable: false` in the customer's body —
telling a customer's agent to give up on a failure that heals by waiting. A
worse defect than the leak the helper was written to fix.

**How to apply:** in `apps/platform/src/**`, anything that inspects a caught
error AND can run in the Worker (route handler, onError, MCP handler, error
mapper) duck-types: `const f = err as {name?, message?, retryable?, step?}`.
`instanceof` is fine strictly inside the DO/engine. Test it by driving the real
HTTP route, not the engine function — an in-process test cannot reproduce this.
Related: [[adapter-selected-from-column-before-same-request-update]] (same
lesson: only the real single-HTTP-call path reproduces it).
