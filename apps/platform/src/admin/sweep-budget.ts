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
 * VERIFIED 2026-08-24 against the vendor's own limits page, and the previous
 * value was WRONG BY 10x IN THE WRONG DIRECTION OF CONFIDENCE — it was labelled
 * "UNVERIFIED IN PRODUCTION" and left at 1000, which is not a conservative
 * reading of the Paid limit, it is the FREE plan's row:
 *
 *   developers.cloudflare.com/workers/platform/limits/ ("Subrequests", last
 *   updated 2026-07-28) — "Subrequests per invocation: Free 50 / Paid 10,000
 *   (up to 10M)"; "Subrequests to internal services: Free 1,000 / Paid Matches
 *   configured limit (default 10,000)". A DO stub RPC is an internal-service
 *   subrequest, so the applicable Paid figure is 10,000.
 *
 * WHAT IS STILL UNVERIFIED, kept explicit rather than quietly resolved: whether
 * a DO stub RPC counts toward the SIX simultaneous-open-connections ceiling.
 * The docs enumerate the calls that do (fetch, KV, Cache, R2, Queues, TCP
 * connect, outbound WebSocket) and DO stubs and D1 are absent from that list,
 * but absence is not an exemption. It does not endanger this arithmetic: the
 * documented behaviour past six is QUEUEING, not an error, so an over-set
 * concurrency saturates rather than throwing — see SWEEP_FANOUT_CONCURRENCY.
 *
 * NEITHER CEILING IS ENFORCEABLE LOCALLY, so no local experiment can bound
 * them: workerd's `LimitEnforcer::newSubrequest` is `override {}` (a no-op) in
 * `src/workerd/server/server.c++`, and `LimitEnforcer` declares no
 * connection-concurrency hook at all.
 *
 * Full provenance: docs/research/sweep-capacity-measurement-2026-08-24.md §2.
 */
export const SWEEP_SUBREQUEST_BUDGET = 10_000;

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

/** DO RPCs one tenant costs the send pipeline: `runScheduledPoll` + `runScheduledTick`. */
export const SEND_PIPELINE_RPCS_PER_TENANT = 2;

/**
 * How many tenants ONE tick's send pipeline may reach.
 *
 * DERIVED FROM ITS OWN LEG DEADLINE, not chosen: at the measured per-RPC round
 * trip, this is simply how many poll+tick pairs fit in
 * `SEND_PIPELINE_LEG_DEADLINE_MS`. The leg was already bounded in WALL CLOCK and
 * carries its own rotation, so a tenant it does not reach is reached next cycle;
 * what it lacked was a bound in COUNT, and B1's whole lesson is that a leg with
 * its own fan-out and no declared count is spend the arithmetic cannot see.
 *
 * WHY THE LEG NEEDS ITS OWN TERM AT ALL AS OF 2026-08-24: it used to be handed
 * the cron's tenant SLICE, so its cost was `2 x slice` and it was priced inside
 * `SWEEP_RPCS_PER_TENANT`. That was wrong in a way that cost customers send
 * cadence rather than budget — the fan-out deadline is DERIVED as what is left
 * of the period AFTER this leg's two bounds, so bounding it by the slice as well
 * deducted the same constraint twice and capped automatic sending at whatever
 * the HEALTH legs could afford. Off the slice it reaches every tenant its own
 * deadline allows, which is what those bounds were sized for.
 */
export const SEND_PIPELINE_TENANT_CAP = Math.floor(SEND_PIPELINE_LEG_DEADLINE_MS / (ASSUMED_DO_RPC_MS * SEND_PIPELINE_RPCS_PER_TENANT));

/** The send pipeline's whole worst-case per-tick cost, now that it fans out over
 * a population of its own rather than over the slice. */
export const SEND_PIPELINE_SUBREQUESTS = SEND_PIPELINE_TENANT_CAP * SEND_PIPELINE_RPCS_PER_TENANT;

/**
 * DO RPCs ONE tenant costs across ALL legs in a single tick, worst case.
 *
 * The breakdown, and why it is the worst case rather than the typical one:
 *   deliverability          1  deliverabilitySweep
 *   opsSummary              1  opsSummaryForSweep — SHARED by the next three
 *   dunning                 1  suspendForDunning (only past_due)
 *   digest                  0  reads the shared summary
 *   watchtower              1  maybeEmitContinuityNudge (stalled only)
 *   warmupCancel            1  warmupCancelSweep
 *   webhooks                1  runWebhookDeliveries
 *   provisioningReconcile   1  provisioningReconcileSweep (dark until armed)
 *                          --
 *                           7
 *
 * THE SEND PIPELINE IS NOT IN THIS TABLE ANY MORE. It was 2 of the 11, priced
 * per SLICE tenant, because the cron handed it the slice. It now fans out over
 * its own population under its own deadline and rotation, so it has an
 * `ownFanout` term (`SEND_PIPELINE_SUBREQUESTS`) instead — see that constant for
 * why bounding it by the slice was double-counting the same constraint.
 *
 * WAS 11. Dunning, digest and the watchtower each made their own `opsSummary`
 * RPC — three round trips to the same object, in the same tick, for the same
 * tenant. One shared prefetch leg (`runOpsSummaryPrefetch`) replaces them, and
 * because the slice is derived from the WORST case it had to be a deterministic
 * PREFETCH rather than a lazy cache: a cache that can miss leaves the worst case
 * where it was, so the slice could not have moved.
 *
 * `sweep-signal-coverage.test.ts` re-derives this from `scheduled.ts`'s own leg
 * bag: a leg added there without an entry in this accounting reds the suite,
 * because the last thing this file may do is under-count and hand the sweep a
 * slice it cannot afford.
 */
export const SWEEP_RPCS_PER_TENANT = 7;

/**
 * How many PAYING tenants one tick may sweep ahead of the rotation.
 *
 * Paying tenants are swept EVERY tick; everyone else waits their turn in the
 * keyset rotation. The founder ruling this implements is "paying-tenant-first",
 * and the shape it takes is a bounded PREPEND rather than a re-ordering of the
 * slice — see `SweepFanout.priorityCount` for why re-ordering is not available:
 * the rotation cursor is a keyset over `id`, so a slice sorted by plan makes
 * `slice.ids[covered - 1]` point at the wrong tenant.
 *
 * IT REALLOCATES THE TICK, IT DOES NOT ENLARGE IT. `sweepTenantSliceFor` takes
 * the ACTUAL priority count and shortens the rotating slice by exactly that
 * many, so the tick touches the same number of tenants either way and the
 * fan-out deadline is unaffected. What changes is WHICH tenants: at 66 tenants
 * with one paying, that tenant is swept every 5 minutes instead of every 4
 * ticks, and the other 65 rotate through a slice of 18 instead of 19.
 *
 * A CAP, because the reallocation stops being free once the paying population
 * approaches the slice: at that point every tick would be priority work and the
 * rotation would stall. The cap is what makes that a bounded degradation with a
 * declared subrequest term rather than a silent one. Small on purpose — it is
 * sized for the paying population this platform actually has, and raising it
 * costs the rotation one tenant per unit.
 */
export const PAYING_TENANT_PRIORITY_CAP = 5;

/**
 * Everything one tick spends that the tenant slice does not: the fixed overhead
 * plus every leg that fans out over a population of its own.
 *
 * The slice derivation subtracts THIS. A leg with its own fan-out that is not
 * summed in here is a leg the slice arithmetic is silently wrong about, which is
 * the whole of B1.
 */
export const SWEEP_FIXED_SUBREQUESTS =
  SWEEP_FIXED_OVERHEAD_SUBREQUESTS + SCREENING_RECOVERY_SUBREQUESTS + RESERVE_REAP_SUBREQUESTS + SEND_PIPELINE_SUBREQUESTS;


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
export const LEG_SUBREQUEST_COSTS: Record<string, { perTenant: number; ownFanout: number; sharedSummary?: true }> = {
  tenantSlice: { perTenant: 0, ownFanout: 0 }, // D1 reads only (counted in the overhead)
  tenantPriority: { perTenant: 0, ownFanout: 0 }, // one bounded D1 read (overhead); its tenants are priced in SWEEP_TENANTS_TOUCHED_PER_TICK
  deliverability: { perTenant: 1, ownFanout: 0 }, // deliverabilitySweep
  opsSummary: { perTenant: 1, ownFanout: 0 }, // opsSummaryForSweep — the ONE fetch the three legs below share
  dunning: { perTenant: 1, ownFanout: 0, sharedSummary: true }, // suspendForDunning (past_due only)
  digest: { perTenant: 0, ownFanout: 0, sharedSummary: true }, // reads the shared summary and nothing else
  watchtower: { perTenant: 1, ownFanout: 0, sharedSummary: true }, // maybeEmitContinuityNudge (stalled only)
  warmupCancel: { perTenant: 1, ownFanout: 0 }, // warmupCancelSweep
  webhooks: { perTenant: 1, ownFanout: 0 }, // runWebhookDeliveries
  spendReservations: { perTenant: 0, ownFanout: RESERVE_REAP_SUBREQUESTS }, // NEW-1 — orphaned reservations
  sdnRefresh: { perTenant: 0, ownFanout: 0 }, // one outbound fetch, once a day (overhead)
  sdnRecovery: { perTenant: 0, ownFanout: SCREENING_RECOVERY_SUBREQUESTS }, // B1 — sentinel-held reviews
  provisioningReconcile: { perTenant: 1, ownFanout: 0 }, // provisioningReconcileSweep (dark until armed)
  sweepCursor: { perTenant: 0, ownFanout: 0 }, // one D1 write (overhead)
  retireChecks: { perTenant: 0, ownFanout: 0 }, // one D1 DELETE (overhead)
  sendPipeline: { perTenant: 0, ownFanout: SEND_PIPELINE_SUBREQUESTS }, // OFF the slice — its own deadline + rotation + cap
};

/**
 * The same count for the legs that run BEFORE the send pipeline — the ones the
 * S6 wall-clock derivation below has to fit into its deadline.
 *
 * EQUAL to `SWEEP_RPCS_PER_TENANT` since 2026-08-24, because the send pipeline
 * was the only per-tenant cost that was NOT part of the fan-out phase and it has
 * moved off the slice entirely. Kept as a separate name rather than collapsed:
 * the two quantities mean different things (what a slice tenant costs the TICK
 * vs what it costs the DEADLINE) and they diverge again the moment another
 * post-deadline per-tenant leg is added. `sweep-budget.test.ts` pins the
 * relationship to the cost table so it cannot drift silently.
 */
export const SWEEP_FANOUT_RPCS_PER_TENANT = SWEEP_RPCS_PER_TENANT;


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
 * How many DO RPCs the tenant fan-out may have in flight at once.
 *
 * SIX, WHICH IS THE DOCUMENTED CEILING ITSELF, and that is the whole reason for
 * the number. Cloudflare documents six simultaneous open connections per
 * invocation; it does NOT document whether a DO stub RPC is one of them (the
 * enumerated list omits DO stubs and D1 — see SWEEP_SUBREQUEST_BUDGET). Bounding
 * at exactly six makes the design independent of that unanswered question: it
 * cannot be clamped by a ceiling it never reaches.
 *
 * Going higher is measurably better (a slice of 22 at C=8, 32 at C=12) and is
 * NOT taken, because it would rest on the unanswered half. If it is ever taken,
 * the failure mode is benign and honest rather than broken: past six the
 * documented behaviour is QUEUEING, so the tick would simply clip, and
 * `sweep_coverage` already grades on the ACHIEVED advance (`covered < handed`)
 * and would report the shortfall truthfully.
 *
 * `SWEEP_FANOUT_CONCURRENCY_MAX` is a clamp on the env override, not a target:
 * beyond ~12 the measured return is flat and the unanswered question dominates.
 *
 * Measurement: docs/research/sweep-capacity-measurement-2026-08-24.md §4,
 * harness in test/sweepcap-experiment/.
 */
export const SWEEP_FANOUT_CONCURRENCY = 6;
export const SWEEP_FANOUT_CONCURRENCY_MAX = 12;

/**
 * How much of LINEAR speedup C overlapping round trips actually buy: 0.70.
 *
 * NOT A SAFETY MARGIN — a MEASURED SHORTFALL, and sizing without it is the
 * defect this constant exists to prevent. A leg is paced by its STRAGGLERS, not
 * by its p75, so the naive `deadline x C` overstates the sustainable slice by
 * 25-30% at every C >= 4. Measured maxima (>=95% of ticks covering the whole
 * slice, 400 trials/cell against the fitted production latency distribution)
 * versus that naive figure:
 *
 *   C     2     3     4     6     8    12
 *   real  6     9    12    17    22    32
 *   naive 7    11    14    22    29    44
 *
 * `1 + (C - 1) x 0.70` reproduces or conservatively under-shoots every one of
 * those points — and it DEGENERATES TO 1 AT C = 1, so the whole concurrency
 * change is a provable no-op with the fan-out serialised. That is the property
 * `sweep-budget.test.ts` pins, and it is what makes the env knob a safe
 * rollback rather than a second code path nobody has exercised.
 */
export const SWEEP_CONCURRENCY_EFFICIENCY = 0.7;

export function effectiveConcurrency(concurrency: number): number {
  return 1 + (Math.max(1, concurrency) - 1) * SWEEP_CONCURRENCY_EFFICIENCY;
}

/**
 * How much of the fan-out deadline the EXPECTED (mean-latency) cost may occupy.
 *
 * Was an assertion in `sweep-budget.test.ts` and nowhere in the derivation,
 * which held only by rounding luck at the serial slice: the p75-derived slice
 * costs `mean/p75 = 0.92` of the deadline in expectation, and `floor()` happened
 * to pull the shipped 3 down to 0.75. At any larger slice that luck runs out.
 * A slice whose EXPECTED cost merely touches the deadline clips its last leg on
 * about half of all ticks — which puts the published coverage figure back into
 * the optimistic-by-default state the 2026-08-20 calibration removed.
 *
 * Now a ceiling in its own right, so the property is derived rather than hoped
 * for. See `sweep-budget.test.ts` for what replaced the assertion it subsumes.
 */
export const SWEEP_MEAN_COMPLETION_FRACTION = 0.85;

/**
 * How many tenants one tick may touch at a given fan-out concurrency, taking
 * the SMALLEST of THREE independent ceilings. Each is real and they bind under
 * different conditions, so taking any one alone leaves the others free to break
 * the tick.
 *
 *  1. SUBREQUESTS — what the invocation may spend at all.
 *  2. WALL CLOCK AT p75 — a typical-tick bound: the slice has to fit the
 *     deadline at the latency the slice is sized against.
 *  3. WALL CLOCK AT THE MEAN, x SWEEP_MEAN_COMPLETION_FRACTION — a COMPLETION
 *     bound. (2) says the slice can fit; (3) says it reliably does.
 *
 * At C = 1 this returns exactly 3, the value shipped since the 2026-08-20
 * calibration — the derivation reproduces the serial configuration rather than
 * replacing it.
 */
export function sweepTenantSliceFor(concurrency: number, priorityCount: number = 0): number {
  const effective = effectiveConcurrency(concurrency);
  // The priority prepend is swept inside the SAME fan-out deadline, so it comes
  // out of the same wall clock. Subtracting it here — from the ACTUAL count, not
  // from the cap — is what makes "paying-tenant-first" a reallocation of the
  // tick rather than an unaccounted addition to it. Subtracting the cap instead
  // would permanently reserve slots for paying tenants that do not exist.
  const priority = Math.max(0, Math.min(priorityCount, PAYING_TENANT_PRIORITY_CAP));
  return Math.max(
    1,
    Math.min(
      Math.floor((SWEEP_SUBREQUEST_BUDGET * SWEEP_BUDGET_FRACTION - SWEEP_FIXED_SUBREQUESTS) / SWEEP_RPCS_PER_TENANT),
      Math.floor((SWEEP_FANOUT_DEADLINE_MS * effective) / (ASSUMED_DO_RPC_MS * SWEEP_FANOUT_RPCS_PER_TENANT)) - priority,
      Math.floor(
        (SWEEP_FANOUT_DEADLINE_MS * SWEEP_MEAN_COMPLETION_FRACTION * effective) /
          (MEASURED_DO_RPC_MS.meanMs * SWEEP_FANOUT_RPCS_PER_TENANT),
      ) - priority,
    ),
  );
}

/**
 * The fan-out concurrency this deployment runs at: the env override if it is a
 * sane integer, else the shipped default.
 *
 * A ROLLBACK LEVER FIRST AND A TUNING KNOB SECOND. Setting it to 1 restores the
 * pre-concurrency behaviour EXACTLY — same slice (3), same serial loop
 * (`sweepSerially` is the old code verbatim) — with no deploy, which is the
 * property that makes arming this safe. Structurally typed on `env` rather than
 * importing `Env`, so this module stays dependency-free and testable as pure
 * arithmetic.
 *
 * Clamped rather than trusted: a typo'd binding must degrade to the default, not
 * to 0 (which would stall the fan-out) or to 500 (which would queue at the
 * platform's connection ceiling and clip every tick).
 */
export function sweepFanoutConcurrency(env: { SWEEP_FANOUT_CONCURRENCY?: string }): number {
  const raw = env.SWEEP_FANOUT_CONCURRENCY;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) return SWEEP_FANOUT_CONCURRENCY;
  return Math.min(n, SWEEP_FANOUT_CONCURRENCY_MAX);
}

/**
 * The slice at the SHIPPED concurrency — the documented constant, and the
 * default `readTenantSlice` uses. The cron re-derives it from the env-resolved
 * concurrency (`scheduled.ts`), so an override moves the slice with it; this
 * constant is what every guard and every test reasons about.
 */
export const SWEEP_TENANT_SLICE = sweepTenantSliceFor(SWEEP_FANOUT_CONCURRENCY);

/**
 * How many tenants one tick's fan-out touches, worst case, INCLUDING the paying
 * tenants swept ahead of the rotation.
 *
 * USUALLY JUST THE SLICE, because the priority pass REALLOCATES rather than
 * adds: `sweepTenantSliceFor` shortens the rotating slice by exactly the actual
 * priority count, so `slice + priority` is the un-prioritised slice again.
 * Pricing the priority pass as its own additive `ownFanout` term — the first
 * shape this took — DOUBLE-COUNTS it, and `sweep-budget.test.ts`'s independent
 * restatement of the worst-case tick is what caught that.
 *
 * The one case where it does NOT net out is the floor: `sweepTenantSliceFor`
 * clamps the rotating slice at 1, so a concurrency low enough for the priority
 * cap to exceed the whole slice touches `1 + cap` tenants instead. That is the
 * max below — bounded, and it only binds at concurrencies this deployment does
 * not run.
 */
export const SWEEP_TENANTS_TOUCHED_PER_TICK = Math.max(SWEEP_TENANT_SLICE, 1 + PAYING_TENANT_PRIORITY_CAP);

/** What one tick actually costs at a full slice — the number the invariant is about. */
export const SWEEP_TICK_SUBREQUESTS = SWEEP_RPCS_PER_TENANT * SWEEP_TENANTS_TOUCHED_PER_TICK + SWEEP_FIXED_SUBREQUESTS;

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
