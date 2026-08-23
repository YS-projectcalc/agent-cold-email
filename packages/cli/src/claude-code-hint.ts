// Claude Code discoverability hint: printed to stderr when this CLI runs
// inside a Claude Code session (CLAUDECODE set), so the harness can surface
// "there's a plugin for this" at natural touchpoints (help, a typo'd
// command, right after auth succeeds). Our real marketplace is self-hosted
// in this repo (`.claude-plugin/marketplace.json`, marketplace name
// "coldrig", plugin name "coldrig") — not a claude-plugins-official listing,
// which does not exist for us. An agent that hasn't added our marketplace
// yet must run `claude plugin marketplace add YS-projectcalc/agent-cold-email`
// first; the `<claude-code-hint>` line's format is undocumented (checked
// code.claude.com/docs/en/cli-reference.md — no mention), so this carries
// only the plain `plugin@marketplace` value, not the add-marketplace step.
const PLUGIN_HINT_VALUE = "coldrig@coldrig";

let emitted = false;

export function emitClaudeCodeHint(): void {
  if (emitted || !process.env.CLAUDECODE) return;
  emitted = true;
  process.stderr.write(`<claude-code-hint v="1" type="plugin" value="${PLUGIN_HINT_VALUE}" />\n`);
}
