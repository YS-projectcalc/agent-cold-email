import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

// MCP parity for SPEC.md §20 — the get_byo_domains/configure_byo_domain tools
// dispatch to the SAME TenantDO facade the HTTP routes call
// (byo-domains-route.test.ts / byo-intake.test.ts already cover the engine
// logic in depth); this exercises the actual JSON-RPC surface end-to-end so a
// regression in the tools.ts/schemas.ts wiring itself is caught, not just the
// underlying engine functions.

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

function rpc(method: string, params?: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
}

async function callTool<T = unknown>(token: string, name: string, args: unknown): Promise<T> {
  const res = await api<JsonRpcSuccess<{ content: { type: string; text: string }[]; isError?: boolean }>>("/mcp", {
    method: "POST",
    token,
    body: rpc("tools/call", { name, arguments: args }),
  });
  expect(res.status).toBe(200);
  expect(res.body.result.isError).not.toBe(true);
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

describe("MCP configure_byo_domain / get_byo_domains — end-to-end through /mcp", () => {
  it("registers, polls DNS to active, and provisions managed mailboxes via the MCP tool surface", async () => {
    const { token } = await signup("MCP Byo Co", "mcpbyo@example.com");

    const registered = await callTool<{ domainId: string; byoStatus: string; dnsMode: string }>(token, "configure_byo_domain", {
      action: "register",
      domain: "mcp-delegated-managed.com",
      domainRelationship: "fresh_standalone",
    });
    expect(registered.byoStatus).toBe("pending_dns");
    expect(registered.dnsMode).toBe("we_manage_zone");

    const polled = await callTool<{ byoStatus: string; verified: boolean }>(token, "configure_byo_domain", {
      action: "poll_dns",
      id: registered.domainId,
    });
    expect(polled).toMatchObject({ byoStatus: "active", verified: true });

    const provisioned = await callTool<{ mailboxEmails: string[] }>(token, "configure_byo_domain", {
      action: "request_managed_mailboxes",
      id: registered.domainId,
      count: 1,
    });
    expect(provisioned.mailboxEmails).toHaveLength(1);

    const list = await callTool<{ domainId: string; mailboxCount: number }[]>(token, "get_byo_domains", {});
    expect(list.find((d) => d.domainId === registered.domainId)?.mailboxCount).toBe(1);
  });

  it("rejects a malformed tool call (missing domainRelationship for register) as a JSON-RPC -32602 error, not a crash", async () => {
    // The zod .refine() failure is caught at the SCHEMA-VALIDATION layer
    // (mcp/handler.ts, BEFORE the tool's call() ever runs) — a top-level
    // JSON-RPC error, not a result-with-isError:true (that shape is reserved
    // for an error the TOOL HANDLER itself throws, e.g. a ValidationError
    // from the engine — see the acknowledge_consent-without-primary case
    // covered at the engine/route layers already).
    const { token } = await signup("MCP Byo Bad Co", "mcpbyobad@example.com");
    interface JsonRpcFailure {
      jsonrpc: "2.0";
      id: number;
      error: { code: number; message: string };
    }
    const res = await api<JsonRpcFailure>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "configure_byo_domain", arguments: { action: "register", domain: "mcp-bad.com" } }),
    });
    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toContain("configure_byo_domain");
  });

  it("requires consent for a primary domain via the tool surface before it can proceed", async () => {
    const { token } = await signup("MCP Byo Primary Co", "mcpbyoprimary@example.com");
    const registered = await callTool<{ domainId: string; byoStatus: string }>(token, "configure_byo_domain", {
      action: "register",
      domain: "mcp-primary.com",
      domainRelationship: "is_primary",
    });
    expect(registered.byoStatus).toBe("pending_consent");

    const acked = await callTool<{ byoStatus: string }>(token, "configure_byo_domain", {
      action: "acknowledge_consent",
      id: registered.domainId,
      acknowledged: true,
    });
    expect(acked.byoStatus).toBe("pending_dns");
  });
});
