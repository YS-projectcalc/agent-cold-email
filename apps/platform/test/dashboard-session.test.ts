import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, cookieApi, createDashboardSession, signup } from "./helpers.js";

// SPEC.md §19.1 [NEW-1] — the dashboard cookie-session exchange + the GLOBAL
// CSRF guard it requires on every cookie-authed mutation across the ENTIRE
// authed surface (not just /dashboard/*).
describe("POST /dashboard/session — cookie exchange", () => {
  it("exchanges a valid bearer token for an httpOnly cookie session scoped to that tenant", async () => {
    const { tenantId, token } = await signup("Dashboard Session Co", "session@dashboard-test.example");
    const session = await createDashboardSession(token);
    expect(session.tenantId).toBe(tenantId);

    // The cookie authenticates GET /account exactly like the bearer token would.
    const viaCookie = await cookieApi<{ tenantId: string }>("/account", session);
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body.tenantId).toBe(tenantId);
  });

  it("rejects an invalid/unknown token with 401 and sets no cookie", async () => {
    const res = await SELF.fetch("https://example.com/dashboard/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "cs_test_not-a-real-token" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("cookie-authed requests never touch the SPA path, and behave like bearer auth", () => {
  it("a cookie-authed GET /inbox / GET /campaigns / GET /activity all work (bearer OR cookie)", async () => {
    const { token } = await signup("Cookie Parity Co", "parity@dashboard-test.example");
    const session = await createDashboardSession(token);

    const inbox = await cookieApi("/inbox", session);
    expect(inbox.status).toBe(200);
    const campaigns = await cookieApi("/campaigns", session);
    expect(campaigns.status).toBe(200);
    const activity = await cookieApi("/activity", session);
    expect(activity.status).toBe(200);
  });
});

// §19.1 [NEW-1] DoD anchor: "cookie-authed POST /cancel WITHOUT
// X-Coldstart-Client -> 403". This must hold for EVERY legacy destructive
// route, not just /dashboard/*.
describe("GLOBAL CSRF guard — cookie-authed mutation requires X-Coldstart-Client: dashboard", () => {
  it("cookie-authed POST /cancel WITHOUT the header is rejected 403 (FAILS on the old blanket-'*' auth wiring)", async () => {
    const { token } = await signup("CSRF Cancel Co", "csrf-cancel@dashboard-test.example");
    const session = await createDashboardSession(token);

    const withoutHeader = await cookieApi("/cancel", session, { method: "POST", body: "{}" });
    expect(withoutHeader.status).toBe(403);
  });

  it("cookie-authed POST /cancel WITH the header succeeds", async () => {
    const { token } = await signup("CSRF Cancel Ok Co", "csrf-cancel-ok@dashboard-test.example");
    const session = await createDashboardSession(token);

    const withHeader = await cookieApi("/cancel", session, { method: "POST", body: "{}", csrf: true });
    expect(withHeader.status).toBe(200);
  });

  it("bearer-authed POST /cancel needs NO CSRF header — the guard only gates cookie auth", async () => {
    const { token } = await signup("Bearer Cancel Co", "bearer-cancel@dashboard-test.example");
    const res = await api("/cancel", { method: "POST", token, body: "{}" });
    expect(res.status).toBe(200);
  });

  it("a cookie-authed SAFE GET request needs no CSRF header", async () => {
    const { token } = await signup("CSRF Get Co", "csrf-get@dashboard-test.example");
    const session = await createDashboardSession(token);
    const res = await cookieApi("/account", session);
    expect(res.status).toBe(200);
  });
});

describe("POST /dashboard/logout", () => {
  it("deletes the session row — the cookie can never be replayed afterward (401)", async () => {
    const { token } = await signup("Logout Co", "logout@dashboard-test.example");
    const session = await createDashboardSession(token);

    expect((await cookieApi("/account", session)).status).toBe(200);

    const logout = await cookieApi("/dashboard/logout", session, { method: "POST", body: "{}", csrf: true });
    expect(logout.status).toBe(200);

    const afterLogout = await cookieApi("/account", session);
    expect(afterLogout.status).toBe(401);
  });
});

describe("dashboard session TTL / revocation", () => {
  it("an expired session 401s with an explanatory message, distinct from 'no credential'", async () => {
    const { token } = await signup("Expiry Co", "expiry@dashboard-test.example");
    const session = await createDashboardSession(token);

    // Force the session row's expires_at into the past (real wall-clock TTL,
    // not the tenant's sandboxed virtual clock — see require-auth.ts).
    await env.DB.prepare(`UPDATE dashboard_sessions SET expires_at = ? WHERE tenant_id = ?`)
      .bind(Date.now() - 1000, session.tenantId)
      .run();

    const res = await cookieApi<{ error: string }>("/account", session);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired|invalid/i);
  });

  it("a suspended tenant's cookie session 401s mid-session, exactly like a suspended bearer token would", async () => {
    const { tenantId, token } = await signup("Suspend Mid Co", "suspend-mid@dashboard-test.example");
    const session = await createDashboardSession(token);
    expect((await cookieApi("/account", session)).status).toBe(200);

    await env.DB.prepare(`UPDATE tenants_index SET status = 'suspended' WHERE id = ?`).bind(tenantId).run();

    const afterSuspend = await cookieApi("/account", session);
    expect(afterSuspend.status).toBe(401);
    // The bearer token is equally rejected — same underlying control-plane check.
    const bearerAfterSuspend = await api("/account", { token });
    expect(bearerAfterSuspend.status).toBe(401);
  });
});

// Item 4 (backend gaps brief) — machine-readable 401 `code` field, sourced
// HONESTLY from the same control-plane state that already gates login (never
// from tenant_profile.billing_state/dunning-suspend inside the DO: that state
// enforces the spend-freeze at the intent layer — engine/billing-state.ts's
// assertNotLifecycleFrozen — and deliberately does NOT lock a dunning tenant
// out of login, so it would be dishonest to report `account_suspended` for
// it here). `tenants_index.status` only ever flips away from 'active' via
// the abuse-terminate lane (routes/admin-ops.ts's setTenantIndexStatus) — that
// IS the actual login-blocking suspension, so it is what `account_suspended`
// honestly reports.
describe("machine-readable 401 `code` field (SPEC.md §19.6 suspended-vs-invalid)", () => {
  it("an unknown/garbage bearer token -> code: invalid_token", async () => {
    const res = await api<{ error: string; code: string }>("/account", { token: "cs_test_not-a-real-token" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_token");
  });

  it("no credential at all -> code: invalid_token", async () => {
    const res = await api<{ error: string; code: string }>("/account");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_token");
  });

  it("an unknown/garbage dashboard cookie -> code: invalid_token", async () => {
    const res = await SELF.fetch("https://example.com/account", {
      headers: { cookie: "cs_dashboard_session=not-a-real-session-id" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_token");
  });

  it("a TTL-expired dashboard session -> code: expired_session (distinct from invalid_token)", async () => {
    const { token } = await signup("Expiry Code Co", "expiry-code@dashboard-test.example");
    const session = await createDashboardSession(token);
    await env.DB.prepare(`UPDATE dashboard_sessions SET expires_at = ? WHERE tenant_id = ?`)
      .bind(Date.now() - 1000, session.tenantId)
      .run();

    const res = await cookieApi<{ error: string; code: string }>("/account", session);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("expired_session");
  });

  it("a suspended tenant -> code: account_suspended, for BOTH bearer and cookie auth", async () => {
    const { tenantId, token } = await signup("Suspend Code Co", "suspend-code@dashboard-test.example");
    const session = await createDashboardSession(token);
    await env.DB.prepare(`UPDATE tenants_index SET status = 'suspended' WHERE id = ?`).bind(tenantId).run();

    const bearerRes = await api<{ error: string; code: string }>("/account", { token });
    expect(bearerRes.status).toBe(401);
    expect(bearerRes.body.code).toBe("account_suspended");

    const cookieRes = await cookieApi<{ error: string; code: string }>("/account", session);
    expect(cookieRes.status).toBe(401);
    expect(cookieRes.body.code).toBe("account_suspended");
  });
});
