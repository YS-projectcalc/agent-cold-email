import { Hono } from "hono";
import type { Env } from "../env.js";
import { handleMcpRequest, MCP_INFO } from "../mcp/handler.js";

// Hosted MCP endpoint (streamable HTTP, JSON-RPC 2.0). Deliberately mounted
// OUTSIDE the `requireAuth` Hono middleware group in index.ts: auth here is
// per-JSON-RPC-method (initialize/tools/list are discovery, tools/call is
// tenant-scoped) rather than per-HTTP-request, so the auth decision lives
// inside ../mcp/handler.ts. See src/mcp/README.md.
// Plain `Response` construction throughout (not `c.json`/`c.body`): the
// status code here is a runtime value computed in ../mcp/handler.ts across
// a wide, non-literal range (200/202/400/401), which doesn't fit Hono's
// narrow per-overload status-code typings.
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// /mcp is unauthenticated at the transport (per-JSON-RPC-method auth), so cap
// the body before c.req.json() materializes it. 64 KB comfortably fits any
// tools/call payload while blocking parse-cost amplification (panel-02).
const MCP_BODY_MAX_BYTES = 64 * 1024;

export const mcpRoute = new Hono<{ Bindings: Env }>()
  .get("/mcp", (c) => jsonResponse(MCP_INFO, 200))
  .post("/mcp", async (c) => {
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MCP_BODY_MAX_BYTES) {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } },
        413,
      );
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: invalid JSON body" } }, 400);
    }

    const { status, body } = await handleMcpRequest(
      c.env,
      c.req.header("Authorization") ?? null,
      raw,
      c.req.header("X-API-Key") ?? null,
    );
    if (body === null) return new Response(null, { status });
    return jsonResponse(body, status);
  });
