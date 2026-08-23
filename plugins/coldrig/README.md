# plugins/coldrig

The installable Coldrig Claude Code plugin — its own small root, separate from the monorepo root, so `claude plugin install coldrig@coldrig` copies only this directory (a few KB) into the plugin cache instead of the whole repo (413 MB before this fix, `docs/adversarial/agent-skill-gate-2026-08-23.md` B1).

- `.claude-plugin/plugin.json` — plugin manifest; declares a `userConfig.token` field so enabling the plugin prompts for the Coldrig bearer token instead of requiring an exported env var.
- `.mcp.json` — the bundled MCP server (`coldrig`, `https://api.coldrig.dev/mcp`), authenticated via `${user_config.token}`.
- `skills/coldrig` — a relative symlink to `../../../skills/coldrig` (the canonical skill source, kept there so `npx skills add` and `.claude/skills/` installs still work). Claude Code dereferences and copies this symlink's target into the plugin cache at install time.

Depends on `../../skills/coldrig/SKILL.md` (via the symlink) and the live `https://api.coldrig.dev/mcp` endpoint. No local build or test step; verify with `claude plugin validate .claude-plugin/plugin.json` and a real install under a throwaway `HOME`.
