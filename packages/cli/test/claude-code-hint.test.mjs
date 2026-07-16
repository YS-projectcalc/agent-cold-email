// Behavior test for the Claude Code discoverability marker: a
// `<claude-code-hint .../>` line on stderr, gated on `process.env.CLAUDECODE`,
// printed at most once per invocation. Two lanes:
//  1. spawn the BUILT cli (dist/index.js, never src/) for the --help and
//     unknown-subcommand touchpoints, matching mcp.test.mjs's convention.
//  2. import the built hint module directly to pin the once-per-invocation
//     guard, which two mutually-exclusive CLI branches can't exercise by
//     spawning a single process.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const HINT_LINE = '<claude-code-hint v="1" type="plugin" value="coldrig@claude-plugins-official" />';

function spawnCli(args, env) {
  const merged = { ...process.env, ...env };
  if (!("CLAUDECODE" in env)) delete merged.CLAUDECODE;
  return spawn(process.execPath, [CLI_ENTRY, ...args], { env: merged, stdio: ["ignore", "pipe", "pipe"] });
}

function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return new Promise((resolve) => child.on("close", () => resolve({ stdout, stderr })));
}

test("--help prints the hint on stderr when CLAUDECODE is set", async () => {
  const child = spawnCli(["--help"], { CLAUDECODE: "1" });
  const { stderr } = await collect(child);
  assert.equal(stderr.trim(), HINT_LINE);
});

test("--help prints nothing on stderr when CLAUDECODE is unset", async () => {
  const child = spawnCli(["--help"], {});
  const { stderr } = await collect(child);
  assert.equal(stderr, "");
});

test("an unknown subcommand prints the hint on stderr, after the usage error, when CLAUDECODE is set", async () => {
  const child = spawnCli(["not-a-real-command"], { CLAUDECODE: "1" });
  const { stderr } = await collect(child);
  // console.error's "Unknown command" line and the hint both land on
  // stderr; the hint must be the last line, printed once.
  assert.match(stderr, /Unknown command: not-a-real-command/);
  const lines = stderr.trim().split("\n");
  assert.equal(lines.at(-1), HINT_LINE);
  assert.equal(stderr.split(HINT_LINE).length - 1, 1, "hint must appear exactly once");
});

test("an unknown subcommand still exits 1 with CLAUDECODE set (the hint doesn't change exit behavior)", async () => {
  const child = spawnCli(["not-a-real-command"], { CLAUDECODE: "1" });
  const [code] = await new Promise((resolve) => child.on("close", (c) => resolve([c])));
  assert.equal(code, 1);
});

test("emitClaudeCodeHint prints at most once per process even if called from multiple sites", async () => {
  process.env.CLAUDECODE = "1";
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    writes.push(chunk);
    return true;
  };
  try {
    const { emitClaudeCodeHint } = await import("../dist/claude-code-hint.js");
    emitClaudeCodeHint(); // simulates the --help call site
    emitClaudeCodeHint(); // simulates the unknown-command call site
    emitClaudeCodeHint(); // simulates the post-signup call site
  } finally {
    process.stderr.write = original;
    delete process.env.CLAUDECODE;
  }
  assert.equal(writes.length, 1, `expected exactly one stderr write, got ${writes.length}: ${JSON.stringify(writes)}`);
  assert.equal(writes[0], `${HINT_LINE}\n`);
});
