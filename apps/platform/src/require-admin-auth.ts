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

  if (configured && presented && timingSafeEqual(configured, presented)) {
    return next();
  }

  // SDN relay ingest carve-out (G1a droplet-relay build, 2026-07-24) — this
  // ONE path additionally accepts the narrow SDN_INGEST_TOKEN
  // (routes/admin-sdn-ingest.ts), so the relay droplet never needs to hold
  // ADMIN_TOKEN's cross-tenant power. Checked independently of ADMIN_TOKEN's
  // own configuration (an unset ADMIN_TOKEN must not block a correctly
  // configured ingest token). Every OTHER /admin/* route is unaffected: this
  // branch only runs for this exact path, and an SDN_INGEST_TOKEN never
  // satisfies the ADMIN_TOKEN check above — see
  // hono-subapp-wildcard-middleware-gotcha (agent memory): "/admin/*" here
  // matches every path under this prefix regardless of which route file
  // registers it, so this carve-out lives in the ONE shared gate rather than
  // a second competing middleware.
  if (c.req.path === "/admin/sdn/ingest") {
    const ingestConfigured = c.env.SDN_INGEST_TOKEN;
    if (ingestConfigured && presented && timingSafeEqual(ingestConfigured, presented)) {
      return next();
    }
  }

  return c.json({ error: "unauthorized" }, 401);
}
