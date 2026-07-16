# Adversarial review — Anthropic directory-readiness bundle (2026-07-16)

Frozen record. Reviewer: adversary (fresh context). Grounded HEAD `249d065` (unchanged start→end; in-scope files verified dirty-as-reviewed at close). Git read-only throughout.

## Scope
Working-tree diff vs `249d065`:
- `apps/platform/src/mcp/tools.ts` (+ `handler.ts` surfacing) — MCP tool annotations on all 17 tools
- `apps/platform/test/mcp-tool-annotations.test.ts` (new)
- `.claude-plugin/plugin.json` (new, name `coldrig`)
- `packages/cli/src/claude-code-hint.ts` (new) + `test/claude-code-hint.test.mjs` (new) + `index.ts`/`commands/signup.ts` wiring
- Root `README.md`, `packages/cli/README.md`, `apps/platform/src/mcp/README.md` (Codex TOML + annotation notes)

IGNORED per brief: all `apps/engine/**`.

## VERDICT: NO-SHIP — 1 BLOCKING (annotation-honesty)

The bundle exists to make MCP tool annotations *honest* for the Anthropic Connectors Directory. One `readOnlyHint: true` tool provably writes to D1, and the new test certifies that false claim as honest. Everything else (bridge stdout safety, plugin validity, README/TOML discipline, full suites) held.

---

## Findings

### BLOCKING — Lens 1 (annotation honesty / claims-class). `infrastructure_status` is `readOnlyHint: true` but writes to D1 on every call.
- **Annotation:** `tools.ts:60` — `infrastructure_status` → `{ title: "Infrastructure Status", readOnlyHint: true }`. Also enshrined in `READ_ONLY_TOOLS` in `mcp-tool-annotations.test.ts:20` which asserts `readOnlyHint === true`.
- **Reality:** tool call → `stub.infrastructureStatus()` → `getInfrastructureStatus(ctx)` (`engine/provisioning.ts:186`) whose **first statement (line 187)** is `refreshMailboxWarmupState(ctx)`. That function (`engine/mailbox-state.ts:17`) unconditionally issues `UPDATE mailboxes SET daily_cap=?, status=? WHERE id=?` for every mailbox (line 43), and on a virtual-day rollover instead runs `UPDATE mailboxes SET sent_today=0, sent_today_epoch_day=?, daily_cap=?, status=?` (line 35). **Both branches write.** MCP `readOnlyHint: true` asserts "the tool does not modify its environment" — a D1 `UPDATE` modifies it. The claim is false.
- **Failure scenario:** a client/agent that treats `readOnlyHint: true` tools as safe-to-auto-run (Claude clients do gate approval on this) polls `infrastructure_status` believing it is side-effect-free; each call rewrites mailbox warmup columns, and across a day boundary resets `sent_today` to 0 before the tick would. Persists and is read by the send tick.
- **Verification:** traced the full call chain in source (handler → TenantDO:270 → provisioning.ts:186-187 → mailbox-state.ts:17-45); confirmed the write is unconditional (no clock-equality guard around the UPDATEs). Confirmed all other 8 read-only tools are pure SELECT (`reporting.ts`/`inbox.ts`/`activity.ts`/`campaigns.ts`/`dashboard-views.ts`/`threads.ts` — no INSERT/UPDATE/DELETE in the read functions; the writes in those files belong to the correctly-flagged mutating tools).
- **Severity note (honest):** runtime *harm* is low — the write is a clock-driven, idempotent materialized-view recompute that the tick performs identically (docstring, `mailbox-state.ts:4-16`); the early `sent_today` reset is epoch-day-keyed so it cannot double-count or corrupt accounting. But the *claim* is false on the exact surface this bundle exists to make honest, and the builder's own test locks the false claim in. Fix is small (read the already-persisted columns without the refresh, or set this one tool's hint to reflect the write). Class-scope + fix-vs-accept is the main loop's call per the class-sweep contract.

### NON-BLOCKING — Lens 1. `setup_infrastructure` comment overstates "never overwrites existing tenant resources."
- `tools.ts:60` comment: "Additive only: creates new domains/mailboxes, never deletes or overwrites existing tenant resources." destructiveHint:false.
- `runSetupInfrastructure` (`provisioning.ts:130-137`) runs an **unconditional** `UPDATE tenant_profile SET brand=?, primary_domain=?, physical_address=?, sender_identity=?` on every call — a re-run with different args overwrites prior profile config. Domains/mailboxes/ledger are INSERT-only (additive) as claimed.
- Ruled NON-BLOCKING: the destructiveHint:**false** *value* is a defensible, honest call (only the tenant's own required-input config fields are overwritten; no operational resources destroyed; far better than the omit→true default). Only the code comment's absolute wording is imprecise.

---

## Attacks that FAILED (survived — this is what makes the PASS-parts meaningful)

- **Lens 1 — the other 8 read-only tools write nothing.** `getMetrics`/`getCampaignResults`/`getAccount`/`getDeliverabilitySummary`/`getTeardownSummary`/`listInbox`/`listCampaigns`/`getActivityFeed`/`getThread`/`listDashboardViews`/`getDashboardView` are all pure SELECT. `getAccount` reads `usageCents` via `SUM(...) FROM ledger_entries` — it does **not** increment usage (no metered-read write). `getThread` does **not** auto-mark-read. HELD.
- **Lens 1 — `label_thread` do_not_contact concern (brief-specified).** `setThreadLabel` (`thread-labels.ts`) only INSERT/UPDATE/DELETEs the `thread_labels` row. Suppression lives in a *separate* `suppressions` table + `leads.global_status`, written solely by `suppress()` on the bounce/complaint/unsubscribe path (`reply-processor.ts`) — never by a label value. The tick's send-guard joins `suppressions` by email (`tick.ts:228`), not `thread_labels`. A `do_not_contact` label is purely cosmetic and triggers nothing. destructiveHint:false is honest. HELD. (See NEW below for the product-semantics flip side.)
- **Lens 1 — destructive trio (`launch_campaign`/`reply`/`pause`/`pause_all`/`configure_dashboard`).** launch/reply schedule/perform real sends; pause/pause_all have no resume tool (unrecoverable via API); configure_dashboard has a hard `delete` action (`dashboard-views.ts:205`). destructiveHint:true is conservative-honest for each. HELD.
- **Lens 2 — stdio-bridge stdout contamination.** The `mcp` subcommand routes to `runMcp()` (`index.ts:67-68`) and never calls `emitClaudeCodeHint()`; the hint fires only at help/`-h`/`--help`/undefined (`:74`), unknown-command (`:79`), and post-signup (`signup.ts:24`), always to **stderr**. Runtime-proven: `CLAUDECODE=1 node dist/index.js mcp </dev/null` → **0 stdout bytes**, no `claude-code-hint` marker anywhere; only the legitimate keyless-mode warning on stderr (legal MCP stdio logging). Once-per-process guard verified by the module-level test. HELD.
- **Lens 3 — plugin manifest validity.** `claude plugin validate` PASSES (name `coldrig` accepted; no reserved-prefix/collision error). The one warning is about the repo's `CLAUDE.md` not loading as plugin context — pre-existing, unrelated to this diff, and it confirms the plugin root = repo root, so the sibling repo-root `.mcp.json` is auto-discoverable as claimed. HELD.
- **Lens 4 — README/TOML overclaim.** The added Codex TOML + prose make **no** live-sending claim; cli/README frames it honestly as "skip the stdio bridge and point Codex straight at the hosted remote endpoint." The blocks are byte-identical to the already-shipped `connect.html`/guide-page blocks (no NEW claim). HELD.
- **Lens 5 — fixture realism / does the test catch a misclassification?** The annotation test asserts *values* (not just presence): removing `readOnlyHint` from a read tool, or flipping `mark`/`label_thread` to destructive, would FAIL it. But it encodes the builder's classification, so it catches *drift from the encoded intent*, NOT a *wrong intent* — it cannot see `refreshMailboxWarmupState` and so it certifies the false `infrastructure_status` claim. Presence+consistency, not ground-truth honesty. (This is why the BLOCKING finding got past the green suite.)
- **Full verification RE-RUN:** platform `npm test` **351/351** (59 files), platform typecheck clean; cli `npm test` **9/9** (incl. the previously-flaky bridge lane — now green), cli build + typecheck clean; annotation test **6/6** in isolation.

---

## UNVERIFIABLE (not folded into the verdict)

- **Codex remote-MCP TOML schema correctness** (`[mcp_servers.coldrig]` + `url` + `bearer_token_env_var`). Could not re-verify against live Codex docs this session: `openai/codex` `docs/config.md` is now a 726-byte stub (moved), unauth GitHub code-search returns empty. Consistent with reviewer's prior-knowledge (Codex streamable-HTTP remote MCP + `bearer_token_env_var`, late-2025) and byte-identical to already-shipped surfaces, so **no NEW risk vs what is live**. Resolve with a live `codex` smoke before treating as verified-working.
- **`<claude-code-hint>` marker effectiveness.** Whether any Claude Code version parses/surfaces `<claude-code-hint v="1" type="plugin" value="coldrig@claude-plugins-official" />` is undocumented here. If unrecognized → inert stderr noise (harmless, CLAUDECODE-gated). If recognized → it advertises a marketplace listing (`coldrig@claude-plugins-official`) that does **not yet exist** (builder-acknowledged inert). Resolve by confirming the marker contract + listing before publish.

## NEW / out-of-scope observations (no verdict weight)

- **plugin.json disclosure regression (shopfront-staleness class).** `plugin.json:description` = "…so your agent runs outbound email end to end with one bearer token — no dashboard required." Unlike the reviewed `server.json` (carries "sandbox") and `server-card.json` (`statusNote: "Real sending is not active"`), plugin.json has **no** sandbox/early-access marker. True in the sandbox, but a marketplace-listing-only reader parses it as live end-to-end delivery — the same "judge from the listing alone" failure that killed the Glama listing. Inert today (plugin unpublished), but should carry the sibling's disclosure **before** marketplace submission. Recommend matching server.json's "free sandbox demo now" / "Early access" wording.
- **Plugin onboarding gap.** A plugin install provides no hint that `AGENT_COLD_EMAIL_API_KEY` must be set for the bundled `.mcp.json`; `tools/call` will 401 until the user discovers it. Failure mode is honest (clean 401, keyless introspection still works) but undiscoverable.
- **`do_not_contact` label is a functional no-op (product semantics, not annotation).** A customer agent that sets a "do_not_contact" label expecting outreach to stop would be wrong — labels never feed the suppression guard. The tool description doesn't claim suppression, so not a defect against this bundle, but a real product footgun for the warm-lead scout flow.
