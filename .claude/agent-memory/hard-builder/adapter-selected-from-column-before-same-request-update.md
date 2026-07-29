---
name: adapter-selected-from-column-before-same-request-update
description: a vendor adapter/port selected from a persisted column at request-entry (buildAdapters) that the SAME request later UPDATEs is one-call-stale — reflects the PRIOR call's input, not this one's.
metadata:
  type: project
---

CLASS (ColdStart B1, registrar-arming): `TenantDO.requireContext()`→`buildAdapters()` SELECTS the domain port + bakes the registrant from `tenant_profile.register_domains`/`registrant_json` — but that column has NO writer other than `runSetupInfrastructure`'s own `UPDATE`, which runs AFTER `requireContext()`. So the port is one call stale in BOTH directions: a fresh single-call opt-in gets the hard-block port (false `registrar_unarmed` 503 + false founder alert; the UPDATE commits before the throw so a retry "works"), and an opt-out still holds the prior real port → a stale-registrant real buy fires.

**Why:** the flow whose OWN request body is the authoritative source of the selection state reads that state from the pre-call persisted row instead of the call's input. `withRequestIdempotency` with no key does NOT transaction-wrap, so the UPDATE commits incrementally even when a later step throws — masking direction 1.

**How to apply:** for the flow whose own input is authoritative, RE-SELECT only the affected port from this call's input after entry (ColdStart fix: `setupInfrastructure` builds a new ctx with `domain: selectSetupDomainPort(base.adapters, input)`, sandbox-eligible bundles untouched, real-eligible re-run the shared factory gate `selectRealDomainPort`). Keep every OTHER flow (REPLACE_DOMAIN/burn) persisted-state-authoritative, and keep the two-leg decouple guard inviolable (env leg absent → hard-block regardless of the call). The post-UPDATE pre-flight (`assertCompleteRegistrant` reading the persisted row) then agrees with the port's baked registrant because both derive from this call's input.

**Test blindness:** every opt-in test that hand-builds `createVendorAdapters(...)` or pre-seeds the row in a SEPARATE `runInDurableObject` block is structurally blind to this — it bypasses `requireContext()`'s pre-UPDATE read. Only a test driving the REAL single HTTP `POST /setup-infrastructure` end-to-end reproduces it. Real paid bundle can't reach 202 (RealBillingPort is a dark `NotActivatedError` stub → 500 AFTER the domain buy), so assert on the observed `/domains/register` vendor call (count + `contact_details`) + response-code-not-`registrar_unarmed`, exactly as the adversary repro'd. Reset account-wide D1 `vendor_spend_ledger`/`vendor_slot_state` in beforeEach or the 15000¢ ceiling accumulates across real-bundle tests. Related: [[persist-before-confirm-cross-boundary]].
