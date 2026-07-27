---
name: coldstart-server-json-two-version-fields
description: coldstart's root server.json has TWO unrelated version fields — top-level (MCP registry listing version) vs packages[0].version (pinned npm CLI version); a brief citing "packages/cli version X" may mean either, verify against `npm view agent-cold-email version` before trusting either number.
metadata:
  type: project
---

In `~/dev/coldstart/server.json`: the top-level `"version"` field is the MCP
registry SERVER-LISTING version (bumped whenever registry metadata like the
description needs a re-publish; registry rejects duplicate versions) — it is
NOT the npm package version. `packages[0].version` (nested, `registryType:
"npm"`) is the actual pinned npm CLI version and should track
`packages/cli/package.json`'s `version`.

Hit 2026-07-27: a brief said "bump packages/cli version 0.2.2 → 0.2.3" but
`packages/cli/package.json` was actually `0.2.0` (confirmed via `npm view
agent-cold-email version` → `0.2.0`, matching git history — last real bump
was `324a15c`). The brief's "0.2.2" was the ROOT server.json top-level
registry version, not the CLI package version — those two numbers had
drifted apart (top-level bumped to 0.2.2 across two registry-description
republishes without a matching npm publish).

**Why:** ambiguous/wrong version numbers in a brief are easy to rubber-stamp
if you don't independently ground them — `npm view <pkg> version` +
`git log --oneline -- packages/cli/package.json` settles it in two commands.

**How to apply:** before any "bump version X→Y" instruction touching this
package, verify BOTH: (1) `npm view agent-cold-email version` = ground truth
published version, (2) which of server.json's two version fields the
instruction actually means. Bump `packages/cli/package.json` off the real
published version (patch+1), sync `server.json`'s `packages[0].version` to
match, and leave the top-level registry version alone unless you're also
changing registry-facing content (description, tool count) — that's a
separate, root-level concern outside a `packages/cli`-scoped brief.
