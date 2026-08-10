import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateDashboardSessionId, hashApiToken } from "../src/auth.js";
import { insertLoginLink } from "../src/db.js";
import { api, cookieApi, createDashboardSession, mintTenant, signup } from "./helpers.js";

// POST /token/rotate — the only recovery path for a lost bearer token (the
// server stores only api_token_hash, never the plaintext — auth.ts). Mounted
// behind requireAuth + the global csrfGuard (index.ts), so it accepts EITHER
// a dashboard session cookie (+ CSRF header) or a bearer token, exactly like
// every other authed mutation.

interface RotateResult {
  token: string;
}

/** Mirrors test/login.test.ts's private `createLoginLink` — mints a
 * login_links row DIRECTLY (bypassing POST /login + the email send), the
 * only way a test can obtain the raw single-use token (the real API never
 * returns it, by enumeration-safety design). */
async function createLoginLink(contactEmail: string): Promise<string> {
  const id = generateDashboardSessionId();
  const tokenHash = await hashApiToken(id, env.TOKEN_HASH_PEPPER);
  const now = Date.now();
  await insertLoginLink(env, { tokenHash, contactEmail: contactEmail.toLowerCase(), createdAt: now, expiresAt: now + 15 * 60 * 1000 });
  return id;
}

describe("POST /token/rotate — atomicity (old dies exactly when new is born)", () => {
  it("the old token 401s immediately after rotation; the new token authenticates", async () => {
    const { token: oldToken } = await signup("Rotate Atomic Co", "rotate-atomic@token-rotate.example");

    const rotateRes = await api<RotateResult>("/token/rotate", { method: "POST", token: oldToken });
    expect(rotateRes.status).toBe(200);
    const newToken = rotateRes.body.token;
    expect(newToken).not.toBe(oldToken);
    expect(newToken).toMatch(/^cr_live_/);

    // No window where NEITHER works: by the time rotate() has returned, the
    // old token must already be dead and the new one already live.
    const oldRes = await api("/account", { token: oldToken });
    expect(oldRes.status).toBe(401);

    const newRes = await api<{ brand: string }>("/account", { token: newToken });
    expect(newRes.status).toBe(200);
    expect((newRes.body as unknown as { brand: string }).brand).toBe("Rotate Atomic Co");
  });

  it("concurrent rotate calls for the same tenant: exactly one winning token survives", async () => {
    const { token } = await signup("Rotate Race Co", "rotate-race@token-rotate.example");

    const [a, b] = await Promise.all([
      api<RotateResult>("/token/rotate", { method: "POST", token }),
      api<RotateResult>("/token/rotate", { method: "POST", token }),
    ]);
    // Both requests carry the SAME original bearer token; rotation atomically
    // replaces the stored hash, so whichever request's UPDATE commits first
    // invalidates the sibling's very next auth lookup. Both race orderings
    // are correct, fail-closed behavior: either both auth-resolve before
    // either UPDATE lands (both 200), or one UPDATE lands first and the
    // sibling 401s at the auth layer, never reaching the rotation handler.
    expect([200, 401]).toContain(a.status);
    expect([200, 401]).toContain(b.status);

    const minted = [a, b].filter((r) => r.status === 200).map((r) => r.body.token);
    if (minted.length === 2) {
      expect(minted[0]).not.toBe(minted[1]);
    }

    // A 401'd request never reached the handler, so it minted nothing. The
    // real invariant — regardless of which/how-many of the two requests
    // were 200 at the HTTP layer — is that exactly one of the two
    // concurrent calls ends up holding a currently-valid token.
    const aliveOutcomes = await Promise.all(
      [a, b].map(async (r) => {
        if (r.status !== 200) return false;
        const check = await api("/account", { token: r.body.token });
        return check.status === 200;
      }),
    );
    expect(aliveOutcomes.filter(Boolean).length).toBe(1);

    // The pre-race token is dead either way.
    const original = await api("/account", { token });
    expect(original.status).toBe(401);
  });
});

describe("POST /token/rotate — session+CSRF required on the cookie path", () => {
  it("rejects a cookie-authed rotate WITHOUT the CSRF header (403, token unchanged)", async () => {
    const { token } = await signup("Rotate CSRF Co", "rotate-csrf@token-rotate.example");
    const session = await createDashboardSession(token);

    const res = await cookieApi<{ error: string }>("/token/rotate", session, { method: "POST" });
    expect(res.status).toBe(403);

    // The original bearer token must still work — a rejected CSRF attempt
    // must never have reached the rotation logic.
    const stillOk = await api("/account", { token });
    expect(stillOk.status).toBe(200);
  });

  it("accepts a cookie-authed rotate WITH the CSRF header", async () => {
    const { token } = await signup("Rotate CSRF Ok Co", "rotate-csrf-ok@token-rotate.example");
    const session = await createDashboardSession(token);

    const res = await cookieApi<RotateResult>("/token/rotate", session, { method: "POST", csrf: true });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cr_live_/);

    const oldRes = await api("/account", { token });
    expect(oldRes.status).toBe(401);
    const newRes = await api("/account", { token: res.body.token });
    expect(newRes.status).toBe(200);
  });
});

describe("POST /token/rotate — bearer path (an agent rotating its own credential)", () => {
  it("a bearer-authed rotate works with no CSRF header at all", async () => {
    const { token } = await mintTenant("Rotate Bearer Co", "demo");
    const res = await api<RotateResult>("/token/rotate", { method: "POST", token });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cr_live_/);
  });
});

describe("POST /token/rotate — the exact lost-token journey (magic-link recovery -> session -> rotate)", () => {
  it("a tenant with no token in hand recovers access AND replaces the (now-known-compromised) old token in one flow", async () => {
    const contactEmail = "lost-token@token-rotate.example";
    const { token: originalToken } = await signup("Lost Token Journey Co", contactEmail);

    // 1. Recovery: the tenant lost their token, so they use the magic-link
    // flow (routes/login.ts) rather than pasting a token they don't have.
    const linkId = await createLoginLink(contactEmail);
    const consumeRes = await api<{ tenantId: string }>("/login/consume", {
      method: "POST",
      headers: { "X-Coldstart-Client": "dashboard" },
      body: JSON.stringify({ token: linkId }),
    });
    expect(consumeRes.status).toBe(200);
    expect(consumeRes.body.tenantId).toBeTruthy();
    // api() (unlike helpers.createDashboardSession) doesn't expose the raw
    // Set-Cookie header, so the rest of this journey drives the
    // dashboard-session leg via the SAME bearer->cookie exchange
    // dashboard-session.test.ts already proves works end to end — the point
    // under test here is what happens AFTER a session exists, not how it was
    // minted (magic-link vs token-paste mint the identical session shape).
    const session = await createDashboardSession(originalToken);

    // 2. Now signed in (session cookie), rotate — this is the point of the
    // whole journey: the OLD token (possibly the very thing that got lost/
    // leaked) must stop working immediately.
    const rotateRes = await cookieApi<RotateResult>("/token/rotate", session, { method: "POST", csrf: true });
    expect(rotateRes.status).toBe(200);
    const newToken = rotateRes.body.token;

    const oldTokenCheck = await api("/account", { token: originalToken });
    expect(oldTokenCheck.status).toBe(401);
    const newTokenCheck = await api<{ brand: string }>("/account", { token: newToken });
    expect(newTokenCheck.status).toBe(200);
    expect((newTokenCheck.body as unknown as { brand: string }).brand).toBe("Lost Token Journey Co");

    // 3. The dashboard session does NOT survive the rotation, deliberately.
    // This assertion used to read the other way — the session authenticates
    // through a separate resolver (require-auth.ts) that never consults
    // `api_token_hash`, so rotation left it alive — and that made step 2's
    // promise hollow: the whole point of the journey is that a leaked
    // credential stops working, and a leaked token exchanged once for a cookie
    // kept full tenant authority for 30 more days, including the authority to
    // rotate again and lock the owner out (BLOCKING-3,
    // docs/adversarial/audit-dashboard-idempotency-2026-08-06.md). Being signed
    // out is the cost of that containment; the tenant signs back in with the
    // token they were just shown.
    const afterRotation = await cookieApi("/account", session);
    expect(afterRotation.status).toBe(401);
    const backIn = await createDashboardSession(newToken);
    expect((await cookieApi("/account", backIn)).status).toBe(200);
  });
});
