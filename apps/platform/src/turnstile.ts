// Cloudflare Turnstile server-side verification (design docs/research/
// human-signup-magic-link-design-2026-07-22.md §2.3) — `/login` ONLY, never
// `/signup` (signup.ts:15-16: signup must stay agent-drivable). `fetcher` is
// injectable (defaults to the real global `fetch`) so a test can prove the
// verify/reject/error paths with a fake fetcher, mirroring the OpsMailer
// dependency-injection house style — no live network call in tests.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success?: boolean;
}

/**
 * Dark-safe by construction: `secret` undefined/empty means the gate is not
 * configured at all — a no-op that always passes (matches every other
 * optional-vendor-binding posture in this repo: absent = inert, not a hard
 * failure). Once configured, a MISSING challenge token fails closed (a
 * client that never rendered/solved the widget cannot bypass the gate by
 * simply omitting the field).
 */
export async function verifyTurnstile(
  secret: string | undefined,
  token: string | undefined,
  remoteIp: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token, remoteip: remoteIp });
  try {
    const res = await fetcher(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch (err) {
    // A network hiccup against Cloudflare's own siteverify endpoint must
    // fail CLOSED (reject the request) rather than silently let a
    // real-but-unverifiable bot request through.
    console.error("turnstile siteverify request failed", err);
    return false;
  }
}
