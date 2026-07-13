import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { DashboardSessionInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import { generateDashboardSessionId, hashApiToken } from "../auth.js";
import { insertDashboardSession } from "../db.js";
import { DASHBOARD_SESSION_COOKIE, resolveTenantFromToken } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

// SPEC.md §19.1 [NEW-1] — 30-day session TTL.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// POST /dashboard/session — UNAUTHENTICATED (see index.ts mount comment): the
// token-gate screen POSTs the pasted tenant bearer TOKEN in the body (there is
// no Authorization header at this point in the flow); this route verifies it
// itself via the SAME token hash resolver `requireAuth` uses, then mints a
// server-side session and sets the httpOnly cookie. The cookie carries the
// OPAQUE session id — never the bearer token itself; the SPA never touches
// either value in JS-readable storage (no localStorage, never in a URL).
export const dashboardSessionRoute = new Hono<{ Bindings: Env }>().post("/dashboard/session", async (c) => {
  const parsed = await parseJsonBody(c, DashboardSessionInput);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveTenantFromToken(c.env, parsed.data.token);
  if (!resolved.ok) return c.json({ error: resolved.message, code: resolved.code }, 401);

  const sessionId = generateDashboardSessionId();
  const sessionHash = await hashApiToken(sessionId, c.env.TOKEN_HASH_PEPPER);
  const now = Date.now(); // real wall clock — dashboard sessions are a control-plane concept, not tenant-sandboxed
  await insertDashboardSession(c.env, {
    sessionHash,
    tenantId: resolved.tenant.tenantId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });

  setCookie(c, DASHBOARD_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return c.json({ tenantId: resolved.tenant.tenantId }, 200);
});
