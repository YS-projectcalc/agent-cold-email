import type { Context, Next } from "hono";
import { extractBearerToken } from "./auth.js";
import type { Env } from "./env.js";
import { timingSafeEqual } from "./timing-safe-equal.js";

// The admin surface (D1/D2/D6, src/admin/README.md) is a SEPARATE facade
// from the tenant-scoped one in require-auth.ts: it reads/mutates
// CROSS-tenant data (every tenant's billing state, all support tickets), so
// it is gated by a single owner-held secret bearer token
// (`env.ADMIN_TOKEN`), never a per-tenant token. Fails closed: an unset
// ADMIN_TOKEN binding means every /admin/* call 401s, never an
// accidental open door (mirrors requireAuth's "missing token -> reject",
// but here the SERVER-side secret being absent is itself a reject
// condition too — there is no equivalent for the tenant-token path).
export async function requireAdminAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const configured = c.env.ADMIN_TOKEN;
  const presented = extractBearerToken(c.req.header("Authorization"));

  if (!configured || !presented || !timingSafeEqual(configured, presented)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
}
