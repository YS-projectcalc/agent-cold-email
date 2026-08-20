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
 * Everything one tick spends that the tenant slice does not: the fixed overhead
 * plus every leg that fans out over a population of its own.
 *
 * The slice derivation subtracts THIS. A leg with its own fan-out that is not
 * summed in here is a leg the slice arithmetic is silently wrong about, which is
 * the whole of B1.
 */
export const SWEEP_FIXED_SUBREQUESTS = SWEEP_FIXED_OVERHEAD_SUBREQUESTS + SCREENING_RECOVERY_SUBREQUESTS;

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
 * The same count for the legs that run BEFORE the send pipeline — the ones the
 * S6 wall-clock derivation below has to fit into its deadline (everything above
 * except `sendPipeline`'s pair).
 */
export const SWEEP_FANOUT_RPCS_PER_TENANT = SWEEP_RPCS_PER_TENANT - 2;

/**
 * Assumed wall clock for one DO RPC round trip.
 *
 * EXPLICITLY AN ASSUMPTION (scale audit UNVERIFIABLE 3: every wall-clock number
 * in that audit is in-process miniflare, a floor rather than a forecast). The
 * fan-out deadline is what makes being WRONG about this number degrade into a
 * deferral — the cursor simply does not advance as far this tick — instead of
 * into a sweep that overruns its own cron period.
 */
export const ASSUMED_DO_RPC_MS = 25;

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
