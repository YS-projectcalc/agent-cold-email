import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
}
interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string };
}

function rpc(method: string, params?: unknown, id: number | string | null = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

interface ToolListResult {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const EXPECTED_TOOL_NAMES = [
  "setup_infrastructure",
  "infrastructure_status",
  "launch_campaign",
  "campaign_results",
  "metrics",
  "inbox",
  "thread",
  "reply",
  "mark",
  "pause",
  "pause_all",
  "account",
  // SPEC.md §19.5 — tools 13-15 (M1 dashboard+inbox brief).
  "get_dashboard",
  "configure_dashboard",
  "label_thread",
];

describe("POST /mcp — hosted MCP JSON-RPC 2.0 endpoint", () => {
  it("GET /mcp returns a discovery info blob, never crashes", async () => {
    const res = await api<{ name: string; transport: string }>("/mcp");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("agent-cold-email");
    expect(res.body.transport).toBe("streamable-http");
  });

  it("initialize returns protocolVersion, serverInfo, capabilities.tools — no auth required", async () => {
    const res = await api<JsonRpcSuccess<{ protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: { tools: unknown } }>>(
      "/mcp",
      { method: "POST", body: rpc("initialize", { protocolVersion: "2025-06-18" }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBe("2025-06-18");
    expect(res.body.result.serverInfo).toEqual({ name: "agent-cold-email", version: "0.1.0" });
    expect(res.body.result.capabilities).toEqual({ tools: {} });
  });

  it("notifications/initialized (a true JSON-RPC notification, no id) gets no response body", async () => {
    const res = await api("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeUndefined();
  });

  it("tools/list returns exactly the 15 AGENTS.md tools with a JSON-Schema inputSchema each — no auth required", async () => {
    const res = await api<JsonRpcSuccess<ToolListResult>>("/mcp", { method: "POST", body: rpc("tools/list") });
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t) => t.name);
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
    expect(res.body.result.tools).toHaveLength(15);
    for (const t of res.body.result.tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toHaveProperty("type", "object");
    }
  });

  // Adversarial panel-03 finding #11: z.toJSONSchema OUTPUT mode marked
  // .default() fields (company, timezone, sendWindow, stopOnReply) as REQUIRED,
  // contradicting the permissive runtime parse + the HTTP shape. INPUT mode
  // makes them optional. FAILS on the old code (old required set includes the
  // defaulted fields).
  it("tools/list marks .default() fields OPTIONAL, matching the runtime parse (finding #11)", async () => {
    const res = await api<JsonRpcSuccess<ToolListResult>>("/mcp", { method: "POST", body: rpc("tools/list") });
    const launch = res.body.result.tools.find((t) => t.name === "launch_campaign");
    expect(launch).toBeDefined();
    const schema = launch!.inputSchema as {
      required?: string[];
      properties: { leads: { items: { required?: string[] } } };
    };

    const required = schema.required ?? [];
    // The genuinely-required fields are present...
    expect(required).toEqual(expect.arrayContaining(["name", "offer", "leads", "sequence"]));
    // ...and the DEFAULTED fields are NOT required (the caller may omit them).
    expect(required).not.toContain("timezone");
    expect(required).not.toContain("sendWindow");
    expect(required).not.toContain("stopOnReply");

    // Inside a lead, `company` (a .default("")) is likewise optional.
    const leadRequired = schema.properties.leads.items.required ?? [];
    expect(leadRequired).toEqual(expect.arrayContaining(["email", "firstName"]));
    expect(leadRequired).not.toContain("company");
  });

  it("unknown JSON-RPC method returns a proper -32601 error object", async () => {
    const res = await api<JsonRpcFailure>("/mcp", { method: "POST", body: rpc("not/a/real/method") });
    expect(res.body.error.code).toBe(-32601);
    expect(res.body.error.message).toMatch(/method not found/i);
  });

  it("tools/call with a missing/invalid token returns a JSON-RPC error, never crashes, HTTP 401", async () => {
    const res = await api<JsonRpcFailure>("/mcp", {
      method: "POST",
      body: rpc("tools/call", { name: "account", arguments: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(-32001);

    const badToken = await api<JsonRpcFailure>("/mcp", {
      method: "POST",
      token: "cs_live_not-a-real-token",
      body: rpc("tools/call", { name: "account", arguments: {} }),
    });
    expect(badToken.status).toBe(401);
  });

  it("tools/call rejects an unknown tool name and invalid arguments with -32602", async () => {
    const { token } = await signup("MCP Bad Args Co", "badargs@mcp-test.example");

    const unknownTool = await api<JsonRpcFailure>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "not_a_real_tool", arguments: {} }),
    });
    expect(unknownTool.body.error.code).toBe(-32602);

    const badArgs = await api<JsonRpcFailure>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "thread", arguments: {} }), // missing required threadId
    });
    expect(badArgs.body.error.code).toBe(-32602);
  });

  it("tools/call dispatches to the SAME TenantDO methods the HTTP facade uses, and surfaces tool errors via isError", async () => {
    const { token } = await signup("MCP Dispatch Co", "dispatch@mcp-test.example");

    const setup = await api<JsonRpcSuccess<ToolCallResult>>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", {
        name: "setup_infrastructure",
        arguments: {
          brand: "MCP Dispatch Co",
          primaryDomain: "mcpdispatch.com",
          domains: 1,
          inboxesEach: 1,
          persona: "Sender",
          physicalAddress: "1 MCP St",
          senderIdentity: "Sender <s@mcpdispatch.com>",
        },
      }),
    });
    expect(setup.status).toBe(200);
    const setupPayload = JSON.parse(setup.body.result.content[0]!.text) as { jobId: string };
    expect(setupPayload.jobId).toMatch(/^job_/);

    const status = await api<JsonRpcSuccess<ToolCallResult>>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "infrastructure_status", arguments: {} }),
    });
    const statusPayload = JSON.parse(status.body.result.content[0]!.text) as { domains: number; mailboxes: number };
    expect(statusPayload.domains).toBe(1);
    expect(statusPayload.mailboxes).toBe(1);

    // A NotFoundError thrown deep inside the DO (campaign_results on a
    // nonexistent id) must surface as a tool-execution error (isError:true
    // inside the result), NOT a top-level JSON-RPC protocol error — the
    // JSON-RPC call itself succeeded, the TOOL failed.
    const badLookup = await api<JsonRpcSuccess<ToolCallResult>>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "campaign_results", arguments: { campaignId: "camp_does_not_exist" } }),
    });
    expect(badLookup.status).toBe(200);
    expect(badLookup.body.result.isError).toBe(true);
    expect(badLookup.body.result.content[0]!.text).toMatch(/not found/i);
  });

  // SECURITY (CRITICAL — B5 brief): the tenant is resolved FRESH from the
  // Authorization header on EVERY call. This proves two different tokens,
  // interleaved on the same /mcp route, never see each other's data — a
  // cached-tenant bug would leak tenant A's account into tenant B's call.
  it("resolves the tenant fresh per call — two tokens interleaved on /mcp never cross-contaminate", async () => {
    const tenantA = await signup("MCP Isolation A", "iso-a@mcp-test.example");
    const tenantB = await signup("MCP Isolation B", "iso-b@mcp-test.example");

    async function accountVia(token: string): Promise<{ tenantId: string; brand: string }> {
      const res = await api<JsonRpcSuccess<ToolCallResult>>("/mcp", {
        method: "POST",
        token,
        body: rpc("tools/call", { name: "account", arguments: {} }),
      });
      return JSON.parse(res.body.result.content[0]!.text) as { tenantId: string; brand: string };
    }

    // Interleave A, B, A, B, A — a cached-tenant bug would show stale data
    // (e.g. tenant A's brand leaking into a call made with tenant B's token).
    const sequence: { token: string; expectId: string; expectBrand: string }[] = [
      { token: tenantA.token, expectId: tenantA.tenantId, expectBrand: "MCP Isolation A" },
      { token: tenantB.token, expectId: tenantB.tenantId, expectBrand: "MCP Isolation B" },
      { token: tenantA.token, expectId: tenantA.tenantId, expectBrand: "MCP Isolation A" },
      { token: tenantB.token, expectId: tenantB.tenantId, expectBrand: "MCP Isolation B" },
      { token: tenantA.token, expectId: tenantA.tenantId, expectBrand: "MCP Isolation A" },
    ];

    for (const step of sequence) {
      const account = await accountVia(step.token);
      expect(account.tenantId).toBe(step.expectId);
      expect(account.brand).toBe(step.expectBrand);
    }

    expect(tenantA.tenantId).not.toBe(tenantB.tenantId);
  });
});
