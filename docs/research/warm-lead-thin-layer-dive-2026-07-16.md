> Frozen research record — verbatim dive output, 2026-07-16 (ordered 2026-07-15, `ROADMAP.md` `## Open`).
> Adversary verdict: SHIP with amendments — `docs/adversarial/warm-lead-thin-layer-design-2026-07-16.md`.
> Ratified into `SPEC.md` §22 (Warm-lead thin layer, ratified design, build-gated).

# Warm-lead lifecycle — deep dive (thin persistence/automation layer)

Verified at HEAD `c30cd68` (main, clean tree). All cites re-checked against current code — the scout's `686e506` line numbers had drifted (schema `leads` moved from `:103-112` to `:115-124`; matcher from `:55-71` to `:57-73`; the "no reply webhook" premise is dead — push shipped in `d0e91ec`).

The MCP surface is **19 tools** (`apps/platform/src/mcp/tools.ts:58-249`). Push webhooks now deliver `reply | bounce | soft_bounce | complaint` (`packages/shared/src/webhooks.ts:16`). The remaining gap is **persistence, not notification**: after a reply is pushed, the platform gives the agent nowhere durable to record what it learned or what to do next.

---

## 1. Agent-journey audit

The thesis question is "where must the customer's agent keep its own state or build its own sidecar." One row per point of forced statefulness.

| Journey stage | What the agent must do today | State it's forced to keep itself (sidecar) | Evidence (HEAD) |
|---|---|---|---|
| **Setup** | Call `setup_infrastructure` (async job), poll `infrastructure_status` for `sendReady`. | Only the poll loop; all warmup/health state is server-side and readable. **No real burden.** | `tools.ts:59-77` |
| **Launch** | Call `launch_campaign` with the **entire `leads[]` inline**. Leads are written once, campaign-scoped, and are **not loadable back out**. | The **canonical lead list** (email→name/company/context). There is no lead store to read from, no `list_leads`, no export, and no "add leads to existing campaign" — the agent's own memory *is* the CRM. | `campaigns.ts:46-67` (only ingest path); `leads` table `schema.ts:115-124`; no `list_leads`/`leads()`/export exists (grep empty; not in TenantDO method set) |
| **Reply arrives** | Webhook **pushes** the reply (good — no polling needed). Agent reads `thread`, decides interest. | Nothing at ingest — but see next two rows: the *result* of the decision has nowhere to live. | webhook enqueue `reply-processor.ts:108-125`; event types `webhooks.ts:16` |
| **Warm-lead disposition** | Classify interest itself (no auto-classification). Record it as a **free-text `label`** (≤100 chars, per-**thread**, single-valued, server-unvalidated) or a per-tenant `agent_note` markdown blob. | **Per-lead interest status + notes/next-step context.** `label` is cosmetic and per-thread, not per-lead; `agent_note` is one blob per tenant, not queryable per lead. Real disposition state lives in the agent's sidecar. | `setThreadLabel` writes label only, no side effect `thread-labels.ts:20-43`; canonical labels are UI-only `dashboard.ts:20-27`; `agent_note` = per-tenant blob `dashboard.ts:84` |
| **"Not interested / stop" (free-text)** | Recognize a non-canonical opt-out ("please stop", "not a fit, remove") that the **strict matcher misses**, and remember never to re-target that address — there is **no manual-suppress tool**. | A **private do-not-contact list**. The address stays contactable by every FUTURE campaign because nothing writes the `suppressions` row. The enum member `'manual'` exists but is **never written** by any code path. | strict exact-phrase matcher `reply-processor.ts:57-73`; `'manual'` declared but unused `types.ts:125`; tick *would* honor a suppressions row `tick.ts:228-244` |
| **Follow-up ("check back in Q3")** | Keep its own timer and re-invoke `reply` later, **or** launch a heavyweight new one-step campaign far in the future. There is **no `schedule_followup`**; the launch-time sequence is the only scheduler. | A **cron/timer sidecar** holding every pending follow-up (when, which thread, what to say). This is the single largest forced-state burden for nurture. | eager launch-time scheduling only `campaigns.ts:73-86`; tick drains `scheduled_sends` but nothing inserts a one-off `tick.ts:229` |
| **Reporting / handoff** | Page `inbox` + `thread` + `activity` + `campaign_results` and reassemble a lead-level view by hand. | A **materialized lead-level projection** — there is no lead-centric read at all (all reads are thread/campaign/event-centric), and no bulk export for a human/CRM handoff. | read tools `tools.ts:87-219`; no lead projection or export anywhere (grep empty) |
| **Opt-out reconciliation (push-driven agent)** | To learn a lead **auto-unsubscribed** (typed matcher or hosted one-click link), the agent must **poll** — `unsubscribe` and `sent` are **not** webhook event types. | A reconciliation poll loop, defeating the push model for the one event class most compliance-relevant. Worse: `unsubscribe` events are inserted **directly**, bypassing the webhook choke point, so merely adding the type to the enum would not deliver them. | enum lacks `unsubscribe`/`sent` `webhooks.ts:16`; choke point is `recordEventIfNew` `reply-processor.ts:81-127`; unsubscribe insert bypasses it `suppression.ts:95-105` |

**Net:** the platform is already a clean *notification + sending* substrate. The agent is forced to run a sidecar for exactly four things — **(1) lead identity/list, (2) per-lead disposition + notes, (3) do-not-contact, (4) follow-up timers** — plus a reconciliation poll for opt-outs. The thin layer makes those four things server-side so the agent can be stateless between webhook invocations.

---

## 2. Thin-layer design

Design principle: **the platform is the system of record for lead state (identity, disposition, notes, suppression, follow-up timers); the agent is the cognition layer.** The agent reacts to a push, reads current state via tools, writes state back via tools, and keeps nothing of its own between invocations. Persistence, not cognition — the customer's agent is already an LLM and classifies replies better than any engine heuristic; it just needs somewhere to put the answer.

### Data-model deltas (minimal, reuse existing keying)

**D1 — `lead_dispositions` table (new), keyed `(tenant_id, email)`** — decouples disposition from campaign-scoped `leads` rows, matching how `suppressions`/`soft_bounces` are already keyed per `(tenant,email)`:
```
lead_dispositions(
  tenant_id, email,                    -- PK (tenant_id, email)
  interest_status TEXT DEFAULT 'none', -- server-enforced enum (see Q2)
  notes TEXT DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  source TEXT,                         -- transport-derived, like thread_labels.source
  updated_at INTEGER
)
```
Chosen over adding columns to `leads` because `leads` has one row **per campaign per email** (`campaigns.ts:55-67`) — disposition belongs to the *contact*, not the campaign-lead. `list_leads` LEFT JOINs this in.

**D2 — `followups` table (new)** for one-off scheduled sends:
```
followups(
  id, tenant_id, thread_id, lead_id, campaign_id,
  run_at INTEGER, body TEXT,
  status TEXT DEFAULT 'pending',       -- pending|sent|skipped|canceled
  idempotency_key TEXT, created_at INTEGER
)
```
**Reject the seed's "reuse `scheduled_sends`."** `scheduled_sends` rows carry sequence semantics (a `step` index whose body is rendered from `campaigns.sequence_json` at send time in the tick) and have **no body column** — a one-off with a custom body would force a synthetic step + a body side-channel + a tick render-path branch = patch-on-patch (violates CLAUDE.md rule f). A dedicated `followups` table drained by the same tick alarm, sending via the **existing manual-reply path** (`threads.ts` `sendReply`, which already resolves the mailbox + dedupes), is cleaner and reuses more.

### New / changed MCP tools (tools 20-23)

1. **`suppress_lead`** *(new, mutating, `destructiveHint:true`)* — `{ email, reason?='manual', note? }`. Writes the `suppressions` row + cancels pending steps + sets lead status across every campaign. **Near-zero new code:** `unsubscribeEmail` already does the exact tenant-wide walk (`suppression.ts:66-109`); it only hardcodes reason `"unsubscribe"` at `suppression.ts:71` — parametrize that to accept `"manual"`. The tick already honors the row (`tick.ts:228-244`), so this instantly closes the "future campaigns still contact them" hole. **⚠️ COMPLIANCE-ADJACENT.**
2. **`update_lead`** *(new, mutating, `destructiveHint:false`)* — `{ email, interestStatus?, notes?, tags? }`. Upserts the `lead_dispositions` row (`source='mcp'`, server-derived like `thread_labels.source`). This is where the agent's reply-classification result lands.
3. **`list_leads`** *(new, read-only)* — filters `{ campaign?, interestStatus?, suppressed?, replied?, cursor, limit }` → `[{ email, name, company, interestStatus, notes, tags, suppressed, lastEventType, campaigns[] }]`. One JOIN over `leads`↔`lead_dispositions`↔`suppressions`↔last-event (the last-event CTE already exists in `inbox.ts:108-143` — reuse the pattern). **This is also the export surface** — paginate to dump; agents consume JSON, so a separate CSV endpoint is optional (item d).
4. **`schedule_followup`** *(new, mutating, `destructiveHint:true`)* — `{ threadId, runAt, body, idempotencyKey? }` → inserts a `followups` row. The tick drains due rows and sends via the existing `sendReply` path, **re-checking suppression + lead status at send time** (same guard as `tick.ts:244`) so a lead who opts out before the timer fires is never sent to. `cancel_followup` folds into `configure`/a status flip.

### What rides webhooks vs polling

- **Already push (keep):** `reply`, `bounce`, `soft_bounce`, `complaint` (`webhooks.ts:16`). The warm-lead trigger (a reply) is push — the agent never polls for the thing that starts the lifecycle.
- **Should push, currently poll-only (gap):** `unsubscribe`. Add it to `WEBHOOK_EVENT_TYPES` **and** route the opt-out insert through the choke point — today `unsubscribeEmail` writes the event via a direct `INSERT` (`suppression.ts:95-105`), not `recordEventIfNew` (`reply-processor.ts:81-127`), so the enqueue fan-out never fires for it. Both changes are needed together or the enum addition is inert.
- **Stays pull:** lead-level state (`list_leads`), disposition, reporting rollups (`metrics`/`campaign_results`/`list_campaigns`) — these are queries the agent runs on demand at handoff, not events.

**End-to-end flow after the thin layer:** reply pushed → agent reads `thread`, decides interest, calls `update_lead` (disposition + note) and either `reply` (now) or `schedule_followup` (later); a "stop" → `suppress_lead`. At handoff, a human or CRM calls `list_leads`. The agent holds **nothing** between pushes.

---

## 3. Ranked build list (with cut-line)

Effort: **S** ≈ ½ day, **M** ≈ 1–1.5 day, **L** ≈ 2 day. Each ships with a test that FAILS on old code (CLAUDE.md rule e).

| # | Increment | Effort | Why here | Reuses |
|---|---|---|---|---|
| **1** | **`suppress_lead` tool** + parametrize `unsubscribeEmail` reason (`"manual"`/`"unsubscribe"`) | **S** | **⚠️ Compliance-adjacent.** Closes the real hole (free-text "stop" stays contactable by future campaigns); highest value per line; the tick already enforces it. | `unsubscribeEmail` `suppression.ts:66-109`; `unsubscribeByEmail` `tenant-do.ts:459`; tick guard `tick.ts:228-244` |
| **2** | **`lead_dispositions` table + `update_lead` tool** | **M** | The persistence core — gives the agent a durable home for interest-status + notes, eliminating sidecar burdens (2) and (3). | keying pattern of `suppressions`/`soft_bounces`; `thread_labels.source` provenance |
| **3** | **`list_leads` tool** (filter + export projection) | **M** | Makes disposition queryable and gives the handoff/export surface (items b + d). Depends on #2. | last-event CTE `inbox.ts:108-143` |
| **4** | **`schedule_followup` + `followups` table + tick drain** | **M–L** | Removes the largest forced-state burden (the timer sidecar). Larger because of alarm/tick integration + idempotency + send-time suppression re-check. | tick alarm loop `tick.ts`; `sendReply` `threads.ts` |
| — | **── CUT LINE — ship #1 first, then #2+#3 as the persistence increment, then #4 ──** | | | |
| 5 | Deterministic reply **auto-classification pre-fill** (low-confidence, agent-overwritable) + push it on the webhook | M | Market-parity signal (buyer-run #1 winner bundled it free; item a) but **not required** — the agent classifies. Build only as a fast-follow for cheap/no-agent configs; never the source of truth. | pure classifier `classify.ts`; writes to `lead_dispositions` (#2) |
| 6 | Add `unsubscribe` (+ optionally `sent`) to webhook events **and** route the opt-out insert through the choke point | S–M | Lets a pure-push agent reconcile opt-outs without polling. Below the line only because reconciliation-by-poll is a tolerable interim. | choke point `reply-processor.ts:81-127`; fix bypass `suppression.ts:95-105` |
| 7 | Event-body **retention TTL** (reply bodies stored full, indefinitely) | S–M | **Compliance, separate track** — orthogonal to warm-lead UX (item e). Track it; don't bundle it into this wave. | `events` table `schema.ts:153-164` |

**Ship-this-increment-first:** **#1 `suppress_lead`.** It's compliance-adjacent, ~½ day, reuses a fully-built walk, and independently closes a real data-integrity/compliance hole regardless of whether #2–#4 ever ship. #2+#3 are the natural second increment (the persistence core is only useful once it's both writable and readable). #4 is the third. #5–#7 are explicitly below the cut-line for this order.

---

## 4. Open founder questions

1. **Lead identity scope.** Recommend disposition keyed per-`(tenant, email)` (`lead_dispositions`) so "interested on campaign A" is visible when campaign B is launched. Confirm — the alternative (per-campaign-lead-row disposition) means the same person can be `interested` in one campaign and `none` in another, and `suppress_lead` semantics (tenant-wide vs campaign-scoped) hang off this. Recommend **tenant-wide** suppress (matches unsubscribe today).
2. **`interest_status`: enum or free-form?** Recommend a **server-enforced enum** for status (`none|interested|meeting_booked|not_now|not_interested|bad_fit`) so it's drift-free and dashboard-filterable, **plus** free-form `tags` for everything else — a hybrid that keeps the `thread_labels` "agent's own taxonomy" freedom without letting core status drift across sessions.
3. **`schedule_followup` shape.** Same-thread reply (recommended for warm nurture — keeps context) vs a new cold thread? And: a scheduled follow-up is a **real send** — confirm it counts against the mailbox daily cap / warmup ramp (recommend yes, routed through the tick's capacity picker, not a bypass).
4. **Auto-classification (item a).** Build the deterministic pre-fill (#5) for dashboard/non-agent parity now, or rely entirely on the customer's agent and treat #5 as demand-driven? Recommend **persistence first (#2), classification pre-fill only if a real customer runs a cheap/no-agent config.**
5. **Retention TTL (item e).** Is indefinite full-body reply storage acceptable for the Mordy pilot, or is a TTL a launch gate? This is a compliance call, not a UX one — flagged so it isn't silently carried into GA.
6. **Export format (item d).** Is `list_leads` (paginated JSON over MCP) sufficient for handoff, or is a literal CSV/CRM-sync endpoint needed for a human-facing export? Recommend JSON-only until a real customer asks for CSV.
