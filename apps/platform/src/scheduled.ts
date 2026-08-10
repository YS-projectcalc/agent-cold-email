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
import { buildOpsDigest, runDeliverabilitySweepAllTenants, runDunningSweep, runSendPipelineAllTenants, runWarmupCancelSweepAllTenants, runWebhookDeliveriesAllTenants } from "./admin/ops-sweep.js";
import { runWatchtower } from "./admin/watchtower.js";
import { reportSweepSignals } from "./admin/sweep-signals.js";
import { recordSweepHeartbeat } from "./admin/watchtower-infra.js";
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
 */
export async function runScheduledOpsSweep(env: Env, opts: { mailer?: OpsMailer } = {}): Promise<void> {
  const now = new RealClock().now();
  const mailer = opts.mailer ?? createOpsMailer(env);

  const deliverability = await runLeg("deliverability", null, () => runDeliverabilitySweepAllTenants(env));
  const dunning = await runLeg("dunning", null, () => runDunningSweep(env, now, mailer));
  const digest = await runLeg("digest", null, () => buildOpsDigest(env, now, 24));
  const watchtower = await runLeg("watchtower", null, () => runWatchtower(env, mailer, now));
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
  const warmupCancel = await runLeg("warmupCancel", null, () => runWarmupCancelSweepAllTenants(env));
  // Outbound webhook delivery pump — the cron is the retry-queue wake
  // (ROADMAP.md WIN-THE-COMPARISON (d)). Last so a webhook fan-out failure
  // can't delay the health/dunning/watchtower legs above.
  const webhooks = await runLeg("webhooks", null, () => runWebhookDeliveriesAllTenants(env));
  // GA gate G2 (design NB-2) — reclaim vendor-spend reservations orphaned by a
  // crash between reserve and commit/release, so leaked reservations can't
  // silently shrink the effective ceiling. Its own concern (D1 account
  // ledger), so it can't delay the health/dunning/watchtower legs.
  const spendReservations = await runLeg("spendReservations", null, () => reapStaleReservations(env, now));
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
  const sdnRecovery = await runLeg("sdnRecovery", null, () => rescreenListUnavailableReviews(env));
  // WAVE 2 — the auto-send driver: poll then tick, for every tenant whose DO
  // says it may (admin/ops-sweep.ts). LAST on purpose. It is the only leg that
  // sends customer mail and the only one carrying a wall-clock budget, so a
  // stalled engine consumes leg time that no other concern was waiting on —
  // every health, billing and alerting leg above has already completed by the
  // time this one starts.
  const sendPipeline = await runLeg("sendPipeline", null, () => runSendPipelineAllTenants(env, now));

  const legs = { deliverability, dunning, digest, watchtower, warmupCancel, webhooks, spendReservations, sdnRefresh, sdnRecovery, sendPipeline };

  // Audit 2026-08-06 (NB-2/NB-3, table row 4) — every leg above already counts
  // its own failures and `runLeg` already catches a leg-level throw; until now
  // all of it ended in the log line below and reached no human. Routed through
  // the SAME throttled state machine as every other check, and damped over
  // consecutive ticks so an intermittent leg cannot flap.
  const signalAlerts = await runLeg("sweepSignals", null, () => reportSweepSignals(env, mailer, { legs, digest }, now));

  // The dead-man's heartbeat (BLOCKING-2). LAST, and its own leg: it is the
  // claim "this tick ran to completion", so it must not be written by any leg
  // that could still be skipped, and it must be written even when legs above
  // failed — a D1 outage is not a dead cron, and the alarm must not say it is.
  await runLeg<void>("heartbeat", undefined, () => recordSweepHeartbeat(env, now));

  console.log("scheduled ops sweep", JSON.stringify({ ...legs, signalAlerts }));
}
