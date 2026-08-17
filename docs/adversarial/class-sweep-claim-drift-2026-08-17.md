# Class sweep — claim drift (F2/F4 family) — 2026-08-17

Read-only class sweep dispatched from the agent-channel product audit
(`docs/adversarial/agent-channel-product-audit-2026-08-17.md`, findings F2 + F4).
No file outside this one was modified; no state-changing git ran.

| Item | Value |
|---|---|
| Ground ref | `9d3ec7e9021eb234c6f633540f0cca2aaa99cf2b` (`audit: agent-channel product readiness`) |
| Worktree drift at sweep time | `M .claude/agent-memory/spec-builder/MEMORY.md`, `M docs/research/backlink-outreach-targets-2026-08-17.md`, `?? .claude/agent-memory/spec-builder/…`, `?? apps/platform/.claude/agent-memory/class-sweeper/` — **no source, site, or doc file under sweep is dirty** |
| Method | static only — TypeScript result types, zod schemas, `MCP_TOOLS` registry, grep. Nothing was executed. |

---

## 1. Class definition (corrected)

The brief's definition is right but stops one level short of the mechanism. Restated:

> **Class: unbound claim.** Coldrig maintains **eight or more independent, hand-written
> copies of the same tool/endpoint contract** — `mcp/tools.ts` descriptions,
> `mcp/schemas.ts` `.describe()` strings, `site/.well-known/mcp/server-card.json`,
> `site/openapi.yaml` (summaries *and* schemas), the `AGENTS.md` table, the `README.md`
> table, `site/guide-mcp-cold-email.html`'s schema reference, and the drafted support-KB
> answer in `admin/support-kb.ts` — and **not one of them is derived from, or mechanically
> checked against, the TypeScript result type / zod schema / tool registry it describes.**
> Any edit to a return type, a `const` enum, or a route silently invalidates N prose
> copies, and nothing fails.

Two consequences the narrower framing misses, both confirmed live below:

- **Drift runs in both directions.** F2/F4 are "the code changed and the prose didn't."
  The `metrics` and `send-readiness date` findings are the mirror: the MCP tool description
  (`tools.ts:109`) is *correct* and **seven published surfaces** describe a different product.
  A guard that only audits `mcp/tools.ts` closes half the class.
- **Some copies are machine contracts, not prose.** `site/openapi.yaml:1792` declares
  `enum: [reply, bounce, soft_bounce, complaint]`. That does not merely mislead a reader —
  a client generated from the published spec **cannot emit `unsubscribe`**, a capability the
  code has shipped and delivers. Severity here is higher than for prose.

**This class has fired in this repo before and was closed only at the instance.**
`engine/tenant-messages.ts:187-190` records it in terms: *"increment 3 shipped the ack
writer without this filter … and **four public tool/API descriptions claimed the opposite
as fact**"* (`msgchannel-inc23-gate-2026-08-06` F1). The prose was fixed; nothing was built
to stop the next one. The sibling tool-COUNT guard (`test/site-tool-count-claims.test.ts`)
is the only structural defense that exists, and §4 shows exactly where its scope leaks.

---

## 2. Search coverage

### Lexical (every pattern run)

| Pattern | Scope |
|---|---|
| `setup_infrastructure\|infrastructure_status\|contact_operator\|list_messages\|ack_message\|remove_mailboxes\|configure_byo_domain\|suppress_lead\|update_lead\|list_leads\|launch_campaign\|campaign_results\|pause_all\|label_thread\|configure_webhook\|get_webhooks\|get_byo_domains\|configure_dashboard\|get_dashboard\|list_campaigns` | all `apps/platform/src/**/*.ts` (tool names referenced outside the registry) |
| `emitTenantMessage(\|emitOperatorMessage(` | `apps/platform/src` — 4 emit sites + 1 admin route |
| `newId("job")` / `CREATE TABLE IF NOT EXISTS` | `apps/platform/src` — proves no job store exists |
| `REPLACE_DOMAIN` / `replaceDomain\|replaceBurningDomain` | `apps/platform/src` |
| `jobId\|poll\|dns\|progress\|until ready\|202` | `site/openapi.yaml`, `site/for-agents.html`, `site/docs.html` |
| `soft_bounce` ∩ `complaint` | `site/*.html`, `README.md`, `AGENTS.md`, `site/llms.txt`, `server-card.json` |
| `Account-wide deliverability\|deliverability + warmup\|send-readiness date\|send-readiness estimate` | `site/`, `README.md`, `AGENTS.md` |
| `remove-mailboxes\|remove_mailboxes` | `site/openapi.yaml`, `apps/platform/src/routes/` |
| `operationId:` | `site/openapi.yaml` (44 ops enumerated, diffed against the 28-tool registry) |
| `support@\|contact support\|mailto` | `site/*.html`, `packages/cli/src`, `apps/platform/src` |
| `interface RemoveMailboxesResult\|ContactOperatorResult\|send_blocked` | `apps/platform/src` |
| `describe(` | `apps/platform/src/mcp/schemas.ts` (all ~40 input-schema strings listed) |
| `tools\|poll\|dns\|replace\|pending\|Returns` | `apps/dashboard/src/pages/SetupPage.tsx` |

### Semantic (surfaces read, not grepped)

- **All 28 tool descriptions** in `mcp/tools.ts:71-378`, each checked against its handler's
  declared result type (not against another description).
- **Result types read in full:** `InfrastructureStatus`/`MailboxHealthReport`
  (infrastructure-status.ts:22-79), `EventCounts`/`AccountSummary`/`DeliverabilitySummary`
  (reporting.ts:14-120), `InboxRow`/`InboxPage`, `ThreadDetail`/`ThreadMessage`,
  `ActivityItem`/`ActivityPage`, `DashboardViewSummary`/`Detail`,
  `WebhookSummary`/`Detail`/`DeliveryView`/`AttemptView`, `ByoDomainSummary`,
  `LeadListRow`/`LeadListPage`, `TenantMessage`/`MessageListPage`/`AckMessageResult`,
  `RemoveMailboxesResult` (billing.ts:987-991), `ContactOperatorResult`
  (contact-operator.ts:40-43), the `send_blocked` body (error-response.ts:107-111).
- **Second copies of the tool contract:** `server-card.json` (all 28 descriptions dumped
  and read), `AGENTS.md` (full file), `README.md` tool table, `site/openapi.yaml`
  (setup/metrics/webhook/idempotency sections + the full operationId set),
  `site/guide-mcp-cold-email.html` schema reference, `site/docs.html` tool table,
  `site/for-agents.html` capability + claim-ledger tables, `site/llms.txt`.
- **Message/alert/error bodies:** `retry-setup-message.ts` (whole file), the two
  `emitTenantMessage` sites in `provisioning.ts:650,680` + their `actionHint`s,
  `mailbox-credential-push.ts:187-193`, `contact-operator.ts:46` (`REPLY_NOTE`),
  `watchtower.ts:264-286`, `domain-dns.ts:386-453`, `error-response.ts:88-150`,
  `brand-guard.ts:93-111`.
- **Ledger-flagged surfaces covered first** (all four under-counted a prior sweep here):
  migration/DDL (`schema.ts` — no job table, `tenant_messages` shape), docs/ledger
  (`ROADMAP.md`, `ACTIVATION.md` — checked the support@ arming claim both directions),
  CI/config (`wrangler.toml` secrets — via the audit's F5), and **downstream consumers**
  (`webhook-enqueue.ts` confirmed type-generic, so the enum drift is doc-only).
- **CLI:** `packages/cli/src/index.ts` HELP (all 10 commands traced to a live case),
  `commands/infra.ts`, `commands/mcp.ts`, `packages/cli/README.md`.
- **Dashboard:** `apps/dashboard/src/pages/SetupPage.tsx` (per brief).
- **Existing guards read in full** to establish the precedent and find its gaps:
  `test/site-tool-count-claims.test.ts`, `test/site-claim-surface-scope.test.ts`.
- **Sibling worktrees under `.claude/worktrees/agent-*/` excluded** from every count.

---

## 3. Inventory

`IN` = exhibits the mechanism. `OUT` = checked and immune. `UNCERTAIN` = needs a ruling or a
fact I could not establish read-only. Most critical first.

### IN — response-field claims naming a field the type does not have

| Site | Verdict | Reason |
|---|---|---|
| `apps/platform/src/mcp/tools.ts:186` | **IN** | *"Returns `{ releasedCount, quote }` where quote is the new projected monthly."* `RemoveMailboxesResult` (`engine/billing.ts:987-991`) is `{ releasedCount, billing }`. **There is no `quote` key** — an agent reading `result.quote` gets `undefined` on the one irreversible money-losing tool. NOT in the audit; found by this sweep. |
| `site/.well-known/mcp/server-card.json:41` | **IN** | *"…per-mailbox health, **send-readiness date**."* No date/ETA field exists anywhere in `InfrastructureStatus` or `MailboxHealthReport` — only `sendReady: boolean` + `warmupDay: number`. Highest-visibility buyer-agent surface (MCP directory card). |
| `README.md:34` | **IN** | Same *"send-readiness date"* claim, same absence. |
| `AGENTS.md:47` | **IN** | *"…send-readiness **estimate**."* Same absence; `sendReady` is a boolean, not an estimate. |
| `apps/platform/src/mcp/tools.ts:74` | **IN** (audit F4) | *"A domain whose DNS setup has not finished yet is still returned by infrastructure_status **with its dns state pending**."* `InfrastructureStatus` (`infrastructure-status.ts:68-79`) has `domains: number` and no per-domain object or `dns` field (`:98-103`, `:167-176`). `site/openapi.yaml:125-126` states the truth (*"There is no per-domain DNS field to poll"*) — **the in-repo honest phrasing already exists.** |

### IN — behavior claims the code does not produce

| Site | Verdict | Reason |
|---|---|---|
| `site/.well-known/mcp/server-card.json:53` | **IN** | `metrics` :: *"Account-wide deliverability + warmup health."* `getMetrics` (`reporting.ts:66-68`) returns `EventCounts` only — sent/reply/bounce/complaint/unsubscribe/failed/soft_bounce. **Zero deliverability or warmup data.** |
| `AGENTS.md:50` | **IN** | Same false claim. |
| `README.md:37` | **IN** | Same false claim. |
| `site/openapi.yaml:304` | **IN** | `summary: Account-wide deliverability + warmup health.` — and openapi's *own* `EventCounts` schema at `:1673-1683` is correct. **One file contradicting itself.** |
| `site/guide-mcp-cold-email.html:118` | **IN** | Same false claim. |
| `site/guide-mcp-tool-count.html:75` | **IN** | Same false claim, in a table that maps buyer requirements to tools. |
| `site/guide-cold-email-with-ai-agent.html:124` | **IN** | *"Account-wide deliverability health"* — same. |
| `apps/platform/src/mcp/tools.ts:74` | **IN** | *"**Async** — returns `{ jobId, billing }`; poll infrastructure_status for progress."* `jobId` is `newId("job")` fabricated at the return statement (`provisioning.ts:626,658,697`); **no jobs table exists in `schema.ts`** and no endpoint accepts a jobId. The saga is synchronous. Same defect the ledger recorded for the "resumable saga" claim. |
| `site/openapi.yaml:138` | **IN** | *"Provisioning started. Returns `{ jobId, billing }`"* — same fabricated handle, published as the REST contract. |
| `AGENTS.md:46` | **IN** | *"kicks off async … Returns `202` **immediately**; poll `infrastructure_status`."* The saga runs inline before the 202 (`routes/infrastructure.ts:13-15`); `contact-operator-reconcile.ts:29` puts its worst case at *"~156 sequential real vendor calls."* Nothing is pollable for progress. |
| `apps/platform/src/mcp/tools.ts:86` | **IN** | `messages[]` :: *"poll this alongside the mailbox fields **so you never miss one**."* The inline list is hard-capped at `MAX_SURFACED_MESSAGES` = 5 (`tenant-messages.ts:194-208`) and silently truncates — audit F9 shows system-message churn evicting an operator reply. The description never discloses the cap; `list_messages`' description does. A false completeness guarantee. |
| `site/.well-known/mcp/server-card.json` (contact_operator) | **IN** (minor) | *"Works in **every** account state, including suspended."* Drops the admin-TERMINATED 401 exception that `tools.ts:371` states carefully. |

### IN — enumeration drift (closed set narrower than the code accepts)

Code truth: `WEBHOOK_EVENT_TYPES = ["reply","bounce","soft_bounce","complaint","unsubscribe"]`
(`packages/shared/src/webhooks.ts:21`; zod accepts all five at `mcp/schemas.ts:128-132`, and
`enqueueEventWebhooks` (`webhook-enqueue.ts:41-44`) filters generically, so `unsubscribe`
**does** deliver). Every surface below enumerates **four**.

| Site | Verdict | Reason |
|---|---|---|
| `site/openapi.yaml:1792` | **IN (highest severity)** | `enum: [reply, bounce, soft_bounce, complaint]` — a **machine contract**. A client generated from the published spec cannot emit `unsubscribe`. |
| `site/guide-mcp-cold-email.html:189` | **IN** | `("reply"\|"bounce"\|"soft_bounce"\|"complaint")[]  // required for create; **1-4 items**` — the zod max is `WEBHOOK_EVENT_TYPES.length` = **5**. A hard-false constraint. |
| `apps/platform/src/mcp/tools.ts:263` | **IN** | *"eventTypes: reply\|bounce\|soft_bounce\|complaint"* |
| `apps/platform/src/mcp/schemas.ts:133` | **IN** | `.describe("Required for create: which events to push (reply \| bounce \| soft_bounce \| complaint).")` — ships to the agent as the inputSchema doc. |
| `site/openapi.yaml:795` | **IN** | *"Push reply, bounce, soft_bounce, and complaint events…"* |
| `site/.well-known/mcp/server-card.json:113` | **IN** | Same four. |
| `AGENTS.md:65` | **IN** | Same four. |
| `AGENTS.md:96` | **IN** | Same four. |
| `README.md:51` | **IN** | Same four. |
| `README.md:124` | **IN** | Same four. |
| `site/llms.txt:52` | **IN** | Same four. |
| `site/docs.html:150` | **IN** | Same four. |
| `site/faq.html:65` | **IN** | Same four, inside a **JSON-LD `acceptedAnswer`** — machine-indexed by search and LLMs. |
| `site/faq.html:148` | **IN** | Same four (rendered twin of the above). |
| `site/for-agents.html:98` | **IN** | Same four, in the buyer-agent capability table. |
| `site/guide-mcp-cold-email.html:184` | **IN** | Same four. |
| `site/guide-cold-email-operation-claude-code.html:106` | **IN** | Same four. |
| `site/guide-cold-email-operation-cursor.html:116` | **IN** | Same four. |
| `site/guide-cold-email-operation-codex.html:97` | **IN** | Same four. |
| `site/compare-vs-salesforge.html:70` | **IN** | Same four, in a competitive comparison row. |

### IN — prescribes an action the surface cannot perform (audit F2 family)

| Site | Verdict | Reason |
|---|---|---|
| `apps/platform/src/engine/domain-dns.ts:396` | **IN** | *"Retrying will not help — this domain **needs to be replaced**; contact support."* No `replace_domain` tool, no replacement parameter, and `REPLACE_DOMAIN` is unreachable from a DNS stall (needs burn thresholds, which need sends). "contact support" names neither `contact_operator` nor an address. |
| `apps/platform/src/engine/domain-dns.ts:417` | **IN** | Same sentence on the give-up branch. |
| `apps/platform/src/admin/watchtower.ts:274` | **IN** | *"no mailbox will come up on it until it is replaced"* — operator-facing, but asserts the same nonexistent remedy. |
| `apps/platform/src/engine/retry-setup-message.ts:24` | **IN** (audit F1) | *"retry `setup_infrastructure` **with the same idempotency key** to finish it."* After the 202 SUCCESS-PENDING branch the key is recorded `done` and `idempotency.ts:78-81` replays without running `fn` — the audit's probe ARM A shows zero vendor calls and empty `messages[]`. The system's own instruction is the one action that cannot work. |
| `apps/platform/src/engine/retry-setup-message.ts:21` | **IN** | Same instruction, no-domain branch. |
| `apps/platform/src/engine/provisioning.ts:654` | **IN** | `actionHint: { tool: "setup_infrastructure", idempotencyKey: setupKey }` — the machine-readable twin of the same dead instruction. |
| `apps/platform/src/engine/provisioning.ts:684` | **IN** | Same. |
| `site/openapi.yaml:124` | **IN** | *"**Repeat the same call** to converge onto that domain and finish its DNS setup."* Contradicts openapi's own `:99-101` (*"The key governs response replay only … returns that call's recorded result without re-running it"*). One file, two incompatible instructions. |

### IN — tool-surface understatement in a file the existing guard does not scan

| Site | Verdict | Reason |
|---|---|---|
| `apps/platform/src/admin/support-kb.ts:48-49` | **IN** | The drafted answer a customer receives: *"point it at the hosted MCP endpoint … and it gets **~12 tools** — setup_infrastructure, infrastructure_status, launch_campaign, campaign_results, metrics, inbox, thread, reply, mark, pause, pause_all, account."* The registry is **28**. This is exactly the class that burned buyer evaluations three times — and it survives because (a) `support-kb.ts` is **not in `CLAIM_SURFACES`** and (b) `12` is not in `RETIRED_TOOL_COUNTS = [17,19,21,24,25,27]`. **Double scope gap.** |

### IN — contract-completeness claims

`site/openapi.yaml` declares 44 `operationId`s covering **27 of the 28 tools**.
`remove_mailboxes` has **no path item** — yet the file references `/remove-mailboxes` three
times (`:1433`, `:1439`, `:1476`) while never declaring it. The route is live
(`routes/checkout.ts:27`).

| Site | Verdict | Reason |
|---|---|---|
| `AGENTS.md:103` | **IN** | *"OpenAPI (**the 28 intents** as REST): `site/openapi.yaml`"* — it documents 27; the missing one is the irreversible downgrade. |
| `AGENTS.md:42` | **IN** | *"**Full** request/response schemas: `site/openapi.yaml`"* — same gap. |
| `site/for-agents.html:110` | **IN** | Claim-ledger row *"28 authenticated intents \| Live \| Evidence: OpenAPI"* — **the cited evidence documents 27.** A claim ledger whose own citation fails to support it. |

### UNCERTAIN

| Site | What would settle it |
|---|---|
| `AGENTS.md:9` — *"you call 28 intents over HTTP, the hosted MCP endpoint, or the `agent-cold-email` CLI"* | The CLI's own commands are 9 REST wrappers covering ~12 intents (`packages/cli/src/index.ts:20-35`); all 28 **are** reachable through `agent-cold-email mcp` (the stdio↔HTTP bridge, `commands/mcp.ts`). Ruling needed on whether "via the CLI" means its commands or its bridge — then either add commands or say "via `agent-cold-email mcp`". |
| `site/terms.html:75` — *"You can also email **support@epiphanymade.com** to request cancellation"* | Every other surface publishes `support@coldrig.dev`, and the only verified routing (`ACTIVATION.md:93`) is `support@coldrig.dev` → Worker. Settles by confirming whether `support@epiphanymade.com` is a monitored, routed mailbox. |
| `apps/platform/src/engine/contact-operator.ts:46` (`REPLY_NOTE`) — *"check list_messages **or** infrastructure_status's messages[]"* | True for `list_messages`; the `infrastructure_status` half is subject to the 5-cap eviction (audit F9). Settles by ruling whether the disjunction is acceptable or should name `list_messages` alone. |
| `apps/platform/src/mcp/tools.ts:86` — per-mailbox field list omits `email`, `domain`, `status`, `sends`, `vendorHealth`, `vendorHealthError` | Under-documentation, not falsity — **except** that `vendorHealth:'unknown'` is a degraded state in which the two documented `vendor*` numbers are `0` and meaningless (`infrastructure-status.ts:47-51`), and the description presents them unconditionally. Needs an editorial ruling: is "a documented field that means something else in a failure mode" in-class? |
| `AGENTS.md:85` — *"Poll `infrastructure_status` until ready"* | Performable in the happy path (`sendReady` exists); never terminates for a DNS-stalled tenant, and the doc gives no exit. Ruling needed on whether an unbounded-in-the-failure-case instruction counts as mechanism (a). |

### OUT — checked and immune

- **Response shapes that match their descriptions exactly:** `inbox` (`InboxRow`), `thread`
  (`ThreadDetail`/`ThreadMessage`), `activity` (`ActivityItem`/`ActivityPage`), `account`
  (`AccountSummary` — every named field present incl. `teardown`), `campaign_results` /
  `metrics` **field list** (`EventCounts`, `soft_bounce` present), `get_dashboard`
  (`DashboardViewSummary`, incl. `editedBy`), `configure_dashboard`'s
  `{ currentRev, currentLayout }`, `get_webhooks` (`WebhookSummary`/`WebhookDetail`),
  `get_byo_domains` (`ByoDomainSummary` — all 8 named fields), `list_leads` (`LeadListRow`
  — all 14), `list_messages` (`TenantMessage` incl. `source`/`readAt`), `ack_message`
  (`AckMessageResult`), `contact_operator` (`ContactOperatorResult` = `{ticketId, note}`),
  `reply`'s refusal body `{error, code:'send_blocked', reason, retryable}`
  (`error-response.ts:107-111`), and the literal wrappers of `mark`/`pause`/`pause_all`.
- `mcp/tools.ts:320` — `suppress_lead`'s *"note (accepted, **not persisted**)"* is **honest**
  (`suppression.ts:138-142`). **Cite this as the model phrasing** for a field a schema
  accepts and the code drops.
- `mcp/schemas.ts:136` — *"Ignored placeholder for symmetry; webhooks record no provenance
  note."* Honest, same pattern.
- `mcp/tools.ts:350` — *"infrastructure_status also inlines the newest 5 **unacked**
  messages"* is **TRUE**; the `read_at IS NULL` filter is present
  (`tenant-messages.ts:200`). Its doc comment (`:187-190`) is the record of the prior
  incarnation of this class.
- `site/guide-mcp-cold-email.html:160` — `count: integer (1-60)` matches
  `intents.ts:199` `.min(1).max(60)`.
- `admin/support-kb.ts:34-43` (billing) and `:54-61` (deliverability) — verified against the
  pricing curve and the real `applyReplaceDomain` path
  (`deliverability-actions.ts:144-230` genuinely retires, releases, and buys a replacement).
- `packages/cli/src/index.ts:15-42` HELP — every listed command traces to a live `case`; no
  count claim made. `packages/cli/README.md`'s *"nine of the ten commands"* is accurate.
- `apps/dashboard/src/pages/SetupPage.tsx:46,52` — *"28 tools"* twice, **correct**.
- `site/status.html:8` — *"support@ inbound delivery is live"* is **TRUE**
  (`ACTIVATION.md:93`, two end-to-end verified tickets 2026-07-20). The stale claims run the
  *other* way and are **internal, not customer-facing**, so they are OUT of this class but
  flagged: `apps/platform/src/ops-mail/auth-mailer.ts:29-30` (*"support@ inbound routing is
  still disarmed"*) and `ROADMAP.md:187(c)` (*"no support@ contact published (routing built
  but disarmed)"*).
- `site/for-agents.html:135` / `site/docs.html:114` — *"POST /checkout … is not one of the
  28 MCP tools"* is **TRUE** (no checkout tool in the registry).
- `mcp/tools.ts:176-183` — the comment explaining there is deliberately no `rotate_token`
  tool is accurate.
- `mailbox-credential-push.ts:190` — *"Your mailbox X is authorized — sending is now
  enabled"* is gated on `!isLifecycleFrozen` (`:185-186`), so the claim is scoped to states
  where it holds.

**Counts: 40 IN · 5 UNCERTAIN · OUT as enumerated above (24 verified-immune claim sites).**

---

## 4. Systemic guard

One new test file, `apps/platform/test/tool-claim-binding.test.ts`, extending the
`site-tool-count-claims.test.ts` `?raw`-import pattern from **counts** to **fields, enums,
and coverage**. Four rules, each mechanically decidable:

**G1 — response-field binding.** A per-tool map `toolName → [sourceFile, interfaceName]`
(28 entries, one-time). Extract the field list from each description's `Returns { … }` /
`→ [{ … }]` phrase with one regex; assert every extracted identifier is a declared property
of that interface in the `?raw`-imported source. A companion assertion fails if any
`MCP_TOOLS` entry lacks a map entry, so **tool 29 cannot be added without declaring its
result type.** Deterministic, no seeding, covers writers as well as readers.
*Optional backstop:* for the ~14 `readOnlyHint` tools, drive the real DO through the existing
workers-pool harness (`test/helpers.ts`, as `test/mcp.test.ts` already does) and assert
`Object.keys(result)` ⊇ the extracted fields — this catches a type that declares a field the
code never populates, which G1 alone cannot.

**G2 — enumeration binding (highest yield).** For every closed set the code owns as a `const`
array (`WEBHOOK_EVENT_TYPES`, `LEAD_INTEREST_STATUSES`, and the `MailboxStatus` /
`ScheduledSendStatus` / `ByoStatus` unions): if a claim surface contains **≥2 members within
a 200-character window, it must contain ALL members.** One rule; it fails on all 20 webhook
sites today and generalizes to every future enum. Structurally the same idea as
`claimsToolCountOf`, moved from cardinality to membership.

**G3 — surface registration.** `CLAIM_SURFACES` is a hand-maintained array, which is
precisely how `admin/support-kb.ts` shipped *"~12 tools"* untouched. Replace it with a glob
(`site/**/*.{html,yaml,txt,json,md}`, root `*.md`, `packages/cli/README.md`, plus any
`apps/platform/src/**/*.ts` containing a string literal that names ≥3 tool names) and **pin
the resulting file count**, so a new claim-bearing file fails the guard until triaged.
Separately, for `src/` and manifest surfaces widen the count check from the fixed
`RETIRED_TOOL_COUNTS` list to *any* integer adjacent to `tools`/`intents` that is not
`MCP_TOOLS.length` — the narrow retired-list heuristic is needed only for prose-dense site
pages, not for code.

**G4 — openapi ↔ registry coverage.** Assert the `operationId` set covers every
`MCP_TOOLS[].name`, modulo the documented fan-out tools (`configure_dashboard` →
`configure_dashboard_{create,update,promote,delete}` etc.). Fails today on
`remove_mailboxes`.

### Failing-test sketch

```ts
// apps/platform/test/tool-claim-binding.test.ts
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { WEBHOOK_EVENT_TYPES } from "@coldstart/shared";
import billingSrc from "../src/engine/billing.ts?raw";
import infraStatusSrc from "../src/engine/infrastructure-status.ts?raw";
import supportKb from "../src/admin/support-kb.ts?raw";
import openapiYaml from "../../../site/openapi.yaml?raw";
// … + the globbed CLAIM_SURFACES from G3

const RESULT_TYPES: Record<string, readonly [string, string]> = {
  remove_mailboxes:      [billingSrc,      "RemoveMailboxesResult"],
  infrastructure_status: [infraStatusSrc,  "InfrastructureStatus"],
  // … 28 entries total
};

it("every tool declares a result type (tool 29 cannot land without one)", () => {
  expect(MCP_TOOLS.map((t) => t.name).filter((n) => !(n in RESULT_TYPES))).toEqual([]);
});

// G1 — FAILS ON HEAD: remove_mailboxes claims "quote"; the interface declares "billing".
it.each(MCP_TOOLS)("$name's Returns{} fields all exist on its result interface", (t) => {
  const [src, iface] = RESULT_TYPES[t.name]!;
  const claimed  = extractReturnsFields(t.description);   // ["releasedCount", "quote"]
  const declared = declaredProps(src, iface);             // ["releasedCount", "billing"]
  expect(claimed.filter((f) => !declared.includes(f))).toEqual([]);
});

// G2 — FAILS ON HEAD on ~20 surfaces: every one omits "unsubscribe".
it.each(CLAIM_SURFACES)("%s enumerates the FULL webhook event set", (label, text) => {
  expect(missingEnumMembers(text, WEBHOOK_EVENT_TYPES), label).toEqual([]);
});

// G3 — FAILS ON HEAD: the drafted support answer says "~12 tools".
it("the drafted support answer states the CURRENT tool count", () => {
  expect(claimsToolCountOf(supportKb, MCP_TOOLS.length)).toBe(true);
});

// G4 — FAILS ON HEAD: remove_mailboxes has no operationId.
it("openapi declares an operation for every MCP tool", () => {
  const ops = new Set([...openapiYaml.matchAll(/operationId:\s*(\S+)/g)].map((m) => m[1]!));
  expect(MCP_TOOLS.map((t) => t.name).filter((n) => !coveredBy(ops, n))).toEqual([]);
});
```

**Revert-fail-restore note for the orchestrator:** G1 (`remove_mailboxes` arm), G2, G3, and
G4 all fail on `9d3ec7e` **unmodified** — HEAD *is* the "old code" state, so the fixer owes a
red-before / green-after transcript, not a revert. The prose-only findings (metrics,
send-readiness date, jobId, F2/F4 strings) are not all covered by G1-G4 and need their own
per-claim assertions or a fix to the code side; the orchestrator owns that scope split.

---

## 5. Confidence — what a second sweep should check

1. **Nothing was executed.** Every finding is static (result type + zod schema + grep +
   registry). The audit's live probes cover F1/F2/F4; the new findings here (`quote`,
   `metrics`, send-readiness date, the webhook enum, openapi's missing `remove_mailboxes`,
   `support-kb.ts`) are all type/grep-provable but none were run against a live DO.
2. **Types, not payloads.** A type can declare a field the code never populates (an
   always-`null` optional). The G1 backstop (live-call the ~14 read-only tools) is the only
   thing that settles that direction; I could not run it read-only.
3. **~30 `site/*.html` pages were pattern-swept, not read end-to-end.** I read them for the
   specific signatures found (webhook enum, `metrics`, tool counts, `jobId`, `dns`). A second
   pass should read the **eight `compare-vs-*.html` pages line by line** — competitive tables
   make the most specific capability claims, and only `compare-vs-salesforge` and
   `compare-vs-smartlead-instantly` appear in either existing guard's surface list.
4. **`mcp/schemas.ts`'s ~40 `.describe()` strings** ship to the agent as inputSchema docs.
   I verified the webhook one and spot-checked the rest; nobody has checked each
   `"Required for X"` note against the `.refine()` that actually enforces it.
5. **Dashboard coverage was scoped to `SetupPage.tsx`** per the brief. `BillingPage`,
   `SettingsPage`, `InboxPage`, and `DashboardPage` carry customer-facing copy and were not
   swept.
6. **Deployed-vs-in-tree `site/`.** This sweep read `site/` at the pinned ref. If the site
   deploys through a separate pipeline, the live pages could differ from what was swept.
