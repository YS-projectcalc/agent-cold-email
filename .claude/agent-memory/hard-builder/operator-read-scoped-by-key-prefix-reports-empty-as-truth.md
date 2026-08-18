---
name: operator-read-scoped-by-key-prefix-reports-empty-as-truth
description: An operator diagnostic that filters by key prefix returns [] for every key it was not written to see, and a diagnosing human reads [] as "no claims exist" — the exact wrong inference during an incident.
metadata:
  type: project
---

`getProvisioningStateForOperator` selects `FROM request_idempotency WHERE key LIKE 'setup_infrastructure:%'` (`apps/platform/src/engine/provisioning-state.ts:125`). The per-mailbox claims are keyed `provision:mbx:<tenant>:<email>` and the per-ordinal work is recorded in `mailbox_intents` / `mailbox_buy_dispatches` — **none of which any admin route exposes**. During the 2026-08-18 warmup incident `requestIdempotency: []` was initially read as "no claim was ever recorded", when it only ever meant "no *setup_infrastructure* claim exists".

**Why:** the incident-time questions are all about the per-RESOURCE records (did this address's buy dispatch? is its intent 'bought' or 'warming'? is its claim cached 'done'?), and the one read surface built for operators answers none of them. Diagnosis fell back on inferring DO state from vendor timestamps.

**How to apply:** before drawing a conclusion from an operator endpoint's empty list, read its SQL. And when adding an operator diagnostic, scope it to the RESOURCE the incident is about, not to the one key prefix that was convenient. The missing surfaces here are `mailbox_intents`, `mailbox_buy_dispatches`, `mailboxes`, and `deliverability_actions` per tenant. Related: [[polling-check-error-is-indistinguishable-from-negative]], [[code-with-no-production-driver-passes-every-test]].
