import { Hono } from "hono";
import { RealClock } from "../clock.js";
import type { Env } from "../env.js";
import { readSweepFreshness } from "../admin/watchtower-infra.js";

// D6 (brief) — a minimal PUBLIC status surface for a status page. Deliberately
// returns NO tenant data (not even a count) — that's what /admin/ops/digest
// is for, behind ADMIN_TOKEN.
//
// It also carries the platform's DEAD-MAN leg (audit 2026-08-06, BLOCKING-2).
// This route used to be a bare `SELECT 1`, which is green with a perfectly dead
// cron — so the 5-minute external prober that ACTIVATION.md names as the
// backstop for alert loss would have watched a silent platform and reported it
// healthy, forever. Sweep freshness is the one fact that makes an external
// prober a real dead-man, and it is safe to publish: an age in seconds says
// nothing about any tenant.
//
// A stale sweep is a 503, not an "ok with a warning field", because the thing
// consuming this is an uptime probe that alerts on status codes.
export const statusRoute = new Hono<{ Bindings: Env }>().get("/status", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (err) {
    console.error("status check: D1 unreachable", err);
    return c.json({ status: "degraded", reason: "d1_unreachable" }, 503);
  }

  const sweep = await readSweepFreshness(c.env, new RealClock().now());
  if (sweep.stale) {
    console.error(`status check: ops sweep is stale (last completed: ${sweep.lastSweepTs === null ? "never" : new Date(sweep.lastSweepTs).toISOString()})`);
    return c.json({ status: "degraded", reason: "sweep_stale", sweepAgeSeconds: sweep.ageSeconds }, 503);
  }
  return c.json({ status: "ok", sweepAgeSeconds: sweep.ageSeconds });
});
