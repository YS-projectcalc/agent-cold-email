import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { DashboardViewCreateInput, DashboardViewUpdateInput, type Provenance } from "@coldstart/shared";
import type { Env } from "../env.js";
import { hashApiToken } from "../auth.js";
import { deleteDashboardSession } from "../db.js";
import { DASHBOARD_SESSION_COOKIE, type AuthedVariables } from "../require-auth.js";
import { DASHBOARD_LAYOUT_MAX_BYTES, parseJsonBody } from "../validate.js";

type DashboardContext = { Bindings: Env; Variables: AuthedVariables };

// Provenance (§19.4) is server-derived from TRANSPORT, never a client claim:
// `authVia` is set by requireAuth ('cookie' -> 'dashboard' human-driven UI;
// 'bearer' -> 'api', a raw HTTP caller presenting the tenant token directly —
// the same bearer surface an agent's HTTP client could hit, distinct from 'mcp'
// which is stamped by mcp/tools.ts for the hosted MCP transport).
function sourceFor(c: { get(key: "authVia"): "bearer" | "cookie" }): Provenance {
  return c.get("authVia") === "cookie" ? "dashboard" : "api";
}

// POST /dashboard/logout + the dashboard-views CRUD lifecycle (§19.2/§19.4).
// Mounted behind requireAuth + the global CSRF guard (index.ts) — bearer OR
// dashboard cookie, exactly like every other tenant-facing route.
export const dashboardRoute = new Hono<DashboardContext>()
  .post("/dashboard/logout", async (c) => {
    const sessionId = getCookie(c, DASHBOARD_SESSION_COOKIE);
    if (sessionId) {
      const sessionHash = await hashApiToken(sessionId, c.env.TOKEN_HASH_PEPPER);
      await deleteDashboardSession(c.env, sessionHash);
    }
    deleteCookie(c, DASHBOARD_SESSION_COOKIE, { path: "/" });
    return c.json({ loggedOut: true });
  })
  .get("/dashboard/views", async (c) => {
    const result = await c.get("tenantStub").dashboardViews();
    return c.json(result);
  })
  .get("/dashboard/views/:id", async (c) => {
    const result = await c.get("tenantStub").dashboardView(c.req.param("id"));
    return c.json(result);
  })
  .post("/dashboard/views", async (c) => {
    // §19.3 — invalid/unknown widget type or props reports 422 (structured,
    // agent-repairable), not this API's usual 400.
    const parsed = await parseJsonBody(c, DashboardViewCreateInput, DASHBOARD_LAYOUT_MAX_BYTES, 422);
    if (!parsed.ok) return parsed.response;
    const result = await c.get("tenantStub").createDashboardView(parsed.data, sourceFor(c));
    return c.json(result, 201);
  })
  .put("/dashboard/views/:id", async (c) => {
    const parsed = await parseJsonBody(c, DashboardViewUpdateInput, DASHBOARD_LAYOUT_MAX_BYTES, 422);
    if (!parsed.ok) return parsed.response;
    // A stale rev throws RevConflictError -> index.ts's onError maps it to a
    // structured 409 { error, currentRev, currentLayout } (§19.4 [F5]).
    const result = await c.get("tenantStub").updateDashboardView(c.req.param("id"), parsed.data, sourceFor(c));
    return c.json(result, 200);
  })
  .post("/dashboard/views/:id/default", async (c) => {
    const result = await c.get("tenantStub").promoteDashboardViewDefault(c.req.param("id"), sourceFor(c));
    return c.json(result, 200);
  })
  .delete("/dashboard/views/:id", async (c) => {
    const result = await c.get("tenantStub").deleteDashboardView(c.req.param("id"));
    return c.json(result, 200);
  });
