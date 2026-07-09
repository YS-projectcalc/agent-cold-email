// D2 (brief) — the Cron Trigger entry point. Runs the SAME sweep logic the
// on-demand admin routes call (admin/ops-sweep.ts) so a scheduled run and a
// manual `curl -X POST /admin/ops/dunning-sweep` can never diverge. The
// actual `crons = [...]` trigger is commented-out in wrangler.toml — this
// export is armed (wired to real time) at activation; until then it's only
// reachable by directly invoking `scheduled()` (e.g. `wrangler dev --test-scheduled`).
//
// What runs each tick: (1) the deliverability control loop for every
// tenant, (2) the dunning sweep for every 'past_due' tenant, (3) the owner
// digest, logged (not emailed — no outbound email channel exists yet; the
// digest is also always available on-demand via GET /admin/ops/digest).
import { RealClock } from "./clock.js";
import type { Env } from "./env.js";
import { buildOpsDigest, runDeliverabilitySweepAllTenants, runDunningSweep } from "./admin/ops-sweep.js";

export async function runScheduledOpsSweep(env: Env): Promise<void> {
  const now = new RealClock().now();

  const deliverability = await runDeliverabilitySweepAllTenants(env);
  const dunning = await runDunningSweep(env, now);
  const digest = await buildOpsDigest(env, now, 24);

  console.log("scheduled ops sweep", JSON.stringify({ deliverability, dunning, digest }));
}
