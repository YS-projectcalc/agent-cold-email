// Pins two process-lifecycle properties of `agent-cold-email mcp` that
// protocol/auth tests (mcp.test.mjs) don't catch:
//
// 1. `initialize` must answer independently of upstream connect latency —
//    the committed test lane was flaky because the bridge awaited the FULL
//    upstream handshake before starting the stdio server (adversarial
//    review finding #1: docs/adversarial/cli-mcp-bridge-review-2026-07-15.md).
// 2. The process must exit cleanly on stdin EOF, not linger as an orphan
//    with a dangling upstream connection (finding #2, same review).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStubMcpServer } from "./helpers/stub-mcp-server.mjs";
import { createRpcHarness } from "./helpers/rpc-harness.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function spawnCli(env) {
  return spawn(process.execPath, [CLI_ENTRY, "mcp"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("mcp bridge: initialize answers fast even when the upstream connect is slow", async (t) => {
  // 8s matches the order of magnitude the adversary measured against the
  // live production endpoint (4-4.8s) and the stub under load (up to
  // 6.8s) — comfortably reproduces the flake without being contrived.
  const SLOW_MS = 8000;
  const stub = createStubMcpServer({ tools: [], toolResult: { content: [] }, initializeDelayMs: SLOW_MS });
  const baseUrl = await stub.listen();
  t.after(() => stub.close());

  const child = spawnCli({ AGENT_COLD_EMAIL_BASE_URL: baseUrl, AGENT_COLD_EMAIL_API_KEY: "test-token" });
  t.after(() => child.kill());
  const rpc = createRpcHarness(child);

  const { message, elapsedMs } = await rpc.requestTimed(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" } },
    SLOW_MS + 5000, // generous backstop so a real hang still fails loudly; the assertion below is the actual check
  );
  assert.equal(message.error, undefined, `initialize errored: ${JSON.stringify(message.error)}`);
  assert.ok(
    elapsedMs < SLOW_MS / 2,
    `initialize took ${elapsedMs}ms against a stub with an ${SLOW_MS}ms upstream delay — expected well under ` +
      `half that, since the local stdio server must answer 'initialize' independently of upstream connect latency`,
  );
});

test("mcp bridge: exits cleanly on stdin EOF (no orphan process)", async (t) => {
  const stub = createStubMcpServer({
    tools: [{ name: "metrics", description: "x", inputSchema: { type: "object", properties: {} } }],
    toolResult: { content: [] },
  });
  const baseUrl = await stub.listen();
  t.after(() => stub.close());

  const child = spawnCli({ AGENT_COLD_EMAIL_BASE_URL: baseUrl, AGENT_COLD_EMAIL_API_KEY: "test-token" });
  const rpc = createRpcHarness(child);

  await rpc.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  });
  rpc.notify("notifications/initialized");

  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit within 5s of stdin EOF")), 5000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  child.stdin.end(); // simulates the client closing the pipe (disconnect)

  const code = await exited;
  assert.equal(code, 0, `expected a clean exit(0) on stdin EOF, got ${code}`);
});
