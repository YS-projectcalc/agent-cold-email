# Integrations

Coding-agent integration files for Coldrig, beyond the Claude Code skill/plugin at the repo root (`skills/coldrig/SKILL.md`, `.claude-plugin/`).

- [`cursor/coldrig.mdc`](./cursor/coldrig.mdc) — Cursor rule; copy to `.cursor/rules/coldrig.mdc` (or `~/.cursor/rules/`).
- [`codex/AGENTS-snippet.md`](./codex/AGENTS-snippet.md) — paste-in block for a project's `AGENTS.md`.

## Install one-liners

- **Claude Code plugin:** `/plugin marketplace add YS-projectcalc/agent-cold-email` then `/plugin install coldrig@coldrig`
- **skills.sh:** `npx skills add YS-projectcalc/agent-cold-email`
- **Cursor / Codex / Cline MCP config:** https://coldrig.dev/connect
