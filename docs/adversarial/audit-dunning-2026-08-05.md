# Adversarial audit — dunning / past-due sweep (2026-08-05)

**Grounding.** HEAD `0fe2471` (main), read-only; live tree untouched. All probes ran in an isolated scratchpad copy (real DO+D1 via vitest-pool-workers), execution not static reading. Part of the founder-ordered full boundary audit; boundary-map flagged this as a money-critical surface with NO frozen adversarial record.

## VERDICT: FAIL — 3 BLOCKING (executed-confirmed)

⚠️ **Cron is ARMED and LIVE:** `wrangler.toml:107-108 crons=["*/5 * * * *"]`, despite `scheduled.ts:4-6` claiming it's "commented-out." Every finding below fires every 5 min against real tenants — Mordy-reachable (on his next payment-failure/flap).

**Target drift:** `admin/dunning.ts` is now only the pure `decideDunningAction`; the ACT half is `runDunningSweep` in `apps/platform/src/admin/ops-sweep.ts` (the `dunning.ts:4/:39` comments misattributing it to `routes/admin-ops.ts` are stale).

## F1 — BLOCKING · missed-suspend + PLATFORM-WIDE cron takedown
The dunning loop is the ONLY per-tenant sweep in `ops-sweep.ts` with NO try/catch. Siblings `runDeliverabilitySweepAllTenants:141`, `runWarmupCancelSweepAllTenants:180`, `runWebhookDeliveriesAllTenants:208` each wrap the body `try{...}catch{errors++}`. `runDunningSweep` (`ops-sweep.ts:42-65`) does not.
- **EXECUTED:** tenant K's `stub.suspendForDunning()`/`stub.opsSummary()` (`:44`) throws (real prod condition: wedged/overloaded DO, storage error, or the DO constructor's own UNIQUE-constraint 500 `tenant-do.ts:251-253`) → propagates out of runDunningSweep → out of `runScheduledOpsSweep` (`scheduled.ts:40`, no try/catch) → `ctx.waitUntil` (`index.ts:166`, unhandled). Because dunning runs MID-SEQUENCE, every later leg is skipped platform-wide: digest, **watchtower (health + founder alerts)**, **webhooks (outbound pump)**, **spendReservations (stale-reservation reaper → spend ceiling erodes)**, sdnRefresh, sdnRecovery — every 5 min until the wedged tenant is fixed.
- Probe P1: `opsSummary order: ["ten_919e…"]` (second tenant never reached); victim after clean re-run `{"status":"suspended"}` (missed solely by the abort).
- **Fix:** wrap the per-tenant body in try/catch like its 3 siblings + wrap runScheduledOpsSweep's legs.

## F2 — BLOCKING · permanent missed-suspend: guard commits before effect
`runDunningSweep:51-63` records the idempotency intent (`insertDunningEventIfNew`, INSERT OR IGNORE on UNIQUE(tenant_id,cycle)) and returns `applied=true` BEFORE calling `suspendForDunning():61`. A crash/RPC-failure between them leaves the dunning_events row committed but the tenant unsuspended. Next sweep: `cycle` (=billingFailureCount) unchanged → `applied=false` → the `if(applied && action==="suspend")` block skipped → **suspend never retried.** Permanent once Stripe exhausts its ~4 payment_failed retries (count freezes). Non-paying tenant keeps sending indefinitely.
- **EXECUTED:** after clearing the fault + clean re-run, faulted tenant still `{"status":"active","billingState":"past_due"}, applied=false`. Same non-atomic shape strands the NOTICE (suspend `:61`, notice `:62`): crash between = suspended but never told, never retried. Mordy-reachable.
- **Fix:** apply the effect (suspend) BEFORE recording the guard row, or add a reconciliation pass.

## F3 — BLOCKING · wrong-suspend of a PAYING customer (flap race)
`suspendTenant` (`engine/ops-summary.ts:69-75`) is a bare unconditional `UPDATE tenant_profile SET status='suspended'` — NO `WHERE billing_state='past_due'` re-check. The sweep's read (`opsSummary:44`) and write (`suspendForDunning:61`) are two separate DO RPCs with a D1 insert between; DO single-threading serializes each RPC but holds no lock across the gap. A recovery webhook in that gap (`checkout.session.completed` → `billing.ts:251` sets billing='active'; `reactivateFromDunning:262` is a NO-OP because status isn't 'suspended' yet) is then overwritten by the unconditional suspend.
- **EXECUTED (P2):** `{"status":"suspended","billingState":"active"}` + customer emailed `"[coldrig] Your account "Charlie Co" has been suspended for non-payment"` — a paying customer, sending frozen (`billing-state.ts:32`), told they didn't pay. NO self-heal (next sweep skips them, not past_due). Permanent-decline codes (fraudulent/lost_card) trigger suspend at cycle 1 (`decideDunningAction:47`) — doesn't even need count-4. Control probe P3: `before {active,active} → after direct suspendForDunning {suspended,active}`.
- **Fix:** make suspendForDunning conditional `WHERE billing_state='past_due'` inside the DO (the house atomic-conditional-UPDATE pattern already used by `resolveScreeningReview` + the spend-ledger reserve).

## Attacks that FAILED (PASS is meaningful)
- **Auth:** POST /admin/ops/dunning-sweep → 401 for no/wrong/SDN-carve-out bearer. `requireAdminAuth` fails closed (unset ADMIN_TOKEN→401, timing-safe); SDN carve-out path-pinned to `/admin/sdn/ingest`+POST.
- **Time base:** `decideDunningAction` purely count-based, no clock; past_due read from the `billing_state` column. Frozen-VirtualClock class does NOT reach dunning.
- **Cross-tenant:** unfiltered `COUNT FROM webhook_events` (`ops-summary.ts:126`) is correct — per-DO SQLite isolation. insertDunningEventIfNew binds tenant_id.
- **Suspend semantics:** dunning suspend is a soft reversible `status='suspended'` freeze; does NOT flip the vendor bundle to sandbox or strand vendor resources (correct dunning≠terminate separation).
- **Idempotency divergence:** duplicate payment_failed short-circuits at `billing.ts:352-355` before updating last_decline_code → declineCode can't diverge from cycle to slip an escalate→suspend past the (tenant,cycle) key.

## NEW (out-of-scope, no verdict weight)
- `scheduled.ts:4-6` "crons commented-out" comment is STALE — the cron IS armed (`index.ts:164` + wrangler.toml). Doc defect.
- `admin/dunning.ts:4/:39` misattribute the ACT half to `routes/admin-ops.ts`; it's `admin/ops-sweep.ts`.

_Frozen by the orchestrator from audit-dunning's verbatim report (read-only lane); probe: scratchpad `cs-sbx/apps/platform/test/zz-adversary-dunning-probe{,-auth}.test.ts`._
