import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import { DashboardSessionInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import { generateDashboardSessionId, hashApiToken } from "../auth.js";
import { insertDashboardSession } from "../db.js";
import { DASHBOARD_SESSION_COOKIE, resolveTenantFromToken } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

// SPEC.md §19.1 [NEW-1] — 30-day session TTL.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The single mint choke point for a dashboard cookie session (SPEC.md §19.1;
 * magic-link design §1.1) — random 256-bit opaque id, stores only its
 * SHA-256(+pepper) hash in D1, sets the httpOnly cookie. Both `POST
 * /dashboard/session` (bearer-token exchange, below) AND `POST
 * /login/consume` (magic-link exchange, routes/login.ts) call this AFTER
 * resolving their own credential — one session table, one cookie, one CSRF
 * posture, regardless of which credential minted it. Pure extraction from
 * the pre-refactor inline body: cookie/CSRF/authVia semantics are unchanged
 * because the *same* code runs either way.
 */
export async function mintDashboardSession(c: Context, env: Env, tenantId: string): Promise<{ tenantId: string }> {
  const sessionId = generateDashboardSessionId();
  const sessionHash = await hashApiToken(sessionId, env.TOKEN_HASH_PEPPER);
  const now = Date.now(); // real wall clock — dashboard sessions are a control-plane concept, not tenant-sandboxed
  await insertDashboardSession(env, {
    sessionHash,
    tenantId,
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

  return { tenantId };
}

// POST /dashboard/session — UNAUTHENTICATED (see index.ts mount comment): the
// token-gate screen POSTs the pasted tenant bearer TOKEN in the body (there is
// no Authorization header at this point in the flow); this route verifies it
// itself via the SAME token hash resolver `requireAuth` uses, then mints a
// server-side session via mintDashboardSession above.
export const dashboardSessionRoute = new Hono<{ Bindings: Env }>().post("/dashboard/session", async (c) => {
  const parsed = await parseJsonBody(c, DashboardSessionInput);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveTenantFromToken(c.env, parsed.data.token);
  if (!resolved.ok) return c.json({ error: resolved.message, code: resolved.code }, 401);

  const result = await mintDashboardSession(c, c.env, resolved.tenant.tenantId);
  return c.json(result, 200);
});
