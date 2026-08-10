import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_DASHBOARD_SESSIONS_PER_TENANT } from "../src/db.js";
import { api, cookieApi, createDashboardSession, signup } from "./helpers.js";
import type { DashboardSession } from "./helpers.js";

// BLOCKING-3, docs/adversarial/audit-dashboard-idempotency-2026-08-06.md.
//
// `POST /token/rotate` documents itself as THE recovery path for a leaked
// bearer token, and it rotated the token while every dashboard session minted
// from that token kept full tenant authority for its remaining 30 days —
// including the authority to rotate the token AGAIN and lock the real owner
// out. The audit executed it: five cookies stayed 200 across a rotation.
//
// Mint is also unbounded — 25 replays of `POST /dashboard/session` produced 25
// independent durable sessions — so containment needs a ceiling as well as a
// revoke.

/** Is this cookie still a valid tenant credential? */
async function sessionAlive(session: DashboardSession): Promise<number> {
  const res = await cookieApi("/account", session);
  return res.status;
}

function countSessions(tenantId: string): Promise<number> {
  return env.DB.prepare(`SELECT COUNT(*) as n FROM dashboard_sessions WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<{ n: number }>()
    .then((row) => row?.n ?? 0);
}

describe("B3 — rotating the bearer token revokes every dashboard session it minted", () => {
  it("kills all live sessions, including the one that asked for the rotation", async () => {
    const { tenantId, token } = await signup("Rotate Co", "founder@rotateco.com");
    const sessions = [
      await createDashboardSession(token),
      await createDashboardSession(token),
      await createDashboardSession(token),
    ];
    for (const s of sessions) expect(await sessionAlive(s)).toBe(200);

    const rotated = await api<{ token: string }>("/token/rotate", { method: "POST", token });
    expect(rotated.status).toBe(200);

    for (const s of sessions) expect(await sessionAlive(s)).toBe(401);
    expect(await countSessions(tenantId)).toBe(0);
    // The old bearer is dead too — the half that already worked.
    expect((await api("/account", { token })).status).toBe(401);
  });

  it("leaves the tenant fully recoverable: the new token mints a working session", async () => {
    const { token } = await signup("Recover Co", "founder@recoverco.com");
    const rotated = await api<{ token: string }>("/token/rotate", { method: "POST", token });

    const fresh = await createDashboardSession(rotated.body.token);

    expect(await sessionAlive(fresh)).toBe(200);
  });

  it("a session that rotates cannot keep rotating — its own credential dies with the token", async () => {
    const { token } = await signup("Attacker Co", "founder@attackerco.com");
    const stolen = await createDashboardSession(token);

    const first = await cookieApi("/token/rotate", stolen, { method: "POST", csrf: true });
    expect(first.status).toBe(200);

    const second = await cookieApi("/token/rotate", stolen, { method: "POST", csrf: true });
    expect(second.status).toBe(401);
  });
});

describe("B3 — dashboard session mint is capped per tenant", () => {
  it("keeps the newest sessions and evicts the oldest beyond the cap", async () => {
    const { tenantId, token } = await signup("Cap Co", "founder@capco.com");

    const minted: DashboardSession[] = [];
    for (let i = 0; i < MAX_DASHBOARD_SESSIONS_PER_TENANT + 2; i++) {
      minted.push(await createDashboardSession(token));
    }

    expect(await countSessions(tenantId)).toBe(MAX_DASHBOARD_SESSIONS_PER_TENANT);
    expect(await sessionAlive(minted[0]!)).toBe(401);
    expect(await sessionAlive(minted[1]!)).toBe(401);
    expect(await sessionAlive(minted[2]!)).toBe(200);
    expect(await sessionAlive(minted[minted.length - 1]!)).toBe(200);
  });
});
