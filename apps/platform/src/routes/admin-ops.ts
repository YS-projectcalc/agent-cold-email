import { Hono } from "hono";
import { buildOpsDigest, runDunningSweep } from "../admin/ops-sweep.js";
import { RealClock } from "../clock.js";
import type { Env } from "../env.js";

const DEFAULT_DIGEST_WINDOW_HOURS = 24;

function parseWindowHours(raw: string | undefined): number {
  const n = raw ? Number(raw) : DEFAULT_DIGEST_WINDOW_HOURS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DIGEST_WINDOW_HOURS;
}

// D2/D6 (brief) — business-ops routines. Both handlers are thin: the actual
// cross-tenant iteration/aggregation lives in ../admin/ops-sweep.ts, shared
// with the cron `scheduled()` handler (../scheduled.ts) so cron and the
// on-demand endpoint can never drift (CLAUDE.md rule c). Acceptable at
// test-mode scale (admin/README.md); a D1 read-model fed by Queues is the
// scale path once tenant count makes a full per-request RPC fan-out slow.
export const adminOpsRoute = new Hono<{ Bindings: Env }>()
  // D2 — dunning / failed-payment sweep. Scans every tenant currently
  // 'past_due' and records at most one dunning_events row per (tenant,
  // failure-count-as-cycle) — a second sweep before the next failure is a
  // no-op (idempotent per cycle). "suspend" flips the tenant's own status
  // now (a real local mutation); the actual retry/dunning EMAILS are an
  // ACTIVATION step (no outbound email channel is wired in this build).
  .post("/admin/ops/dunning-sweep", async (c) => {
    const result = await runDunningSweep(c.env, new RealClock().now());
    return c.json(result);
  })
  // D6 — the owner's single cross-tenant business-health rollup: the daily
  // digest that replaces the owner doing ops manually (SPEC.md §0.10).
  .get("/admin/ops/digest", async (c) => {
    const windowHours = parseWindowHours(c.req.query("hours"));
    const digest = await buildOpsDigest(c.env, new RealClock().now(), windowHours);
    return c.json(digest);
  });
