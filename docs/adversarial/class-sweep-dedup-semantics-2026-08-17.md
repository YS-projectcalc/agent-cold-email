# Class sweep — dedup/collapse semantics that destroy or hide a genuine signal

Read-only inventory produced for the Bug Response protocol step 3, off the
agent-channel product audit (`agent-channel-product-audit-2026-08-17.md`,
findings F7 + F9). This document inventories the class. It does not fix
anything and does not scope the fix — the main loop owns that decision.

## Grounding

| Item | Value |
|---|---|
| Ref | `9d3ec7e9021eb234c6f633540f0cca2aaa99cf2b` |
| Worktree state | `apps/platform/src` CLEAN. Dirty at sweep time: `.claude/agent-memory/spec-builder/MEMORY.md`, `docs/research/backlink-outreach-targets-2026-08-17.md`, untracked `apps/platform/.claude/agent-memory/class-sweeper/` — none engine code |
| Scope | `apps/platform/src/**`, `apps/platform/migrations/**`, **`apps/engine/src/**`**, `packages/shared/src/**`, `packages/cli/src/**`, `site/openapi.yaml`, `AGENTS.md`, `apps/platform/test/**`, `apps/platform/wrangler.toml` |
| Excluded | `spikes/*/node_modules` (vendor code only — no first-party dedup logic in `spikes/` or `tools/`) |
| Sibling agents | `sweep-cached-terminal` overlaps on member IN-13 (`withRequestIdempotency` cached-`done` replay). Flagged, not dropped |

---

## 1. Class definition (CORRECTED)

The brief's definition — *"any dedup key/window/re-stamp/bounded-view whose
semantics can DESTROY or HIDE a genuine distinct signal"* — is **correct in
extension but too loose in mechanism**: as written it also catches every rate
cap and every threshold in the repo, most of which are immune because they
report the suppression. Sharpened:

> **A collapse decision is taken on a key, window or view whose granularity is
> COARSER than the identity of the signal being collapsed, and the collapse is
> reported to the party that could act on it as an ordinary success (or not
> reported at all).**

The mechanism is the pairing, not either half. A coarse key that *throws* is
safe (`launchCampaign`'s duplicate guard). A perfectly-keyed dedup that returns
a bare `201` is safe *only* because its key is exact. Every member below fails
both halves at once, or fails the disclosure half over a key that cannot be
made exact.

Three sub-mechanisms, one missing invariant:

- **A — COLLAPSE-AT-WRITE.** The dedup key omits a field that distinguishes two
  genuinely different signals (`(body,urgency)` omits *time-of-intent*;
  `content-hash` omits *intent-to-send-again*; `(type,message_id)` omits *which
  DSN*; `(tenant_id,action)` omits *which episode*).
- **B — HIDE-AT-READ.** An unbounded producer feeds a bounded or re-ordered
  view (`LIMIT 5`; `created_at` re-stamped to now; a keyset cursor over a
  column the writer mutates).
- **C — SUPPRESS-AT-NOTIFY.** An alert state machine whose consecutive-
  observation or cooldown semantics **delete** rather than delay (a streak
  reset by any good tick; a materially-changed detail inside a 24h step).

Sub-mechanism C is the direct sibling of the already-closed
`confirmation-guard-deletes-one-shot-signals` class from the alert-debounce
wave. That wave closed the **never-re-observed** case (one-shot reports got
`IMMEDIATE_ALERT_POLICY`). It did **not** close the **re-observed but not
CONSECUTIVELY** case, which is IN-8 and IN-9 below. Naming this correctly
matters: "the debounce class is closed" is true only for one of its two halves.

---

## 2. Search coverage

### Lexical (every pattern run, `apps/platform/src`, `--include='*.ts'`, test files filtered separately)

| Pattern | Purpose |
|---|---|
| `-i "dedup"` | the named mechanism, incl. comments |
| `"INSERT OR IGNORE\|ON CONFLICT\|INSERT OR REPLACE"` | upsert-as-dedup |
| `"UNIQUE"` | the backing keys, code + migrations |
| `-iE "throttl\|cooldown\|debounce\|COOLDOWN_MS\|silenc\|suppressAlert"` | notify-side collapse |
| `"LIMIT"` (minus `LIMIT ?` / `limit + 1` / `query.limit`) | fixed-N bounded views |
| `"\.slice(0"` | JS-side truncation (catches what SQL `LIMIT` misses) |
| `-E "^(export )?const MAX_[A-Z_]+ ="` | every declared ceiling |
| `"source_send_id"`, `"message_id"`, `"messageId\|originalMessageId"` | dedup-key provenance |
| `"emitTenantMessage(\|emitOperatorMessage("` | every dedupKey chooser |
| `"withRequestIdempotency"` | transport-layer replay |
| `"insertDunningEventIfNew\|hasDunningEventForCycle\|insertEnforcementActionIfNew"` | D1 idempotency anchors |
| `"failure_signals\|warmup_cancel_gave_up\|SEND_STARVED_CHECK\|TENANT_DO_WEDGED_CHECK"` | aggregate check names |
| `"FROM suppressions\|suppressions "` | who reads a clobbered column |
| `-iE "dedup\|throttl\|cooldown\|already\|OR IGNORE\|ON CONFLICT"` over `engine/byo-*.ts` | the BYO lane specifically |

### Semantic (surfaces read in full, that no grep above would have surfaced)

- **The port CONTRACT, not just the consumer** — `packages/shared/src/vendor-ports.ts:293-372`.
  This is what settles whether `events`' `(type, message_id)` key equals the
  signal's identity: `PolledReply.messageId` is the **inbound** RFC 5322 id
  (exact → OUT); `PolledBounce`/`PolledComplaint` carry only
  `originalMessageId`, the **outbound** send's id, and no id of their own
  (coarse → IN-14). Reading `reply-processor.ts` alone cannot decide this.
- **Both adapters, diffed** — `vendors/sandbox/email-port.ts:45-107` mints a
  fresh `sandboxMessageId()` per reply and reuses `result.messageId` for every
  bounce/complaint, so the sandbox **cannot produce** two distinct DSNs for one
  send. IN-14 is untestable with the current fixtures by construction.
- **The DISCLOSURE boundary** (the half a code grep never finds): `routes/messages.ts:36-41`
  returns `201` for a collapse; `mcp/tools.ts:376` passes the RPC result
  through unchanged; `packages/shared/src/intents.ts:173-177` defines the input
  but there is **no** `ContactOperatorResult` schema in shared at all — the
  result shape is declared inline at `engine/contact-operator.ts:40-43` as
  `{ticketId, note}` with no discriminator.
- **The CLAIM surfaces** (ledger lesson — docs under-counted in a prior sweep):
  `mcp/tools.ts:86` and `:371`, `site/openapi.yaml:1188` and `:1250-1267`,
  `AGENTS.md:71`. Two of these assert the missing guarantee as fact.
- **The TESTS that pin the defect**: `test/tenant-messages.test.ts:59`,
  `test/contact-operator.test.ts:170,508`. A green suite today is evidence
  *for* the defect, not against it.
- **Migration SQL as a separate surface from runtime DDL** (ledger lesson):
  `migrations/0002_admin_ops.sql:36-46` (`UNIQUE(tenant_id, cycle)`),
  `0003_lifecycle.sql:19-33` (`UNIQUE(tenant_id, action)`),
  `0005_support_dedupe.sql:4-15` (`UNIQUE(tenant_id, message_id)`),
  `0017`, `0018_watchtower_debounce.sql` — versus `tenant-do.ts:447-467`'s
  runtime `ensureDedupeIndex`/`ensurePartialDedupeIndex`. The DO-side keys
  exist **only** in TypeScript; no migration file declares them.
- **The boot-time destructive collapse** — `tenant-do.ts:514-526`. Not a dedup
  *decision* site, but it `DELETE`s historical rows that share the key, so it
  retroactively amplifies any key that is too coarse. Grepping for dedup
  decisions misses it entirely.
- **The time base under every window** — `clock.ts:1-56`, `tenant-do.ts:265-301,584`.
  See §5: this **corrected a stale assumption** carried in from a prior sweep.
- **Cron cadence vs. debounce arithmetic** — `wrangler.toml:121-122` (`*/5 * * * *`)
  against `WATCHTOWER_CONFIRM_OBSERVATIONS = 2` and `LEG_ALERT_AFTER_SWEEPS = 3`.
- **The in-repo COMPLIANT templates** — `engine/campaigns.ts:93-108` (same
  content-hash-over-a-window shape as IN-7, opposite disclosure posture) and
  `apps/engine/src/mailbox-store.ts:35-60` (content-hash dedup ordered by a
  monotonic claim sequence, rejecting ambiguity loudly).
- **THE SECOND SERVICE.** `apps/engine/src` is a separate daemon with its own
  dedup logic, and an `apps/platform/src`-only sweep under-counts by
  construction — flagged in the class-sweeper ledger by the concurrent
  head-of-line-blocking sweep, and it paid off immediately: IN-22 and IN-23
  live only there. Patterns run: `-iE "dedup|OR IGNORE|ON CONFLICT|cooldown|throttl|LIMIT [0-9]"`
  over `apps/engine/src` and `packages/cli/src`, then `"return null"` over
  `classify.ts` and its caller in `engine.ts`. `apps/dashboard` holds no dedup
  logic.

---

## 3. Inventory

`file:line · verdict · reason`. Most critical first.

### IN-CLASS

| # | Site | Reason + swallowed-signal scenario |
|---|---|---|
| 1 | `engine/contact-operator-guard.ts:126` (window `:33-36`) | **A.** Key `(body, urgency)` over 60 min. The agent's second, genuinely new *"Any update?"* 50 min later matches an earlier row and returns `{kind:"duplicate"}`. The key encodes text identity, never intent-to-ask-again. **Confirmed live** (audit F7, probe 2: same `sup_bdeaf511-…` returned twice). |
| 2 | `routes/messages.ts:36-41`, `mcp/tools.ts:376`, `engine/contact-operator.ts:40-46,62` | **The disclosure half of #1.** `contactOperator` returns `{ticketId, note}` with the identical `REPLY_NOTE` for a filed ticket and a collapsed one; the REST facade returns **201 Created** either way. No client — MCP or REST — can tell. This is where the systemic guard belongs. |
| 3 | `engine/tenant-messages.ts:89-101` | **B.** The dedup branch `UPDATE`s `created_at = now`. Two losses: the original occurrence time is destroyed ("how long has this been stuck?" is unanswerable), and the row jumps to the front of every `created_at DESC` ordering. Audit F9. |
| 4 | `engine/tenant-messages.ts:194-209` | **B.** `ORDER BY created_at DESC … LIMIT 5` over an unbounded producer. With ≥5 domains each refreshing a per-domain `retry_setup`, an operator's reply is evicted from `infrastructure_status.messages[]`. Reachable at Scale tier (18-domain cap); not at `ten_91aab24a`'s current 2 domains. |
| 5 | `engine/tenant-messages.ts:248-282` (cursor `:229-237`) | **B, one layer deeper than the audit found.** The keyset cursor is `(unacked, created_at, rowid)` and the doc at `:220-227` claims a mid-pagination emit "can't shift an already-issued page". True for INSERTs; **false for #3's UPDATE**, which moves an existing row's `created_at` from below the agent's cursor to above it. A row re-stamped mid-drain is skipped by that entire pass — the *full* surface, the one `list_messages` offers as the complete fallback for #4, silently loses it too. Recoverable on a later full pass; invisible during the one the agent is running. |
| 6 | `engine/provisioning.ts:650-656` and `:680-686` | **A.** Both emit `kind:"retry_setup"` with `dedupKey: inFlightDomain ?? \`tenant:${ctx.tenantId}\``, at **different severities**. An `action_required` "retry with the same key" for domain D is overwritten in place by a later `info` propagation-pending note for D — the action item silently downgrades and the polling agent reads "nothing needed". The `tenant:<id>` fallback is worse: every failure with no in-flight domain, on any ordinal, collapses onto one row and the earlier body is overwritten. |
| 7 | `engine/threads.ts:137-148` (TTL `:11`) | **A.** `replyToThread`'s send key falls back to `h:sha256(body)` when the caller sends no idempotency key, over a **30-day** window, and a hit `return`s the *first* send's `messageId` with no second send and no signal. A customer sending "Following up on this." into the same thread on Monday and again on Thursday gets a success and one email. Directly contradicts the sibling guard at `engine/campaigns.ts:103-108`, which throws on the same shape. |
| 8 | `admin/watchtower-grading.ts:100-112` | **C.** `gradeStreak` resets `unhealthy` to 0 on **any** good tick. An ops-sweep leg that errors every other 5-minute tick never reaches `LEG_ALERT_AFTER_SWEEPS = 3`, so `grade` is permanently `null` = HOLD, and `cron_legs` **never alerts at all**. A 50%-failure-rate sweep leg is silent forever. The hysteresis comment at `:52-54` states the intent (no alternating email pair) without stating this consequence. |
| 9 | `admin/watchtower-policy.ts:220-229` + `:232-234` | **C.** Same mechanism at the second layer: `confirmAfterObservations = 2`, and `healthyState()` zeroes `unhealthyObs`. A `d1` / `engine` / `do_storage` probe that flips healthy↔unhealthy every tick never reaches 2 consecutive and stays `pending` — zero emails, in both directions, indefinitely. `GET /admin/ops/checks` reflects only whichever tick the operator happened to sample. |
| 10 | `admin/watchtower-policy.ts:213-217` | **C.** The `suppressed` branch records the latest detail and sends nothing, with no escape for a **materially changed** detail. Concretely: `domain_dns_aging:<domain>` escalating from "past the point where propagation explains it" to "the platform has **GIVEN UP** — setup calls now fail non-retryably" (`admin/watchtower.ts:271-273`) is a different, terminal signal on the same check name, and waits out the ladder — up to `WATCHTOWER_STEADY_REALERT_MS` = **24h**. Same for `mailbox_provisioning:<email>` detail changes (`engine/mailbox-acquisition.ts:149-152` explicitly relies on this dedup). |
| 11 | `admin/watchtower.ts:213-224` | **A + C.** `failure_signals` is ONE global check name rolling up every tenant. Once announced, a genuinely new and larger burst on a different tenant is `suppressed` for up to 24h, and the eventual re-alert carries only the current window's number with no indication it escalated. |
| 12 | `admin/sweep-signals.ts:116-129` | **A + C.** `warmup_cancel_gave_up` is one check name over a **count**. Escalation from 1 to 12 abandoned cancellations — each one a vendor subscription that "may STILL BE BILLING" — is silent inside the 24h step. Money-bearing. |
| 13 | `tenant-do.ts:722-724` → `engine/idempotency.ts:78-81` | **A.** A `status='done'` row replays the stored response for `REQUEST_IDEMPOTENCY_TTL_MS` = 30 days without running `fn`. The platform's own message body — `engine/retry-setup-message.ts:21,24` — instructs the agent to *"retry it with the same idempotency key to finish it"*. Doing exactly that returns a cached 202 and performs **zero work**. Audit Q1. ⚠️ Overlaps `sweep-cached-terminal`'s scope — listed for completeness, not for double-ownership. |
| 14 | `engine/reply-processor.ts:129-140` and `:157-167`, key at `tenant-do.ts:454`, producer at `apps/engine/src/classify.ts:37-67` | **A — settled LIVE against the real DSN parser, not theoretical.** Bounce/complaint events dedup on `(tenant_id, type, originalMessageId)`, and `classifyBounce` sets `originalMessageId` from `resolveOriginal(source)` — the **original send's** id echoed back by the DSN — while **discarding the DSN's own `Message-ID` entirely** (it is never read). `PolledBounce` has no id field of its own (`vendor-ports.ts:301-323`). So a re-polled DSN and a genuinely second DSN for the same send are indistinguishable by construction. A greylisting MTA emitting a 4.4.1 "delayed" then a later 4.2.2 "mailbox full" advances `soft_bounces.streak` by 1, not 2 → `SOFT_BOUNCE_SUPPRESS_THRESHOLD` is reached late → the platform keeps mailing an effectively-dead address, and the deliverability control loop is fed a low count. **Bounded:** a soft→hard escalation *does* survive, because `type` differs (`'soft_bounce'` vs `'bounce'`). Only same-severity repeats collapse. |
| 15 | `admin/db.ts:234-247`, `migrations/0003_lifecycle.sql:19-33` | **A.** `enforcement_actions` `UNIQUE(tenant_id, action)`. A tenant terminated, reinstated, re-terminated for a *different* AUP reason records only the first `reason`/`evidence`. Partially mitigated: `admin/terminate.ts:36,46` returns `enforcementLogged:false`, so an admin caller **can** tell — the disclosure exists but the audit record is still gone. |
| 16 | `engine/deliverability-actions.ts:71-81` | **A.** `applyPause`'s conditional `UPDATE … AND deliv_status != 'paused'` doubles as dedup: a second PAUSE for a **different reason** (already paused for bounce rate, now also a complaint spike) writes nothing and calls no `logAction`, so the activity feed and `infrastructure_status` show only the first cause. |
| 17 | `ofac/sdn-alert.ts:86-88` | **C.** Within `SDN_ALERT_COOLDOWN_MS` = 6h the latest `detail` is persisted and no email is sent, with no changed-detail escape — and the singleton row (`id = 1`) deliberately merges the direct-fetch and droplet-relay paths (`:1-8`), so a *new* failure mode on the other path is folded into the running streak. |
| 18 | `db.ts:277-284`, `routes/waitlist.ts:76-80` | **A, minor but textbook.** `INSERT OR IGNORE` on the email PK; `insertWaitlistEmail`'s boolean return is **discarded** by the route, which answers `{ok:true}` identically for a new lead and a silent no-op. Low blast radius; included because it is the exact undisclosed-collapse shape the guard should make unwritable. |
| 19 | `mcp/tools.ts:86`, `site/openapi.yaml:1188`, `AGENTS.md:71` | **B, claim surface.** *"poll this alongside the mailbox fields so you never miss one"* is a false completeness guarantee over the `LIMIT 5` view of #4. The docs assert the property the code lacks. |
| 20 | `mcp/tools.ts:371`, `site/openapi.yaml:1250-1267` | **A, claim surface.** Both describe #1's collapse as *"safe … returns the SAME ticketId and does not file a second ticket"*, framing a distinct follow-up as a retry. `openapi.yaml:1267` even documents the 201 as covering "an identical-body dedup hit" — while the response **schema** carries nothing a client could branch on. |
| 21 | `test/tenant-messages.test.ts:59`, `test/contact-operator.test.ts:170,508` | **Defect pinned as spec.** `"a re-triggered emit with the SAME dedupKey does NOT insert a second row (refreshes instead)"` and `"dedup — identical body within 1h"` assert the current behavior as correct. Any fix RED-lines these; a green suite at HEAD is not evidence of health here. |
| 22 | `apps/engine/src/classify.ts:100-101` + `apps/engine/src/engine.ts:237-246` | **A, and the most severe member found — the dedup REQUIREMENT itself destroys the signal, in the OTHER service.** `classifyReply` returns `null` when the inbound message carries no `Message-ID` header — *"no stable dedupe key -> can't safely emit"*. The caller does `if (event) events.push(event)` with **no counter, no log line, and no effect on the cursor**, which still advances to `throughUid`. A genuine prospect reply from a client that omits `Message-ID` (RFC 5322 makes it SHOULD, not MUST) is destroyed at the source: the Worker never sees it, no `events` row, no inbox thread, no webhook, and the UID is permanently behind the high-water. The customer's reply simply never existed. Note this is a *drop*, not a collapse — but the stated reason for the drop is the dedup key's absence, which is why it belongs to this class and not to the poll-loop class. |
| 23 | `packages/shared/src/vendor-ports.ts:283-296` + `apps/engine/src/classify.ts:101` | **A, the contract that forces #22.** `SendEmailResult.messageId` is documented as the dedup anchor for the whole inbound path, and `PolledReply.messageId` is typed `string` (non-nullable) — so the engine has no way to emit an event it cannot key, and the Worker has no way to accept one. Closing #22 needs a contract change (a nullable id plus a synthesized fallback key such as `(threadId, receivedAt, sha256(body))`), not a patch in `classify.ts`. |

### UNCERTAIN

| # | Site | What would settle it |
|---|---|---|
| U-1 | `tenant-do.ts:514-526` (`ensureDedupeIndex`), `:545-559` (partial) | Not a decision site, but at **every DO boot** it `DELETE`s historical rows sharing the key, keeping `MIN(rowid)`. If IN-14's key is too coarse, this permanently destroys the surplus bounce/complaint history rather than merely declining to write it. Settle by: does any surface read historical `events` rows of type `bounce`/`soft_bounce`/`complaint` for anything other than a live count? (`engine/deliverability.ts` rate computation is the likely reader.) |
| U-2 | `admin/watchtower-grading.ts:76-80` (`gradeFailureSignals`) | A persistent sub-threshold failure rate — 2 failed sends/hour forever, ≈48/day — returns `null` (HOLD) and **never** alerts. This is a threshold, not a dedup, so it sits just outside the corrected class definition. Settle by ruling whether "silent-by-threshold" is this class or a separate `sub-threshold-persistent-condition` class deserving its own sweep. I recommend the latter. |
| U-3 | `admin/db.ts:179-192` + `migrations/0002_admin_ops.sql:44` | `dunning_events UNIQUE(tenant_id, cycle)` omits `action`, and `hasDunningEventForCycle` (`:201-206`) ignores `action` too — so an escalation *within* a cycle would be swallowed **and the suspend skipped** (`admin/ops-sweep.ts:85-88`). I traced it to unreachable today: `decideDunningAction` (`admin/dunning.ts:47-52`) depends only on `(cycle, declineCode)`, `last_decline_code` is written **only** at `engine/billing.ts:751` inside `case "invoice.payment_failed"`, and that same event adds the `webhook_events` row that *is* the cycle. **Latent, held by an accidental invariant.** Settle by: pin it with a test, or make it structural by adding `action` to the key. |
| U-4 | `engine/tenant-messages.ts:73,195,249`, `engine/threads.ts:136`, `engine/idempotency.ts:71` | These windows are measured on `ctx.clock`, which for demo/free tenants is a `VirtualClock` at up to 1440×. The 30-day idempotency TTL and the 30-day `sent_message_keys` TTL therefore expire in ~30 real minutes for those tenants. Direction is **over**-count (dedup stops deduping → double-send), which is the inverse of this class — but the documented window ("30 days", "within an hour") is false for those tenants, and `contact-operator-guard.ts:30-32` shows the authors already know this hazard and route around it with `RealClock`. Settle by ruling whether mixed time bases under dedup windows are in scope here or belong to the time-base class. |

### OUT

| Site | Why it is immune |
|---|---|
| `engine/campaigns.ts:93-108` | **The compliant template.** Same content-hash-over-60s shape as IN-7, but `throw`s `DuplicateCampaignError`, names the prior campaign id, and tells the caller how to actually retry. Cite this, don't invent a pattern. |
| `engine/reply-processor.ts:74-83` (reply path) | Key is `PolledReply.messageId` = the **inbound** message's own RFC 5322 id (`vendor-ports.ts:293-300`). Key granularity == signal identity. A lead replying twice files two events. |
| `engine/webhook-enqueue.ts:58-71`, `schema.ts:861` | `UNIQUE(subscription_id, event_id)` where `event_id` is a fresh `newId("evt")` minted per new event at `engine/events.ts:42`. Exact by construction. |
| `engine/idempotency.ts` for `launch_campaign` / `reply` / `remove_mailboxes` (`tenant-do.ts:786,932,999`) | A same-key retry of these **is** a replay by contract; nothing instructs a caller to reuse the key to make new progress. Only `setup_infrastructure` (IN-13) does. |
| `engine/tenant-messages.ts:301-310` (`ackMessage`) | Returns `alreadyAcked: true`. The disclosure model the rest of the class should copy. |
| `engine/events.ts:23-57` with `messageId: null` | SQLite NULLs are distinct in a unique index, so the tenant-wide unsubscribe walk records one row per lead. Correct and deliberate. |
| `tenant-do.ts:1339-1362` (`enforceDemoRunThrottle`) | `throw new RateLimitError(...)`. Loud. |
| `engine/deliverability-actions.ts:29-34` (`MAX_REPLACEMENTS_PER_WINDOW`) | Over the cap the burning domain is still retired and the withholding is `logAction`-ed. Disclosed. |
| `engine/provision-intents.ts:32,299-320` (`MAX_BUY_DISPATCHES`) | Budget exhaustion is surfaced by the `mailbox_rebuy:` watchtower check ("no re-buy authorized (1 dispatch(es) so far)" — visible in the live probe). Disclosed. |
| `engine/spend-ceiling.ts:338-350` (`INSERT OR REPLACE`) | A recovery write after the reaper resolved the row, and the unrecoverable ledger skew is explicitly recorded for reconciliation rather than hidden. |
| `engine/lead-dispositions.ts:55-83` | Field-level merge (`input.x ?? existing.x`), an intentional partial-update contract, not a collapse. |
| `engine/suppression.ts:15-18` | `ON CONFLICT DO UPDATE` clobbers `reason` and `ts` — but **no reader consumes either**: every consumer (`guarded-send.ts:56`, `tick.ts:245`, `campaigns.ts:130`, `list-leads.ts:133-139`, `suppression.ts:81`) tests membership only. Provenance-only loss with zero live consumer. ⚠️ Becomes IN the moment any surface answers "why is this address suppressed?". |
| `admin/db.ts:43-80` + `migrations/0005_support_dedupe.sql:15` | `UNIQUE(tenant_id, message_id)` with `tenant_id` always NULL for inbound support mail (`admin/support-inbound.ts:47-57`) → NULLs distinct → the dedup **never fires**. The live defect here is the inverse (a redelivered support email files a second ticket and re-forwards), which is a different class. Also note `message-id` is a spoofable header, so exact-keying it would be attacker-controlled if a resolved-tenant flow is ever added. |
| `ofac/sdn-alert.ts:62-77` (streak reset on success) | An alternating SDN load produces an email **per** failure — the storm direction, the cry-wolf class this file already exists to fix, not signal destruction. |
| `engine/contact-operator-guard.ts:139-174, 202-237` (email throttle + claim/release) | **Re-verified per brief.** Claim-before-send, `releaseEmailClaim` restores `emailed_at = NULL` on send failure so held bodies ride the next successful email, `revokeAdmission` compensates a failed D1 write, prune keyed on both `created_at` and `emailed_at` so it cannot reset the throttle clock, and the release chunks at 99 ids for the DO 100-bound-parameter ceiling. No signal is destroyed; held **bodies**, not just counts, are carried (`contact-operator.ts:170-180`). Holds. |
| `engine/byo-*.ts` | No dedup/window/collapse mechanism of this class anywhere in the BYO lane. `byo-intake.ts:271` is a state-transition idempotent no-op on an already-acknowledged step. |
| `engine/reporting.ts:150-153`, `engine/webhooks.ts:136,157` | `LIMIT 20` diagnostic tails on `deliverability_actions` / `webhook_deliveries` / `webhook_delivery_attempts`. Bounded views, but each is an explicitly-recent-N debugging surface with a full table behind it and no completeness claim attached. |
| `engine/activity.ts`, `engine/inbox.ts`, `engine/list-leads.ts` | Cursor-paginated with `limit + 1` lookahead over columns no writer mutates. Immune to IN-5's page-skip. |
| `apps/engine/src/mailbox-store.ts:35-60` | **The best compliant template in the repo for this class.** Content-hash dedup, but ordered by a Worker-owned monotonic `pushSeq`: `<` is "stale, no write", `===` with same content is "unchanged", `===` with *different* content is **REJECTED with a BadRequest** — *"two claims for one seq is a caller bug, surfaced loudly rather than silently picking a winner"*. Plus tombstones so a pre-cancel claim cannot resurrect a removed mailbox. This is exactly the posture G1 generalizes. |
| `apps/engine/src/classify.ts:44,78,98` | The other three `return null` arms drop messages that resolve to no known thread — an attribution failure, not a dedup one, and the platform-side `lookupThreadRef` would drop them identically (`reply-processor.ts`). Different class. |

**Counts: IN 23 · UNCERTAIN 4 · OUT 19.**

---

## 4. Systemic guard

**One guard, three enforcement points.** The invariant is *a collapse is a
disclosed outcome, never an undisclosed success.*

### G1 — the type change (makes sub-mechanism A unwritable)

Give every collapse-capable operation a result type that **cannot** be
constructed without stating whether it collapsed. In `packages/shared`:

```ts
export type Collapsed<T> = T & { deduplicated: boolean; deduplicatedAgainst?: string };
```

`contactOperator`, `replyToThread`, `insertWaitlistEmail`'s callers, and
`emitTenantMessage` return `Collapsed<…>`. Because `deduplicated` is
non-optional, every existing call site fails to typecheck until it decides what
to do — which is the point. The REST/MCP layer then surfaces it: `201` for a
real create, `200 {deduplicated:true, ticketId}` for a collapse, and
`openapi.yaml` + `mcp/tools.ts` descriptions updated to match (closing IN-19,
IN-20 in the same edit). `ackMessage`'s `alreadyAcked` already has this shape —
it is the in-repo precedent.

### G2 — the lint rule (makes B and C detectable)

Two `?raw`-source checks, mirroring the repo's existing coverage-test pattern
but **with an explicit SOURCES array reviewed at add-time** (a prior guard here
pinned `allSites.length === 3` against a single file and was a coverage lie):

1. Any `ORDER BY … LIMIT <literal>` on a tenant- or operator-facing read must
   be accompanied by a `hasMore`/`total` field, or carry a documented
   `// bounded-view: <why eviction is acceptable>` annotation.
2. Any `UPDATE … SET created_at` / `ts` / `since_ts` on a row that an
   `ORDER BY` or a keyset cursor reads is denied outright. This is IN-3 and
   IN-5 in one rule.

### G3 — the cadence test (closes C structurally)

`watchtower-policy.test.ts` already enumerates every check name and fails on an
unclassified new one. Extend the table so each check declares its **signal
cadence** — `one-shot` / `re-observed-continuous` / `re-observed-intermittent`
— and assert that an `intermittent` check is never assigned a policy whose
`confirmAfterObservations > 1`, and never routed through `gradeStreak` with a
reset-on-good-tick. A new check cannot be added without stating its cadence,
which is exactly the fact IN-8 and IN-9 assume and never check.

### Failing-test sketch (must be RED at `9d3ec7e9`, GREEN after)

```
1. contact-operator.test.ts
   file "Any update?" (normal) at T+0; file the IDENTICAL body at T+50min.
   ASSERT the second call returns a NEW ticketId, or `deduplicated: true`.
   Today: returns the first ticketId with `note` unchanged and no flag. RED.
   (This RED-lines the existing :170 and :508 cases — expected; they pin the defect.)

2. tenant-messages.test.ts
   emit dedupKey "acme.com" at T+0 (created_at C0); emit again at T+1h.
   ASSERT the row's created_at is STILL C0.
   Today: :91's UPDATE re-stamps it to now. RED.
   Then: 6 unread system messages + 1 older operator message ->
   ASSERT listSurfacedTenantMessages() includes the operator message.
   Today: evicted by LIMIT 5. RED.

3. tenant-messages.test.ts (IN-5, the layer the audit did not reach)
   20 unread messages; page 1 (limit 5); re-stamp a message from page 4 via a
   dedupKey re-emit; drain pages 2..N with the issued cursors.
   ASSERT the re-stamped message appears in the drain.
   Today: it jumped above the cursor and is skipped entirely. RED.

4. threads.test.ts
   replyToThread(thread, "Following up.") with NO idempotencyKey; advance the
   REAL clock 3 days; same call again.
   ASSERT a second send occurred, or the call threw the way
   launchCampaign's DuplicateCampaignError does.
   Today: returns the first messageId, sends nothing, says nothing. RED.

5. watchtower-policy.test.ts / watchtower-grading.test.ts
   Feed decideAlert (DEBOUNCED) and gradeStreak the sequence
   [bad, good, bad, good, bad, good, bad, good] at 5-min ticks.
   ASSERT at least one "alerted".
   Today: decideAlert never leaves "pending"; gradeStreak never leaves null. RED.

6. watchtower-policy.test.ts
   Unhealthy episode already announced (alertCount>=2, inside the 24h step);
   next observation carries a MATERIALLY different detail
   ("aging" -> "GIVEN UP").
   ASSERT action !== "suppressed".
   Today: suppressed for up to 24h. RED.

7. apps/engine — classify.test.ts (IN-22, the customer-visible one)
   Feed classifyMessage a well-formed reply whose source has NO Message-ID
   header, In-Reply-To pointing at a known send.
   ASSERT an event is emitted (with a synthesized key), or at minimum that
   the drop is counted/logged and the cursor does NOT advance past it.
   Today: returns null, the caller drops it silently, the cursor advances,
   the reply is gone forever. RED.
```

Every one of these must be proven by revert-fail-restore before the class is
called closed.

---

## 5. Confidence + what a second sweep should check

**Corrected mid-sweep — a stale premise that would have produced a wrong
finding.** I carried an assumption that a paid tenant's clock is frozen at
signup (which would have made IN-13's 30-day idempotency window *infinite* and
its 10-minute pending-claim reclaim *never fire*). Verified against this ref
and it is **false**: `clock.ts:6-14` and `tenant-do.ts:268,274-276,294-301,584`
show the one-shot `engine/clock-migration.ts` migration has shipped and paid
tenants run on `RealClock`. The live exposure is the opposite direction
(demo/free VirtualClock at 1440× makes those windows far *narrower* than
documented) — recorded as U-4, not as an IN member.

Not covered, in rough priority order for a second pass:

1. **U-1's blast radius.** I did not read `engine/deliverability.ts`'s rate
   computation closely enough to say whether the boot-time collapse destroys
   data any live calculation depends on.
2. **The rest of `apps/engine/src`.** I swept its dedup surfaces
   (`classify.ts`, `engine.ts`'s poll loop, `mailbox-store.ts`) but not
   `api-send.ts`'s 429/5xx backoff or the send-side idempotency-key handling,
   which the platform's `sendKey` flows into.
3. **`engine/webhook-delivery.ts`'s retry/attempt semantics.** I read its
   enqueue producer and its `LIMIT 20` read surfaces but not the delivery
   pump's own dedup/backoff — a plausible home for a fourth sub-mechanism.
4. **`admin/watchtower-infra.ts` and `watchtower-do.ts`'s DO-side store.** I
   read the shared *policy* both substrates apply and confirmed it is one
   function, but not the DO store's own read/write path, which per
   `watchtower-policy.ts:126-131` has **no migration mechanism** and reconciles
   old values purely through `normalizeAlertState`'s fallback.
5. **The 5-minute cron against every window constant.** I checked the debounce
   arithmetic; I did not systematically verify each of the ~12 window constants
   against the cadence of the signal it gates, which is what G3 would make
   structural.
