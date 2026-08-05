---
name: error-mapping-surfaces
description: Search-coverage ledger — surfaces that UNDER-COUNT when sweeping the "unmapped error class → opaque 500 / unstructured passthrough" class in coldstart. Read FIRST.
metadata:
  type: reference
---

Sweeping "a foreseeable failure reaches the customer unmapped" in `~/dev/coldstart`. `grep onError` finds ONE of three mapping surfaces. Cover these first:

1. **THREE independent error-mapping chains, not one.** (a) `apps/platform/src/index.ts` `app.onError` — string-compares `err.name` (must, RPC drops the prototype chain), fallthrough `{error:"internal error"}` 500. (b) `apps/platform/src/mcp/handler.ts` `tools/call` catch — a SEPARATE, much thinner chain; its fallthrough returns `err.message` VERBATIM (over-exposes where HTTP over-hides — same class, inverted symptom). (c) `apps/engine/src/errors.ts` `statusFor()` — the droplet's own `instanceof` chain, default 503. A sweep that reads only (a) under-counts by ~2/3.

2. **The mapped/unmapped split is invisible from the throw site.** Every `real/` adapter throws `VendorError`/`NotActivatedError`; both are UNMAPPED. Two of their SUBCLASSES (`RegistrarUnarmedError`, `IncompleteRegistrantError`) ARE mapped — so `grep VendorError` looks covered while the base class 500s. Enumerate `packages/shared/src/errors.ts` EXPORTS and diff against each chain's name strings; do not reason from the throw sites.

3. **`site/openapi.yaml` is the PUBLISHED error contract** and drifts silently — `/setup-infrastructure` documents only 202/400/401 (no 503 `registrar_unarmed`, no 400 `incomplete_registrant`, no 409, no 500). Only `send_blocked` is documented anywhere. Docs are an in-class surface, not commentary.

4. **A test docstring can ENSHRINE the defect as normal.** `test/registrar-arming.test.ts`'s `installInboxKitFetchMock` doc states "a real paid provision always ends in a non-2xx AFTER the domain buy" — that IS the 2026-08-04 live incident, normalized in the suite months earlier. Grep test comments for normalized failure ("ends non-2xx", "expected to fail", "doesn't line up") before declaring an inventory.

5. **The guard idiom already exists here** — `test/*-coverage.test.ts` (`send-governance-coverage`, `spend-armed-env-coverage`, `spend-ceiling-coverage`): `import.meta.glob("../src/**/*.ts", {query:"?raw", eager:true})` + a non-vacuity assertion + an allowlist-with-reasons + self-proving synthetic detectors. Propose new guards in THAT shape, not a fresh invention.

6. **Graceful-catch coverage is per-call-site, never central.** `CapacityPendingError` is caught in `engine/provisioning.ts` (setup) and `engine/deliverability-actions.ts` (REPLACE_DOMAIN) but NOT in `engine/byo-mailbox-composition.ts` — the same gate 200s on one entry point and 500s on its sibling. For any "caught somewhere" error, enumerate EVERY caller of the throwing helper.
