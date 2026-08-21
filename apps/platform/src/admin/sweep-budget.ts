// The cron sweep's PER-TICK BUDGET arithmetic — pure, no I/O, no clock.
//
// WHY THIS FILE EXISTS (scale audit 2026-08-17, S1 + S6). The sweep fanned every
// per-tenant leg out over the WHOLE tenant list, serially, with no cap:
// `subrequests(N) ~= 8N + 29`, measured on the real sweep at 5/20/50/100/200
// seeded tenants. Two things then break at once, and neither is loud:
//
//  - the invocation's subrequest budget runs out mid-sweep. `runLeg` catches a
//    leg throw and continues, so every REMAINING leg throws instantly and is
//    swallowed — and the LAST thing in line is the dead-man heartbeat, which is
//    deliberately last precisely so it means "this tick ran to completion". The
//    platform then pages the founder that the scheduler is dead while the thing
//    that actually stopped is automatic sending, and nothing says so.
//  - the send pipeline's stated invariant (`SEND_PIPELINE_LEG_DEADLINE_MS` +
//    `SEND_PIPELINE_TENANT_BUDGET_MS` = 285s < the 300s cron period) silently
//    assumes the six legs ABOVE it cost zero wall clock. None of them carried a
//    deadline, a budget or a cursor, so at 500 tenants the true worst case was
//    360-435s against a 300s period — overlapping sweeps, the exact condition
//    the invariant exists to prevent.
//
// THE SHAPE OF THE FIX: one bounded tenant SLICE per tick (admin/tenant-slice.ts),
// shared by every fan-out leg, advanced by a persisted keyset cursor. That makes
// the per-tick cost a function of the SLICE, not of the tenant count — so the
// trailing legs stay reachable at any N, and a new O(N) leg costs one more RPC
// per SLICE rather than one more per tenant.
//
// Every number below is DERIVED rather than chosen, so that raising one
// constant cannot silently break the invariant another one depends on:
// `sweep-budget.test.ts` re-computes each identity and reds if the arithmetic
// stops holding.

/** The `[triggers] crons` period every bound below is sized against (5 minutes). */
export const CRON_PERIOD_MS = 300_000;

/**
 * How long ONE tenant's poll+tick pair may occupy the send-pipeline leg. Rung 3
 * of the ordering ladder documented in vendors/real/email-port.ts — it MUST
 * exceed ENGINE_REQUEST_TIMEOUT_MS (120s), or a tenant behind a slow-but-alive
 * engine is abandoned having completed zero work on every single cycle, forever
 * (adversary round-2, R5). Read that comment before changing this.
 *
 * The pair shares ONE budget, per the design. Consequence, stated rather than
 * hidden: against a WEDGED engine a tenant's poll can consume the whole budget
 * and its tick never runs — but a wedged engine is exactly the state in which
 * the tick could not have sent anything either, so nothing is lost that was
 * otherwise available.
 */
export const SEND_PIPELINE_TENANT_BUDGET_MS = 135_000;

/**
 * The send-pipeline leg's own wall-clock ceiling, checked BETWEEN tenants.
 * Converts "the tenants behind a stalled one never run" into "some tenants this
 * cycle, all tenants across cycles" (with the rotation in ops-sweep.ts).
 */
export const SEND_PIPELINE_LEG_DEADLINE_MS = 150_000;

/**
 * The per-invocation subrequest ceiling this sweep is sized against
 * (Cloudflare Workers Paid).
 *
 * UNVERIFIED IN PRODUCTION, deliberately restated as an assumption rather than
 * a fact: the scale audit could not confirm the real cap or whether DO RPCs
 * count toward it (miniflare does not enforce it — 200 tenants ran ~1629
 * subrequests clean — and the OSS workerd binary carries no such string). What
 * does NOT depend on that number is the property this file buys: per-tick cost
 * that no longer grows with the tenant count. If the real cap is higher, the
 * slice is merely conservative; if it is lower, `SWEEP_BUDGET_FRACTION` is the
 * one knob to turn.
 */
export const SWEEP_SUBREQUEST_BUDGET = 1000;

/**
 * How much of that budget the per-tenant fan-out may spend. The remainder is
 * NOT slack — it is reserved for the things that must still work after the
 * fan-out has run: the founder's alert sends, the per-check D1 writes
 * `reconcileAlerts` makes, the trailing heartbeat, and the next O(N) leg
 * somebody adds. The audit's own headline failure is a trailing leg starved by
 * the legs in front of it, so reserving for the tail is the whole point.
 */
export const SWEEP_BUDGET_FRACTION = 0.6;

/**
 * Subrequests one tick spends that do NOT scale with the tenant slice AND do
 * not fan out over any other population: the D1 reads/writes each leg makes
 * once (tenant list, cursor, watchtower state, support/waitlist counts, the
 * sweep heartbeat), and the DO-storage / rate-limiter canary probes and vendor
 * checks.
 *
 * The audit MEASURED this at 29 on the real sweep. Rounded up to leave room for
 * the checks this wave adds rather than pinning the measurement itself, which
 * would red on every new probe.
 *
 * IT NO LONGER CLAIMS TO COVER THE SCREENING-RECOVERY LEG. It used to — the
 * docstring said "and the screening-recovery leg (bounded by the pending-review
 * queue, not by tenant count)" — while that leg was separately capped at 500
 * items costing two subrequests each. 1,000 subrequests, unmodelled, on top of a
 * 599-subrequest tick, against a budget of 1,000. B1 (docs/adversarial/
 * wave-b1-scale-monitoring-gate-2026-08-20.md): past the cap `runLeg` swallows
 * the budget-exhaustion throw and every leg after it dies silently — the cursor
 * commit, the retirement, the send pipeline, the signal report, and the
 * dead-man heartbeat. The dead-man then pages "cron STOPPED" about a cron that
 * is running, which is verbatim the failure this whole wave exists to remove.
 *
 * "Bounded by a population that is not the tenant count" is NOT the same as
 * "small". Any leg with its own fan-out gets its own term below and is summed
 * into `SWEEP_FIXED_SUBREQUESTS`; `sweep-budget.test.ts` asserts that sum is
 * closed, so the next such leg cannot be waved through in a docstring.
 */
export const SWEEP_FIXED_OVERHEAD_SUBREQUESTS = 60;

/**
 * Subrequests ONE screening-recovery item costs: the `rescreenIfListUnavailable`
 * DO RPC, plus — on `status === "clear"`, which that leg's own comment calls
 * "the common case" — the `resolveScreeningReview` D1 write.
 */
export const SCREENING_RECOVERY_SUBREQUESTS_PER_ITEM = 2;

/**
 * How many sentinel-held tenants ONE tick may re-screen.
 *
 * A DRAIN RATE, not a page. The population is transient by construction
 * (tenants screened fail-closed only because no SDN list had loaded yet), it
 * is self-draining (a re-screen either clears the row or re-versions it, and
 * either way the row leaves this leg's `LIST_UNAVAILABLE_VERSION`-narrowed
 * query), and the leg runs every 5 minutes — so a backlog of 500 drains in
 * ~100 minutes while costing this tick a bounded 50 subrequests.
 *
 * Chosen small ON PURPOSE: a recovery backlog is a rare event, and the tenant
 * slice this term is subtracted from is what every tick pays. Trading 5 tenants
 * off the permanent slice to drain a rare backlog twice as fast is the wrong
 * way round. `ofac/screening-recovery.ts` imports THIS constant rather than
 * declaring its own — the two living in different files, in different lanes,
 * is exactly how B1 happened.
 */
export const SCREENING_RECOVERY_BATCH = 25;

/** The screening-recovery leg's whole worst-case per-tick cost. */
export const SCREENING_RECOVERY_SUBREQUESTS = SCREENING_RECOVERY_BATCH * SCREENING_RECOVERY_SUBREQUESTS_PER_ITEM;

/**
 * Subrequests ONE stale-reserve reap costs: the status flip plus the ledger
 * UPDATE, and a THIRD for a `kind = 'mailbox'` entry (the account slot
 * counter). Three, because a budget takes the worst case.
 */
export const RESERVE_REAP_SUBREQUESTS_PER_ITEM = 3;

/**
 * How many orphaned reservations ONE tick may reclaim.
 *
 * NEW-1 (round 2 of docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md)
 * — B1's CLASS, still open one leg over. `reapStaleReservations` read
 * `WHERE status = 'reserved' AND created_at < ?` with no LIMIT and looped it
 * with no deadline, ahead of everything including the heartbeat. Executed by
 * the gate: `seeded=300 reaped=300 => ~901 Worker subrequests in ONE leg`,
 * against a 592-subrequest budgeted tick. Pre-existing — it predates this wave
 * — but this wave enlarged the standing population as a side effect, because
 * N7 raised `RESERVE_REAP_TTL_MS` 15 -> 45 min and orphans now linger 3x
 * longer, so the first tick after an outage window faces the whole set at once.
 *
 * A DRAIN RATE like the recovery batch, and the same size for one convention.
 * Draining slowly is safe in the direction that matters: a stranded reservation
 * OVER-restricts (it shrinks the effective ceiling), so the cost of taking an
 * hour to clear 300 of them is a slightly tighter bound meanwhile, never spend
 * that should have been refused. 25/tick at the 5-minute cadence clears 300 in
 * an hour.
 */
export const RESERVE_REAP_BATCH = 25;

/** The stale-reserve reaper's whole worst-case per-tick cost. */
export const RESERVE_REAP_SUBREQUESTS = RESERVE_REAP_BATCH * RESERVE_REAP_SUBREQUESTS_PER_ITEM;

/**
 * Everything one tick spends that the tenant slice does not: the fixed overhead
 * plus every leg that fans out over a population of its own.
 *
 * The slice derivation subtracts THIS. A leg with its own fan-out that is not
 * summed in here is a leg the slice arithmetic is silently wrong about, which is
 * the whole of B1.
 */
export const SWEEP_FIXED_SUBREQUESTS =
  SWEEP_FIXED_OVERHEAD_SUBREQUESTS + SCREENING_RECOVERY_SUBREQUESTS + RESERVE_REAP_SUBREQUESTS;

/**
 * DO RPCs ONE tenant costs across ALL legs in a single tick, worst case.
 *
 * The breakdown, and why it is the worst case rather than the typical one:
 *   deliverability          1  deliverabilitySweep
 *   dunning                 2  opsSummary + suspendForDunning (only past_due)
 *   digest                  1  opsSummary
 *   watchtower              2  opsSummary + maybeEmitContinuityNudge (stalled only)
 *   warmupCancel            1  warmupCancelSweep
 *   webhooks                1  runWebhookDeliveries
 *   provisioningReconcile   1  provisioningReconcileSweep (dark until armed)
 *   sendPipeline            2  runScheduledPoll + runScheduledTick
 *                          --
 *                          11
 *
 * `sweep-signal-coverage.test.ts` re-derives this from `scheduled.ts`'s own leg
 * bag: a leg added there without an entry in this accounting reds the suite,
 * because the last thing this file may do is under-count and hand the sweep a
 * slice it cannot afford.
 */
export const SWEEP_RPCS_PER_TENANT = 11;

/**
 * WHAT EACH CRON LEG COSTS, per leg, as an independent statement of the two
 * aggregates above.
 *
 * NEW-2 (round 2 of the wave-b1 gate) — the guard that was supposed to close
 * B1's class was a TAUTOLOGY. It asserted
 * `SWEEP_FIXED_SUBREQUESTS === OVERHEAD + SCREENING_RECOVERY_SUBREQUESTS`
 * while the source DEFINED `SWEEP_FIXED_SUBREQUESTS` as exactly that sum:
 * `A === A`, incapable of failing. The gate proved it by planting the precise
 * defect the guard's own comment claimed to catch — a new 300-item x
 * 3-subrequest fan-out leg declared in this file and not summed in — and the
 * suite stayed green, 13/13.
 *
 * A guard needs an ORACLE THAT IS NOT THE THING IT CHECKS. This table is that
 * oracle: it is written per leg, and `sweep-budget.test.ts` asserts (a) every
 * leg in `scheduled.ts`'s own leg bag appears here, (b) the `perTenant` column
 * sums to `SWEEP_RPCS_PER_TENANT`, and (c) the `ownFanout` column sums to the
 * non-overhead part of `SWEEP_FIXED_SUBREQUESTS`. Three different sources —
 * the scheduler, this table, and the derived constants — have to agree, so no
 * single edit can move all of them silently.
 *
 * `perTenant`: DO RPCs this leg spends per tenant in the slice, worst case.
 * `ownFanout`: subrequests this leg spends over a population that is NOT the
 * tenant slice. Non-zero here means the leg needs its own batch and its own
 * term — which is the whole of B1 and NEW-1.
 */
export const LEG_SUBREQUEST_COSTS: Record<string, { perTenant: number; ownFanout: number }> = {
  tenantSlice: { perTenant: 0, ownFanout: 0 }, // D1 reads only (counted in the overhead)
  deliverability: { perTenant: 1, ownFanout: 0 }, // deliverabilitySweep
  dunning: { perTenant: 2, ownFanout: 0 }, // opsSummary + suspendForDunning (past_due only)
  digest: { perTenant: 1, ownFanout: 0 }, // opsSummary
  watchtower: { perTenant: 2, ownFanout: 0 }, // opsSummary + maybeEmitContinuityNudge (stalled only)
  warmupCancel: { perTenant: 1, ownFanout: 0 }, // warmupCancelSweep
  webhooks: { perTenant: 1, ownFanout: 0 }, // runWebhookDeliveries
  spendReservations: { perTenant: 0, ownFanout: RESERVE_REAP_SUBREQUESTS }, // NEW-1 — orphaned reservations
  sdnRefresh: { perTenant: 0, ownFanout: 0 }, // one outbound fetch, once a day (overhead)
  sdnRecovery: { perTenant: 0, ownFanout: SCREENING_RECOVERY_SUBREQUESTS }, // B1 — sentinel-held reviews
  provisioningReconcile: { perTenant: 1, ownFanout: 0 }, // provisioningReconcileSweep (dark until armed)
  sweepCursor: { perTenant: 0, ownFanout: 0 }, // one D1 write (overhead)
  retireChecks: { perTenant: 0, ownFanout: 0 }, // one D1 DELETE (overhead)
  sendPipeline: { perTenant: 2, ownFanout: 0 }, // runScheduledPoll + runScheduledTick
};

/**
 * The same count for the legs that run BEFORE the send pipeline — the ones the
 * S6 wall-clock derivation below has to fit into its deadline (everything above
 * except `sendPipeline`'s pair).
 */
export const SWEEP_FANOUT_RPCS_PER_TENANT = SWEEP_RPCS_PER_TENANT - 2;

/**
 * MEASURED wall clock for one DO RPC round trip, caller-side, on the real
 * platform — the distribution the slice is now derived from.
 *
 * PROVENANCE. `wrangler tail agent-cold-email-api --format json` against prod
 * worker `133fc911` at 63 tenants, 2026-08-20: three consecutive cron ticks
 * captured whole, with the distribution below pooled over the first two. Each
 * sample is the interval between two consecutive starts of the SEQUENTIAL
 * per-tenant RPCs a fan-out leg issues, which is exactly the quantity the
 * fan-out deadline spends. Restricted to the fan-out legs' methods
 * (`deliverabilitySweep`, `opsSummary`, `warmupCancelSweep`,
 * `runWebhookDeliveries`), because those are the mix the deadline pays for.
 *
 * The third tick is the corroboration rather than a sample: on all three the
 * rotation cursor advanced by exactly one tenant (it landed on `ids[0]`,
 * `ids[1]`, `ids[2]` of the same slice), which is the behaviour these numbers
 * predict and the shipped constant did not.
 *
 * THE COST IS DISPATCH, NOT WORK, so it will not optimise away: the same tail
 * reports `cpuTime` at 1-3% of `wallTime` on every one of these methods. Each
 * tenant's DO is touched once per tick and evicted in between, so essentially
 * every RPC pays a cold hop.
 *
 * This exists as a SEPARATE constant from the assumption below so that
 * `sweep-budget.test.ts` has an oracle that is not derived from the thing it
 * checks — the defect it guards against is a plausible-looking constant that
 * nothing contradicts.
 */
export const MEASURED_DO_RPC_MS = {
  meanMs: 414,
  p50Ms: 350,
  p75Ms: 450,
  p90Ms: 531,
  samples: 77,
  capturedAt: "2026-08-20",
} as const;

/**
 * The per-RPC round trip the slice is SIZED against: the measured p75.
 *
 * WAS 25 — an in-process miniflare floor, correctly labelled an assumption and
 * then never re-measured. It was low by ~17x, and the consequences were not the
 * graceful ones the old docstring promised. At 63 tenants it sized the slice at
 * 37 while the 15s deadline afforded 3, so leg 1 (`deliverabilitySweep`, one
 * RPC per tenant) consumed the ENTIRE deadline by itself and every trailing leg
 * ran exactly one tenant and deferred 36. Because `commitSweepCursor` advances
 * by the LEAST-covered leg — correctly, or coverage would go probabilistic —
 * the rotation moved ONE tenant per tick: a full pass took 63 ticks (~5.25h)
 * while `sweep_coverage` told the founder it took 2 (~10 min), inside the very
 * alert whose subject is degraded detection latency.
 *
 * WHY p75 AND NOT THE MEAN. The fan-out phase is a SUM of
 * `SWEEP_FANOUT_RPCS_PER_TENANT x slice` sequential draws, so sizing at the
 * mean puts the expected cost exactly ON the deadline — the last leg then clips
 * on roughly half of all ticks, `leastVisited` drops below the slice, and the
 * published coverage figure is optimistic again by exactly the mechanism this
 * re-calibration exists to remove. At p75 the expected cost is ~11.2s of the
 * 15s deadline, so the slice completes on a typical tick and the number the
 * check publishes is the number the rotation achieves.
 *
 * The deadline still makes being wrong DEGRADE rather than break — but "it
 * degrades gracefully" was used to justify never checking the number, and a
 * graceful degradation that misreports itself is not one.
 *
 * WHAT THE SMALLER SLICE DID TO SEND CADENCE IS AN EQUALISATION, NOT A WIN, and
 * it is CONDITIONAL. Simulated over the verbatim rotation arithmetic (gate
 * 2026-08-20, finding 1): mean wait 12.02 -> 10.00 ticks and worst case 31.0 ->
 * 10.0, but 36 of 63 tenants get SLOWER — the median tenant pays 39 -> 50 min to
 * retire a 155-min starvation tail. And if latency ever degrades far enough to
 * clip the fan-out back to one tenant, the new regime's mean wait (29.09) is
 * WORSE than the old one's (12.02). The whole improvement rests on the slice
 * COMPLETING, which is what this constant buys and what `sweep_coverage` now
 * measures. Full table in `admin/README.md`.
 */
export const ASSUMED_DO_RPC_MS = MEASURED_DO_RPC_MS.p75Ms;

/**
 * The wall-clock ceiling for the whole pre-send-pipeline fan-out.
 *
 * DERIVED, not chosen: it is exactly what the 300s cron period has left after
 * the send pipeline's own two published bounds. That is the S6 invariant made
 * true rather than asserted — the old comment stated 285s < 300s and then
 * silently assumed the six legs above the pipeline were free.
 *
 * If someone raises `SEND_PIPELINE_LEG_DEADLINE_MS` or
 * `SEND_PIPELINE_TENANT_BUDGET_MS` past the period, this goes non-positive and
 * `sweep-budget.test.ts` reds — which is the point of deriving it.
 */
export const SWEEP_FANOUT_DEADLINE_MS = CRON_PERIOD_MS - SEND_PIPELINE_LEG_DEADLINE_MS - SEND_PIPELINE_TENANT_BUDGET_MS;

/**
 * How many tenants one tick may touch, taking the SMALLER of the two
 * independent ceilings — subrequests and wall clock. Both are real and they bind
 * at different tenant counts, so taking either one alone leaves the other free
 * to break the tick.
 */
export const SWEEP_TENANT_SLICE = Math.max(
  1,
  Math.min(
    Math.floor((SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION - SWEEP_FIXED_SUBREQUESTS) / SWEEP_RPCS_PER_TENANT),
    Math.floor(SWEEP_FANOUT_DEADLINE_MS / (ASSUMED_DO_RPC_MS * SWEEP_FANOUT_RPCS_PER_TENANT)),
  ),
);

/** What one tick actually costs at a full slice — the number the invariant is about. */
export const SWEEP_TICK_SUBREQUESTS = SWEEP_RPCS_PER_TENANT * SWEEP_TENANT_SLICE + SWEEP_FIXED_SUBREQUESTS;

/**
 * How many ticks a full rotation takes at a given tenant count — the number
 * that turns "the sweep is bounded" into a claim an operator can check. A
 * bounded sweep trades per-tick cost for COVERAGE LATENCY, and a bound whose
 * latency nobody publishes is the same blind spot in the other direction.
 */
export function coverageTicks(tenantTotal: number, slice: number): number {
  if (tenantTotal <= 0 || slice <= 0) return 0;
  return Math.ceil(tenantTotal / slice);
}
