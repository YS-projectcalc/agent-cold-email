// A direct JSON-RPC 2.0 handler for MCP over streamable HTTP — deliberately
// NOT the Agents SDK `McpAgent` (ARCHITECTURE.md #7 predates this brief's
// "our facade is thin" call): the facade is ~12 tools with no resources,
// prompts, sampling, or SSE streaming needed, so a direct Hono handler
// keeps the surface small and auditable. See ../routes/mcp.ts for the
// transport wiring.
//
// SECURITY (CRITICAL): the tenant is resolved FRESH from the Authorization
// header on every single call to `handleMcpRequest` — nothing here is
// cached across requests/calls. A cached tenant would be a cross-tenant
// data leak the moment two different bearer tokens hit the same route.

import { z } from "zod";
import type { Env } from "../env.js";
import { resolveRequestToken } from "../auth.js";
import { resolveTenantFromToken } from "../require-auth.js";
import { MCP_TOOLS } from "./tools.js";

const SERVER_INFO = { name: "agent-cold-email", version: "0.1.0" };
// No full version-negotiation table here (thin facade, YAGNI) — the server
// echoes back whatever protocolVersion the client requested in `initialize`
// and otherwise defaults to the latest spec date this was built against.
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  /** `null` body = a JSON-RPC notification: per spec, no response is sent. */
  body: Record<string, unknown> | null;
}

function isRequestId(id: unknown): id is string | number | null | undefined {
  return id === undefined || id === null || typeof id === "string" || typeof id === "number";
}

function result(id: string | number | null, res: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: "2.0", id, result: res } };
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

export async function handleMcpRequest(
  env: Env,
  authHeader: string | null,
  raw: unknown,
  apiKeyHeader: string | null = null,
): Promise<McpResponse> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return rpcError(null, -32600, "invalid request: expected a single JSON-RPC 2.0 request object", 400);
  }
  const req = raw as JsonRpcRequest;
  if (!isRequestId(req.id) || typeof req.method !== "string" || req.method.length === 0) {
    return rpcError(isRequestId(req.id) ? (req.id ?? null) : null, -32600, "invalid request: missing/invalid method", 400);
  }

  const id = req.id ?? null;
  const isNotification = req.id === undefined;

  switch (req.method) {
    case "initialize": {
      const params = req.params;
      const requestedVersion =
        typeof params === "object" && params !== null && "protocolVersion" in params && typeof (params as { protocolVersion: unknown }).protocolVersion === "string"
          ? (params as { protocolVersion: string }).protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion: requestedVersion,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    }

    case "notifications/initialized": {
      // A true JSON-RPC notification (no `id`): the spec says send nothing.
      // If a client sent it with an id anyway, ack it politely instead of
      // silently dropping a response it might be waiting on.
      if (isNotification) return { status: 202, body: null };
      return result(id, {});
    }

    case "tools/list": {
      const tools = MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        // INPUT mode: a tool's arguments are what the CALLER sends, so a field
        // with a `.default()` (company, timezone, sendWindow, stopOnReply) is
        // OPTIONAL — the caller may omit it. The default OUTPUT mode marked
        // those `required`, contradicting the permissive runtime parse + the
        // HTTP openapi shape (adversarial panel-03 finding #11).
        inputSchema: z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }),
        // MCP-spec ToolAnnotations (title/readOnlyHint/destructiveHint) —
        // see tools.ts's McpToolAnnotations doc for why each is set.
        annotations: t.annotations,
      }));
      return result(id, { tools });
    }

    case "tools/call": {
      // Accept the bearer token from Authorization OR X-API-Key (Smithery's
      // gateway reserves Authorization) — same resolution as the HTTP surface.
      const token = resolveRequestToken(authHeader, apiKeyHeader);
      const resolved = await resolveTenantFromToken(env, token);
      if (!resolved.ok) return rpcError(id, -32001, resolved.message, 401);

      const params = req.params;
      const toolName = typeof params === "object" && params !== null && "name" in params ? (params as { name: unknown }).name : undefined;
      if (typeof toolName !== "string") return rpcError(id, -32602, "invalid params: 'name' (string) is required");

      const matched = MCP_TOOLS.find((t) => t.name === toolName);
      if (!matched) return rpcError(id, -32602, `invalid params: unknown tool '${toolName}'`);

      const rawArgs =
        typeof params === "object" && params !== null && "arguments" in params ? (params as { arguments: unknown }).arguments : {};
      const parsedArgs = matched.schema.safeParse(rawArgs ?? {});
      if (!parsedArgs.success) {
        // Bare zod messages ("Invalid input: expected number, received
        // undefined") don't say WHICH field failed — prefix each issue with
        // its dot-path (z.core.toDotPath, e.g. "sendWindow.startHour") so an
        // agent driving this over MCP (no REST JSON body to eyeball) can
        // fix the call without re-deriving the schema from AGENTS.md. The
        // REST facade's shared parseJsonBody() (../validate.ts) already
        // returns the raw `issues` array with each issue's `path` intact —
        // this is a divergent presentation of the same information for the
        // MCP transport, which has only a single error `message` string.
        const details = parsedArgs.error.issues
          .map((i) => (i.path.length > 0 ? `${z.core.toDotPath(i.path)}: ${i.message}` : i.message))
          .join("; ");
        return rpcError(id, -32602, `invalid params for '${toolName}': ${details}`);
      }

      try {
        const toolResult = await matched.call(resolved.tenant.tenantStub, parsedArgs.data);
        return result(id, { content: [{ type: "text", text: JSON.stringify(toolResult) }] });
      } catch (err) {
        // SPEC.md §19.5 — configure_dashboard's stale-rev conflict is the
        // MCP-transport equivalent of the HTTP 409 (index.ts onError):
        // structured, carrying currentRev/currentLayout so the agent can
        // rebase, not just a stringified message. Checked via `err.name`
        // (NOT `instanceof`) — a DO method call crosses a Workers RPC
        // boundary, which reconstructs a thrown Error's name/message/own
        // properties on this side WITHOUT preserving its original prototype
        // chain, so `instanceof RevConflictError` never matches here (the
        // same reason index.ts's onError already string-compares `err.name`
        // for every error class, not just this one).
        const name = err instanceof Error ? err.name : "";
        if (name === "RevConflictError") {
          const conflict = err as Error & { currentRev: number; currentLayout: unknown };
          return result(id, {
            content: [{ type: "text", text: JSON.stringify({ error: conflict.message, currentRev: conflict.currentRev, currentLayout: conflict.currentLayout }) }],
            isError: true,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return result(id, { content: [{ type: "text", text: message }], isError: true });
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${req.method}`);
  }
}

export const MCP_INFO = {
  name: SERVER_INFO.name,
  version: SERVER_INFO.version,
  protocol: "mcp",
  transport: "streamable-http",
  note: "POST a JSON-RPC 2.0 request body here (methods: initialize, notifications/initialized, tools/list, tools/call). GET is discovery-only.",
};
