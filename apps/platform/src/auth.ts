// Bearer-token minting + hashing. Tokens are high-entropy random strings;
// only their SHA-256(+pepper) hash is ever persisted (D1 tenants_index),
// never the plaintext — CLAUDE.md rule g (no secrets in git/store).

const TOKEN_PREFIX = "cs_live_";

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
