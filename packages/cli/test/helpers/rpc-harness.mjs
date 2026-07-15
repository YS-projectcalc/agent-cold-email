// Drives newline-delimited JSON-RPC 2.0 over a child process's stdio, the
// same framing `StdioServerTransport` speaks. Used by test/mcp.test.mjs to
// exercise the built `agent-cold-email mcp` bridge as a real subprocess.

export function createRpcHarness(child) {
  let buffer = "";
  const pending = new Map();
  let nextId = 1;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  // 15s, not 5s: a margin over observed upstream latency (measured 2-6.8s
  // against a stub, 4-4.8s against production) so genuine network slowness
  // never masquerades as a red test. The ordering fix (mcp.ts) is what
  // actually guarantees `initialize` answers fast — this timeout is only a
  // backstop; mcp-lifecycle.test.mjs asserts the real elapsed time via
  // `requestTimed()` below, which is the actual correctness signal.
  function request(method, params, timeoutMs = 15000) {
    const id = nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for response to ${method} (id ${id})`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  async function requestTimed(method, params, timeoutMs) {
    const startedAt = Date.now();
    const message = await request(method, params, timeoutMs);
    return { message, elapsedMs: Date.now() - startedAt };
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  return { request, requestTimed, notify };
}
