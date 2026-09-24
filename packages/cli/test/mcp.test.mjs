// Behavior test for `agent-cold-email mcp`: spawns the BUILT cli
// (dist/index.js, never src/) in mcp mode against a local stub HTTP server
// (never the live Worker — see helpers/stub-mcp-server.mjs) and drives a
// real JSON-RPC round trip over its stdio, matching what a coding agent's
// MCP client actually does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStubMcpServer } from "./helpers/stub-mcp-server.mjs";
import { createRpcHarness } from "./helpers/rpc-harness.mjs";

const CLI_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const STUB_TOOLS = [{ name: "metrics", description: "Account-wide metrics.", inputSchema: { type: "object", properties: {} } }];
const STUB_TOOL_RESULT = { content: [{ type: "text", text: "{\"sent\":42}" }] };

function spawnCli(env) {
  const merged = { ...process.env, ...env };
  // Deterministic regardless of the outer shell's env: the missing-key test
  // asserts on the ABSENCE of a key, so it must not leak in from the runner.
  if (!("AGENT_COLD_EMAIL_API_KEY" in env)) delete merged.AGENT_COLD_EMAIL_API_KEY;
  return spawn(process.execPath, [CLI_ENTRY, "mcp"], {
    env: merged,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function collectStderr(child) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return () => stderr;
}

test("mcp bridge: authenticated round trip forwards initialize/tools-list/tools-call and the bearer header", async (t) => {
  const stub = createStubMcpServer({ tools: STUB_TOOLS, toolResult: STUB_TOOL_RESULT });
  const baseUrl = await stub.listen();
  t.after(() => stub.close());

  const child = spawnCli({
    AGENT_COLD_EMAIL_BASE_URL: baseUrl,
    AGENT_COLD_EMAIL_API_KEY: "test-token-abc",
  });
  t.after(() => child.kill());
  const getStderr = await collectStderr(child);
  const rpc = createRpcHarness(child);

  const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" } });
  assert.equal(init.error, undefined, `initialize errored: ${JSON.stringify(init.error)}`);
  assert.equal(init.result.serverInfo.name, "agent-cold-email");

  rpc.notify("notifications/initialized");

  const list = await rpc.request("tools/list", {});
  assert.equal(list.error, undefined, `tools/list errored: ${JSON.stringify(list.error)}`);
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["metrics"],
  );

  const call = await rpc.request("tools/call", { name: "metrics", arguments: {} });
  assert.equal(call.error, undefined, `tools/call errored: ${JSON.stringify(call.error)}`);
  assert.deepEqual(call.result.content, STUB_TOOL_RESULT.content);

  assert.deepEqual(stub.receivedAuthHeaders, ["Bearer test-token-abc"]);
  assert.equal(getStderr().includes("AGENT_COLD_EMAIL_API_KEY is not set"), false, "should not warn when a key is present");
});

test("mcp bridge: missing key still serves initialize/tools-list, warns, and tools/call fails cleanly (no hang, no crash)", async (t) => {
  const stub = createStubMcpServer({ tools: STUB_TOOLS, toolResult: STUB_TOOL_RESULT });
  const baseUrl = await stub.listen();
  t.after(() => stub.close());

  const child = spawnCli({ AGENT_COLD_EMAIL_BASE_URL: baseUrl });
  t.after(() => child.kill());
  const getStderr = await collectStderr(child);
  const rpc = createRpcHarness(child);

  const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "0.0.0" } });
  assert.equal(init.error, undefined, `initialize errored keyless: ${JSON.stringify(init.error)}`);

  rpc.notify("notifications/initialized");

  const list = await rpc.request("tools/list", {});
  assert.equal(list.error, undefined, `tools/list errored keyless: ${JSON.stringify(list.error)}`);
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name),
    ["metrics"],
  );

  // tools/call must come back as a clean JSON-RPC error, not a timeout.
  const call = await rpc.request("tools/call", { name: "metrics", arguments: {} });
  assert.ok(call.error, "expected a JSON-RPC error for a keyless tools/call");
  assert.equal(typeof call.error.code, "number");
  assert.deepEqual(stub.receivedAuthHeaders, [null]);

  // Proves the process survived the tool-call error (no crash): it still
  // answers a second request afterward.
  const listAgain = await rpc.request("tools/list", {});
  assert.equal(listAgain.error, undefined);
  assert.equal(child.exitCode, null, "process should still be alive after a keyless tools/call error");

  assert.match(getStderr(), /AGENT_COLD_EMAIL_API_KEY is not set/);
});
