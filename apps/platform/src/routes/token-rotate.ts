import { Hono } from "hono";
import type { Env } from "../env.js";
import { generateApiToken, hashApiToken } from "../auth.js";
import { updateTenantIndexApiTokenHash } from "../db.js";
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
 * Atomicity: mint the new token, then ONE `UPDATE ... SET api_token_hash`
 * (db.ts's updateTenantIndexApiTokenHash) — the column always holds exactly
 * one hash, so there is never a window where neither the old nor the new
 * token authenticates, and the old token 401s on its very next use (its hash
 * no longer matches any row). Two concurrent rotations for the same tenant
 * both succeed at the HTTP layer, but only the hash written by whichever
 * UPDATE commits last is ever valid again — "exactly one winner" falls out of
 * D1/SQLite's own write serialization, not a separate CAS.
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
  await updateTenantIndexApiTokenHash(c.env, tenantId, newTokenHash);
  return c.json({ token: newToken }, 200);
});
