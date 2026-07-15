// `agent-cold-email mcp` — MCP over stdio, bridged to the hosted
// streamable-HTTP endpoint (the standard "mcp-remote" pattern, built with
// the official SDK instead of shelling out to a separate package). This is
// the only command in the CLI that talks MCP JSON-RPC instead of the REST
// facade, and the only one with a runtime dependency (client.ts's fetch
// wrapper stays dependency-free for the other nine commands).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_API_BASE } from "../client.js";

function packageVersion(): string {
  const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

// http:// (not localhost/loopback) sends the bearer in cleartext. Same
// allowlist as apps/platform/src/vendors/real/email-port.ts's
// isSecureEngineUrl — but unlike that guard, this WARNS rather than blocks:
// a self-hoster pointing AGENT_COLD_EMAIL_BASE_URL at their own http://
// deployment is a deliberate, same-actor choice (adversarial review finding
// #5), not something the CLI should refuse to run.
function isSecureOrLoopback(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function resolveMcpUrl(): URL {
  const fromEnv = process.env.AGENT_COLD_EMAIL_BASE_URL;
  const base = fromEnv ? fromEnv.replace(/\/$/, "") : DEFAULT_API_BASE;
  return new URL(`${base}/mcp`);
}

export async function runMcp(): Promise<void> {
  const apiKey = process.env.AGENT_COLD_EMAIL_API_KEY;
  if (!apiKey) {
    // Not fatal: the hosted endpoint answers `initialize`/`tools/list`
    // without auth (only `tools/call` is tenant-scoped), so a keyless
    // bridge can still start and pass introspection — e.g. a registry
    // quality checker that only starts the server and lists tools. A tool
    // CALL without a key surfaces as a normal JSON-RPC error from the
    // upstream 401, not a crash (see resolveMcpUrl/connect below).
    console.error(
      "agent-cold-email mcp: AGENT_COLD_EMAIL_API_KEY is not set — starting in unauthenticated mode. " +
        "initialize/tools/list will work; tools/call will fail until a key is set " +
        "(run `npx agent-cold-email signup` or `npx agent-cold-email demo` to get one).",
    );
  }

  const version = packageVersion();
  const url = resolveMcpUrl();
  if (apiKey && !isSecureOrLoopback(url)) {
    console.error(
      `agent-cold-email mcp: warning — AGENT_COLD_EMAIL_BASE_URL (${url.toString()}) is plain http:// to a ` +
        "non-loopback host, so AGENT_COLD_EMAIL_API_KEY will be sent in cleartext. Use https:// unless this is a " +
        "trusted localhost deployment.",
    );
  }

  const upstream = new Client({ name: "agent-cold-email-mcp-bridge", version }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
  });

  // Connect upstream in the BACKGROUND, not before serving stdio: the local
  // stdio server's `initialize`/`notifications/initialized` handling is
  // purely local (the SDK's `Server` answers them without touching
  // `upstream`), so blocking `server.connect()` on the full upstream
  // handshake made `initialize` as slow as the upstream connect itself
  // (measured 2-6.8s against a stub, 4-4.8s against production — see
  // docs/adversarial/cli-mcp-bridge-review-2026-07-15.md finding #1). The
  // `tools/list`/`tools/call` handlers below await this same in-flight
  // promise, so a request that arrives before upstream is ready waits for
  // it instead of erroring.
  const upstreamReady = upstream.connect(transport).catch((err: unknown) => {
    // Fail fast: an upstream that's unreachable (or rejects even a keyless
    // `initialize`) can't serve anything real, so there's nothing to gain
    // by staying up just to error on every subsequent request.
    console.error(
      `agent-cold-email mcp: failed to connect to ${url.toString()}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });

  const server = new Server({ name: "agent-cold-email", version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await upstreamReady;
    return upstream.listTools();
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await upstreamReady;
    return upstream.callTool(request.params);
  });

  // MCP stdio convention: exit when the client closes its end of the pipe.
  // `StdioServerTransport` only listens for stdin `data`/`error` — it never
  // fires `onclose` on EOF — so without this, the upstream client's
  // background SSE-reconnect loop keeps the event loop alive and the
  // process becomes an orphan after the client disconnects (adversarial
  // review finding #2).
  process.stdin.on("end", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
