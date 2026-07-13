import type { Context, Next } from "hono";
import type { AuthedVariables } from "./require-auth.js";
import type { Env } from "./env.js";

const CSRF_HEADER = "X-Coldstart-Client";
const CSRF_HEADER_VALUE = "dashboard";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * GLOBAL CSRF guard (SPEC.md §19.1 [NEW-1]) — mounted on the ENTIRE authed
 * surface in index.ts (same pattern list as `requireAuth`), not just
 * `/dashboard/*`. `SameSite=Strict` on the dashboard session cookie is
 * same-SITE-scoped (eTLD+1): once the dashboard and the marketing site share
 * `coldrig.dev` at activation, SameSite alone no longer isolates them from
 * each other, so a cookie-authed mutating request needs an explicit
 * same-origin proof a cross-site page can't forge: a custom header a simple
 * cross-site form/fetch can't attach without triggering a CORS preflight this
 * API never approves.
 *
 * Bearer-authed requests (an agent/CLI/MCP caller) are exempt — they never
 * carry a browser-planted cookie in the first place, so there is no
 * ambient credential for a third-party page to ride.
 */
export async function csrfGuard(c: Context<{ Bindings: Env; Variables: AuthedVariables }>, next: Next) {
  const authVia = c.get("authVia");
  const method = c.req.method.toUpperCase();
  if (authVia === "cookie" && !SAFE_METHODS.has(method) && c.req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
    return c.json({ error: `missing required ${CSRF_HEADER} header for a cookie-authed mutation` }, 403);
  }
  await next();
}
