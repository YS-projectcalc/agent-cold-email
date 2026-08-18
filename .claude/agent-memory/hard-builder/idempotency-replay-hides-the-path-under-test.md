---
name: idempotency-replay-hides-the-path-under-test
description: A crash fixture built by running the saga to SUCCESS then corrupting one row proves nothing — the recorded idempotency claim replays and the retry never re-enters the code under test; expire the pending claim too.
metadata:
  type: reference
---

Writing a crash-recovery test as "run the saga for real, then undo one write, then re-run" is the right instinct and silently wrong on a claim-then-execute path.

**The instance (coldstart E1, 2026-08-18):** attempt 1 completed, so `request_idempotency` held a `done` row for `provision:mbx:<tenant>:<email>`. Attempt 2 replayed the RECORDED result and never re-entered `runMailboxProvisioningUnit` at all. The assertion "no second warmup enrolment" PASSED — for the wrong reason, on both the fixed and the broken code.

The tell: the negative assertion passes but the *positive* one next to it fails — `warmupChecks` was `[]`, i.e. the vendor was never asked, i.e. the code under test never ran.

**How to apply:** model the crash as what a killed process actually leaves:
```
UPDATE mailbox_intents SET status = 'bought' WHERE email = ?;              -- marker never written
UPDATE request_idempotency SET status='pending', response_json=NULL,
       created_at = <now - 11min>  WHERE key = 'provision:' || <intentKey>; -- claim neither completed nor deleted, aged past
```
`REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS` is 10 min (`engine/idempotency.ts`) — the retry only takes a stale claim over past it. A *throw* deletes the claim (so a failed attempt re-runs freely); only a kill leaves it pending.

**Always assert the positive:** that the guarded call was ATTEMPTED (a pre-check log/spy), not just that the billed effect was absent. Absence is also what a code path that never executed produces. Same shape as [[total-count-assertion-proxies-per-resource-invariant]] and [[sandbox-fallback-masks-a-missing-activation-gate]].
