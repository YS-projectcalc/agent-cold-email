import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateApiToken, hashApiToken } from "../auth.js";
import { rotateApiTokenAndRevokeSessions } from "../db.js";
import type { AuthedVariables } from "../require-auth.js";

/**
 * POST /token/rotate — the ONLY recovery path for a lost bearer token
 * (auth.ts / db.ts store only `api_token_hash`, never the plaintext, so
 * "reveal my token" is impossible by design). Mounted behind requireAuth +
 * the global csrfGuard in index.ts, on the SAME explicit authed-path list as
 * every other tenant route — so it accepts EITHER credential a tenant can
 * already present:
 *   - a dashboard session cookie (a human clicking "Rotate API token" in
 *     Settings) — csrfGuard requires the X-Coldstart-Client header on this
 *     path exactly like every other cookie-authed mutation;
 *   - a bearer token (an agent rotating its OWN credential proactively) —
 *     csrfGuard exempts bearer callers (no ambient cookie to forge).
 *
 * WHAT ROTATION REVOKES (BLOCKING-3, audit-dashboard-idempotency-2026-08-06):
 * the bearer token AND every dashboard session for the tenant, in one atomic
 * write (db.ts's rotateApiTokenAndRevokeSessions). It used to revoke the token
 * only, which made the sentence above false in the case it was written for: a
 * leaked token exchanged once for a cookie kept full tenant authority for that
 * session's remaining 30 days — including the authority to rotate the token
 * again and lock out the legitimate owner. Cookie sessions are resolved from
 * `dashboard_sessions`, which never consults `api_token_hash`, so killing the
 * token alone could not touch them.
 *
 * The caller's own session is revoked too, deliberately — see the db.ts note on
 * why a carve-out would hand the attack back to the attacker. A human rotating
 * from Settings is signed out and signs back in with the token just shown, so
 * the SPA must treat the 401 that follows as a normal re-auth, not an error.
 *
 * Atomicity: the column always holds exactly one hash, so there is never a
 * window where neither the old nor the new token authenticates, and the old
 * token 401s on its very next use (its hash no longer matches any row). Two
 * concurrent rotations for the same tenant both succeed at the HTTP layer, but
 * only the hash written by whichever transaction commits last is ever valid
 * again — "exactly one winner" falls out of D1/SQLite's own write
 * serialization, not a separate CAS.
 *
 * Residual, stated plainly: a session minted from the OLD token in the instant
 * between this request being authorized and the transaction committing is not
 * covered — nothing short of holding a lock across the whole request could be.
 * Rotating a second time closes it, and the mint cap (db.ts) bounds how much
 * such a race could ever accumulate.
 *
 * Deliberate MCP omission (session-invariant, not a gap): no `rotate_token`
 * MCP tool exists. An agent mid-session invalidating the very bearer token
 * authenticating its OWN current call (or a sibling call racing it) is a
 * footgun with no clean recovery inside that same session — the dashboard
 * (session-cookie) and a deliberate out-of-band bearer POST are the two
 * supported rotation paths; MCP tool parity does not extend to this action.
 */
export const tokenRotateRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().post("/token/rotate", async (c) => {
  const tenantId = c.get("tenantId");
  const newToken = generateApiToken();
  const newTokenHash = await hashApiToken(newToken, c.env.TOKEN_HASH_PEPPER);
  await rotateApiTokenAndRevokeSessions(c.env, tenantId, newTokenHash);
  return c.json({ token: newToken }, 200);
});
