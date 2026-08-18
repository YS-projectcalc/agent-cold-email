---
name: claim-surface-drift-surfaces
description: ColdStart claim-drift sweeps (tool descriptions / docs / openapi vs real types) — the 8 parallel copies of the tool contract, and which ones the existing guards do NOT scan.
metadata:
  type: reference
---

Sweep of 2026-08-17 (ref `9d3ec7e9`, 40 IN / 5 UNCERTAIN). Cover these BEFORE declaring a
claim-drift inventory complete. See [[coverage-ledger]] for the general ColdStart surfaces.

- **There are EIGHT hand-written copies of the same tool contract**, none derived from the
  types: `mcp/tools.ts` descriptions, `mcp/schemas.ts` `.describe()` strings (they ship to the
  agent as inputSchema docs — easy to miss), `site/.well-known/mcp/server-card.json` (a FULL
  second set of 28 descriptions — dump it with python/json, don't grep), `site/openapi.yaml`
  (summaries AND schemas can disagree *within one file*), the `AGENTS.md` table, the
  `README.md` table, `site/guide-mcp-cold-email.html`'s schema reference, and
  `apps/platform/src/admin/support-kb.ts`'s drafted answers. Sweep all eight or the count is a lie.
- **Drift runs BOTH directions.** Don't only audit `mcp/tools.ts` against the code. For
  `metrics`, `tools.ts` is CORRECT and seven published surfaces describe a different product
  ("Account-wide deliverability + warmup health" — it returns `EventCounts`). Diff each
  published copy against the TYPE, never against another copy.
- **`apps/platform/src/admin/support-kb.ts` is a CUSTOMER-FACING claim surface** (AI support
  triage drafts the text a customer receives) and is in NEITHER existing guard's
  `CLAIM_SURFACES`. It shipped "~12 tools" against a 28-tool registry. Any `src/**/*.ts`
  string literal naming ≥3 tool names is a claim surface.
- **`site/openapi.yaml` is a MACHINE contract, so rank its drift higher than prose.** A stale
  `enum:` (found: webhook eventTypes declared 4, code has 5 incl. `unsubscribe`) makes a
  capability unreachable for any generated client. Also check the `operationId` set against
  `MCP_TOOLS` — `remove_mailboxes` had NO path item while being referenced 3× elsewhere in
  the same file.
- **Check `Returns { … }` field NAMES against the result interface, not just their presence.**
  `remove_mailboxes` promised `{ releasedCount, quote }`; `RemoveMailboxesResult` declares
  `{ releasedCount, billing }`. Pure grep for "does the tool exist" misses field-name drift.
- **JSON-LD blocks in `site/faq.html` (`acceptedAnswer`) duplicate the rendered prose** — fix
  both or the machine-indexed copy stays wrong. Same for `site/llms.txt` and `og-image.svg`.
- **In-repo HONEST phrasings to cite instead of inventing one:** `openapi.yaml:125-126`
  ("There is no per-domain DNS field to poll") is the correct version of the F4 claim
  `tools.ts:74` gets wrong; `tools.ts:320` ("note (accepted, not persisted)") and
  `schemas.ts:136` are the model for a field a schema accepts and the code drops.
- **This class already fired once and was closed at the instance only** —
  `engine/tenant-messages.ts:187-190` records "four public tool/API descriptions claimed the
  opposite as fact" (`msgchannel-inc23-gate-2026-08-06` F1). Prose was fixed; no guard was
  built. Expect a third occurrence unless the binding is mechanical.
- **The tool-COUNT guard's two scope leaks:** `CLAIM_SURFACES` is a hand-maintained array
  (misses any new file), and `RETIRED_TOOL_COUNTS` is a fixed list `[17,19,21,24,25,27]`
  (misses "~12"). Both must be checked before crediting it — same lesson as
  `spend-ceiling-coverage.test.ts` in [[coverage-ledger]].
