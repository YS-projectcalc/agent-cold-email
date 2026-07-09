---
name: coldstart-per-tick-recompute-clobbers-control-state
description: ColdStart B6 — a per-tick warmup recompute silently wipes deliverability throttle/pause if they share a column; separate columns + refresh honors override
metadata:
  type: project
---

ColdStart `apps/platform/src/engine`: `mailbox-state.ts#refreshMailboxWarmupState` runs at the TOP of every `runTick`, recomputing each mailbox's `daily_cap` and `status` from the warmup ramp. Any control-loop mutation written to those SAME columns (a throttle lowering `daily_cap`, a pause setting `status`) is silently reverted on the next tick.

**Fix pattern applied (B6):** deliverability state lives in its OWN columns — `deliv_status` (healthy/throttled/paused, distinct from warmup `status`) and `cap_override` (nullable). The warmup refresh reads `cap_override` and sets `daily_cap = MIN(rampCap, cap_override)` so a throttle survives; it never touches `deliv_status`. The tick send-picker excludes `deliv_status='paused'`.

**Why:** two-writer-one-column is the trap. A "harmless" recompute on a hot path (every tick) is a second writer that overwrites the first. Targeted unit tests on `evaluate` (pure) all passed — only an integration test that ADVANCES THE CLOCK + ticks (so the refresh actually fires again) caught it. Revert-fail proof: reverting the `cap_override` MIN made the throttle-survives test fail "expected 40 to be 5".

**How to apply:** when adding a control loop over state that a scheduler/refresh already owns, never share the column. Give the loop its own columns and make the refresh honor them. Write the regression test so the recompute actually re-runs (advance the injected clock a day, then tick) — a single-tick test won't expose it.

Related: pending sends in this engine are NOT pre-bound to a mailbox (mailbox_id is NULL until send-time), so "rotate sends off a mailbox" = make the send-picker exclude it, not move rows. Complaint/bounce rates are FRACTIONS (Gmail 0.30% = 0.003, not 0.30 — the 100x trap).
