---
name: billed-effect-and-adapter-contract-surfaces
description: ColdStart sweeps for billed-non-idempotent-vendor-effects (class E) and adapter-vs-LIVE-response drift (class F) — where each under-counts, plus the live-probe recipe that settles F.
metadata:
  type: reference
---

Added by the E (marker-after-billed-effect) + F (adapter live-contract drift) sweep, 2026-08-18, ref `8c87c79`. See [[coverage-ledger]].

**Class F — adapter reads a field the LIVE response does not carry**

- **The one systemic root is `InboxKitClient.request<T>`'s `return body as T`** (`vendors/real/inboxkit-client.ts:87`). Fifteen `client.request<…>` call sites each declare a hand-written `interface …Response` that TypeScript never checks against the wire. Sweep the CAST, not only the destructures — `grep 'client.request<'` finds every member in one pass; `grep 'const { … } = body'` finds exactly ONE.
- **LIVE-PROBE, do not reason from the interface or the fixture.** Recipe (read-only, ~2 min): key `security find-generic-password -a coldrig -s inboxkit-api-key -w`, header `x-workspace-id: c5188ced-33db-436f-b970-1860e6c8c66b`, base `https://api.inboxkit.com/v1/api`. List endpoints are POST+JSON (`/mailboxes/list`, `/domains/list`, `/warmup/list`); `/domains/available` and `/email-insights/mailbox/{uid}/health` are GET. Probing settled 5 of 6 shapes in one pass and DISPROVED two.
- **A hand-written fixture is the class's camouflage, and its header will lie about provenance.** `test/fixtures/inboxkit.ts` says "Derived from real responses captured live … 2026-07-20", yet `IK_MAILBOX_HEALTH_SUCCESS` carries `health_status`/`bounce_rate`, which the live endpoint does not return at all. `real-mailbox-port.test.ts:104` asserts against the fiction and is GREEN. Diff EVERY fixture against a live probe before crediting a contract test.
- **A doc comment that says "⚠️ UNVERIFIED, confirm at the first live mailbox" is an unpaid debt, not a mitigation** — `showMailboxCredentials`' endpoint returns HTTP 404 live (it does not exist). Grep `UNVERIFIED` in `vendors/real/` and probe each one; the comment is a to-do that outlived its author.
- **Two failure modes hide under one class; tag them separately.** SILENT (guard passes, `NaN`/fabricated default propagates — `getHealth`) vs LOUD (the endpoint/status fails before the shape is read — the 404 credentials path). Only the silent arm reaches a control surface.
- **`Math.min/Math.max` clamps do NOT sanitize `NaN`** — `clamp01(undefined/100)` is `NaN`, and `JSON.stringify(NaN)` is `null`, so a field typed `number` reaches the customer as `null`. A `switch` on `undefined` silently returns its `default:` arm — that is how an absent field becomes a plausible-looking 50.
- **In-repo COMPLIANT templates for F (cite these, don't invent):** `apps/engine/src/oauth.ts:57` + `gmail.ts:125` (typeof-check then fail-loud/explicit-default), `real/email-port.ts:84,92` and `engine-mailbox-client.ts:71` (validate then throw a non-retryable VendorError), `stripe-client.ts:277-283` + `readNestedString` (accept both shapes, validate each).

**Class E — billed non-idempotent effect, marker written after the effect**

- **Score each site on FOUR axes, not "is it wrapped?":** (1) is a pre-check possible, (2) is the durable marker written before or after the effect, (3) is the effect idempotent vendor-side, (4) what does a crash-between-effect-and-marker + retry do. `withSpendCeiling` answers NONE of these — it is an accounting choke-point, and `spend-ceiling-coverage.test.ts` is not a guard for this class.
- **The pre-check can be structurally impossible even when the code exists.** `RealMailboxPort.warmupSubscriptionState` (the exact "is it already enrolled?" query) is `private` and absent from the `MailboxPort` interface in `packages/shared/src/vendor-ports.ts`, so no engine caller can reach it. Always check the PORT INTERFACE, not just the adapter file, before writing "the capability exists 60 lines away".
- **A pre-check reading a SNAPSHOT captured before the awaits is not a pre-check.** `runMailboxProvisioningUnit` captures `intent` at entry and passes it down through two vendor round trips. Grep for a status object passed as a parameter rather than re-read.
- **Compliant templates for E:** `dispatchBuy`/`claimBuyDispatch` (claim written BEFORE the call, so the crash window leaves proof), `findAdoptableDomain` (ask the vendor before buying), `confirmVendorOwnership` (vendor is the arbiter, never error text).
- **Spend-STOPPING calls (`release`, `cancelWarmup`) are OUT by construction** and documented as such at `spend-ceiling.ts:96-98` — do not pad the inventory with them.
- **`SpendKind` has a `prewarm` arm with ZERO call sites** — an enum arm is not an effect; verify a call site exists before listing it.
