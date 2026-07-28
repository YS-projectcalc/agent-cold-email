import { describe, expect, it } from "vitest";
import { api, createDashboardSession, mintTenantWithToken } from "./helpers.js";

// Auth-surface fix (2026-07-28): TOKEN_PREFIX moved from `cs_test_` to
// `cr_live_` (auth.ts) — brand-correct (Coldrig) and mode-honest (the
// platform is now live with real billing). Resolution (require-auth.ts's
// resolveTenantFromToken) hashes the FULL presented string and looks that
// hash up in `tenants_index` — it never inspects a prefix — so a token
// minted before this change must keep authenticating FOREVER. These tests
// prove that grandfathering holds across every credential-consuming
// surface: the plain HTTP API, the hosted MCP JSON-RPC endpoint, and the
// dashboard's bearer->cookie-session exchange.

const LEGACY_TOKEN = "cs_test_deadbeef00112233445566778899aabbccddeeff00112233445566778899";

describe("legacy cs_test_-prefixed tokens remain valid forever (prefix-blind hash lookup)", () => {
  it("authenticates on the plain HTTP API (GET /account)", async () => {
    const { tenantId } = await mintTenantWithToken("Legacy API Co", "demo", LEGACY_TOKEN);
    const res = await api<{ brand: string }>("/account", { token: LEGACY_TOKEN });
    expect(res.status).toBe(200);
    expect((res.body as unknown as { brand: string }).brand).toBe("Legacy API Co");
    void tenantId;
  });

  it("authenticates on the hosted MCP JSON-RPC endpoint (tools/call account)", async () => {
    await mintTenantWithToken("Legacy MCP Co", "demo", `${LEGACY_TOKEN}-mcp`);
    const res = await api<{ result?: { content: { type: string; text: string }[] }; error?: unknown }>("/mcp", {
      method: "POST",
      token: `${LEGACY_TOKEN}-mcp`,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account", arguments: {} } }),
    });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    const parsed = JSON.parse(res.body.result!.content[0]!.text) as { brand: string };
    expect(parsed.brand).toBe("Legacy MCP Co");
  });

  it("authenticates on the dashboard's bearer->cookie-session exchange (POST /dashboard/session)", async () => {
    await mintTenantWithToken("Legacy Dashboard Co", "demo", `${LEGACY_TOKEN}-dash`);
    const session = await createDashboardSession(`${LEGACY_TOKEN}-dash`);
    expect(session.tenantId).toBeTruthy();
    const res = await api("/account", { headers: { cookie: session.cookie } });
    expect(res.status).toBe(200);
  });
});
