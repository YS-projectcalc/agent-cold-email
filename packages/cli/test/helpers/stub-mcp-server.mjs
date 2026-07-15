// A minimal local stand-in for the hosted /mcp route (apps/platform/src/mcp),
// used ONLY by test/mcp.test.mjs and test/mcp-lifecycle.test.mjs — never
// points at the live Worker. Mirrors the real route's observable contract:
// GET /mcp -> 200 JSON (not an SSE stream, not 405); POST /mcp -> JSON-RPC
// 2.0, `notifications/initialized` answered 202 with an empty body,
// `tools/call` answered 401 with a JSON-RPC error when no bearer token is
// present.

import http from "node:http";

export function createStubMcpServer({ tools, toolResult, initializeDelayMs = 0 }) {
  const receivedAuthHeaders = [];

  function send(res, body, status = 200) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/mcp") {
      send(res, { name: "stub-mcp", version: "0.0.0" });
      return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const msg = JSON.parse(raw);
        const id = msg.id ?? null;
        const authHeader = req.headers["authorization"] ?? null;

        switch (msg.method) {
          case "initialize": {
            // Simulates a slow upstream handshake (the real-world case the
            // bridge measured 2-6.8s against, and 4-4.8s against production)
            // — used by mcp-lifecycle.test.mjs to pin that the bridge's OWN
            // `initialize` answers fast regardless of this delay.
            const respond = () =>
              send(res, {
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
                  serverInfo: { name: "stub-mcp", version: "0.0.0" },
                  capabilities: { tools: {} },
                },
              });
            if (initializeDelayMs > 0) {
              setTimeout(respond, initializeDelayMs);
            } else {
              respond();
            }
            return;
          }
          case "notifications/initialized":
            res.writeHead(202);
            res.end();
            return;
          case "tools/list":
            send(res, { jsonrpc: "2.0", id, result: { tools } });
            return;
          case "tools/call":
            receivedAuthHeaders.push(authHeader);
            if (!authHeader) {
              send(res, { jsonrpc: "2.0", id, error: { code: -32001, message: "missing bearer token" } }, 401);
              return;
            }
            send(res, { jsonrpc: "2.0", id, result: toolResult });
            return;
          default:
            send(res, { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${msg.method}` } });
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    receivedAuthHeaders,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
