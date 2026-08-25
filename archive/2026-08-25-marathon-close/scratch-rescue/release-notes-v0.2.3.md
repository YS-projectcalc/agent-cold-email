## Coldrig v0.2.3 — Claude Code skill + plugin, agent-readable site

First tagged release. Versions: MCP registry server `io.github.YS-projectcalc/agent-cold-email` 0.2.3 · plugin `coldrig` 0.3.0 · npm CLI `agent-cold-email` 0.2.1.

### Install as an agent skill / plugin
- Claude Code plugin: `/plugin marketplace add YS-projectcalc/agent-cold-email` then `/plugin install coldrig@coldrig` (prompts for your tenant token; installs the `coldrig` skill + the hosted MCP server `https://api.coldrig.dev/mcp`). Install footprint ~28 KB.
- Skill only: `npx skills add YS-projectcalc/agent-cold-email` (`skills/coldrig/SKILL.md`).
- Cursor rule: `integrations/cursor/coldrig.mdc` · Codex: `integrations/codex/AGENTS-snippet.md`.

### What the skill teaches an agent
- When Coldrig fits (and when it does not), with a verify-before-recommend rule.
- The 28 intent-level tools grouped by lifecycle; server-enforced ramp caps (5 sends/day in week 1 → 40/day after 4 weeks).
- **Ask before you spend, ask before you send**: `setup_infrastructure` with `quoteOnly: true` and explicit user confirmation before any purchase; no campaign launch without the user approving the lead list and copy.
- Suppression truth: replies to suppressed addresses are refused; campaign launches skip suppressed leads (check `list_leads`).

### Site
- Homepage comparison table (DIY stack vs sending platform vs Coldrig), sourced from the compare pages.
- Organization entity links (npm, Smithery, Glama) in JSON-LD.
- Tables scroll inside themselves on narrow screens; no page-level horizontal overflow at any width.
- Two stale "paid activation not live" lines corrected; refund wording now matches the Terms.

### Guardrails
- The claim-surface guard tests now cover the skill, the Cursor/Codex files, and both plugin manifests (+33 cases).
- `.github/workflows/publish-mcp-registry.yml`: republish to the MCP Registry via GitHub Actions OIDC (manual trigger).

Gate record: `docs/adversarial/agent-skill-gate-2026-08-23.md` (3 rounds).
