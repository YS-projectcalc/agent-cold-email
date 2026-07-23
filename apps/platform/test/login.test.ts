import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateDashboardSessionId, hashApiToken } from "../src/auth.js";
import { insertLoginLink } from "../src/db.js";
import { RealOpsMailer } from "../src/ops-mail/real-ops-mailer.js";
import { api, signup, type ApiResult } from "./helpers.js";

// Magic-link login (design docs/research/human-signup-magic-link-design-
// 2026-07-22.md §1; adversary round 1 2026-07-23).

interface LoginRequestBody {
  ok: true;
  message: string;
}
type LoginConsumeBody = { tenantId: string } | { tenants: { tenantId: string; brand: string }[] } | { error: string };

/** Mints a login_links row DIRECTLY (bypassing POST /login + the email send
 * entirely) — the raw token id is never returned by the real API (enumeration
 * safety), so tests need their own way to obtain one to exercise
 * POST /login/consume in isolation. Mirrors helpers.ts's mintTenant()
 * bypass-the-real-flow pattern. */
async function createLoginLink(contactEmail: string, opts?: { expiresInMs?: number }): Promise<string> {
  const id = generateDashboardSessionId();
  const tokenHash = await hashApiToken(id, env.TOKEN_HASH_PEPPER);
  const now = Date.now();
  await insertLoginLink(env, {
    tokenHash,
    contactEmail: contactEmail.toLowerCase(),
    createdAt: now,
    expiresAt: now + (opts?.expiresInMs ?? 15 * 60 * 1000),
  });
  return id;
}

async function consumeLogin(token: string, opts?: { tenantId?: string; csrf?: boolean }): Promise<ApiResult<LoginConsumeBody>> {
  const body: Record<string, unknown> = { token };
  if (opts?.tenantId !== undefined) body.tenantId = opts.tenantId;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.csrf !== false) headers["X-Coldstart-Client"] = "dashboard";
  return api<LoginConsumeBody>("/login/consume", { method: "POST", headers, body: JSON.stringify(body) });
}

function requestLogin(email: string, ip: string): Promise<ApiResult<LoginRequestBody>> {
  return api<LoginRequestBody>("/login", {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify({ email }),
  });
}

async function loginLinkCount(contactEmail: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM login_links WHERE contact_email = ?`)
    .bind(contactEmail.toLowerCase())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("POST /login — enumeration-safe (§1.3)", () => {
  it("returns an IDENTICAL 200 body for an existing vs a never-registered email", async () => {
    await signup("Enum Co", "enum-exists@login-test.example");
    const exists = await requestLogin("enum-exists@login-test.example", "198.51.100.10");
    const missing = await requestLogin("enum-never-registered@login-test.example", "198.51.100.11");

    expect(exists.status).toBe(missing.status);
    expect(exists.body).toEqual(missing.body);
    expect(exists.status).toBe(200);
    expect(exists.body.ok).toBe(true);
  });

  it("inserts a login_links row for an existing email, and none for an unknown one", async () => {
    await signup("Enum Row Co", "enum-row@login-test.example");
    await requestLogin("enum-row@login-test.example", "198.51.100.12");
    await requestLogin("enum-row-unknown@login-test.example", "198.51.100.13");

    expect(await loginLinkCount("enum-row@login-test.example")).toBe(1);
    expect(await loginLinkCount("enum-row-unknown@login-test.example")).toBe(0);
  });

  it("does not email (no login_links row) a SUSPENDED tenant's contact address", async () => {
    const { tenantId } = await signup("Enum Suspended Co", "enum-suspended@login-test.example");
    await env.DB.prepare(`UPDATE tenants_index SET status = 'suspended' WHERE id = ?`).bind(tenantId).run();

    const res = await requestLogin("enum-suspended@login-test.example", "198.51.100.14");
    expect(res.status).toBe(200);
    expect(await loginLinkCount("enum-suspended@login-test.example")).toBe(0);
  });
});

describe("POST /login — lowercase email normalization (adversary r1 NB4)", () => {
  it("signup normalizes contact_email to lowercase on write", async () => {
    const { tenantId } = await signup("Mixed Case Co", "Mixed.Case@Example.com");
    const row = await env.DB.prepare(`SELECT contact_email FROM tenants_index WHERE id = ?`).bind(tenantId).first<{ contact_email: string }>();
    expect(row?.contact_email).toBe("mixed.case@example.com");
  });

  it("a login request in a DIFFERENT case than the signup still finds the tenant (RED on old code: exact-match SQL comparison against an unnormalized column)", async () => {
    await signup("Mixed Case Login Co", "Mixed.Case.Login@Example.com");
    const res = await requestLogin("MIXED.CASE.LOGIN@EXAMPLE.COM", "198.51.100.15");
    expect(res.status).toBe(200);
    expect(await loginLinkCount("mixed.case.login@example.com")).toBe(1);
  });
});

describe("POST /login/consume — single-tenant auto-complete (§1.4)", () => {
  it("consumes the token and mints a dashboard cookie session", async () => {
    const { tenantId } = await signup("Consume Co", "consume@login-test.example");
    const token = await createLoginLink("consume@login-test.example");

    const res = await consumeLogin(token);
    expect(res.status).toBe(200);
    expect((res.body as { tenantId: string }).tenantId).toBe(tenantId);

    // The mint reused mintDashboardSession — same cookie/CSRF/authVia path
    // as the bearer exchange (dashboard-session.test.ts already proves the
    // cookie itself works end to end); here we prove a REAL session row
    // exists for this tenant.
    const sessionRow = await env.DB.prepare(`SELECT COUNT(*) as n FROM dashboard_sessions WHERE tenant_id = ?`).bind(tenantId).first<{ n: number }>();
    expect(sessionRow?.n).toBe(1);
  });
});

describe("POST /login/consume — single-use (adversary-held: atomic changes()===1)", () => {
  it("a replay of an already-consumed token is rejected 401 and mints NO second session", async () => {
    const { tenantId } = await signup("Replay Co", "replay@login-test.example");
    const token = await createLoginLink("replay@login-test.example");

    const first = await consumeLogin(token);
    expect(first.status).toBe(200);
    const second = await consumeLogin(token);
    expect(second.status).toBe(401);

    const sessionRow = await env.DB.prepare(`SELECT COUNT(*) as n FROM dashboard_sessions WHERE tenant_id = ?`).bind(tenantId).first<{ n: number }>();
    expect(sessionRow?.n).toBe(1);
  });

  it("two CONCURRENT consumes of the same token mint exactly ONE session (RED on a naive read-then-write consume)", async () => {
    const { tenantId } = await signup("Race Co", "race@login-test.example");
    const token = await createLoginLink("race@login-test.example");

    const [a, b] = await Promise.all([consumeLogin(token), consumeLogin(token)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);

    const sessionRow = await env.DB.prepare(`SELECT COUNT(*) as n FROM dashboard_sessions WHERE tenant_id = ?`).bind(tenantId).first<{ n: number }>();
    expect(sessionRow?.n).toBe(1);
  });
});

describe("POST /login/consume — expiry", () => {
  it("an expired link is rejected 401, distinct from a garbage token", async () => {
    await signup("Expiry Login Co", "expiry-login@login-test.example");
    const token = await createLoginLink("expiry-login@login-test.example", { expiresInMs: -1000 });

    const res = await consumeLogin(token);
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/invalid|expired/i);
  });
});

describe("GET never consumes (prefetch-safety, §1.4)", () => {
  it("a raw GET on /login/consume does not match any route (404) and leaves the token usable", async () => {
    await signup("Prefetch Co", "prefetch@login-test.example");
    const token = await createLoginLink("prefetch@login-test.example");

    const getRes = await SELF.fetch(`https://example.com/login/consume?token=${encodeURIComponent(token)}`);
    expect(getRes.status).toBe(404);

    const postRes = await consumeLogin(token);
    expect(postRes.status).toBe(200);
  });
});

describe("POST /login/consume — CSRF header required (adversary r1 NB3)", () => {
  it("rejects a consume WITHOUT X-Coldstart-Client with 403, and the token remains unconsumed", async () => {
    await signup("CSRF Consume Co", "csrf-consume@login-test.example");
    const token = await createLoginLink("csrf-consume@login-test.example");

    const withoutHeader = await consumeLogin(token, { csrf: false });
    expect(withoutHeader.status).toBe(403);

    const withHeader = await consumeLogin(token);
    expect(withHeader.status).toBe(200);
  });
});

describe("POST /login/consume — multi-tenant picker (§1.5)", () => {
  it("returns a picker list WITHOUT consuming when the email owns several active tenants", async () => {
    const first = await signup("Picker Co A", "picker@login-test.example");
    const second = await signup("Picker Co B", "picker@login-test.example");
    const token = await createLoginLink("picker@login-test.example");

    const picked = await consumeLogin(token);
    expect(picked.status).toBe(200);
    const tenants = (picked.body as { tenants: { tenantId: string; brand: string }[] }).tenants;
    expect(tenants.map((t) => t.tenantId).sort()).toEqual([first.tenantId, second.tenantId].sort());

    // Not consumed yet — the SAME token still resolves to the picker again.
    const again = await consumeLogin(token);
    expect(again.status).toBe(200);
    expect("tenants" in again.body).toBe(true);
  });

  it("rejects a tenantId that is NOT one of this email's own tenants, without consuming", async () => {
    await signup("Picker Guard A", "picker-guard@login-test.example");
    await signup("Picker Guard B", "picker-guard@login-test.example");
    const { tenantId: unrelatedTenantId } = await signup("Unrelated Co", "unrelated@login-test.example");
    const token = await createLoginLink("picker-guard@login-test.example");

    const badPick = await consumeLogin(token, { tenantId: unrelatedTenantId });
    expect(badPick.status).toBe(403);

    // Still usable afterward — the bad pick did not burn the token.
    const list = await consumeLogin(token);
    expect(list.status).toBe(200);
    expect("tenants" in list.body).toBe(true);
  });

  it("consumes on the picker's confirmed pick and mints that tenant's session", async () => {
    const first = await signup("Picker Confirm A", "picker-confirm@login-test.example");
    await signup("Picker Confirm B", "picker-confirm@login-test.example");
    const token = await createLoginLink("picker-confirm@login-test.example");

    await consumeLogin(token); // the list call, not consumed
    const confirmed = await consumeLogin(token, { tenantId: first.tenantId });
    expect(confirmed.status).toBe(200);
    expect((confirmed.body as { tenantId: string }).tenantId).toBe(first.tenantId);

    const replay = await consumeLogin(token, { tenantId: first.tenantId });
    expect(replay.status).toBe(401);
  });
});

describe("POST /login — rate limits (§1.6, reuses SIGNUP_LIMITER)", () => {
  it("throttles a single email past its per-minute cap (3/min)", async () => {
    const ip = "203.0.113.40"; // TEST-NET-3, fixed per this test's own email bucket
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await requestLogin("burst-email@ratelimit-login-test.example", ip);
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(3);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });

  it("throttles a single IP past its per-minute cap (5/min) across DIFFERENT emails", async () => {
    const ip = "203.0.113.41";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await requestLogin(`burst-ip-${i}@ratelimit-login-test.example`, ip);
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200).length).toBe(5);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });

  it("does not throttle distinct IP+email pairs against each other", async () => {
    const a = await requestLogin("distinct-a@ratelimit-login-test.example", "203.0.113.50");
    const b = await requestLogin("distinct-b@ratelimit-login-test.example", "203.0.113.51");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe("POST /login — Turnstile (§2.3, dark until TURNSTILE_SECRET is configured)", () => {
  it("is a no-op when TURNSTILE_SECRET is unset (every other test in this file already proves this — sanity check)", async () => {
    expect(env.TURNSTILE_SECRET).toBeFalsy();
    const res = await requestLogin("turnstile-dark@login-test.example", "198.51.100.70");
    expect(res.status).toBe(200);
  });

  it("rejects with 400 when TURNSTILE_SECRET is configured and no turnstileToken is submitted, gated BEFORE the tenant lookup", async () => {
    await signup("Turnstile Co", "turnstile-gate@login-test.example");
    const original = env.TURNSTILE_SECRET;
    env.TURNSTILE_SECRET = "test-turnstile-secret";
    try {
      const res = await requestLogin("turnstile-gate@login-test.example", "198.51.100.71");
      expect(res.status).toBe(400);
      // Gated before the lookup — no login_links row was created either.
      expect(await loginLinkCount("turnstile-gate@login-test.example")).toBe(0);
    } finally {
      env.TURNSTILE_SECRET = original;
    }
  });
});

describe("POST /login — send fires via ctx.waitUntil, never inline-awaited (adversary r1 NB2)", () => {
  it("responds fast even when the mail channel is slow (RED on code that awaits the send before responding)", async () => {
    await signup("Slow Mail Co", "slow-mail@login-test.example");

    // env.OPS_EMAIL is a truthy Miniflare-simulated `send_email` binding in
    // THIS test harness (declared via wrangler.toml's `[[send_email]]`, not a
    // `.dev.vars` key, so hermetic-env.ts's neutralization does not apply to
    // it) — createOpsMailer therefore picks RealOpsMailer here, not
    // SandboxOpsMailer, exactly as it would in production. Patch the class
    // actually exercised, not the one env.ts's doc comment assumes.
    const originalSend = RealOpsMailer.prototype.send;
    RealOpsMailer.prototype.send = function (...args: Parameters<typeof originalSend>) {
      return new Promise((resolve) => {
        setTimeout(() => resolve(originalSend.apply(this, args)), 3000);
      });
    };
    try {
      const start = Date.now();
      const res = await requestLogin("slow-mail@login-test.example", "198.51.100.60");
      const elapsed = Date.now() - start;
      expect(res.status).toBe(200);
      // Inline-awaiting the 3000ms send would blow well past this bound; a
      // ctx.waitUntil-fired send lets the response return immediately.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      RealOpsMailer.prototype.send = originalSend;
    }
  });
});
