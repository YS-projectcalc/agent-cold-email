---
name: claude-plugin-validate-marketplace-shadows-plugin-json
description: when a repo root has BOTH .claude-plugin/plugin.json and .claude-plugin/marketplace.json, `claude plugin validate .` validates only the marketplace manifest and silently skips the plugin
metadata:
  type: reference
---

`claude plugin validate .` (bare directory arg) picks ONE manifest when both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` exist at the same root — it validated marketplace.json and never touched plugin.json in this repo (confirmed: baseline run before marketplace.json existed printed "Validating plugin manifest" + walked components; after adding marketplace.json, the identical `claude plugin validate .` call printed only "Validating marketplace manifest").

**How to apply:** once a repo ships both manifests (a plugin marketplace whose only entry is the repo root itself, `"source": "./"` — the coldrig-skill pattern), validate each explicitly by path: `claude plugin validate .claude-plugin/plugin.json` for the plugin (checks plugin.json + skills/agents/commands dirs, still warns on a root CLAUDE.md as a pre-existing non-blocking note) and `claude plugin validate .claude-plugin/marketplace.json` for the marketplace. To check a nested `skills/<name>/SKILL.md`'s frontmatter specifically, name the `skills` directory itself (`claude plugin validate skills`) — a bare `.` or the plugin-root run does NOT surface SKILL.md frontmatter errors on its own per the docs' "Validate a plugin or a directory without a manifest" table. `--strict` on marketplace.json without a top-level `description` field fails on the "No marketplace description provided" warning — add one, it's a required-in-practice field once you gate on strict.
