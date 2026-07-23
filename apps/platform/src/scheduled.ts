// D2 (brief) — the Cron Trigger entry point. Runs the SAME sweep logic the
// on-demand admin routes call (admin/ops-sweep.ts) so a scheduled run and a
// manual `curl -X POST /admin/ops/dunning-sweep` can never diverge. The
// actual `crons = [...]` trigger is commented-out in wrangler.toml — this
// export is armed (wired to real time) at activation; until then it's only
// reachable by directly invoking `scheduled()` (e.g. `wrangler dev --test-scheduled`).
//
// What runs each tick: (1) the deliverability control loop for every
// tenant, (2) the dunning sweep for every 'past_due' tenant (now emailing a
// suspend notice via the OpsMailer), (3) the owner digest, logged, and (4) the
// watchtower — health probes + the founder-alert state machine. The OpsMailer
// is built ONCE and shared by the dunning sweep + watchtower; it is real in
// production (dark until the domain is onboarded) and degrades gracefully — an
// unsendable alert can never take down the sweep.
import { RealClock } from "./clock.js";
import type { Env } from "./env.js";
import { buildOpsDigest, runDeliverabilitySweepAllTenants, runDunningSweep, runWebhookDeliveriesAllTenants } from "./admin/ops-sweep.js";
import { runWatchtower } from "./admin/watchtower.js";
import { createOpsMailer } from "./ops-mail/ops-mailer.js";
import { reapStaleReservations } from "./engine/spend-ceiling.js";
import { maybeRefreshSdnList } from "./ofac/sdn-refresh.js";
import { rescreenListUnavailableReviews } from "./ofac/screening-recovery.js";

export async function runScheduledOpsSweep(env: Env): Promise<void> {
  const now = new RealClock().now();
  const mailer = createOpsMailer(env);

  const deliverability = await runDeliverabilitySweepAllTenants(env);
  const dunning = await runDunningSweep(env, now, mailer);
  const digest = await buildOpsDigest(env, now, 24);
  const watchtower = await runWatchtower(env, mailer, now);
  // Outbound webhook delivery pump — the cron is the retry-queue wake
  // (ROADMAP.md WIN-THE-COMPARISON (d)). Last so a webhook fan-out failure
  // can't delay the health/dunning/watchtower legs above.
  const webhooks = await runWebhookDeliveriesAllTenants(env);
  // GA gate G2 (design NB-2) — reclaim vendor-spend reservations orphaned by a
  // crash between reserve and commit/release, so leaked reservations can't
  // silently shrink the effective ceiling. Its own concern (D1 account
  // ledger), so it can't delay the health/dunning/watchtower legs.
  const spendReservations = await reapStaleReservations(env, now);
  // G1a — once-daily SDN (OFAC) list refresh, piggybacked on this same 5-min
  // cron (design ga-gates-design-2026-07-22.md §G1a line 49) rather than a
  // second `[triggers] crons` entry. Self-contained: its own internal guard
  // no-ops on every tick but one per day, and it never throws (fail-loud means
  // "alert + keep the prior list", not "abort this sweep" — see sdn-refresh.ts).
  const sdnRefresh = await maybeRefreshSdnList(env, now, fetch, mailer);
  // N-OF-1 fix (adversary OFAC build review, 2026-07-23) — recovers any
  // tenant fail-closed to 'review' ONLY because no list had loaded yet at
  // screening time, now that a refresh above may have just loaded one. Cheap
  // no-op whenever no list is available or nothing is stuck.
  const sdnRecovery = await rescreenListUnavailableReviews(env);

  console.log(
    "scheduled ops sweep",
    JSON.stringify({ deliverability, dunning, digest, watchtower, webhooks, spendReservations, sdnRefresh, sdnRecovery }),
  );
}
