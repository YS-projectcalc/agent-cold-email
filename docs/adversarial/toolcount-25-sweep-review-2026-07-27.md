# Adversarial review — tool-count 24→25 claim-surface sweep

- **Date:** 2026-07-27
- **Reviewer:** adversary (fresh context)
- **Worktree:** `.claude/worktrees/agent-afded06cede950022` (branch `worktree-agent-afded06cede950022`)
- **Grounded at:** `git rev-parse HEAD` = `a0249705a7800565e861e8315501e5f1c1cdbaa6` (== main HEAD at review time). Read-only git throughout.
- **Change:** whole-class sweep bumping stale MCP tool-count claims 24→25 (remove_mailboxes joined via the quantity-billing merge) across ~28 public surfaces, a rebuilt dashboard bundle, a NEW guard test `apps/platform/test/site-tool-count-claims.test.ts`, and a `sql-raw.d.ts` type extension.

## VERDICT: SHIP

25 is the true current count (live prod `tools/list` = exactly 25, registry `MCP_TOOLS.length` = 25, page enumerations = 25, all match 1:1). Every guard-listed public surface is correct at 25; no stale "24"/"twenty-four" remains on a living public surface. Battery green (platform 904/904 tests, platform+dashboard typecheck clean). The new guard is non-vacuous (proven to catch stale "24 tools" and reject `$249`/`2024`/`07-21` false-positive traps) and derives its current count from `MCP_TOOLS.length`. Deploy is safe in any order — live Worker already serves 25, so claims move to match reality with no over-claim window. All three findings below are NON-BLOCKING.

## Findings (ranked)

### F1 · NON-BLOCKING · lens 3/5 · guard forward-check omits 2 count-claiming surfaces
`site/compare-vs-agentmail.html` ("25 intent-level tools") and `site/guide-cold-email-with-ai-agent.html` ("The ~25 tools, at a glance") are in `CLAIM_SURFACES` but NOT in `SURFACES_THAT_STATE_THE_COUNT` (test file lines 83–110 vs 48–77), so the forward "states the CURRENT tool count" assertion (line 193–196) never runs on them.
- **Failure scenario:** when tool 26 lands, these two surfaces can keep saying "25 … tools" and the guard stays green — the retired-count check (line 180–183) only fires if someone manually appends 25 to `RETIRED_TOOL_COUNTS` (line 168). This is the exact historical failure mode the guard exists to kill ("a public page kept the old count").
- **Mitigation that keeps it non-blocking:** the sanity anchor `expect(MCP_TOOLS.length).toBe(25)` (line 173–178) goes RED the instant the registry grows to 26, forcing a human to re-ground the whole file (its header says so). So drift can't ship silently *overall*; the gap is only that these 2 surfaces aren't individually pinned.
- **Verification:** read the two sets and diffed membership; confirmed both surfaces `claimsToolCountOf(text, 25) === true` today (so adding them to the set passes now — verified via the extracted detector). Recommend adding both to `SURFACES_THAT_STATE_THE_COUNT`.

### F2 · NON-BLOCKING · lens 5/8 · og-image "states 25" is satisfied by the SVG font-size attribute, not the visible text
`site/assets/og-image.svg` contains both `font-size="25"` and the visible "25 focused tools". `claimsToolCountOf` matches the `25` inside `font-size="25"` because it sits ~28 chars before "tools".
- **Verification (RUN):** `claimsToolCountOf('font-size="25">One token · 26 focused tools', 25)` returns **true** — i.e. the states-current check passes even when the visible count is wrong.
- **Consequences (latent, no current defect):** (a) a future og-image whose visible text drifts but whose font-size stays 25 would still pass; (b) once 25 becomes a retired count, the retired-check will FALSE-POSITIVE on `font-size="25"` and block a legitimate update unless the font-size is also changed. Visible text is correct (25) today, so nothing is wrong now. Minor.

### F3 · NON-BLOCKING (borderline out-of-declared-scope) · lens 1 · internal src README still says "now 24"
`apps/platform/src/mcp/README.md:5` reads "the facade started as 17 tools (now 24, … — see `tools.ts`'s own header comment for the current count)". "now 24" is a present-tense stale count (truth 25).
- **Why non-blocking:** it is an internal source-tree README, not in the brief's public-surface set (site/**, root docs, server.json, dashboard build, .claude-plugin, llms*); it is GitHub-only (not a marketing/registry surface a buyer-agent `tools/list` cross-check reads); and it self-defers to `tools.ts`'s header, which correctly says 25. But per the sweep's own "whole-class" framing and CLAUDE.md "sweep the class," it is a missed in-repo member — recommend the one-line fix.
- **Verification:** full-repo grep for `\b24\b` near tool/intent; this was the only hit on a non-frozen, non-log file.

## Attacks that FAILED (held)

- **Dangling OpenAPI `$ref` (my #1 prior-incident class for this repo, commit 453e445):** `site/openapi.yaml` change this sweep is a text-only "24 curated → 25 curated intents" bump — no new paths added, so the dangling-schema class is not re-triggered. (The prior 6 dangling refs were closed in `d28afe7`; not this diff's concern.)
- **Count-CLAIMED vs count-ENUMERATED buyer cross-check kill:** `guide-mcp-tool-count.html` headlines 25 AND enumerates all 25 registry tools (`comm` of page `<code>` names vs registry = zero missing; remove_mailboxes added to the lifecycle table). `server-card.json` `tools[]` includes remove_mailboxes in correct registry order. All match live `tools/list` 1:1.
- **Half-rebuilt dashboard bundle / broken hashes:** `apps/platform/public/app/index.html` → `index-gV3fZEcV.js`, which references exactly the new page-chunk hashes; every referenced chunk (8 pages + src) is present, and `ui-*.js`/`index-*.css` are present unchanged. Rebuilt `SetupPage-xUAp3jkQ.js` contains "25 tools" (2×, Cursor+Cline) and zero "24 tools".
- **Over-claim deploy window:** live prod `tools/list` returns exactly 25 (incl. remove_mailboxes) — verified by curl+parse. Claims go 24→25 to MATCH already-live reality, so no over-claim in either direction regardless of deploy order.
- **Guard vacuity / false-positives:** extracted `claimsToolCountOf` and ran it — catches "24 tools"/"24 intent-level tools", rejects `$249`, `2024`, `07-21` traps; sanity anchor `toBe(25)` derived-then-pinned trips on registry drift. Not tautological.
- **Meaning change beyond the number:** `remove_mailboxes` schema section in `guide-mcp-cold-email.html` (`count: integer (1-60)`, `acknowledged: true`) matches `RemoveMailboxesInput` (`z.number().int().min(1).max(60)`, `z.literal(true)`) exactly. server-card.json / plugin.json / server.json all parse as valid JSON. The sweep also corrected a doubly-stale "Five of the 21" → "Five of the 25".
- **Regression ring:** full platform suite 117 files / 904 tests PASS (exit 0); platform typecheck clean; dashboard typecheck clean (SetupPage.tsx source edit valid). `sql-raw.d.ts` `?raw` ambient decls typecheck clean.
- **Deploy safety (Worker runtime):** no `src/**/*.ts` runtime logic in the diff — only static assets (public/), dashboard source+bundle, tests, and marketing/doc surfaces. Registry `tools.ts` untouched (already 25 from the prior merge).

## UNVERIFIABLE / not run (safe to skip, stated for honesty)
- engine and packages/cli test suites were NOT run — the diff touches neither engine nor CLI source (only platform test+dts, dashboard source+bundle, and static/marketing docs), so they are outside the change's blast radius.

## NEW (out-of-scope) observations
- The prior review's note that `guide-mcp-tool-count.html` under-enumerated tools is now resolved (BYO + lead rows + remove_mailboxes all present) — no longer a gap.
