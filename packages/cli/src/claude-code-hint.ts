// Claude Code discoverability hint: printed to stderr when this CLI runs
// inside a Claude Code session (CLAUDECODE set), so the harness can surface
// "there's a plugin for this" at natural touchpoints (help, a typo'd
// command, right after auth succeeds). Deliberately inert today — "coldrig"
// is not yet listed on claude-plugins-official, so no marketplace lookup
// resolves this value until that listing exists.
const PLUGIN_HINT_VALUE = "coldrig@claude-plugins-official";

let emitted = false;

export function emitClaudeCodeHint(): void {
  if (emitted || !process.env.CLAUDECODE) return;
  emitted = true;
  process.stderr.write(`<claude-code-hint v="1" type="plugin" value="${PLUGIN_HINT_VALUE}" />\n`);
}
