// D2 (brief) — the Cron Trigger entry point. Runs the SAME sweep logic the
// on-demand admin routes call (admin/ops-sweep.ts) so a scheduled run and a
// manual `curl -X POST /admin/ops/dunning-sweep` can never diverge. The
// `crons = [...]` trigger is ARMED and LIVE in wrangler.toml (every 5 min,
// index.ts's `scheduled()` export wires it to this function) — this is NOT a
// dormant/inert export.
//
// What runs each tick: (1) the deliverability control loop for every
// tenant, (2) the warmup-pool auto-cancel sweep for every tenant (founder
// ruling 2026-08-02 — this cron is its ONLY production driver; see
// runWarmupCancelSweepAllTenants), (3) the dunning sweep for every 'past_due'
// tenant (now emailing a suspend notice via the OpsMailer), (4) the owner
// digest, logged, and (5) the watchtower — health probes + the founder-alert
// state machine. The OpsMailer
// is built ONCE and shared by the dunning sweep + watchtower; it is real in
// production (dark until the domain is onboarded) and degrades gracefully — an
// unsendable alert can never take down the sweep.
import { RealClock } from "./clock.js";
import type { Env } from "./env.js";
import { buildOpsDigest, runDeliverabilitySweepAllTenants, runDunningSweep, runWarmupCancelSweepAllTenants, runWebhookDeliveriesAllTenants } from "./admin/ops-sweep.js";
import { runWatchtower } from "./admin/watchtower.js";
import { createOpsMailer } from "./ops-mail/ops-mailer.js";
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

export async function runScheduledOpsSweep(env: Env): Promise<void> {
  const now = new RealClock().now();
  const mailer = createOpsMailer(env);

  const deliverability = await runLeg("deliverability", null, () => runDeliverabilitySweepAllTenants(env));
  // Warmup-pool auto-cancel at ramp completion (founder ruling 2026-08-02,
  // ROADMAP.md:25). THIS is the sweep's only production driver — it is not
  // reachable from the tick, which nothing in production calls (adversary A1).
  // Its own lane rather than part of the tick, so cron never arms automatic
  // campaign sending. Runs after the deliverability loop and before dunning;
  // its own try/catch inside the runner means a vendor hiccup can neither
  // abort the remaining legs nor delay any tenant's mail.
  const warmupCancel = await runLeg("warmupCancel", null, () => runWarmupCancelSweepAllTenants(env));
  const dunning = await runLeg("dunning", null, () => runDunningSweep(env, now, mailer));
  const digest = await runLeg("digest", null, () => buildOpsDigest(env, now, 24));
  const watchtower = await runLeg("watchtower", null, () => runWatchtower(env, mailer, now));
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

  console.log(
    "scheduled ops sweep",
    JSON.stringify({ deliverability, warmupCancel, dunning, digest, watchtower, webhooks, spendReservations, sdnRefresh, sdnRecovery }),
  );
}
