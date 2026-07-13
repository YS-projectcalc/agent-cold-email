// Bearer-token minting + hashing. Tokens are high-entropy random strings;
// only their SHA-256(+pepper) hash is ever persisted (D1 tenants_index),
// never the plaintext — CLAUDE.md rule g (no secrets in git/store).

// Every tenant in this build is a non-activated sandbox tenant (no real
// sending), so tokens carry a `cs_test_` prefix — mirroring Stripe's
// test/live convention so an agent never mistakes a sandbox token for a
// production credential (adversarial panel-02). `cs_live_` is reserved for
// activated real-sending tenants once ACTIVATION.md is executed.
const TOKEN_PREFIX = "cs_test_";

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

// SPEC.md §19.1 (M1) — the dashboard cookie session's opaque id. A random
// 256-bit value, same entropy source as `generateApiToken`, but deliberately
// NOT bearer-token-shaped (no `cs_test_` prefix) so it's never mistaken for
// one if it ever leaked into a log line. The cookie carries this raw id; only
// its `hashApiToken`-computed hash is ever persisted (D1 `dashboard_sessions`),
// mirroring how the bearer token itself is never stored in plaintext.
export function generateDashboardSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
