---
name: do-constructor-and-query-order-test-gotchas
description: ColdStart platform vitest-pool-workers — how to test DO CONSTRUCTOR behavior (evictDurableObject), why a throwing stub RPC pollutes the run, and why an un-ORDER-BY'd query follows the partial index not rowid. Includes the U1 probe answers.
metadata:
  type: reference
---

Three levers/traps hit while building the wave-2 clock migration (Inc-C, 2026-08-06).

**Testing the DO CONSTRUCTOR for real:** `evictDurableObject(stub)` from `cloudflare:test`
tears down the instance while preserving durable storage; the next RPC re-runs the
constructor. That is the only way to exercise constructor-time migrations on the
production path (calling a private method directly proves nothing about constructor
context). `runInDurableObject(stub, () => undefined)` is enough to force the rebuild.

**A throwing RPC across the stub bridge is an unhandled rejection.** `await
expect(stub.someMethod()).rejects.toThrow(...)` passes AND emits `Uncaught (in promise)
… Serialized Error: { remote: true }`, which vitest reports as "Errors 1 error" on an
otherwise green run. Assert on the instance inside `runInDurableObject` instead —
`expect(() => (instance as TenantDO).method()).toThrow()` — for synchronous guards.

**Query result order follows the INDEX, not rowid.** `SELECT … FROM mailboxes WHERE
tenant_id = ? AND … released_at IS NULL` with no ORDER BY comes back in
`idx_mailboxes_live_email` order (tenant_id, email), NOT insertion order — a test that
assumed rowid order picked the wrong candidate first. Any order-dependent fixture must
make rowid order and index order AGREE (insert first AND sort first).

**U1 probe answers (both frozen as assertions in test/clock-migration.test.ts):**
- `storage.transactionSync` both COMMITS and ROLLS BACK from DO-constructor context on
  workerd/miniflare. The constructor-migration design is sound.
- Binding `NaN` to `warmup_started_at INTEGER NOT NULL` is REJECTED —
  `NOT NULL constraint failed` (NaN binds as NULL). A non-finite ramp anchor can never
  reach the column, so [[coldstart-vitest-binding-and-d1-isolation-gotchas]]-style
  backfill sweeps are unnecessary; the port-level clamp is hardening only.
