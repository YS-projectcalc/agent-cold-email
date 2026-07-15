import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { signup } from "./helpers.js";

// SECONDARY (brief) — accept `X-API-Key: <token>` as equivalent to
// `Authorization: Bearer <token>` when Authorization is absent (Smithery's
// gateway reserves Authorization). Authorization wins if both present. Same
// hashing/constant-time resolution path; a garbage key is rejected.

async function getAccount(headers: Record<string, string>) {
  const res = await SELF.fetch("https://example.com/account", { headers });
  return { status: res.status, body: await res.text() };
}

describe("X-API-Key auth alternative (HTTP surface)", () => {
  it("authenticates a request presenting only X-API-Key", async () => {
    const { token } = await signup("XApiKey Co", "xapikey@example.com");
    const res = await getAccount({ "X-API-Key": token });
    expect(res.status).toBe(200);
  });

  it("Authorization wins when BOTH are present (valid bearer + garbage key -> 200)", async () => {
    const { token } = await signup("XApiKey Precedence Co", "prec@example.com");
    const res = await getAccount({ Authorization: `Bearer ${token}`, "X-API-Key": "garbage-not-a-token" });
    expect(res.status).toBe(200);
  });

  it("Authorization wins when present-but-INVALID — does NOT fall back to a valid X-API-Key (fail closed)", async () => {
    const { token } = await signup("XApiKey Failclosed Co", "fc@example.com");
    const res = await getAccount({ Authorization: "Bearer wrong-token", "X-API-Key": token });
    expect(res.status).toBe(401);
  });

  it("rejects a garbage X-API-Key", async () => {
    const res = await getAccount({ "X-API-Key": "cs_test_deadbeef_not_real" });
    expect(res.status).toBe(401);
  });
});

describe("X-API-Key auth alternative (MCP transport)", () => {
  async function mcpToolsCall(headers: Record<string, string>) {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account", arguments: {} } }),
    });
    return (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  }

  it("resolves the tenant from X-API-Key on tools/call (not a -32001 auth error)", async () => {
    const { token } = await signup("XApiKey MCP Co", "mcp@example.com");
    const body = await mcpToolsCall({ "X-API-Key": token });
    expect(body.error?.code).not.toBe(-32001);
    expect(body.result).toBeDefined();
  });

  it("rejects a garbage X-API-Key on tools/call with the -32001 auth error", async () => {
    const body = await mcpToolsCall({ "X-API-Key": "not-a-real-token" });
    expect(body.error?.code).toBe(-32001);
  });
});
