import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleMcpRequest } from "../src/mcp/handler.js";
import { signup } from "./helpers.js";

// FOUNDER RULE: customer- and agent-facing surfaces never reveal which upstream
// provider we use, our internal hostnames, env-var names, or runbook text
// (docs/adversarial/sweep-vendor-leak-2026-08-05.md).
//
// In-class sibling of wave 1's vendor-identity sweep, at the MCP transport.
// handler.ts's tools/call catch graded the throw by `err.name` and routed
// everything named through toErrorResponse — but a NON-Error throw has no
// `name`, so it fell to a `String(err)` fallthrough that shipped the raw text
// to the tenant verbatim. That is the exact leak the named-class branch above
// it exists to close, reachable by any path that rejects with a non-Error
// value (a thrown string/object from a vendor SDK or a hand-rolled reject),
// and by an Error whose `name` was blanked.
//
// Driven through the REAL handleMcpRequest with REAL token resolution: only the
// TENANT namespace is swapped, so auth, dispatch, and the catch block are the
// production code path.

/**
 * The real env with ONLY the DO namespace replaced, so `resolveTenantFromToken`
 * still does its genuine D1 token lookup against the real bindings and the tool
 * dispatch reaches a stub that throws what we hand it.
 */
function envWithThrowingStub(thrown: unknown): Env {
  return {
    ...env,
    TENANT: {
      idFromName: (name: string) => env.TENANT.idFromName(name),
      get: () => ({
        account: async () => {
          throw thrown;
        },
      }),
    },
  } as unknown as Env;
}

async function callAccountTool(thrown: unknown, token: string): Promise<string> {
  // The 500-grade path console.errors the raw throw for operators — that is the
  // CORRECT destination for this detail, so silence it rather than assert on it.
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await handleMcpRequest(envWithThrowingStub(thrown), `Bearer ${token}`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "account", arguments: {} },
    });
    const result = (res.body as { result: { content: { text: string }[]; isError?: boolean } }).result;
    expect(result.isError).toBe(true);
    return result.content.map((c) => c.text).join(" ");
  } finally {
    spy.mockRestore();
  }
}

describe("MCP tools/call — a NON-Error throw is customer-safe, never returned verbatim", () => {
  it("a thrown STRING carrying vendor identity + internals never reaches the agent", async () => {
    const { token } = await signup("Mcp Nonerror Co", "founder@mcpnonerror.test");
    // Every shape the vendor-leak sweep bans, in the one value the old
    // fallthrough would have stringified straight into the response.
    const leaky =
      "inboxkit upstream https://internal.inboxkit.example/v2/register failed from 10.4.2.9 " +
      "(check INBOXKIT_API_KEY / ACTIVATION.md) token=sk_live_abcdef0123456789ZZZZ";

    const text = await callAccountTool(leaky, token);

    for (const marker of [
      "inboxkit",
      "InboxKit",
      "internal.inboxkit.example",
      "https://",
      "10.4.2.9",
      "INBOXKIT_API_KEY",
      "ACTIVATION.md",
      "sk_live_abcdef0123456789ZZZZ",
    ]) {
      expect(text).not.toContain(marker);
    }
    // Positively the generic translator body — not merely "scrubbed".
    expect(JSON.parse(text)).toEqual({ error: "internal error", code: "internal" });
  });

  it("a thrown OBJECT is not stringified into the response either", async () => {
    const { token } = await signup("Mcp Nonerror Obj Co", "founder@mcpnonerrorobj.test");
    const text = await callAccountTool(
      { provider: "inboxkit", endpoint: "https://internal.inboxkit.example/v2/buy", apiKey: "sk_live_objleak" },
      token,
    );
    for (const marker of ["inboxkit", "internal.inboxkit.example", "sk_live_objleak", "apiKey"]) {
      expect(text).not.toContain(marker);
    }
    expect(JSON.parse(text)).toEqual({ error: "internal error", code: "internal" });
  });

  it("an Error whose name was blanked takes the same customer-safe path", async () => {
    const { token } = await signup("Mcp Blank Name Co", "founder@mcpblankname.test");
    const err = new Error("inboxkit rejected the call: see ACTIVATION.md, key INBOXKIT_API_KEY");
    err.name = "";

    const text = await callAccountTool(err, token);

    for (const marker of ["inboxkit", "ACTIVATION.md", "INBOXKIT_API_KEY"]) {
      expect(text).not.toContain(marker);
    }
    expect(JSON.parse(text)).toEqual({ error: "internal error", code: "internal" });
  });

  it("a NAMED error class still gets its OWN mapped body — the fix did not flatten everything to 'internal'", async () => {
    const { token } = await signup("Mcp Named Co", "founder@mcpnamed.test");
    const err = new Error("campaign camp_nope not found");
    err.name = "NotFoundError";

    const text = await callAccountTool(err, token);

    expect(JSON.parse(text)).toEqual({ error: "campaign camp_nope not found" });
  });
});
