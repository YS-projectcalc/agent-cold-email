---
name: claude-plugin-subdir-userconfig-throwaway-home-proof
description: how to prove a Claude Code plugin's cache footprint and userConfig wiring under a throwaway HOME, and the one leg that can't be proven that way (sensitive value storage)
metadata:
  type: reference
---

Proving a plugin install is small (not "the whole monorepo") and its `userConfig` token prompt is wired: `HOME=$(mktemp -d) claude plugin marketplace add <worktree-path>` then `claude plugin install <plugin>@<marketplace>` — a `du -sh $HOME/.claude/plugins/cache/<marketplace>` and `find ... -name node_modules` before/after a marketplace-root-is-monorepo-root fix (`"source": "./"` → `"source": "./plugins/<name>"`) is the exact before/after evidence a gate wants (413 MB → 28 KB in this repo, [[claude-plugin-validate-marketplace-shadows-plugin-json]]).

A relative symlink from the small plugin dir's `skills/<name>` to the canonical `../../../skills/<name>` at the repo root is the documented pattern (plugins-reference.md "Share files within a marketplace with symlinks" — a symlink resolving elsewhere WITHIN the marketplace is dereferenced and its content copied into the cache). Verify with `diff` between the cached copy and the source — must be byte-identical, and `claude plugin details <plugin>@<marketplace>` should report `Skills (1)` + `MCP servers (1)`.

**Gotcha:** `claude mcp get`/`claude mcp list` resolve PROJECT-scope `.mcp.json` by the actual `cwd` the command runs in (or an ambient default that can silently be a SIBLING worktree of the same repo) — always explicit `cd <worktree> &&` before these commands in the same Bash call, never assume the harness's implicit cwd matches your worktree. Wrong-worktree output looks identical in shape (a real server list) so it's easy to mistake for a real result.

**Cannot prove under a throwaway HOME:** setting a `sensitive: true` `userConfig` field (`claude plugin install <plugin> --config token=xxx`) fails with "Failed to save sensitive plugin options... to secure storage" — macOS Keychain access isn't fully decoupled from `$HOME` in this sandbox. `claude plugin install` still correctly reports "1 userConfig option not yet set (1 required)" (proves the field is wired), and a NON-sensitive project-scope `.mcp.json` using an env var still resolves fine via `claude mcp get`. Report the sensitive-value round-trip as UNVERIFIED-by-this-technique rather than claiming it works, and don't burn time trying to route around a real Keychain in a disposable HOME.
