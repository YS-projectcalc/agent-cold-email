# Adversarial review — warm-lead thin-layer DESIGN (pre-ratification)

- **Target:** `scratchpad/warm-lead-dive.md` (agent-journey audit + data-model deltas D1/D2 + 4 new MCP tools 20-23 + ranked build list) — about to be ratified into `SPEC.md` as the settled warm-lead lifecycle design. BUILD is separately founder-gated; this verdict gates only the DESIGN ratification.
- **Grounded at:** HEAD `c30cd68` (`git rev-parse HEAD` = c30cd689…; tree clean except an unrelated ` M apps/engine/Dockerfile`). Read-only git throughout (shared live worltree).
- **Reviewer posture:** refute-by-default. Every load-bearing "X does not exist / X bypasses Y" claim re-derived from source; every candidate finding self-refuted before listing.

## VERDICT: **SHIP** (design safe to ratify) with named non-blocking residuals

No blocking finding survived self-refutation. The five premises the brief flagged as ratification-critical are all **TRUE** at HEAD (evidence below). Tenant isolation is structurally satisfied. The design introduces **no new path by which a suppressed/opted-out address can be emailed**, provided the `schedule_followup` drain implements the suppression re-check the design already mandates. The one substantive residual (R1) is a self-contradiction between §2 and open-question Q3 on the follow-up send mechanism — but Q3 explicitly defers that decision, so it is a text-reconciliation item, not a false premise.

---

## Premise verification (the "worst failure mode" pass — a design ratified on a false cite)

| Design claim | Verdict | Evidence (HEAD c30cd68) |
|---|---|---|
| MCP surface is **19 tools** | TRUE | `apps/platform/src/mcp/tools.ts:1,58-249` — 19 `tool(...)` entries; header comment matches. |
| Push webhooks deliver only `reply\|bounce\|soft_bounce\|complaint` | TRUE | `packages/shared/src/webhooks.ts:16` `WEBHOOK_EVENT_TYPES`. |
| `'manual'` suppression reason **declared but never written** | TRUE | Declared `packages/shared/src/types.ts:125`. Every `suppress(ctx,…)` callsite writes `"unsubscribe"`/`"bounce"`/`"soft_bounce"`/`"complaint"` (`suppression.ts:71`, `reply-processor.ts:204,253,285`). The only other `"manual"` in the tree is a `fetch` `redirect:"manual"` (`webhook-security.ts:267`), unrelated. |
| `unsubscribe` event inserted **directly**, bypassing the `recordEventIfNew` choke → adding it to the enum alone is **inert** | TRUE | Direct `INSERT INTO events … 'unsubscribe'` at `suppression.ts:95-105`; the webhook fan-out (`enqueueEventWebhooks`) fires **only** inside `recordEventIfNew` (`reply-processor.ts:81-127`, enqueue at :108). `recordEventIfNew` is never called with type `unsubscribe`/`sent`. Confirmed both changes (enum + route-through-choke) are needed together — item #6 is correctly stated. |
| `scheduled_sends` has **no body column** and carries **sequence semantics** (step index rendered from `sequence_json` at tick time) | TRUE | `schema.ts:126-151` (columns: …`step`, no `body`). Tick renders from `sequence.find(s=>s.step===row.step)` and **skips** a row whose step isn't in the sequence (`tick.ts:269-275`). So a custom-body one-off in `scheduled_sends` would be dropped unless `sequence_json` is polluted or the render path is branched → the "reject reuse" rationale is sound (see R2). |
| `leads` has **one row per campaign per email** (no cross-campaign uniqueness) | TRUE | `schema.ts:115-124` (`campaign_id NOT NULL`, no unique on email); launch inserts one lead row per (campaign,email) (`campaigns.ts:46-67`); `unsubscribeEmail` explicitly "walks EVERY lead row sharing this email — across every campaign" (`suppression.ts:74-80`). |
| Tick **honors suppressions at send time**, across every campaign | TRUE | `LEFT JOIN suppressions` + `CASE … suppressed` (`tick.ts:224-234`); skip on `row.suppressed` (`tick.ts:244-248`). |
| No `list_leads` / lead-centric read / export exists | TRUE | `grep -riE 'list_leads\|listLeads'` empty; no lead-read method on `TenantDO`. Lead **email** is recoverable via `inbox`/`thread`, but name/company are write-only — the full identity tuple is not loadable, as claimed. |
| `suppress_lead` can reuse `unsubscribeEmail` by parametrizing the reason | TRUE | Reason hardcoded `"unsubscribe"` at `suppression.ts:71`; tenant-wide walk (cancel pending + status='suppressed' + one event/lead) already implemented (`suppression.ts:66-109`); idempotent via the `alreadySuppressed` gate, not a dedupe index (events dedupe index `(tenant_id,type,message_id)` treats NULL message_id as distinct — `tenant-do.ts:164`). |
| Supporting cites: `setThreadLabel` label-only `thread-labels.ts:20-43`; canonical labels UI-only `dashboard.ts:20-27`; `agent_note` widget `dashboard.ts:84`; last-event CTE `inbox.ts:108-143`; `unsubscribeByEmail` `tenant-do.ts:459`; teardown keeps suppressions `lifecycle.ts:269-270` | TRUE | All read and confirmed. (`agent_note` is a dashboard **widget** prop, not literally a single per-tenant row — a tenant can have several; but the load-bearing point "not per-lead, not queryable per lead" holds.) |

**Tenant isolation (rule h):** structurally satisfied. MCP dispatch calls `matched.call(resolved.tenant.tenantStub, args)` (`mcp/handler.ts:140`) — the stub is derived from the authenticated tenant, never from a tool-supplied field. The four new tools take `email`/`threadId` operated **inside the caller's own DO**; a DO can physically reach no other tenant's SQLite. New tables D1/D2 carry `tenant_id` (belt-and-suspenders, matching existing convention). No cross-tenant reachability by design.

**Compliance (suppressed address emailable?):** No NEW hole.
- Campaign tick: suppression-checked (`tick.ts:244`).
- `schedule_followup` drain: design **mandates** re-check "suppression + lead status at send time (same guard as `tick.ts:244`)" — required because the manual-reply primitive it reuses (`replyToThread`) does **not** itself check suppression (`threads.ts:111-179`, no suppressions read). As long as the drain applies the stated re-check, the follow-up path is compliant.
- Independent of any agent: every send already carries a **server-honored RFC-8058 one-click link** (`tick.ts:342-343` + List-Unsubscribe header) and a **server-side typed-opt-out matcher** (`isUnsubscribeIntentReply`, `reply-processor.ts:57-73,163`). So the CAN-SPAM opt-out floor does not depend on the agent calling `suppress_lead` — `suppress_lead` is a genuine additive convenience for free-text opt-outs the strict matcher misses. This resolves the brief's "does anything REQUIRE server-side classification for compliance" question: **no** — the server-side backstops (hosted link + strict matcher) already exist upstream of the agent.
- `suppress_lead reason='manual'` vs CAN-SPAM: fine. Writing the `suppressions` row honors the opt-out immediately; the internal reason label is advisory (see R3).

---

## Non-blocking residuals (ranked)

**R1 (top) — §2 follow-up send mechanism contradicts its own open-question Q3; reconcile before lifting §2 text into SPEC.**
§2 says `schedule_followup` sends "via the existing manual-reply path (`threads.ts` `sendReply`…)". Q3 recommends the send "counts against the mailbox daily cap / warmup ramp … routed through the tick's capacity picker, not a bypass." These conflict: `replyToThread` (the real function; "sendReply" is a naming drift) resolves the thread's prior sending mailbox and sends **without** the daily-cap check, warmup-ramp check, `pickMailboxWithCapacity`, or the `deliv_status='paused'` exclusion that the tick applies (`tick.ts:256-267`). Implementing §2 literally would let a scheduled follow-up send from a **throttled/paused/still-warming** mailbox — a deliverability-reputation hazard (not a compliance/opt-out hazard; the suppression re-check is preserved in both readings). Because Q3 explicitly defers the mechanism, this is a **text-reconciliation** item, not a false premise — but if SPEC lifts §2 verbatim while Q3 stays open, a builder can ship the cap-bypassing path. **Resolution:** the ratified text should mark the send mechanism as pending Q3, and note that Q3=capacity-picker implies a shared *guarded single-send primitive* (caps + deliverability-pause + suppression) that neither `replyToThread` nor `runTick`'s inline loop currently exposes as a callable unit (see R2).

**R2 — the "reject reuse `scheduled_sends`" call is sound for storage, but the `followups` **drain** re-introduces guard duplication (rule c) the design under-counts.** Rejecting `scheduled_sends` is justified (no body column; step-render contortion — verified). But the design's claim that a `followups` drain "reuses more" is optimistic: to satisfy both rule c and Q3, the drain needs the tick's send guards (suppression re-check, cap, deliverability-pause exclusion), which live **inline** in `runTick`'s loop and are **absent** from `replyToThread`. So the honest reuse target is a *new shared guarded-send primitive*, not `replyToThread`. The design should name that primitive as part of increment #4 rather than implying `replyToThread` suffices.

**R3 — `suppress_lead` overwrites the `suppressions.reason` last-write-wins, and can relabel a stronger legal signal.** `unsubscribeEmail` calls `suppress()` **unconditionally** even when already suppressed (`suppression.ts:71-72`), so `suppress_lead(email,'manual')` on a former **complaint**/**unsubscribe** row overwrites the reason to `'manual'`. Inert **today** (every consumer — tick skip, teardown retention, launch COUNT — is reason-blind), and the reason column was already last-write-wins across existing paths, so this adds no new *class* of problem. Flagged because it introduces a new writer of a weaker value into a column that FBL/CAN-SPAM audit trails sometimes care about, and it becomes load-bearing the moment any reason-gated *un-suppress* is added (the design proposes none — keep it that way, or gate un-suppress on reason='manual' only).

**R4 (minor) — `followups` terminal-row retention unspecified.** D2 has `status pending|sent|skipped|canceled` but no pruning; `webhook_deliveries`/`sent_message_keys` both prune terminal rows (`tick.ts` TTL patterns). Add terminal-row pruning to D2 to avoid unbounded per-tenant growth. Build detail.

---

## Attacks that FAILED (why the PASS is meaningful)

- **Lens 1 (spec-vs-code line-trace):** opened and re-derived all ~15 cites; the design had already re-checked the scout's drifted `686e506` numbers against HEAD (leads 103→115, matcher 55→57, "no reply webhook" premise correctly retired to `d0e91ec`). Zero stale/false cites survived. This is the class that most often sinks a ratification here; it held.
- **Lens 8 (isolation):** tried to find a tool arg that crosses tenants — none; stub is auth-derived (`handler.ts:140`), tables are per-DO.
- **Compliance race:** tried "opt-out arrives after `schedule_followup` is queued but before it fires" → the mandated send-time suppression re-check (mirroring `tick.ts:244`) closes it; and the hosted one-click link + strict matcher suppress server-side regardless of the agent.
- **Cross-campaign disposition "leak":** keying `lead_dispositions` on `(tenant,email)` surfaces a note/status set in campaign A when campaign B lists the same contact — but this is **intra-tenant, same physical person**, and Q1 explicitly surfaces it as the recommended contact-level model vs the per-campaign alternative. Disclosed design decision, not an isolation defect. Not a leak in the cross-tenant sense.
- **Enum-addition inertness (item #6):** confirmed *correct* (would have been a false-optimism trap if wrong) — the direct insert genuinely bypasses the fan-out; the design flags that both changes are required together.
- **Idempotency of `suppress_lead`:** `alreadySuppressed` gate + NULL-message_id-distinct dedupe index → re-suppression is a safe no-op on the per-lead walk while still refreshing the reason. Held.
- **Migration risk:** D1/D2 are **DO-SQLite** tables (not the D1 control-plane), added via `CREATE TABLE IF NOT EXISTS` in `TENANT_DO_SCHEMA`, additive, no column migration/backfill on existing tables. Low. (The brief's "D1 migration" lens is a slight mislabel — nothing touches `migrations/0001_init.sql`.)

---

## UNVERIFIABLE / not attempted

- **Runtime behavior of the unbuilt tools.** These are design shapes; there is no code to execute for lens 2 (run-it) or lens 3 (live-drive). Verified the *reuse targets* (`unsubscribeEmail`, `replyToThread`, tick guards, last-event CTE) run as described by reading them, but the four new tools themselves cannot be exercised until built. Resolution: re-attack at BUILD time with a test that FAILS on old code (CLAUDE.md rule e), specifically asserting the `schedule_followup` drain's suppression re-check and (per Q3's answer) cap/deliverability routing.
- **AGENTS.md tool-list count** not re-synced here — if ratification bumps 19→23 tools, AGENTS.md / `.mcp.json` / any "19 tools" copy must move in lockstep (out of scope for the design doc; flagged for the build).

## NEW (out-of-scope) observations — no verdict weight

- The **existing `reply` tool** (`replyToThread`, `threads.ts:111-179`) already sends with **no suppression check** — an agent can `reply` into a thread whose lead has opted out. Pre-existing, not introduced by this design (a 1:1 reply is defensibly relationship/transactional), but it is the same unchecked primitive `schedule_followup` would reuse, so worth a deliberate ruling when #4 is built.
- `'sent'` events are also direct-inserted (`tick.ts:471`) and thus, like `unsubscribe`, invisible to webhooks — consistent with the design's item-6 "(+ optionally `sent`)" aside.
