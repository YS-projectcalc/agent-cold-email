---
name: code-with-no-production-driver-passes-every-test
description: "CLASS: a feature whose only caller is a function that PRODUCTION never invokes (ColdStart runTick) is 100% green and 100% dead — tests call the entry point directly, so no suite can see it. Trace the caller chain to a scheduler/route/alarm before claiming shipped."
metadata:
  type: project
---

CLASS: a feature reachable only from an entry point that **nothing in production calls** is
fully green and fully dead. Every test drives the entry point *directly*, so no suite — unit,
integration, or full-net — can detect it. Verification-by-effect must therefore include
"what invokes this in prod?", not just "does it do the right thing when invoked?".

**Member (ColdStart, adversary A1, 2026-08-02):** the warmup auto-cancel sweep was wired into
`runTick` only. `runTick`'s callers are the `tick()` DO RPC and the demo pipeline — and
`tick()` is invoked by NOTHING in production: not the cron (`scheduled.ts` drives
deliverability/dunning/digest/watchtower/webhooks/spend-reaper/SDN only), not a route, not an
MCP tool, not a DO alarm (alarm-driven scheduling is still B2 backlog). I shipped it with 8
passing tests including one that drove `tenantStub.tick()` end to end. Fix: its own cron lane
— `scheduled.ts` -> `runWarmupCancelSweepAllTenants` -> `warmupCancelSweep()` DO RPC.

**The check that would have caught it, and now must be routine:** for any new engine work,
grep the CALLER CHAIN outward until it terminates at a real trigger (cron entry, HTTP route,
MCP tool, alarm handler, webhook). If the chain dead-ends at a function only tests call, the
feature is unshipped no matter how green the suite is. `grep -rn "\.tick(" apps/` was a
10-second check I did not run.

**Two traps in the fix itself:**
- Do NOT solve it by wiring the dead entry point into cron. Driving `runTick` from cron would
  have armed automatic CAMPAIGN SENDING — a separate founder-gated arc. Give the new feature
  its OWN lane that carries none of the neighbouring behaviour.
- The A1 test must drive the REAL trigger (`worker.scheduled(createScheduledController(),
  env, ctx)`), not the DO method. A test calling the DO method reproduces the original blind
  spot exactly.

**Adjacent standing fact:** the same unreachability means ColdStart campaign sends do not fire
automatically in production either — `scheduled_sends` is drained only by `runTick`. That is
B2 backlog, not a regression, but do not assume "the tick runs" anywhere.

Related: [[guards-inline-in-a-loop-are-not-a-policy]],
[[vendor-cancel-needs-marker-and-attempt-cap]].
