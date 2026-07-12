---
name: coverage-ledger
description: ColdStart class-sweep — surfaces/patterns that UNDER-COUNTED in past sweeps here; cover these FIRST every sweep.
metadata:
  type: reference
---

Search-coverage ledger for `~/dev/coldstart`. One line per surface that a sweep can easily miss. Cover these BEFORE declaring an inventory complete.

- **Downstream consumers of a raw signal**, not just its handler. The bounce-suppression bug (`reply-processor.ts`) also feeds `deliverability.ts::gatherMailboxHealth` bounce COUNTS → `evaluate` PAUSE/REPLACE_DOMAIN thresholds → real vendor spend. A sweep that stops at the write site misses the reputation/action loop that re-reads it.
- **Vendor-port ERROR CONTRACT (`packages/shared/src/errors.ts`)** is the systemic root of the retryable-vs-fatal class: `NotActivatedError`/`ValidationError` carry no severity/`retryable` flag, so every `real/` adapter throws an unclassifiable error. Check the contract, not only the call sites.
- **Sandbox adapters mask the missing branch** — always diff sandbox fixture shape vs real contract. `sandbox/email-port.ts` only emits hard bounces; `PolledBounce` has no severity field; `test/helpers.ts` `invoice.payment_failed` carries no decline-code. The other branch is untested BY CONSTRUCTION.
- **Stripe webhook `obj` payload fields dropped on the floor** — `billing.ts` reads `obj.status`/`obj.id` but never the decline reason/code on `invoice.payment_failed`. Grep for the event type AND check which sub-fields the handler ignores.
- **Schema can't EXPRESS the distinction** — `suppressions` PK `(tenant_id,email)`, `reason TEXT`, no `severity`/`expires_at`; `PolledBounce`/`events` have no severity column. A guard that only lints code misses that the storage layer forbids a soft/temporary suppression.
- **Cron/RPC lanes duplicate engine entry points** — `scheduled.ts` → `admin/ops-sweep.ts` re-invokes deliverability + dunning per-tenant; a class present in the engine fn is present in the cron lane too. (Prior general lesson: migration SQL, drift scripts, docs, CI config under-counted elsewhere — none present in this repo, but check `wrangler.toml` crons + any `spikes/` real-server code, which is out-of-scope here but is where the real contract lives.)
- **Ground ref matters**: sibling chats mutate this repo. Sweep of 2026-07-12 pinned `d4937ce1a9565261cc6f394451b8a2ced499cce2`; engine code was clean, only `site/` + docs dirty.
