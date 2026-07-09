import { Hono } from "hono";
import type { Env } from "../env.js";

// D6 (brief) — a minimal PUBLIC status surface for a status page. Deliberately
// returns NO tenant data (not even a count) — that's what /admin/ops/digest
// is for, behind ADMIN_TOKEN. This just confirms the Worker + D1 binding are
// reachable, which is what a status page's uptime probe actually needs.
export const statusRoute = new Hono<{ Bindings: Env }>().get("/status", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch (err) {
    console.error("status check: D1 unreachable", err);
    return c.json({ status: "degraded" }, 503);
  }
  return c.json({ status: "ok" });
});
