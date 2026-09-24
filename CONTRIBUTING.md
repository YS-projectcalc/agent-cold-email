# Contributing

Thanks for the interest — this repository holds the installable client surface (CLI, Claude Code skill/plugin, editor integrations) for Coldrig's hosted cold-email infrastructure. The service itself (API, engine, dashboard) is not in this repo. Please open an issue before a large PR to avoid duplicate work.

## Project layout

```
packages/cli/     the `agent-cold-email` npm CLI (source in src/, tests in test/)
skills/            Claude Code Agent Skill (skills/coldrig/SKILL.md)
plugins/           Claude Code plugin bundling the skill + hosted MCP config
integrations/      Cursor rule + Codex AGENTS.md paste-in block
.claude-plugin/    the plugin marketplace manifest
```

`AGENTS.md` is the operational contract for a coding agent using Coldrig; `README.md` covers install and usage for humans. Read both before proposing a structural change.

## Local setup

```bash
git clone <repo-url>
cd agent-cold-email
npm install
npm run typecheck -w packages/cli
npm run build -w packages/cli
npm test -w packages/cli
```

## Ground rules

- **No dead code.** No commented-out blocks, no unused exports — delete it, git remembers it.
- **No god files.** A file that grows past ~300 lines or takes on a second responsibility gets split.
- **No duplicated logic.** Search for an existing implementation before writing a new one.
- **No hallucinated dependencies.** Every import must resolve via `package.json`/the lockfile; run install and build before opening a PR.
- **Tests assert behavior, not existence.** A bugfix PR includes a test that fails on the old code and passes on the fix.
- **No patches-on-patches.** Root-cause fixes only.
- **Secrets never in code or git.** The CLI takes a bearer token via `AGENT_COLD_EMAIL_API_KEY`/flags only — never hardcode one.
- **Every new directory that holds code or content gets a `README.md`** at creation time: what it is, how to run/test it, what depends on it.

## Before opening a PR

1. `npm run typecheck -w packages/cli` and `npm test -w packages/cli` pass (this is also what CI runs).
2. Any new directory has a `README.md`.
3. Any bugfix includes a regression test.
4. No secrets, no real bearer tokens, no `.env` files in the diff.

## Compliance-sensitive areas

This repo doesn't implement suppression, unsubscribe handling, send caps, or the lookalike-domain generator — those are server-side and out of scope here. If a PR touches how the CLI/skill/plugin *describes* those guardrails to a user or agent, keep the description accurate against [coldrig.dev/docs](https://coldrig.dev/docs) and call it out in the PR description.
