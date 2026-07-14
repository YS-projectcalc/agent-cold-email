// B4 opt-out — stateless RFC 8058 one-click unsubscribe token. No new table:
// the brief's own framing is exact ("tenant + lead email + expiry
// irrelevant — opt-outs don't expire"), so there is nothing to look up,
// invalidate, or garbage-collect. The URL's own (tenant, email, sig) triplet
// IS the credential, the same shape checkout.ts's `/checkout/simulate`
// session id already uses for an unauthenticated-but-verified route.
//
// Key source: derived from the existing `TOKEN_HASH_PEPPER` secret (one more
// HMAC step, never the raw pepper bytes) rather than a brand-new required
// env binding — no wrangler.toml/.dev.vars/test-harness plumbing needed, and
// the domain-separation label below means this key is cryptographically
// independent of `auth.ts`'s hashApiToken use of the same pepper (a
// forgery/collision against one gives no leverage against the other).
//
// Construction: HMAC-SHA256 via crypto.subtle, mirroring
// billing/stripe-webhook.ts's verifyStripeSignature — NOT auth.ts's
// hashApiToken (`SHA-256(pepper + ":" + token)`). That plain concat-hash is
// the wrong primitive here: hashApiToken's token is a high-entropy random
// value the caller could never choose, so there is nothing to forge a
// length-extension attack against. This token's message (`tenant:email`) is
// the OPPOSITE — fully attacker-known/guessable — so it needs a real MAC
// construction (HMAC), not a prefix-secret hash.
import { timingSafeEqual } from "./timing-safe-equal.js";

const KEY_DERIVATION_LABEL = "coldstart:unsubscribe-token-key:v1";

async function importHmacKey(rawKeyBytes: BufferSource): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function deriveUnsubscribeKey(pepper: string): Promise<CryptoKey> {
  const pepperKey = await importHmacKey(new TextEncoder().encode(pepper));
  const derivedBytes = await crypto.subtle.sign("HMAC", pepperKey, new TextEncoder().encode(KEY_DERIVATION_LABEL));
  return importHmacKey(derivedBytes);
}

function payloadFor(tenantId: string, email: string): Uint8Array {
  // No delimiter-collision risk worth guarding: tenantId is a server-minted
  // `ten_...` id (schema.ts's newId, never contains ':'), so `tenantId:email`
  // cannot be reinterpreted as a different (tenantId, email) pair.
  return new TextEncoder().encode(`${tenantId}:${email}`);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signs `tenantId:email` — used both to mint the hosted unsubscribe URL
 * (engine/tick.ts) and, symmetrically, to verify one presented back. */
export async function signUnsubscribeToken(pepper: string, tenantId: string, email: string): Promise<string> {
  const key = await deriveUnsubscribeKey(pepper);
  const sigBuf = await crypto.subtle.sign("HMAC", key, payloadFor(tenantId, email));
  return toHex(sigBuf);
}

/** Constant-time verification against a caller-presented `sig` — never
 * branches on WHICH part (tenant/email/sig) was wrong, so a tamper attempt
 * gets the same generic rejection regardless of what it flipped. */
export async function verifyUnsubscribeToken(
  pepper: string,
  tenantId: string,
  email: string,
  sig: string,
): Promise<boolean> {
  if (!sig) return false;
  const expected = await signUnsubscribeToken(pepper, tenantId, email);
  return timingSafeEqual(expected, sig);
}

/** Builds the full hosted one-click URL from a base origin + a signed token
 * — the exact value `List-Unsubscribe`'s https form and the in-body opt-out
 * link both point at (engine/tick.ts). */
export function buildUnsubscribeUrl(baseUrl: string, tenantId: string, email: string, sig: string): string {
  const url = new URL("/unsubscribe", baseUrl);
  url.searchParams.set("tenant", tenantId);
  url.searchParams.set("email", email);
  url.searchParams.set("sig", sig);
  return url.toString();
}
