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

/**
 * The per-pepper signing key. Derived ONCE per tick by the send path rather than
 * per row (engine/tick.ts) — it is constant for the whole batch, and hoisting it
 * is what moves an unusable pepper from "throws mid-batch, after rows are
 * claimed" to "detected before anything is claimed".
 *
 * THE EXPLICIT GUARD IS NOT DEFENSIVE PADDING (U1, class sweep 2026-08-17,
 * verified in workerd): `new TextEncoder().encode(undefined)` yields a
 * ZERO-length array, exactly like `encode("")`, and WebCrypto rejects
 * zero-length raw HMAC key material with `DataError: Imported HMAC key length
 * (0) must be a non-zero value...`. So BOTH an unset and an empty
 * TOKEN_HASH_PEPPER throw here — and they used to throw deep inside the send
 * loop, aborting every remaining due row with no grading, no 'failed' event and
 * no alert. (Note that `hashApiToken` does NOT fail on the same input: it string-
 * concatenates, so an unset pepper silently degrades to the literal "undefined"
 * there. That divergence is why the condition can exist unnoticed at all.)
 *
 * Named rather than left to WebCrypto so the operator reads what to fix instead
 * of a key-length error from a call site three modules away.
 */
export async function deriveUnsubscribeKey(pepper: string): Promise<CryptoKey> {
  if (!pepper) {
    throw new Error(
      "TOKEN_HASH_PEPPER is unset or empty — the one-click unsubscribe token cannot be signed, so no compliant message can be built. Set the secret.",
    );
  }
  const pepperKey = await importHmacKey(new TextEncoder().encode(pepper));
  const derivedBytes = await crypto.subtle.sign("HMAC", pepperKey, new TextEncoder().encode(KEY_DERIVATION_LABEL));
  return importHmacKey(derivedBytes);
}

/** Signs with an ALREADY-derived key — the per-row half of the split above. */
export async function signWithUnsubscribeKey(key: CryptoKey, tenantId: string, email: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", key, payloadFor(tenantId, email)));
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
  return signWithUnsubscribeKey(await deriveUnsubscribeKey(pepper), tenantId, email);
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

function buildTokenUrl(baseUrl: string, path: string, tenantId: string, email: string, sig: string): string {
  const url = new URL(path, baseUrl);
  url.searchParams.set("tenant", tenantId);
  url.searchParams.set("email", email);
  url.searchParams.set("sig", sig);
  return url.toString();
}

/** Builds the full hosted one-click URL from a base origin + a signed token
 * — the exact value `List-Unsubscribe`'s https form and the in-body opt-out
 * link both point at (engine/tick.ts). */
export function buildUnsubscribeUrl(baseUrl: string, tenantId: string, email: string, sig: string): string {
  return buildTokenUrl(baseUrl, "/unsubscribe", tenantId, email, sig);
}

/**
 * msgchannel Inc4 (design §6) — the SAME (tenant, email, sig) HMAC triplet as
 * `buildUnsubscribeUrl` above, reused rather than re-invented (CLAUDE.md rule
 * c), pointed at a different hosted path. `routes/messages.ts`'s two-step
 * GET-confirm/POST-perform opt-out route verifies it with the same
 * `verifyUnsubscribeToken` `/unsubscribe` already uses.
 */
export function buildMirrorOptOutUrl(baseUrl: string, tenantId: string, email: string, sig: string): string {
  return buildTokenUrl(baseUrl, "/messages/mirror/optout", tenantId, email, sig);
}
