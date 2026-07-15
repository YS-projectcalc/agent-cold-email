# Adversarial review — MCP tool `description` rewrite (17 tools)

- **File under review:** `apps/platform/src/mcp/tools.ts` (uncommitted working-tree edit; descriptions only)
- **Grounded HEAD:** `ebd1a1298d0f4bc1c44692ce116339f536b18967`
- **Reviewer:** adversary (fresh context) · **Date:** 2026-07-15
- **Scope:** truthfulness of the 17 rewritten `description` strings vs. implementation; newly-introduced claim-class violations; count/integrity. Style NOT reviewed.

## VERDICT: SHIP (PASS) — 0 blocking findings

Every factual clause in all 17 descriptions traced to its handler → `TenantDO` method → engine function and held. No description names a return field the code does not return, an input the schema does not accept, or behavior the code does not do. No webhook/push, AI-copy, real-send, or deliverability-guarantee claim was introduced. 17 tools still registered; no tool name or schema/required-field changed (descriptions-only diff); `mcp.test.ts:83` still asserts `toHaveLength(17)`.

## Per-tool truthfulness (all PASS — load-bearing clauses verified)

| tool | key claims verified against | result |
|---|---|---|
| setup_infrastructure | 7 inputs (brand/primaryDomain/domains/inboxesEach/persona/physicalAddress/senderIdentity) = `SetupInfrastructureInput` (intents.ts:14); returns `{jobId}` (provisioning.ts:153) | PASS |
| infrastructure_status | `{domains,mailboxes,sendReady,mailboxHealth[]}` + per-mailbox fields = `InfrastructureStatus`/`MailboxHealthReport` (provisioning.ts:156-226); delivStatus healthy/throttled/paused | PASS |
| launch_campaign | inputs = `LaunchCampaignInput` (intents.ts:38); "does not write copy" true; suppressed leads skipped (campaigns.ts:69); returns `{campaignId}` | PASS |
| campaign_results | returns `{campaignId,...EventCounts}` (reporting.ts:49); bounce=hard only + soft_bounce distinct (reporting.ts:12-18); opens not tracked; 404 (reporting.ts:57) | PASS |
| metrics | enumerated return = `EventCounts` from `getMetrics` (reporting.ts:61); tenant-wide GROUP BY | PASS |
| inbox | `{threads[],nextCursor}` + named row fields ⊆ `InboxRow` (inbox.ts:19); filters + archived exclude-default (dashboard.ts:196) | PASS |
| thread | `ThreadDetail` incl. mailboxEmail null-before-send (threads.ts:64); messages oldest-first (ts ASC); 404 | PASS |
| reply | body-hash idempotency fallback (threads.ts:134); returns `{messageId}`; 404 on no sending mailbox (threads.ts:125) | PASS |
| mark | status enum read/unread/archived = `MarkInput` (intents.ts:56); archived hidden from default inbox; 404 (threads.ts:182) | PASS |
| pause | status→'paused' (campaigns.ts:101); tick skips non-active (tick.ts:244); "no resume tool" true; 404 | PASS |
| pause_all | active→'paused' only (campaigns.ts:104-108) | PASS |
| account | full `AccountSummary` incl. deliverability rollup + teardown null-while-live (reporting.ts:85-103) | PASS |
| get_dashboard | list `{id,name,isDefault,rev,editedBy}` ⊆ `DashboardViewSummary` (dashboard-views.ts:11); id→full layout+rev | PASS |
| configure_dashboard | action enum + rev-CAS conflict `{currentRev,currentLayout}` — thrown (dashboard-views.ts:147) AND serialized to agent (handler.ts:151-156) | PASS |
| label_thread | set/clear label (null clears); distinct from mark; filterable via inbox.label | PASS |
| list_campaigns | `[{campaignId,name,status,counts}]` newest-first (campaigns.ts:124-152, ORDER BY created_at DESC) | PASS |
| activity | `{items[],nextCursor}` + item fields = `ActivityItem` (activity.ts:11); kind/limit(50/200) = `ActivityQueryInput` (dashboard.ts:200) | PASS |

## Claim-class result: CLEAN

- **webhooks/push:** none introduced (token sweep of added lines = 0 hits).
- **AI-support / AI-writes-copy:** none; launch_campaign explicitly states "the platform does not write copy" (the inverse claim).
- **deliverability guarantee:** none; the "deliverability loop actions (throttle/pause/rotate/replace)" surfaced by `account`/`activity` is REAL behavior — `deliverability-actions.ts` writes THROTTLE (:55), PAUSE (:67), ROTATE (:184), REPLACE_DOMAIN (:161) to `deliverability_actions`; not an outcome guarantee.
- **real-sending-live implication:** none.

## Integrity

- 17 `tool(...)` entries; names unchanged (setup_infrastructure…activity).
- Diff touches only the description string + reformat; every schema arg identical (EmptyInput/ThreadIdInput/ThreadMarkInput/CampaignIdInput/etc. re-emitted verbatim). `schemas.ts` and `packages/shared` not in the diff (git status: only tools.ts modified in src).
- `mcp.test.ts:83` asserts `tools` length 17.

## Self-refuted candidates (NON-findings)

- **inbox / infrastructure_status field lists are non-exhaustive** (omit campaignId/snippet/mailboxDelivStatus/labelSource; email/domain/status/sends). Omission ≠ false claim; every field named IS returned. Not a defect.
- **reply "404 if no sending mailbox"** omits the thread-not-found 404 (threads.ts:118). The stated 404 is real; the omitted one is implied by "existing thread." Not a defect.
- **metrics "same shape as campaign_results"** — metrics lacks `campaignId`; but the description's EXPLICIT field enumeration is exactly `getMetrics`'s `EventCounts`. Analogy is loose, enumeration is correct. Not a defect.

## NEW / out-of-scope (no verdict weight)

- **setup_infrastructure "Async — returns { jobId }"**: `runSetupInfrastructure` runs synchronously in B0 and returns a jobId "not yet backed by a tracked job record" (provisioning.ts:112). By the time the agent gets the jobId, provisioning is already complete, so polling shows the final state with no intermediate progress. This framing is CARRIED OVER unchanged from the prior description ("Returns immediately (async job)") and the returned field is real + pollable — not introduced by this diff, not a truthfulness defect. Noted only.
