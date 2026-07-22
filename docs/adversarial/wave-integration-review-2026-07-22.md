# Wave integration review — combined-diff adversary gate (2026-07-22)

**Reviewer:** adversary (fresh context) · **Ground:** worktree `/Users/yaakovscher/dev/coldstart-worktrees/integration-2026-07-21`, branch `integration/2026-07-21-wave`, HEAD `453e445698ae88c466445edee9cae5df23687654` (matches brief). Read-only git.
**Diff under review:** `git diff d17e417..453e445` (71 files). Primary target: sweep commit `453e445` (27 files, builder died pre-self-report).

## VERDICT: SHIP (round 2) — was SHIP-after-fixes (round 1), F1 now closed

Round 1 (HEAD `453e445`): one BLOCKING finding — the openapi.yaml lead paths referenced six undefined component schemas (dangling `$ref`s → invalid OpenAPI on exactly the new lead endpoints). Round 2 (HEAD `d28afe7`, openapi.yaml-only fix): the six schemas are now defined with code-derived shapes, 0 unresolved refs, all shapes verified against the actual serialization. **F1 CLOSED — CLEAN-SHIP.** See the round-2 addendum at the bottom. Everything else held under attack in round 1, including a re-attack of the prior spend-authorizing simulate class.

---

## Findings (most severe first)

### F1 — BLOCKING · lens 2/4 · openapi.yaml adds 3 lead paths that reference 6 undefined schemas
The sweep added `/leads`, `/leads/suppress`, `/leads/disposition` to `site/openapi.yaml`, each referencing component schemas — but **none of the six were defined** in `components/schemas`:
`LeadInterestStatus`, `LeadListPage`, `SuppressLeadInput`, `SuppressLeadResult`, `UpdateLeadInput`, `LeadDispositionView`.

- **Failure scenario:** a buyer agent (or any codegen/Swagger UI/Redoc consumer) fetches `coldrig.dev/openapi.yaml` — which the guides explicitly tell it is "verifiable directly against the OpenAPI schema" — to build an HTTP client. All three new lead endpoints have unresolvable request/response bodies. Client generation and spec validation fail on exactly the surface this wave ships.
- **file:line:** `site/openapi.yaml:972` (`LeadInterestStatus`), `:991` (`LeadListPage`), plus the `SuppressLeadInput`/`SuppressLeadResult`/`UpdateLeadInput`/`LeadDispositionView` refs in the three added path blocks (approx `:1000`, `:1030`, `:1050`).
- **Verification method:** parsed the YAML, collected the actual `components.schemas` key set, checked all 148 `#/components/...` refs → exactly these 6 are dangling (every byo/webhook ref resolves; only the lead lane omitted its schemas). Independently confirmed by `npx @redocly/cli lint site/openapi.yaml` → `no-unresolved-refs` rule fires: "Can't resolve $ref" at 972/991. The YAML itself parses (item 6 "valid YAML" passes) — it is *valid YAML, invalid OpenAPI*.
- **Note:** the paths and query params themselves are correct — GET `/leads` (6 params) + the two POST bodies match `routes/leads.ts` and `packages/shared/src/leads.ts` (`ListLeadsQueryInput`/`SuppressLeadInput`/`UpdateLeadInput`) exactly. Only the schema *definitions* are absent. Fix = add the 6 schemas (shapes are in `packages/shared/src/leads.ts` + the DO method return types).
- **Self-refutation:** could the refs resolve externally? No — all `#/components/schemas/` internal, single self-contained file. Could they be pre-existing/out-of-scope? No — §22 lead types are new this wave; they are missing at HEAD, which is what deploys. Redocly's separate `nullable` struct errors ARE pre-existing (WebhookDeliveryView/WebhookAttemptView/ActivityItem) and not this wave's doing — excluded from this finding.

### F2 — NON-BLOCKING (PRE-EXISTING, not a sweep regression) · lens 1/5 · guide-mcp-tool-count.html headlines 24 but surfaces only 22 tools
The page's H1/lede/callout/title/JSON-LD all say "24 tools," and the lifecycle table + caveats reference 22 of them: 20 in the table, `get_webhooks`/`configure_webhook` in the caveats paragraph. **`get_byo_domains` and `configure_byo_domain` appear nowhere on the page.**
- **Why not BLOCKING:** verified against the base (`d17e417`) version — the 21-tool page had the identical gap (byo tools were never in the table/caveats). This wave faithfully bumped every number 21→24, added the lead-disposition row, and updated `dateModified`. The omission is pre-existing, and the page hedges ("does not claim to cover every possible cold-outreach requirement"; "each stage has one/two/three intents"), so the coverage claim isn't strictly false.
- **Residual risk:** a buyer agent counting tools on this load-bearing page finds only 22 of the claimed 24 referenced. Optional: add a BYO-domain-intake row to the table. Not a wave blocker; flagged for the record because the brief named this page a primary target.
- **file:line:** `site/guide-mcp-tool-count.html:66-85` (table), `:88` (caveats). **Verification:** enumerated table `<code>` tool names (20) + caveats (2); diffed base vs HEAD to confirm pre-existing.

---

## Attacks that failed (why the PASS on everything but F1 is meaningful)

- **Buyer cross-check kill class (the exact prior kill: claim N, enumerate M) — lens 5.** `server-card.json` `tools[]` enumerates exactly 24 names AND its description says "24 focused tools." `AGENTS.md` enumerates exactly 24 table rows AND says "24 intents / 24 authed intents plus the one unauthenticated signup." Both internally consistent; all 24 names match `mcp/tools.ts` 1:1. HELD.
- **Stale-count sweep (fresh patterns, whole repo) — lens 1.** No live buyer surface (`site/*`, `README.md`, `AGENTS.md`, `llms.txt`, `server.json`, `plugin.json`, `llms-install.md`, `server-card.json`, `openapi.yaml` info block) still claims 21/19/17. Spelled-out cardinals corrected to "Twenty-four" on `llms.txt`, `index.html`, `agent-evaluation.md`. Remaining 21/19/17 hits are all in internal ledgers (ROADMAP/HANDOFF/MEMORY/`archive/`/`docs/`) — historical records, not buyer-facing. HELD.
- **3 new tool descriptions overclaim (CRM / auto-classification / Q4-Q5 deferred) — lens 1.** server-card + AGENTS.md descriptions for `suppress_lead`/`update_lead`/`list_leads` are faithful, tighter subsets of `tools.ts`. No "CRM," no "auto-classification," no `schedule_followup` capability claimed anywhere. HELD.
- **Concierge-activation caveat deletion — lens 1.** Diffed every deleted line: the only concierge/activation deletions are the OLD 21-tool `plugin.json` string (replaced by a 24-tool string that KEEPS "New accounts activate real sending via a short concierge step") and the self-serve lane's `realAdaptersActivated`→activation-gate refactor. No disclosure caveat was dropped. HELD.
- **Coldstart simulate-spend re-arm (my blind-spot ledger, lens 8 + regression ring).** The I1 gate elevates `billing_state='active'` to spend-authorizing; my ledger flagged that F1's round-1 guard keyed on `STRIPE_SECRET_KEY` presence while the danger window is exactly when that key is *absent* (engine armed before Stripe). Re-verified the round-2 fix `dc934e9`: `isRealSpendArmed(env) = STRIPE_SECRET_KEY || (ENGINE_BASE_URL && ENGINE_AUTH_SECRET)` (`engine/billing.ts:37`); used by both the route guard (`routes/checkout.ts:44`, 404 before any work) and the defense-in-depth guard inside `completeSimulatedCheckout` (`billing.ts:109`, throws before writing billing_state). `factory.ts:105` arms `RealEmailPort` exactly on `activated && engineConfig` where `engineConfig` derives from `ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET` — so the guard's signal fully covers the current real-spend path. InboxKit (mailbox/domain spend) has no env binding (I3/I4 unbuilt); the function documents the required extension when `INBOXKIT_*` lands. Engine-armed-before-Stripe window CLOSED. HELD.
- **Merge dross / lost lane edits — lens 7.** No conflict markers anywhere. `index.ts` mounts both lanes' routes (`leadsRoute:125`, `byoDomainsRoute:124`, `webhookSubscriptionsRoute:123`, `checkoutSimulateRoute:45`). `schema.ts` has both lanes' tables. `tenant-do.ts` has both lanes' methods. `server.json`/`plugin.json`/`server-card.json` all parse valid JSON. HELD.
- **openapi lead PATHS/params vs code — lens 4.** The path shapes and query params match `routes/leads.ts` exactly (only the schema *definitions* they reference are missing → F1). HELD on paths.

---

## UNVERIFIABLE
- **og-image.png raster text (lens 1).** The sweep regenerated `site/assets/og-image.png` (55335→55482 bytes); I cannot read raster text. The SOURCE `og-image.svg` was verified to say "One token · 24 focused tools · server-side guardrails." Low risk (svg is the generator input, regenerated in the same commit), but the PNG bytes were not OCR-confirmed. Resolve: render/OCR the PNG, or trust the svg source.
- **Live-surface drive (lens 3).** This is a pre-deploy branch review; no deployed Worker/site corresponds to `453e445` yet. F1 will manifest against the live `/openapi.yaml` once this deploys. Resolve: after deploy, `curl coldrig.dev/openapi.yaml | redocly lint -` should be clean (it will not be until F1 is fixed).

---

## NEW (out-of-scope observations — no verdict weight)
- **`schema.ts:569` ships a dead `followups` table.** New this wave (warm-lead commit `9b98909`, increments #1+#2), zero code references (no writer/reader) — it is increment #4's (`schedule_followup`) data model, and #4 is explicitly OUT of scope for this build (per `mcp/tools.ts:287-292`). Harmless at runtime (empty per-DO SQLite table, authorizes nothing), but a YAGNI/anti-slop-rule-(a)/(i) violation. Within the already-adversary-shipped warm-lead lane. Main loop may choose to strip it before deploy; not a blocker.
- **`guide-cold-email-with-ai-agent.html:115` "The ~24 tools"** uses an approximate tilde on an exact count (was "~21"). Pre-existing informal style, faithfully carried by the sweep; not false. Cosmetic only.

---

## Round-2 addendum (2026-07-22) — F1 fix re-verification

**HEAD `d28afe7`** (`fix(openapi): define the 6 lead component schemas (wave-gate F1)`), `git show --name-only` = **`site/openapi.yaml` only** (+85 lines, no code/test touched → no typecheck/test impact).

**F1 CLOSED.** Re-ran `npx @redocly/cli lint site/openapi.yaml` myself: **0 unresolved refs** (was 6). Spot-checked all six new definitions against the actual code serialization — every one matches, so no relocated codegen break:

| Schema | Code source | Match |
|---|---|---|
| `LeadInterestStatus` | `packages/shared/src/leads.ts:15` LEAD_INTEREST_STATUSES | exact 8-member enum |
| `SuppressLeadInput` | `packages/shared/src/leads.ts:36` | email/reason(=manual)/note(≤2000), required [email] — exact |
| `SuppressLeadResult` | `engine/suppression.ts:35` UnsubscribeResult | `{suppressed:true, alreadySuppressed:boolean}` — exact (`suppressed:true` literal modeled as `boolean enum [true]`) |
| `UpdateLeadInput` | `packages/shared/src/leads.ts:47` | exact; the zod `.refine()` at-least-one-of rule is captured in `description` (openapi can't express it structurally) — acceptable |
| `LeadDispositionView` | `engine/lead-dispositions.ts:9` | exact; `source` enum `[dashboard,mcp,api,system]` = `ProvenanceSchema` (`packages/shared/src/dashboard.ts:14`) exactly — neither too wide nor too narrow |
| `LeadListPage` | `engine/list-leads.ts:15-35` | exact 14-field row + `nextCursor`; the 3 `nullable` fields (`lastEventType`, `lastEventTs`, `nextCursor`) are genuinely `string|null`/`number|null` in code — correctly modeled, not droppable |

**Ruling on the 3 new nullable-class hits (team-lead question 3): ACCEPTABLE as house-style consistency — not must-fix for the wave.** The file declares `openapi: 3.1.0`, where `nullable: true` is a 3.0-ism (3.1 wants `type: [x, 'null']`), so redocly's `struct` rule flags it. But this is a **pre-existing file-wide class**: 18 identical `nullable: true` usages already live in `ThreadLabelInput`/`ActivityItem`/`ActivityPage`/`DashboardViewSummary`/`WebhookSummary`/`WebhookDeliveryView`/`WebhookAttemptView`, etc. The 3 new hits inside `LeadListPage` correctly model genuinely-nullable fields and match that established pattern. Converting just these 3 to 3.1 syntax while 18 siblings keep the old style would introduce inconsistency AND still leave redocly red (18 errors). Common codegen (openapi-generator et al.) tolerate `nullable: true` in 3.1 docs, so no hard codegen break. **Recommend a separate follow-up** (ROADMAP `## Open`): either pin `openapi: 3.0.3` (makes all 21 valid instantly) or convert all 21 to `type: [x, 'null']` — one cleanup, whole class, not piecemeal. Out of scope for this wave gate.

**Round-2 verdict: SHIP.** The 18 remaining redocly errors are entirely that pre-existing nullable class; the wave introduced no new error class. F2 (guide-page byo omission, pre-existing) and the dead `followups` table remain optional non-blocking cleanups from round 1.
