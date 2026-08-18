# Class sweep — "a non-terminal outcome frozen as terminal"

**Date:** 2026-08-17 · **Sweeper:** class-sweeper (opus, xhigh) · **Mode:** READ-ONLY (no edits outside this file, no state-changing git)
**Ground ref:** `9d3ec7e9021eb234c6f633540f0cca2aaa99cf2b` on `main`
**Tree state at sweep time:** `apps/platform/src`, `apps/engine`, `packages/`, `site/` all CLEAN at this ref. Dirty: `.claude/agent-memory/spec-builder/`, `docs/research/backlink-outreach-targets-2026-08-17.md`, and two untracked sweep docs under `docs/adversarial/`. Sibling agents edit this worktree — **re-ground before acting**.
**Fix branch:** `feat/channel-truth-2026-08-17` exists but `git diff main...feat/channel-truth-2026-08-17` is **EMPTY** at this ref — nothing committed yet, so nothing in this inventory can be assumed already closed.
**Sibling sweep, different class:** `docs/adversarial/class-sweep-watch-completeness-2026-08-17.md` (monitoring completeness). Members 5–8 below sit adjacent to it but are a different mechanism: theirs is *a read that cannot see the row*, mine is *a written marker that lies about the row*.

---

## 1. Class definition

The brief's definition is **correct in extension** — every site it names is in scope — but its stated mechanism is one level too shallow to drive a guard. Sharpened:

> **The class:** a durable short-circuit whose "this is complete" predicate is a **PROXY** — `fn` returned without throwing / a row exists / a marker was written / a dedup key matched — rather than the outcome's actual terminality. The proxy and the truth diverge exactly when an operation ends in a legitimate non-terminal state, and at that moment the non-terminal outcome is frozen as terminal: every later retry or read is answered from the frozen artifact, success-shaped, while no work occurs.

**One sentence:** *terminality is inferred from control flow or row-existence, never asserted by the outcome itself.*

Keeping the brief's wording alone would have cost coverage. "Records a non-terminal outcome" reads as a search for `"pending"` string literals; three of the strongest members below contain no such literal. The proxy framing splits the class into three spellings, and every member is one of them:

- **(a) Return-implies-done.** `withRequestIdempotency` (`apps/platform/src/engine/idempotency.ts:113-120`) records `status='done'` on any non-throwing return. `fn`'s *control flow* is the terminality predicate. Members 1–3, 10.
- **(b) Marker-before-confirmation.** A durable flag meaning "the external effect completed" is written before, or regardless of, the external call's result — and the failure branch writes nothing distinguishable, so no reconcile lane can find it. Members 4, 5.
- **(c) Absence-implies-success.** A condition leaving an unhealthy set, a dedup key matching, or a bounded poll exhausting is announced as the good terminal outcome. Members 6–9, 14.

**Why the confirmed member is a recurrence, precisely.** The vendor-verdict wave (2026-08-14) closed spelling (a) *inside* the saga: `mailbox-provisioning.ts:236-329`'s `acquireMailbox` was rewritten so every uncertain vendor branch **throws** (`terminalMailboxError`, `unresolvedPurchaseError`, `abandonedPurchaseError`) instead of returning. That made control flow a *sound* terminality proxy for `provision:${intentKey}`. Nobody applied the same reasoning to the wrapper one layer up, where `runSetupInfrastructure` has **three** deliberate non-throwing returns for non-terminal states.

---

## 2. Search coverage

Ledger surfaces covered first, per `.claude/agent-memory/class-sweeper/coverage-ledger.md`: downstream consumers (not just write sites), the port error contract, sandbox-adapter masking, dropped payload fields, schema-can't-express, cron lanes, migration SQL, drift/reconcile scripts, docs/openapi claim surfaces, CI/wrangler config, sibling packages, `.sql` migrations vs `tenant-do.ts` runtime DDL.

### Lexical — every pattern run

Run over `apps/platform/src`, `apps/engine/src`, `packages/`, `site/`, `docs/`, `*.md`, `wrangler.toml`, `migrations/`; `.claude/worktrees/agent-*` and `node_modules` excluded from all.

| # | Pattern | Purpose |
|---|---|---|
| 1 | `withRequestIdempotency` | enumerate all 5 live call sites + 2 test refs |
| 2 | `request_idempotency` | every reader/writer/deleter of the replay table |
| 3 | `response_json\|storedResponse\|replay` | stored-response replay surfaces |
| 4 | `dedup\|duplicate\|already_\|alreadyAcked` | dedup short-circuits |
| 5 | `INSERT OR IGNORE\|ON CONFLICT` | claim-as-dedup rows (the mirror shape) |
| 6 | `cache\|Cache\|memo\|_cached\|= new Map(\|private .*Map<` | in-memory + durable caches |
| 7 | `"pending"\|'pending'\|queued\|scheduled\|inProgress\|in_progress\|partial\|deferred\|"held"\|throttled` | non-terminal payload/state markers |
| 8 | `NOT NULL DEFAULT '` over `schema.ts` + all 17 migration files | columns whose DEFAULT is a terminal value |
| 9 | `dns_status\|dns_gave_up_at\|dns_first_checked_at\|dns_check_count` | the DNS state family |
| 10 | `mailbox_intents\|markMailboxIntent\|recordMailboxIntent\|markMailboxIntentsReleased` | intent-state transitions + invalidation |
| 11 | `'revoked'\|"revoked"` | tombstone readers (found: none that retry) |
| 12 | `capacity_pending\|CapacityPendingError` | the spend-ceiling back-pressure path |
| 13 | `screening_status\|screenTenant\|grandfatherActiveScreening` | unscreened-reads-as-clear |
| 14 | `billing_state = 'active'` | every activation writer |
| 15 | `warmup_cancel_gave_up_at\|warmup_status\|warmup_state` | warmup give-up markers |
| 16 | `trySend\|emailSent\|reconcileAlerts\|AlertOutcome` | alert-delivery bookkeeping |
| 17 | `recordDunningEvent\|insertDunningEventIfNew\|hasDunningEventForCycle` | dunning cycle claims |
| 18 | `INSERT INTO domains` / `INSERT OR IGNORE INTO domains` | which inserts omit `dns_status` |
| 19 | `pollUntil` | client-side bounded polls |
| 20 | `idempotencyKey\|Idempotency-Key\|"same idempotency key"\|"same key"` over `.ts .md .yaml .html .json` | the CLAIM surface (docs/openapi/tool descriptions/message bodies) |
| 21 | `inflight\|inFlight\|dangling\|parked` over `apps/engine` | sibling-package send-record lifecycle |
| 22 | `crons\|PROVISIONING_RECONCILE\|[vars]` over `wrangler.toml` | cron lanes + dark-flag config |

### Semantic — every surface read in full (lexical could not have caught these)

- **All 5 `withRequestIdempotency` call sites read end-to-end, tracing each wrapped fn to *every* `return` statement**: `tenant-do.ts:722` (`setup_infrastructure`), `:786` (`launch_campaign`), `:932` (`reply`), `:999` (`remove_mailboxes`), `mailbox-provisioning.ts:151` (`provision:${intentKey}`). This is what surfaced members 2 and 3 — `provisioning.ts:429` (`quoteOnly`) and `:626` (`CapacityPendingError`) are non-terminal returns with **no `"pending"` token anywhere in them**.
- **The failure branch of every swallowed-error call**, not just the happy path: `revokePushedMailboxCredentials` (`mailbox-credential-push.ts:288-297`), `trySend` (`watchtower-alerts.ts:222-230`), `maybePushProvisionedMailbox` (`:224-233`), `runWarmupCancellationSweep`'s per-mailbox catch (`warmup-cancel.ts:107-156`).
- **The reconcile lane's SELECT predicate for every state a failure can leave**, asking "does anything ever pick this row up again?" — `reconcileMailboxCredentialPushes` (`mailbox-credential-push.ts:252`, `status='pending'` only ⇒ member 4), `runProvisioningReconcile` (`provisioning-reconcile.ts:120-126`), `ops-summary.ts:330/341/371`, `tick.ts:196-230` orphan reclaim.
- **Schema comments as CLAIMS to falsify, not documentation.** `migrations/0008_watchtower.sql` says `last_alert_ts` = "Last time an alert was actually SENT" — the code advances it on a failed send (member 5). `spend-ceiling.ts:213-215` says "On a thrown CapacityPendingError the idempotency claim is cleared" — true for the inner wrapper, false for the outer one (member 3).
- **Both DDL surfaces** (`schema.ts` canonical CREATE **and** `tenant-do.ts`'s `addColumnIfMissing` runtime backfills, `:362-414`) — the ledger's two-surface rule. `dns_status` and `screening_status` are declared in both.
- **All 17 `.sql` files under `apps/platform/migrations/`** including `0018_watchtower_debounce.sql`'s backfill `UPDATE`.
- **The published claim surface, read as product contract:** `site/openapi.yaml:88-127`, `apps/platform/src/mcp/tools.ts:74/86/93/130/186/350/371`, `AGENTS.md:48/58/71/73`, `engine/retry-setup-message.ts` (whole file).
- **Sibling package `apps/engine`** — `store.ts:151-270` (`getSend`/`claimSend`/`recordSend`/`park`/`resolveIntent`/`isBlocked`), `reconcile.ts:54-112`, `mailbox-store.ts:158-256`. This is where the repo's *correct* pattern lives.
- **Client layer:** `packages/cli/src/client.ts` + all 12 command files; `apps/dashboard/src/api/queries.ts` optimistic-mutation lifecycle (`onMutate`/`onError`/`onSettled`), `main.tsx:13` `staleTime`.
- **Cron lanes:** `wrangler.toml:122` (`*/5 * * * *`), `scheduled.ts`, `admin/ops-sweep.ts`, `watchtower-do.ts:130-160`, confirming `PROVISIONING_RECONCILE_ENABLED` is absent from `[vars]`.
- **The test that should have caught it:** `apps/platform/test/idempotency.test.ts:72-91`.

---

## 3. Inventory

**IN 14 · OUT 21 · UNCERTAIN 3.** Most critical first. Every candidate examined is listed; nothing dropped.

### IN

| # | Site | Why it exhibits the mechanism |
|---|---|---|
| 1 | `engine/provisioning.ts:642-663` (returns at `:657-662`) | **The confirmed member (audit F1).** The 202 SUCCESS-PENDING branch RETURNS `{jobId, billing, provisioning:"pending", pendingDomain}`, so `idempotency.ts:115-119` records `status='done'` with that payload. Every later same-key call hits `:79-81` and replays it for 30 days (`REQUEST_IDEMPOTENCY_TTL_MS`, `:9`) with zero vendor calls and an empty `tenant_messages`. **Failure:** the tenant follows the platform's own `actionHint` forever and never gets a mailbox. Audit probe ARM A. |
| 2 | `engine/provisioning.ts:428-430` (`quoteOnly` preview) | **NEW — the most reachable member in the class.** A preview provisions nothing, returns `{quoteOnly:true, billing}`, and is recorded `done` under `setup_infrastructure:<key>`. `mcp/tools.ts:74` explicitly instructs the two-call flow (*"pass quoteOnly:true first to preview … before committing"*), `quoteOnly` and `idempotencyKey` ride the **same tool input** (`mcp/schemas.ts:51` + `tools.ts:82`) and the **same HTTP header** (`routes/infrastructure.ts:14`). **Failure:** an agent that treats one idempotency key as "my setup_infrastructure call" quotes, then commits with that key, and receives the quote back — 200 not 202, `quoteOnly:true`, zero domains, permanently. Needs no vendor failure, no DNS stall, no crash: it fires on the documented happy path. |
| 3 | `engine/provisioning.ts:615-626` (`CapacityPendingError`) | **NEW — worse payload than member 1.** Graceful back-pressure RETURNS `{jobId, billing}` — the **full-success shape, with no `provisioning` discriminator at all** — so a replay is indistinguishable from a completed provision. `spend-ceiling.ts:213-215` asserts the opposite in terms (*"On a thrown CapacityPendingError the idempotency claim is cleared … a retry after the founder raises the ceiling re-runs cleanly"*): true for the inner `provision:${intentKey}` wrapper, **false** for the outer `setup_infrastructure:<key>` one, which caught it. **Failure:** founder raises the ceiling, the agent retries with its key, gets a stale success, and nothing provisions. |
| 4 | `engine/lifecycle.ts:208-213` + `engine/mailbox-credential-push.ts:288-297` | **Credential revoke tombstoned before confirmation.** `status='revoked'` is written synchronously *before* `revokePushedMailboxCredentials` (`lifecycle.ts:222`), which swallows every failure to `console.error` and never throws. `'revoked'` is terminal to every reader: `reconcileMailboxCredentialPushes` selects `status='pending'` only (`:252`), and the sole other reader of `'revoked'` is the revive-on-reprovision guard (`:97`). **Failure:** the engine keeps a released mailbox's IMAP password and `gmail_api` refresh token indefinitely; nothing retries, nothing alerts. Also reaches the replay layer — `removeMailboxes` returns `{releasedCount:N}` success-shaped and is recorded `done`. *(The tombstone-first ordering is deliberate — CREDSTORE F2 closed a resurrection window — so the fix is a distinct unconfirmed state, NOT moving the write.)* |
| 5 | `admin/watchtower.ts:356-359`; same shape at `admin/watchtower-infra.ts:55` and `watchtower-do.ts:147` | **A failed alert is recorded as a delivered one.** `decideAlert` (`watchtower-policy.ts:229`) returns `next: {lastAlertTs: nowMs, alertCount: 1}` computed **before** any send; `reconcileAlerts` then calls `upsertWatchtowerState(..., state: transition.next, ...)` **unconditionally**, discarding `trySend`'s boolean (`watchtower-alerts.ts:222-230` returns `false` on a dark channel or send failure). `migrations/0008_watchtower.sql` documents the column as *"Last time an alert was actually SENT"*. **Failure:** the founder is never told; the next tick reads `alertCount>0`, takes the PHASE-2 backoff and stays silent for `firstRealertMs`; and on recovery `decideAlert:192` sends a **"RECOVERED"** email for an incident that was never announced. `watchtower_state` has no delivery column, so `GET /admin/ops/checks` (`watchtower.ts:readAllCheckRows`) cannot show it either. |
| 6 | `admin/watchtower.ts:277-285` (clear at `:284`) | **Audit F10.** Emits `healthy:true, "Domain X now has working mail DNS"` whenever the domain leaves `agingPendingDomains` for **any** reason. That query also requires `status='active' AND source='provisioned'` (`ops-summary.ts:373`), while the ownership guard `provisionedDomainNames` is **not** status-filtered (`ops-summary.ts:396-398`). A released/burned domain therefore clears its own alert with a positive claim that was never checked. |
| 7 | `admin/watchtower.ts:299-308` (clear at `:307`) | Same shape, and **coupled to member 4**: `"Mailbox X now has its engine credentials pushed"` fires when the row leaves `WHERE status='pending'` (`ops-summary.ts:341`) — which is exactly what member 4's `'revoked'` tombstone does. A failed revoke on a released mailbox produces a green "credentials pushed" alert. |
| 8 | `admin/watchtower.ts:310-323` (clear at `:322`) | Same shape: `"has eligible mailboxes again"` is the `else` of `starved = activated && dueNonDemoPendingSends > 0 && eligibleMailboxes === 0`. It also fires when `dueNonDemoPendingSends` reaches 0 (campaigns paused, tenant torn down) with `eligibleMailboxes` still 0. |
| 9 | `engine/contact-operator.ts:63` (guard at `engine/contact-operator-guard.ts:126-127`) | **Audit F7.** The dedup branch returns `{ticketId, note: REPLY_NOTE}` — **byte-identical** to a real admission, including *"Recorded for the operator. Their reply will arrive…"*. The response carries no `duplicate` marker; `admission.kind` is discarded at the boundary. **Failure:** two genuine follow-ups with identical short text ("Any update?") 50 min apart collapse to one ticket; the agent is told both were filed. *Mitigating:* the behaviour IS disclosed in `AGENTS.md:73` and `mcp/tools.ts:371` — the defect is that the runtime response gives an agent already in a loop no signal. Contrast the compliant sibling one file over: `launchCampaign` **throws** `DuplicateCampaignError` with `existingCampaignId` (`engine/campaigns.ts`, surfaced at `error-response.ts:73-78`). |
| 10 | `schema.ts:481-486` — `request_idempotency.status TEXT NOT NULL DEFAULT 'done'` | **The class written into the schema.** The replay table's completion column defaults to the **terminal** value; a row inserted without an explicit `status` short-circuits its key immediately. Worse, `status='done' AND response_json IS NULL` is an **unrecoverable** state: `idempotency.ts:79` declines to replay it, `:85` throws `RequestInProgressError` inside the 10-min window, `:97`'s reclaim `UPDATE … WHERE key = ? AND status='pending'` silently matches nothing so `created_at` is never re-stamped, and `:123`'s failure cleanup is likewise `AND status='pending'`. Not reachable from today's three writers (all set `status` explicitly); the DEFAULT is the only door, and it is standing open. |
| 11 | `engine/retry-setup-message.ts:21,24` | The body hard-codes *"retry setup_infrastructure with the same idempotency key to finish it"* and is emitted from **both** `provisioning.ts:651` (the 202 branch — where the key is consumed, so the advice is a guaranteed no-op) and `provisioning.ts:681` (the retryable-throw branch — where `idempotency.ts:123` deletes the claim, so the advice is correct). One string, opposite truth, chosen by a branch the reader cannot see. This is the instruction that turned member 1 into a live customer incident. |
| 12 | `mcp/tools.ts:74` | *"A domain whose DNS setup has not finished yet is still returned by infrastructure_status with its dns state pending and can be completed by retrying — it is never lost."* No per-domain object and no `dns` field exist anywhere in `InfrastructureStatus` (`engine/infrastructure-status.ts:98-103,167-176` return `domains: <count>`), and "completed by retrying" is false past the 6h bound and false again under member 1. Audit F4. |
| 13 | `site/openapi.yaml:97-127` | The **published** contract states both halves of the contradiction four sentences apart: *"a replay of a completed keyed call returns that call's recorded result without re-running it"* then *"Repeat the same call to converge onto that domain and finish its DNS setup."* It is also honest that `/infrastructure-status` has no per-domain field — directly contradicting member 12, so the two published surfaces disagree with each other. |
| 14 | `packages/cli/src/client.ts:75-87` + `packages/cli/src/commands/demo.ts:47-51` | **Client-side.** `pollUntil` returns the last result when `maxAttempts` (default 8) is exhausted, with no exhaustion signal in the return type. `demo.ts` then unconditionally prints `"${status.domains} domain(s), ${status.mailboxes} mailbox(es) provisioned, warmup started"` — printing `0 mailbox(es) … warmup started` on a poll that never converged. Sandbox/demo blast radius, but the shape is exact. |

### OUT

| Site | Why it is immune |
|---|---|
| `tenant-do.ts:786` → `engine/campaigns.ts` `launchCampaign` | Fully synchronous; returns `{campaignId}` only after the campaign + leads + `scheduled_sends` rows land. `scheduled_sends.status='pending'` is the campaign's normal *running* state, not an incomplete launch. Duplicate submits **throw** with `existingCampaignId`, never a success-shaped dedup. |
| `tenant-do.ts:932` → `engine/threads.ts` `replyToThread` | Returns `{messageId}` only after `sendWithGuards` confirms; `sent_message_keys` is written **after** the send (`threads.ts:` post-send `INSERT OR IGNORE`). The durable-key short-circuit only ever replays a send that provably went out. |
| `tenant-do.ts:999` → `engine/billing.ts:1003` `removeMailboxes` | `releaseMailboxes` throws on any vendor release failure (`lifecycle.ts:217`), so a non-throwing return means every selected mailbox was released. *(Its swallowed credential-revoke leg is member 4, not this row.)* |
| `mailbox-provisioning.ts:151` `provision:${intentKey}` | The vendor-verdict fix made control flow a sound proxy here: every uncertain branch of `acquireMailbox` **throws** (`:282`, `:294`, `:305`), and `runMailboxProvisioningUnit` returns only past `awaitMailboxReady`. The claim is also invalidated on teardown (`provision-intents.ts:412` deletes `provision:${key}`), closing the N4 stale-replay path. **This is the in-repo template for spelling (a).** |
| `engine/lifecycle.ts:262-269` `teardownTenant` | Anchor-AFTER-completion: `teardown_records` is INSERTed at `:370` after every release; the `readTeardownRecord` short-circuit at `:268-269` can therefore only fire on genuinely completed work. |
| `engine/billing.ts:570-629` `applyStripeWebhookEvent` | The 2026-08-06 fix landed: the `webhook_events` claim is paired with a `webhook_event_inflight` marker and a **completion pass** (`:602-610`), so a half-applied event is finished, not no-op'd as a duplicate. The claim→inflight window (`:572-625`) contains no `await`, so a DO commits it in one turn. |
| `engine/warmup-cancel.ts:105-168` | **Template for spelling (b).** `warmup_cancelled_at` is set only after the vendor confirms (`:163`); a give-up gets its **own** column `warmup_cancel_gave_up_at` (`:126-131`) plus an ops-visible `WARMUP_CANCEL_GAVE_UP` action row that says the subscription may still be billing. The doc comment states the invariant outright: *"Both columns stop the sweep; only one of them is evidence the charge stopped."* |
| `engine/tick.ts:186-230` orphan reclaim | Bumps `attempts`, caps at `MAX_SEND_ATTEMPTS`, and at the cap writes `status='failed'` with `message_id NULL` plus a `'failed'` event — exhaustion is a distinct, ops-visible terminal state, never `'sent'`. |
| `engine/webhook-delivery.ts:135-175` | Success writes `'delivered'`, retry writes `'pending'` with backoff, exhaustion writes a terminal failure — three distinguishable states. |
| `admin/db.ts:179-190` + `admin/ops-sweep.ts:85` dunning | Effect-before-guard-row (the 2026-08-05 F2 fix): the suspend runs before `insertDunningEventIfNew` commits, so a crash between them leaves nothing committed and the next tick retries. |
| `engine/byo-intake.ts:232-257` `pollByoDomainDns` | `'active'`, `'abandoned'` and `'pending_dns'` are three distinct states and `verified` always mirrors the real one. The `byo_status !== 'pending_dns'` early return reports a state that *was* confirmed (post-confirmation drift is a staleness class, not this one). |
| `apps/engine/src/store.ts:151-270` + `reconcile.ts:54-112` | **The repo's gold standard.** An unverified dispatch is never recorded as `sent`: it is a `dangling`, boot reconciliation either finalizes or **parks** it, and a parked key returns 424 (`isBlocked`, `:264`) until an operator resolves it. `recordSend` runs only after a confirmed submit. |
| `apps/engine/src/mailbox-store.ts:162-250` | Content-hash + idempotency-key replay records the outcome of a **completed** upsert; a `'stale'` engine answer means the goal state already holds (documented at `mailbox-credential-push.ts:153-158`). |
| `vendors/sandbox/email-port.ts:41-46`, `billing-port.ts:20-24` | In-memory caches keyed on an idempotency key, populated only after the (deterministic, always-terminal) sandbox operation completes. |
| `apps/dashboard/src/api/queries.ts:335-365` optimistic mutations | `onMutate` snapshots, `onError` restores verbatim (`:284`, `:301`), `onSettled` invalidates. The optimistic write is never durable and never survives a failure. |
| `apps/dashboard/src/main.tsx:13` `staleTime: 5_000` | A 5s read cache with no completion semantics attached. |
| `packages/cli/src/client.ts` `request()` | No client-side caching, no idempotency key sent on any command — the CLI cannot create a replay row. |
| `tenant_profile.screening_status DEFAULT 'clear'` (`schema.ts:57`, `tenant-do.ts:414`) | Form is in-class ("never screened" reads as terminal-pass, and `isTenantActivated` reads `screening_status` while the real discriminator is `screening_list_version IS NULL`), but **defended in depth**: all three writers of `billing_state='active'` screen first or inherit a screened tenant — `billing.ts:695` (Stripe checkout, ordering fixed by the 2026-08-06 audit), `billing.ts:276` (simulated checkout), `billing.ts:817` (dispute-won, tenant already screened). No live path reaches activation on the default. |
| `mailboxes.deliv_status DEFAULT 'healthy'` (`schema.ts:249`) | "Healthy" is the correct baseline for a mailbox with zero sends (no evidence of harm), and the control loop re-derives it from measured signals every sweep. |
| `engine/tenant-messages.ts:77-101` `emitTenantMessage` dedup | Refreshes one row for one ongoing condition rather than inserting a run; a read or expired row no longer dedup-matches, so a genuinely new occurrence gets its own row. *(Audit F9 — the `created_at` re-stamp pushing an operator reply off the newest-5 preview — is real but is a bounded-view/ordering defect; it belongs to the sibling monitoring-completeness sweep, not here.)* |
| `vendors/real/*.ts` `_idempotencyKey` (underscore-prefixed, ignored) | Adjacent class, not this one: the real InboxKit adapters do not dedupe vendor-side, so retry safety rests entirely on our own claim rows. Already recorded in `.claude/agent-memory/class-sweeper/idempotency-replay-surfaces.md`. |

### UNCERTAIN

| Site | What is unresolved · what would settle it |
|---|---|
| `schema.ts:150` + `tenant-do.ts:366` — `domains.dns_status TEXT NOT NULL DEFAULT 'ready'` | **In-class in form and it has a live population:** `byo-intake.ts:191-193`'s `INSERT INTO domains` does **not** list `dns_status`, so every BYO row lands `'ready'` — terminal — while `byo_status` is still `'pending_scan'`/`'pending_dns'`. I could not demonstrate a consumer: `ops-summary.ts:373` and `provisioning-reconcile.ts:122-124` both filter `source='provisioned'`. The one **unfiltered** reader is `findExistingDomain` (`provisioning.ts:55-59`, no `source` predicate), whose result gates `setDnsWithRetry` at `:261`. **Settles it:** prove that no `setup_infrastructure` path can resolve a `source='byo'` row through `findExistingDomain` (trace `liveDomainForIntent`/`findAdoptableDomain` and candidate generation for a BYO-name collision), or flip the default to `'pending'` and make `provisioning.ts:344` the only promoter. |
| Idempotency rows are **not** invalidated on teardown for four of five key namespaces | `provision-intents.ts:412` deletes `provision:${key}` on release (the N4 fix). Nothing deletes `setup_infrastructure:`, `launch_campaign:`, `reply:` or `remove_mailboxes:` rows. Inside the 30-day TTL a cancel-then-resubscribe can replay a pre-teardown response — for `setup_infrastructure` that is a stale `billing` projection describing infrastructure that no longer exists. **Settles it:** a test that tears a tenant down and replays each key namespace, asserting what each replay claims. |
| `apps/platform/test/idempotency.test.ts:72-91` | Not a defect — a **coverage lie** that let the class survive. It exercises `setup_infrastructure` replay against **sandbox** adapters, where the provision always completes, so it proves only the terminal-replay case and is blind by construction to all three non-terminal returns. The ledger's sandbox-masking and coverage-theatre lessons both apply. **Settles it:** the failing tests in §4 below. |

---

## 4. Systemic guard

### The guard: make control flow stop being the terminality predicate

**Type-level, at `engine/idempotency.ts`.** Change the wrapped function's contract so terminality must be *asserted*, not inferred:

```ts
export type Settled<T> =
  | { terminal: true; value: T }    // -> record 'done', replay forever
  | { terminal: false; value: T };  // -> DELETE the claim (same as a throw), return value to THIS caller

export async function withRequestIdempotency<T>(
  ctx: TenantContext,
  key: string | undefined,
  fn: () => Settled<T> | Promise<Settled<T>>,
): Promise<T>
```

Why this and not a lint rule: TypeScript makes omission a **compile error at every call site**, present and future. All five sites must classify each of their returns, and `runSetupInfrastructure`'s three non-terminal returns (`:429` quoteOnly, `:626` capacity-pending, `:657` DNS-pending) become impossible to mark `terminal: true` without someone writing the word. The class stops being writable rather than being caught after the fact. `packages/shared/src/errors.ts` is the precedent for putting this kind of contract in the type system rather than in reviewer discipline.

Non-terminal returns keep today's customer-facing behaviour exactly — the caller still gets its 202 with `provisioning:"pending"` — but the key stays reclaimable, so the platform's own `retry_setup` instruction becomes true instead of a trap.

**Schema half (closes member 10), in `schema.ts` + a new migration-equivalent in `tenant-do.ts`'s runtime DDL — both surfaces, per the ledger:**

```sql
status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status <> 'done' OR response_json IS NOT NULL)
```

The default becomes the safe value and the unrecoverable `done`+NULL state becomes unrepresentable.

**Spelling (b) guard — one invariant, stated once and enforced per site:** *a durable marker meaning "the external effect completed" may only be written after the external call returned successfully; a failed or skipped call must write a **distinguishable** value that a named reconcile lane selects on.* In-repo template to copy: `warmup_cancel_gave_up_at` (own column, own action row) and `agent_contact_log.emailed_at` (`contact-operator-guard.ts:227-237` puts the claim back when the send fails). Applied:
- member 4 → a `revoke_failed` status (or a `revoke_confirmed_at` column) plus a reconcile lane that selects it. Do **not** move the tombstone write; CREDSTORE F2 depends on its position.
- member 5 → keep advancing the storm damper, but split it: record the *attempt* in `last_alert_attempt_ts` and only advance `last_alert_ts`/`alert_count` when `trySend` returns `true`. That preserves the anti-retry-storm requirement while making `GET /admin/ops/checks` able to show "we tried and could not tell you."

**Spelling (c) guard:** an alert clear must re-assert the positive condition it announces, never infer it from absence from the unhealthy set. `watchtower.ts:284/307/322` should each re-read the fact they claim (`dns_status='ready'`, `mailbox_cred_pushes.status='pushed'`, `eligibleMailboxes>0`) and otherwise emit a neutral clear.

### Failing-test sketch (revert-fail-restore proof)

Cheapest proof first — it needs **no** vendor stubbing, no DNS fixture and no crash injection, because it rides the documented happy path:

```ts
// apps/platform/test/idempotency-nonterminal.test.ts
it("a quoteOnly preview does not consume the idempotency key", async () => {
  const { tenantId, token } = await signup("Quote Idem Co", "f@quoteidem.com");
  const headers = { "Idempotency-Key": "setup-k1" };
  const spec = { brand: "Quote Idem Co", primaryDomain: "quoteidem.com", domains: 1,
                 inboxesEach: 2, persona: "Sender", physicalAddress: "1 St",
                 senderIdentity: "Sender <s@quoteidem.com>" };

  await api("/setup-infrastructure", { method: "POST", token, headers,
                                       body: JSON.stringify({ ...spec, quoteOnly: true }) });
  const commit = await api("/setup-infrastructure", { method: "POST", token, headers,
                                                      body: JSON.stringify(spec) });

  expect(commit.status).toBe(202);                 // TODAY: 200
  expect("quoteOnly" in commit.body).toBe(false);  // TODAY: true — the quote replays
  expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM domains`)).toBe(1);   // TODAY: 0
  expect(await rowCount(tenantId, `SELECT COUNT(*) as n FROM mailboxes`)).toBe(2); // TODAY: 0
});
```

Three more, one per remaining spelling — all written as the CORRECT behaviour so each fails as the finding today and passes unmodified as the closure gate:

1. **DNS-pending (member 1)** — seed the audit's ARM A shape (last-ordinal domain with `dns_status='pending'`, key row `done`), retry with the same key, assert `domain.setDns` was called and `tenant_messages` is non-empty. Today: `setDns=[]`, `messages=[]`.
2. **Capacity-pending (member 3)** — drive `withSpendCeiling` to reject, then raise the ceiling and retry with the same key. Assert the retry provisions. Today: it replays `{jobId, billing}` and provisions nothing.
3. **Revoke tombstone (member 4)** — make `EngineMailboxClient.removeMailbox` throw during `releaseMailboxes`, assert `mailbox_cred_pushes.status !== 'revoked'` (i.e. a state the reconcile lane selects) and that `reconcileMailboxCredentialPushes` picks the row up. Today: `'revoked'`, invisible forever.
4. **Alert delivery (member 5)** — inject a mailer that throws, run `reconcileAlerts`, assert `watchtower_state.last_alert_ts IS NULL` and that the next sweep re-alerts. Today: `last_alert_ts` is stamped and the next sweep is silent.

**Coverage-guard caveat.** If a completeness guard is added over the call sites, enumerate them by globbing the source tree — **do not** hardcode a `SOURCES` array or pin `allSites.length`. `spend-ceiling-coverage.test.ts` already demonstrates that failure mode: it `?raw`-imports one file and pins a count, so a new money-out site elsewhere is invisible *and* the assertion still passes.

---

## 5. Confidence

**High** on the five `withRequestIdempotency` call sites — all read end-to-end, every `return` in each wrapped function traced. Members 2 and 3 are new to this sweep and, on reachability, member 2 outranks the confirmed member.

**High** on spellings (b) and (c) within `apps/platform/src` and on the claim surface (openapi/tools/AGENTS/message bodies).

**What a second sweep with more time should check, that I could not:**

1. **`spikes/` and `tools/`** — out of scope here and unread. The ledger notes `spikes/` is where real-server contract code lives; a replay or marker there would not appear in any grep above.
2. **`apps/dashboard` beyond `api/queries.ts`** — I verified the optimistic-mutation lifecycle and `staleTime`, not every page component. A component that renders a completion state from a mutation's `data` without checking a status field would be a member.
3. **The `provisioning-reconcile` interaction with member 1** — worth confirming as a scope input: `runProvisioningReconcile` calls `provisionDomainWithMailboxes` **directly** (`provisioning-reconcile.ts:147`), with no `withRequestIdempotency` wrapper, so arming `PROVISIONING_RECONCILE_ENABLED` would bypass the replay for DNS-pending domains. That may change how urgent member 1's *runtime* fix is relative to the arming decision (audit F5) — but it does nothing for members 2 and 3, which the reconcile never reaches.
4. **Whether tenant `ten_91aab24a`'s `setup_infrastructure:apd-setup-a-2mbx` row is actually `done`** — unreadable from outside the DO (audit UNVERIFIABLE-1). Every member here is structural and holds regardless, but the *wording of the next operator reply* depends on it.
5. **Concurrency around member 10's `done`+NULL state** — I reasoned through the branch statically. If it were ever reached, `:97`'s reclaim silently no-ops, so the "exactly one retry proceeds" guarantee at `:88-96` is void and every past-window call runs `fn` unserialized. A live repro under concurrent retries would confirm the severity; today it is a latent schema hazard, not a live path.
