// Bearer-token minting + hashing. Tokens are high-entropy random strings;
// only their SHA-256(+pepper) hash is ever persisted (D1 tenants_index),
// never the plaintext — CLAUDE.md rule g (no secrets in git/store).

// The platform is LIVE (real billing, real Stripe keys flipped — ROADMAP.md
// 2026-07-23), so every newly-minted token carries a brand-correct,
// mode-honest `cr_live_` prefix (Coldrig; "live" is now true, not aspirational
// — see the prior `cs_test_`/`cs_live_` split below). Token resolution
// (require-auth.ts's resolveTenantFromToken) is hash-based and prefix-BLIND —
// it hashes the full presented string and looks up that hash in
// `tenants_index`, never inspecting the prefix — so every `cs_test_` token
// minted before this change remains valid FOREVER (grandfathered): there is
// no re-issuance, migration, or rejection of a legacy token, and none is
// planned. The prefix exists purely as an agent-facing signal of what a FRESH
// token looks like, mirroring Stripe's test/live convention so an agent never
// mistakes a sandbox credential for a production one (adversarial panel-02,
// the reasoning that motivated having a prefix at all — only the concrete
// value changed, since every tenant now transacts on real money).
const TOKEN_PREFIX = "cr_live_";

export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${TOKEN_PREFIX}${raw}`;
}

export async function hashApiToken(token: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`${pepper}:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractBearerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

/**
 * Resolve the API token from a request that may present EITHER an
 * `Authorization: Bearer <token>` header OR an `X-API-Key: <token>` header.
 * Authorization WINS if present at all — X-API-Key is consulted ONLY when no
 * Authorization header was sent. This unblocks gateways (e.g. Smithery) that
 * reserve the Authorization header for their own auth and cannot forward a
 * bearer token, without changing behavior for any existing bearer caller.
 *
 * The returned token flows into the SAME hash+constant-time resolution path as
 * a bearer token (resolveTenantFromToken) — X-API-Key is not a second
 * credential type, just a second transport for the same token. Neither header
 * value is logged. A garbage X-API-Key resolves to no tenant (401), exactly
 * like a garbage bearer token.
 */
export function resolveRequestToken(
  authHeader: string | undefined | null,
  apiKeyHeader: string | undefined | null,
): string | null {
  const bearer = extractBearerToken(authHeader);
  if (bearer) return bearer;
  // Authorization present but not Bearer-shaped still "wins" (fail closed) —
  // only a fully ABSENT Authorization header falls through to X-API-Key.
  if (authHeader != null && authHeader.trim() !== "") return null;
  const apiKey = apiKeyHeader?.trim();
  return apiKey ? apiKey : null;
}

// SPEC.md §19.1 (M1) — the dashboard cookie session's opaque id. A random
// 256-bit value, same entropy source as `generateApiToken`, but deliberately
// NOT bearer-token-shaped (no `cr_live_` prefix) so it's never mistaken for
// one if it ever leaked into a log line. The cookie carries this raw id; only
// its `hashApiToken`-computed hash is ever persisted (D1 `dashboard_sessions`),
// mirroring how the bearer token itself is never stored in plaintext.
export function generateDashboardSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
