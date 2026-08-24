// D2 (brief) — the Cron Trigger entry point. Runs the SAME sweep logic the
// on-demand admin routes call (admin/ops-sweep.ts) so a scheduled run and a
// manual `curl -X POST /admin/ops/dunning-sweep` can never diverge. The
// `crons = [...]` trigger is ARMED and LIVE in wrangler.toml (every 5 min,
// index.ts's `scheduled()` export wires it to this function) — this is NOT a
// dormant/inert export.
//
// What runs each tick, in order: (1) the deliverability control loop for every
// tenant, (2) the dunning sweep for every 'past_due' tenant (emailing a suspend
// notice via the OpsMailer), (3) the owner digest, logged, (4) the watchtower —
// health probes + the founder-alert state machine, (5) the warmup-pool
// auto-cancel sweep for every tenant (founder ruling 2026-08-02 — this cron is
// its ONLY production driver), (6) outbound webhook delivery, (7) the
// spend-reservation reaper, (8/9) the OFAC list refresh + recovery, and (10)
// the WAVE-2 SEND PIPELINE — poll then tick for every tenant whose DO-side
// activation predicate allows it. That last leg is what makes real campaign
// sends fire in production; everything before it is health/billing/ops work
// that must not be delayed by a slow engine, which is why it is last.
//
// ORDERING RULE: health + alerting legs precede vendor-call-heavy lanes, so a
// stalled vendor can never delay the founder learning the platform is
// unhealthy. The OpsMailer is built ONCE and shared by the dunning sweep +
// watchtower; it is real in production (dark until the domain is onboarded) and
// degrades gracefully — an unsendable alert can never take down the sweep.
import { RealClock } from "./clock.js";
import type { Env } from "./env.js";
import { buildOpsDigest, DIGEST_WINDOW_HOURS, runDeliverabilitySweepAllTenants, runDunningSweep, runOpsSummaryPrefetch, runProvisioningReconcileAllTenants, runSendPipelineAllTenants, runWarmupCancelSweepAllTenants, runWebhookDeliveriesAllTenants } from "./admin/ops-sweep.js";
import { retireHealthyCheckRows, runWatchtower } from "./admin/watchtower.js";
import { FAILURE_SIGNAL_WINDOW_MS } from "./admin/watchtower-grading.js";
import { reportMirrorDeliveryHealth, reportSweepSignals, reportSweepSignalsHealth } from "./admin/sweep-signals.js";
import { recordSweepHeartbeat } from "./admin/watchtower-infra.js";
import { priorityWindowSize, SWEEP_FANOUT_DEADLINE_MS, sweepFanoutConcurrency, sweepTenantSliceFor } from "./admin/sweep-budget.js";
import { commitSweepCursor, newSweepFanout, readPriorityTenantIds, readTenantSlice, type SweepScope } from "./admin/tenant-slice.js";
import { createOpsMailer, type OpsMailer } from "./ops-mail/ops-mailer.js";
import { reapStaleReservations } from "./engine/spend-ceiling.js";
import { maybeRefreshSdnList } from "./ofac/sdn-refresh.js";
import { rescreenListUnavailableReviews } from "./ofac/screening-recovery.js";

/**
 * F1 (audit 2026-08-05): each leg below is a SEPARATE concern (dunning,
 * health, spend accounting, OFAC, ...) that must never be able to take the
 * others down for the tick. Most legs already isolate per-tenant failures
 * internally, but a leg-level throw (e.g. a D1 outage on the very first
 * `listAllTenantIds` read, before any per-tenant try/catch even starts, or
 * `buildOpsDigest`'s own unguarded per-tenant `Promise.all` — a reported
 * sibling, not fixed here) still used to propagate straight out of this
 * function and skip every leg after it. Runs `fn`, and on a throw logs +
 * returns `fallback` instead of letting it escape.
 */
async function runLeg<T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`scheduled ops sweep: "${name}" leg failed — other legs still ran this tick`, err);
    return fallback;
  }
}

/**
 * `mailer` is injectable for the SAME reason `runDunningSweep` and
 * `runWatchtower` take one: it is how a test asserts what the sweep actually
 * emailed rather than that its code looks right. Production passes nothing and
 * gets the real (or dark) channel.
 *
 * `sliceLimit` is the same seam for the SCALE property (S1): the claim is that
 * one tick's DO-RPC cost stops growing with the tenant count, and asserting it
 * at the shipped slice would mean seeding a hundred Durable Objects per
 * assertion. Shrinking the slice tests the same arithmetic at a size a test can
 * afford — exactly what `tenantBudgetMs` / `legDeadlineMs` already do for the
 * send pipeline's wall-clock bounds. Production passes nothing.
 */
export async function runScheduledOpsSweep(env: Env, opts: { mailer?: OpsMailer; sliceLimit?: number } = {}): Promise<void> {
  const now = new RealClock().now();
  const mailer = opts.mailer ?? createOpsMailer(env);

  // SCALE AUDIT S1/S6 — the ONE bounded tenant window every per-tenant leg
  // below shares this tick, and the wall-clock ceiling they all check between
  // tenants. Reading it can fail (D1), and a failed read must not take the
  // tick down: an empty slice means the fan-out legs no-op and the watchtower's
  // own `d1` check reports the outage, which is the correct division of labour.
  //
  // THE SLICE IS A FUNCTION OF THE FAN-OUT CONCURRENCY, so the two can never
  // disagree: `sweepTenantSliceFor` derives how many tenants that many
  // in-flight round trips can finish inside the deadline. Reading the env knob
  // here rather than at module scope is what makes `SWEEP_FANOUT_CONCURRENCY=1`
  // a live rollback to the pre-concurrency slice of 3.
  const concurrency = sweepFanoutConcurrency(env);

  // PAYING TENANTS ARE SWEPT EVERY TICK, ahead of the rotation. Read before the
  // slice because the slice is SHORTENED by exactly this many — the priority
  // pass shares the fan-out deadline, so it reallocates the tick rather than
  // enlarging it (admin/sweep-budget.ts's PAYING_TENANT_PRIORITY_CAP).
  const priorityAll = await runLeg("tenantPriority", [] as string[], () => readPriorityTenantIds(env, priorityWindowSize(concurrency), now));
  const slice = await runLeg("tenantSlice", null, () =>
    readTenantSlice(env, opts.sliceLimit ?? sweepTenantSliceFor(concurrency, priorityAll.length)),
  );
  // THE FILTER HAPPENS ONCE, HERE, because `fanout.priorityCount` is the offset
  // the rotation accumulator subtracts and it has to be EXACT. A paying tenant
  // that already sits on this tick's keyset page is swept by the page; prepending
  // it as well would sweep it twice and, worse, make the prepend length differ
  // from the count the cursor arithmetic was told about.
  const priorityIds = priorityAll.filter((id) => !(slice?.ids ?? []).includes(id));
  const fanout = newSweepFanout(new RealClock().now(), SWEEP_FANOUT_DEADLINE_MS, concurrency, priorityIds.length);
  const scope: SweepScope = { tenantIds: slice?.ids ?? [], priorityTenantIds: priorityIds, fanout };

  const deliverability = await runLeg("deliverability", null, () => runDeliverabilitySweepAllTenants(env, scope));

  // THE SHARED OPS-SUMMARY PREFETCH — one DO RPC per tenant, feeding the three
  // legs below that each used to make their own. It runs FIRST of the three so
  // its coverage is a superset of theirs, and both windows are computed in the
  // one call because the three consumers ask about three different spans and
  // the windowed fields are pre-aggregated counts nobody can re-window
  // (admin/tenant-slice.ts's `sweptSummary` asserts each consumer got its own).
  const summaryWindows = { actionsSinceMs: now - DIGEST_WINDOW_HOURS * 60 * 60 * 1000, failureSignalsSinceMs: now - FAILURE_SIGNAL_WINDOW_MS };
  const opsSummary = await runLeg("opsSummary", null, () => runOpsSummaryPrefetch(env, summaryWindows, scope));
  // NAMED TO KEEP `scopedLegNames()` HONEST. sweep-signal-coverage.test.ts finds
  // the slice-bounded legs by grepping each `runLeg(...)` call for the substring
  // "scope"; a variable called `sharedScope` does not contain it (capital S), so
  // dunning/digest/watchtower would have silently dropped out of that guard —
  // the guard would still pass, on three fewer legs.
  const scopeWithSummaries: SweepScope = { ...scope, summaries: opsSummary?.summaries, summaryFailures: opsSummary?.failures };

  const dunning = await runLeg("dunning", null, () => runDunningSweep(env, now, mailer, scopeWithSummaries));
  const digest = await runLeg("digest", null, () => buildOpsDigest(env, now, DIGEST_WINDOW_HOURS, scopeWithSummaries));
  const watchtower = await runLeg("watchtower", null, () => runWatchtower(env, mailer, now, scopeWithSummaries));
  // Warmup-pool auto-cancel at ramp completion (founder ruling 2026-08-02,
  // ROADMAP.md:25). BELOW runWatchtower per this file's own ordering rule —
  // the health/alerting legs come first so a slow vendor lane can never delay
  // the founder learning the platform is unhealthy (warmup-wave round-2
  // residual R2, landed here with the wave-2 send-pipeline edit as the design's
  // §8/NEW-3 requires, since both edits touch this one file).
  //
  // Its own lane rather than part of the tick: the tick now DOES run from this
  // cron (below), but the warmup sweep must keep running for every tenant,
  // including the ones the send-pipeline's activation predicate skips.
  const warmupCancel = await runLeg("warmupCancel", null, () => runWarmupCancelSweepAllTenants(env, scope));
  // Outbound webhook delivery pump — the cron is the retry-queue wake
  // (ROADMAP.md WIN-THE-COMPARISON (d)). Last so a webhook fan-out failure
  // can't delay the health/dunning/watchtower legs above.
  const webhooks = await runLeg("webhooks", null, () => runWebhookDeliveriesAllTenants(env, scope));
  // GA gate G2 (design NB-2) — reclaim vendor-spend reservations orphaned by a
  // crash between reserve and commit/release, so leaked reservations can't
  // silently shrink the effective ceiling. Its own concern (D1 account
  // ledger), so it can't delay the health/dunning/watchtower legs.
  const spendReservations = await runLeg("spendReservations", null, () => reapStaleReservations(env, now, scope));
  // G1a — once-daily SDN (OFAC) list refresh, piggybacked on this same 5-min
  // cron (design ga-gates-design-2026-07-22.md §G1a line 49) rather than a
  // second `[triggers] crons` entry. Self-contained: its own internal guard
  // no-ops on every tick but one per day, and it never throws (fail-loud means
  // "alert + keep the prior list", not "abort this sweep" — see sdn-refresh.ts).
  const sdnRefresh = await runLeg("sdnRefresh", null, () => maybeRefreshSdnList(env, now, fetch, mailer));
  // N-OF-1 fix (adversary OFAC build review, 2026-07-23) — recovers any
  // tenant fail-closed to 'review' ONLY because no list had loaded yet at
  // screening time, now that a refresh above may have just loaded one. Cheap
  // no-op whenever no list is available or nothing is stuck.
  const sdnRecovery = await runLeg("sdnRecovery", null, () => rescreenListUnavailableReviews(env, scope));
  // C3 part d — the out-of-band provisioning reconcile: finish every tenant's
  // dns_status 'pending' setup domain so a benign propagation wait completes
  // without an agent retry. DARK unless PROVISIONING_RECONCILE_ENABLED is armed
  // (checked once inside), so a cheap no-op in the shipped default. Its own leg,
  // BELOW the health/alerting lanes per this file's ordering rule (once armed it
  // makes vendor calls / mailbox spend, so a stall here must never delay the
  // founder learning the platform is unhealthy) and ABOVE the send pipeline
  // (that one carries the wall-clock budget and must run last).
  const provisioningReconcile = await runLeg("provisioningReconcile", null, () => runProvisioningReconcileAllTenants(env, scope));

  // THE ROTATION ADVANCES HERE, on the FAN-OUT legs' own progress and nothing
  // else's (admin/tenant-slice.ts's commitSweepCursor explains why the minimum
  // is the only safe cursor). Before the send pipeline deliberately: that leg
  // carries the rest of the period and its own deadline, so letting it decide
  // where the next tick resumes would let one slow engine pin the rotation.
  // Wrapped in an object, not returned bare: `runLeg`'s fallback is `null` and
  // `collectLegSignals` reads `null` as "this leg threw" — while a SUCCESSFUL
  // commit legitimately returns `null` (the rotation restarting at the head).
  // A bare return would report a healthy wrap as a leg failure on every
  // rotation boundary.
  const sweepCursor = await runLeg("sweepCursor", null, async () => ({
    cursor: slice ? await commitSweepCursor(env, slice, fanout.leastVisited ?? slice.ids.length, now) : null,
  }));

  // S5 — retire check rows that have been healthy long enough to have said
  // everything they had to say. Without this, `watchtower_state` grows for the
  // platform's lifetime and every row in it re-emits a result (and a D1 write)
  // on every tick, forever, INCLUDING for customers who churned months ago.
  const retireChecks = await runLeg("retireChecks", null, () => retireHealthyCheckRows(env, now));
  // WAVE 2 — the auto-send driver: poll then tick, for every tenant whose DO
  // says it may (admin/ops-sweep.ts). LAST on purpose. It is the only leg that
  // sends customer mail and the only one carrying a wall-clock budget, so a
  // stalled engine consumes leg time that no other concern was waiting on —
  // every health, billing and alerting leg above has already completed by the
  // time this one starts.
  //
  // OFF THE TENANT SLICE as of 2026-08-24. It used to be handed `scope.tenantIds`,
  // which bounded automatic sending by the FAN-OUT's slice — a slice derived
  // from what the health legs can do in the 15s left over after THIS leg's own
  // two bounds. That deducted the same constraint twice and, at the calibrated
  // slice of 3, meant the send pipeline polled and ticked three tenants a cycle
  // out of 66. It carries its own leg deadline, its own per-tenant budget, its
  // own rotation and now its own count cap, which is what those bounds were
  // sized for. Deliberately NOT given `scope`: `scopedLegNames()` in
  // sweep-signal-coverage.test.ts reads that as "slice-bounded", and it is not.
  const sendPipeline = await runLeg("sendPipeline", null, () => runSendPipelineAllTenants(env, now, {}));

  const legs = {
    tenantPriority: priorityAll,
    tenantSlice: slice,
    deliverability,
    opsSummary,
    dunning,
    digest,
    watchtower,
    warmupCancel,
    webhooks,
    spendReservations,
    sdnRefresh,
    sdnRecovery,
    provisioningReconcile,
    sweepCursor,
    retireChecks,
    sendPipeline,
  };

  // Audit 2026-08-06 (NB-2/NB-3, table row 4) — every leg above already counts
  // its own failures and `runLeg` already catches a leg-level throw; until now
  // all of it ended in the log line below and reached no human. Routed through
  // the SAME throttled state machine as every other check, and damped over
  // consecutive ticks so an intermittent leg cannot flap.
  // `covered` is the ACHIEVED rotation advance — `fanout.leastVisited`, the same
  // number `commitSweepCursor` moved the cursor by above — NOT `slice.ids.length`.
  // Handing over the slice was the 2026-08-20 defect: at 63 tenants the slice
  // said 37 while the fan-out deadline was letting the trailing legs finish one,
  // so the founder was paged about degraded detection latency by an alert that
  // put that latency at ~10 min when it was ~315. Read AFTER the `sweepCursor`
  // leg, so every fan-out leg has already folded its own count in.
  const signalAlerts = await runLeg("sweepSignals", null, () =>
    reportSweepSignals(
      env,
      mailer,
      // `leastVisited === null` means NO fan-out leg reported a visit count at
      // all (they all threw). That is unknown coverage, not full coverage —
      // substituting the slice length here, as `commitSweepCursor`'s fallback
      // does for its own separate reason, would publish a healthy rotation
      // figure on the one tick where nothing was swept. The throws are already
      // `cron_legs`; this check simply makes no observation.
      {
        legs,
        digest,
        coverage:
          slice && fanout.leastVisited !== null
            ? { total: slice.total, covered: fanout.leastVisited, handed: slice.ids.length, allowed: slice.limit }
            : null,
      },
      now,
    ),
  );

  // W-M4 (docs/adversarial/sweep-completeness-pass-2026-08-17.md) — the
  // ALERTING leg reporting on ITSELF, which it structurally could not do: the
  // `legs` bag is built above it, so a `reportSweepSignals` that threw on every
  // tick (its first act is a cross-DO `gradeSweepStreak` RPC) was logged,
  // swallowed and reported by nobody — total, permanent, silent loss of every
  // leg signal while the heartbeat below kept the dead-man green.
  //
  // Reported from OUT HERE, after the leg, by code that cannot be the thing
  // that failed. It writes straight to `watchtower_state` via `reportCheck`,
  // which never throws, so it stays honest whenever D1 is up — and when D1 is
  // the thing that is down, the `d1` check (DO-backed) is the one that says so.
  await runLeg<void>("sweepSignalsSelfReport", undefined, () =>
    reportSweepSignalsHealth(env, mailer, signalAlerts !== null, now),
  );

  // msgchannel Inc4 §7 — the email mirror's OWN delivery channel, produced
  // ONCE per tick over the `deliverability` leg's aggregate (never per
  // tenant, C8). `deliverability` is `null` when that leg itself threw
  // (`runLeg`'s fallback) — reported by `cron_legs`, not by an invented
  // all-zero mirror observation.
  if (deliverability) {
    await runLeg<void>("mirrorDeliverySelfReport", undefined, () =>
      reportMirrorDeliveryHealth(env, mailer, deliverability.mirror, now),
    );
  }

  // The dead-man's heartbeat (BLOCKING-2). LAST, and its own leg: it is the
  // claim "this tick ran to completion", so it must not be written by any leg
  // that could still be skipped, and it must be written even when legs above
  // failed — a D1 outage is not a dead cron, and the alarm must not say it is.
  //
  // It is REACHABLE at any tenant count now (scale audit S1): every leg above
  // is bounded by the tick's slice, so nothing between here and the top of the
  // sweep grows with N and starves this write.
  await runLeg<void>("heartbeat", undefined, () => recordSweepHeartbeat(env, now));

  console.log(
    "scheduled ops sweep",
    JSON.stringify({
      ...legs,
      signalAlerts,
      // `covered` beside `scanned` on purpose: the gap between them is what a
      // reader of this line needs to see the fan-out deadline binding mid-slice.
      slice: slice
        ? {
            scanned: slice.ids.length,
            covered: fanout.leastVisited,
            total: slice.total,
            plannedCoverageTicks: slice.plannedCoverageTicks,
          }
        : null,
    }),
  );
}
