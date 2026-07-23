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
  // silently shrink the effective ceiling. Last, and its own concern (D1
  // account ledger), so it can't delay the health/dunning/watchtower legs.
  const spendReservations = await reapStaleReservations(env, now);

  console.log(
    "scheduled ops sweep",
    JSON.stringify({ deliverability, dunning, digest, watchtower, webhooks, spendReservations }),
  );
}
