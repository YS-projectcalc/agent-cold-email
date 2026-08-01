# Adversarial review — warmup wave (engine + site claims + SPEC), 2026-08-02

**Ref:** `git rev-parse HEAD` = `8b3695ce31aabe0c70b18ef2249a71076a478b2b`. Target = the complete UNCOMMITTED working-tree diff (47 modified files + 7 untracked), nothing staged. Read-only git throughout.

**VERDICT: NO-SHIP** — 2 BLOCKING.

**Battery re-run by me (not the builder's numbers):**

| Command | Result |
|---|---|
| `npm run typecheck` (root, all workspaces) | exit **0** |
| `npm run test --workspace apps/platform` | **125 files / 1143 tests passed**, exit 0 |
| `npm run test --workspace apps/engine` | 16 files (+2 skipped) / **126 passed** (4 skipped), exit 0 |
| `npm run test --workspace apps/dashboard` | 29 files / **143 passed**, exit 0 |
| `npm run test --workspace packages/cli` | **12 pass / 0 fail** |
| All 24 site JSON-LD blocks | **0 invalid** |
| Live `POST api.coldrig.dev/mcp tools/list` | **25 tools** |
| Live `GET coldrig.dev/AGENTS.md` | **404** (confirms the audit item; `_redirects` fix resolves it only post-deploy) |

The suites are green **with both blockers present** — neither is test-detectable.

---

## BLOCKING

### A1 — The warmup auto-cancel sweep has NO production driver: `runTick` is unreachable, so "the platform automatically cancels the pool subscription" is false as shipped

**Lens 4 (deploy/arm-time plumbing) + lens 1 (spec-vs-code trace).**

The new sweep is wired into exactly one place — `apps/platform/src/engine/tick.ts:172`, inside `runTick`. Full caller enumeration of `runTick`:

- `apps/platform/src/tenant-do.ts:751-753` — the DO method `tick()`.
- `apps/platform/src/engine/demo.ts:130,137` — the sandbox demo pipeline, plan-gated to demo/free tenants.

And `tick()` is invoked by **nothing** in production:

- Not the cron. `apps/platform/wrangler.toml` `crons = ["*/5 * * * *"]` → `src/scheduled.ts:24-50`, which calls `runDeliverabilitySweepAllTenants` → `stub.deliverabilitySweep()`, `runDunningSweep`, `buildOpsDigest`, `runWatchtower`, `runWebhookDeliveriesAllTenants`, `reapStaleReservations`, `maybeRefreshSdnList`, `rescreenListUnavailableReviews`. `tenant-do.ts:770` labels `deliverabilitySweep` "no send scheduling — that's tick()/B2".
- Not a route. Every `app.route` mount in `src/index.ts:39-141` was walked; no path reaches `tick()`. `src/routes/admin-ops.ts` exposes only `dunning-sweep`, `digest`, `waitlist`, `terminate`.
- Not an MCP tool. All 25 tool names in `src/mcp/tools.ts` enumerated; no tick tool. Every `stub.*` call in `src/mcp/` enumerated; `stub.tick` is absent.
- Not a DO alarm. `grep -rn "alarm" apps/platform/src` returns comments only — there is no `alarm()` handler on `TenantDO`.

The code says so itself: `engine/tick.ts:130-131` — "Represents what a DO-alarm would do once fired; B0 exposes it as a directly-callable RPC method since real alarm-driven scheduling is **B2**"; `engine/README.md:193-199` — "B2 is where resumable, DO-alarm-driven scheduling lands." B2 is still open backlog (`ROADMAP.md:121`).

**Failure scenario:** Mordy's first mailbox is provisioned on day D. `provisioning.ts:79-81` starts a real InboxKit warmup subscription at $3/mbx/mo. On day D+28 the ramp completes. No tick ever fires, so `runWarmupCancellationSweep` never executes, `warmup_cancelled_at` stays NULL forever, and the subscription bills every month for the life of the mailbox — the exact COGS outcome the founder ruling exists to prevent. Meanwhile `site/faq.html:124` and `site/guide-cold-email-deliverability.html:111` tell buyers, in the present tense, that the platform automatically cancels it.

**Claims falsified by this:** `site/faq.html:124` ("the platform automatically winds down and cancels that pool subscription"), `site/guide-cold-email-deliverability.html:111` ("the platform automatically cancels the pool subscription"), `SPEC.md:38`, `SPEC.md:152` (both "automatically cancels ... engine/warmup-cancel.ts, a tick-driven sweep").

This also fails the founder ruling's own DoD, `ROADMAP.md:25`: "Hard deadline: must be live before the FIRST real mailbox reaches day 29." Code that no scheduler calls is not live. The claims-coupling condition ("site copy may say 'pool warmup included during ramp-up' ONLY in the same deploy that ships the cancel step") is satisfied in letter — the file ships — and violated in substance.

**Verification:** exhaustive grep of `runTick` / `.tick(` / `stub.` / route mounts / `alarm` across `apps/platform/src`, `apps/dashboard/src`, `apps/engine/src`, `packages/`; read `scheduled.ts` and `admin/ops-sweep.ts` end to end; live-probed `api.coldrig.dev` for `/tick`, `/engine/tick`, `/cron/tick` (all 404). The diff adds no wiring — its only `tick.ts` change is the sweep call itself.

**Self-refutation attempted and failed:** (a) "the tick lands in the same deploy" — no wiring anywhere in the diff; (b) "day 29 is weeks away, so this is not urgent" — true that no charge leaks today, but the copy is published today in the present tense, and the diff creates no roadmap item to wire it; (c) "I mis-enumerated" — five independent enumeration methods plus the code's own comments agree.

`file:line` — `apps/platform/src/engine/tick.ts:172` and `apps/platform/src/engine/warmup-cancel.ts:57` vs `apps/platform/src/tenant-do.ts:751`, `apps/platform/src/scheduled.ts:24-50`, `apps/platform/wrangler.toml` `[triggers]`; claims at `site/faq.html:124`, `site/guide-cold-email-deliverability.html:111`, `SPEC.md:38,152`.

> Adjacent, PRE-EXISTING, out of scope for this verdict but load-bearing for the platform: the same unreachability means **campaign sends never fire automatically in production either** — `scheduled_sends` rows are drained only by `runTick`. That is B2 backlog, not this wave's regression, and it carries no verdict weight here. It does mean A1 cannot be dismissed as a warmup-only concern.

### A2 — `security.html`'s new spend claim says "per-tenant" where the ceiling is a single account-wide row shared by every tenant

**Lens 1 (spec-vs-code) + lens 8 (security surface).**

New copy, `site/security.html:8` (card `05 / OWNER`): *"every real vendor-spend call is atomically reserved against a **per-tenant** monthly spend ceiling before it's allowed to run, not just logged after the fact."*

The ceiling is not per-tenant. `apps/platform/migrations/0011_vendor_spend_ledger.sql:19-25`:

```sql
CREATE TABLE IF NOT EXISTS vendor_spend_ledger (
  period_key      TEXT PRIMARY KEY,
  reserved_cents  INTEGER NOT NULL DEFAULT 0,
  committed_cents INTEGER NOT NULL DEFAULT 0,
  ceiling_cents   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
```

One row per calendar month, **no `tenant_id` anywhere**. The atomic reserve gates on `period_key` alone (`apps/platform/src/engine/spend-ceiling.ts:229-239`). `tenant_id` appears only in the `vendor_spend_entries` audit trail (`:271-277`), never in the gate. The migration's own header states the design intent explicitly (`0011:4-6`): *"the ceiling + the InboxKit plan-slot count are properties of the **WHOLE InboxKit account, spanning every tenant**."* The G4 slot counter is likewise one row, `vendor_slot_state` `id = 1` (`0011:36-41`).

**Failure scenario:** default ceiling is $150/mo (`spend-ceiling.ts:43`), mailbox cost 690¢ (`:44`). Tenant A provisions 20 mailboxes → 13,800¢ reserved of 15,000¢. Tenant B's next provision fails the conditional UPDATE, `rejectCapacity` fires, B is parked in `capacity_pending` (`:161-172`) and cannot provision — because of A's spend. A reader of the security page concluded each tenant has its own budget. The misstatement sits two cards away from `04 / TENANCY`'s "Customers do not share a sender reputation pool", so the section reads as an isolation inventory; it now asserts isolation on an axis where tenants are in fact fully coupled.

**Verification:** read the migration, the reserve/rollback/commit SQL, and `withSpendCeiling` end to end; confirmed no tenant predicate on either counter.

**Self-refutation attempted and failed:** the charitable parse ("spend *by* a tenant is reserved against a monthly ceiling") does not survive the words on the page — "per-tenant" grammatically modifies "ceiling", and the correct word is *account-wide*. This text is brand new in this diff (it replaced the honest "Paid mutations remain disabled until the backend meter is ready"), on the security page, in a claims-honesty wave whose whole premise is that published mechanism descriptions match code. One-word fix.

`file:line` — `site/security.html:8` vs `apps/platform/migrations/0011_vendor_spend_ledger.sql:4-6,19-25,36-41` and `apps/platform/src/engine/spend-ceiling.ts:229-239`.

---

## NON-BLOCKING

- **N-a — the governance coverage guard is evadable by five shapes, one of them accidental.** `test/send-governance-coverage.test.ts:44,60-62`. I extracted both regexes and ran them against synthetic sources (node, verbatim patterns). CAUGHT: direct `ctx.adapters.email.send(`, `const { adapters } = ctx; adapters.email.send(`, multiline member chains, `const port = ctx.adapters.email`. **EVADES:** `ctx.adapters["email"].send(...)`; `const a = ctx.adapters; a.email.send(...)` (aliasing the *bundle*, not the port — the alias regexes only look for `.adapters.email`); `const s = ctx.adapters.email.send; s(...)` (method reference — `.email` is followed by `.` so the negative lookahead rejects it, and `.send` is not followed by `(`); `ctx.adapters.email["send"](...)`; and **`ctx.adapters.email?.send(...)`** — optional chaining, the one a developer could write by accident. The guard is a useful tripwire, not a sandbox; the file's own docstring (`:17-19`) overstates it as making the two-call-site property "MECHANICAL".
- **N-b — `WARMUP_CANCEL_GAVE_UP` goes to the customer, not the operator whose money is leaking.** `warmup-cancel.ts:104-108` writes it via `logAction` into `deliverability_actions`. Readers of that table: `engine/activity.ts:63` (the tenant's `activity` tool / dashboard feed) and `engine/reporting.ts:152` (tenant report). The owner-facing digest counts only `REPLACE_DOMAIN` (`engine/ops-summary.ts:164`), and the watchtower has no check for it. So the row that says "warmup subscription may still be billing — verify with the vendor" is visible only to the tenant, who cannot act on it, and never to the founder, who can.
- **N-c — the give-up path sets `warmup_cancelled_at` without vendor confirmation, contradicting the column's own documented invariant.** `warmup-cancel.ts:98-103` writes the marker at the attempt cap. `schema.ts:205-212` defines that column as "Set **only after the vendor confirms**". After a give-up, any future reader asking "is this pool still billing?" gets "no" from a column that means "we stopped trying". A distinct `warmup_cancel_gave_up_at` (or a status enum) would keep the invariant intact.
- **N-d — `RealMailboxPort.cancelWarmup` violates the idempotency contract its own port interface asserts.** `packages/shared/src/vendor-ports.ts:80-82` — "an implementation must be safe to invoke more than once for the same mailbox." But `vendors/real/mailbox-port.ts:120-131` throws unless our uid comes back in `results.success[]`; an already-cancelled subscription will not plausibly appear there. This is exactly the crash-between-vendor-200-and-marker-write path the design counts on: the retry burns all 5 attempts and files a **false** "may still be billing" give-up for a subscription that is in fact cancelled. Untestable today — `vendors/sandbox/mailbox-port.ts:23-31` returns success unconditionally, so no fixture can express it.
- **N-e — the sweep does not exclude BYO-connected mailboxes, which never had a pool subscription.** `warmup-cancel.ts:65-70` filters on `tenant_id`, `warmup_cancelled_at IS NULL`, `released_at IS NULL`, `warmup_cancel_attempts < 5` — but not on `source`. `engine/byo-mailbox-composition.ts:106-108` inserts BYO mailboxes into the same table with `source = 'byo_connected'` and a real `warmup_started_at`, and never calls `startWarmup`. Past day 28 the sweep would call `cancelWarmup` on them; `resolveMailboxUid` (`vendors/real/mailbox-port.ts:189-196`) throws "inboxkit has no mailbox matching …", costing 5 vendor round-trips and a false give-up row per mailbox. **Latent today:** a real tenant cannot reach `byo_status = 'active'` (the real DNS-scan/reputation ports throw `NotActivatedError`), and for a sandbox tenant the sandbox port no-ops to success — producing a spurious `WARMUP_CANCELLED` row for a pool that never existed. `source` is a clean available discriminator.
- **N-f — the version sync landed on the wrong number for the server, half-closing the audit's version-skew item.** `site/.well-known/mcp/server-card.json:5` and `site/openapi.yaml:4` now read `0.2.1`, but the live MCP server reports `"version":"0.2.2"` (verified live against `api.coldrig.dev/mcp` `initialize`), sourced from `apps/platform/package.json` via `mcp/handler.ts:23`. The repo's own registry manifest models it correctly — `server.json:9` = `0.2.2` (server) with `packages[0].version` = `0.2.1` (npm CLI). `0.2.1` is the CLI's version, correct on `llms.txt:49`, `docs.html:102`, `for-agents.html:109`, `agent-evaluation.md:52`; it is the wrong value for the server card and the API's OpenAPI doc.
- **N-g — prior N4 (cap-as-entitlement) is improved but still open on the two loudest pages.** The wave *added* a genuine caveat at `compare-vs-maildoso.html:170` ("actual safe daily volume depends on warmup stage, mailbox health, and provider rules"). But `guide-cold-email-deliverability.html:102` publishes the ladder as "what this platform actually enforces, day by day … Day 29+: 40/day, fully warmed", and `faq.html:124` repeats it, with no statement that health can hold a mailbox *below* schedule. `engine/deliverability.ts:63` (`throttleFloorCap: 5`) plus `deliverability-actions.ts:54-58,276` persist `cap_override`, which `mailbox-state.ts` MINs in — a fully-warmed mailbox can sit at 5/day indefinitely, 8× under the published day-29 figure. Mitigations present: the guide points to the runtime `dailyCap` via `infrastructure_status` (`:102`), and the same page describes health-based throttling generically (`:118`). **Ruling: NON-BLOCKING** — the ladder is a truthful description of the ramp ceiling, and the live value is checkable — but a capacity-planning agent reading `:102` alone will over-plan.
- **N-h — no test covers the guarded-send failure rollback.** `guarded-send.ts:126-139` decrements `sent_today` when the vendor throws. `test/reply-send-guard.test.ts` has no vendor-failure case, so the one path that could drive the counter wrong (or, if it regressed, silently burn a day's allowance per transient failure) is unexercised.
- **N-i — prior N3 stands unchanged.** `engine/byo-ramp.ts:12-20` still implements `primary` (20/day clamp) and `shortened` (40/day by day 10) tiers alongside `standard`, while `guide-cold-email-deliverability.html:102` presents the standard ladder as *the* enforced schedule. Same latency caveat as N-e.

---

## Disposition of the round-1 findings (`warmup-claims-fix-review-2026-07-31.md`)

| # | Status | Evidence |
|---|---|---|
| B1 (headline denial false) | **RESOLVED** | Founder ruling `ROADMAP.md:25`; copy inverted to the truth at `faq.html:124`, `guide-cold-email-deliverability.html:111`, `SPEC.md:38,152` — the pool is now disclosed as bundled, not denied. (Its *cancel* half is A1.) |
| B2 (uncapped `reply` path) | **RESOLVED** | `threads.ts:150-165` routes through `sendWithGuards`; `guarded-send.ts:54-122` = suppression re-check → pause refusal → atomic conditional-UPDATE cap reserve; structured 429/409 at `index.ts:178-188` and MCP at `mcp/handler.ts:167-181`; 6 behavioral tests in `test/reply-send-guard.test.ts`. |
| B3 (faq week-4 = 40) | **RESOLVED** | `faq.html:124` now reads "35/day the next three weeks, then 40/day once fully warmed on **day 29**" — matches `warmup.ts:14-19`. |
| N1 (SPEC §9 survivor) | **RESOLVED** | `SPEC.md:152` rewritten. |
| N2 ("real recipient engagement") | **RESOLVED** | Phrase absent from `guide-domains-inboxes-warmup-compliance.html` (0 matches). |
| N3 (byo-ramp tiers unpublished) | **STILL OPEN** | See N-i. |
| N4 (cap-as-entitlement) | **PARTLY RESOLVED / STILL OPEN** | See N-g. |
| N5 (stale Maildoso comparison) | **RESOLVED** | "No published fixed daily figure" gone; `compare-vs-maildoso.html:152,161,170` rewritten to publish the ramp and concede the normalized-cost point. |
| N6 (adopted-then-denied pool paragraph) | **RESOLVED BY TRUTH CHANGE** | `:101`'s pool description is now consistent with `:111`, which bundles rather than denies a pool. |
| N7 (byo-domain inverted claim) | **RESOLVED** | `byo-domain.html:8` now reads "Live reputation/blocklist monitoring against your domain is on the roadmap, not running yet — don't rely on it today." |
| N8 ("(prewarm SKU)") | **RESOLVED** | `SPEC.md:38` — "a future, founder-held option (**not a shipped SKU**)"; the phrase "prewarm SKU" is gone (0 matches). |
| N9 (pool-detection-as-fact) | **RESOLVED** | `SPEC.md:548` now reads "plausible but not confirmed by any primary Gmail/MS statement … (unaudited)". |

---

## Attacks that FAILED (the wave held)

- **Guarded-send atomicity under concurrency.** Traced the full guard sequence for an interleaving await: `refreshMailboxWarmupState` → SELECT → pause check → conditional reserve are all synchronous `ctx.sql.exec` calls with no await between them, and the first await in `sendWithGuards` is the vendor send *after* the reserve (`guarded-send.ts:75-125`). Two concurrent replies at cap−1: A reserves, B's `sent_today < daily_cap` fails, `rowsWritten === 0`, B is refused. Held.
- **Idempotent-retry vs cap interaction.** The durable send-key lookup sits *before* `sendWithGuards` (`threads.ts:145-147`), so replaying a reply that already went out returns the recorded `messageId` and consumes no capacity, rather than being refused because the mailbox has since capped. Deliberate and correct.
- **HTTP/MCP refusal parity.** Both emit `{error, code:"send_blocked", reason, retryable}` with the same field names (`index.ts:181-187`, `mcp/handler.ts:174-179`); reason enum matches `SendBlockedReason` in `packages/shared/src/errors.ts:126` exactly.
- **OpenAPI vs onError mapping.** `site/openapi.yaml` 409 enumerates `[suppressed, mailbox_paused]` with `retryable: false`; 429 enumerates `[daily_cap_reached]` with `retryable: true`. Cross-checked against all four `SendBlockedError` construction sites in `guarded-send.ts` — the status split is exact, and the body shape matches `index.ts` field for field.
- **`resolveMailboxUid` cancelling the WRONG subscription.** Tried to construct a wrong-uid cancel (recreated mailbox, reused address, casing, keyword pagination). `vendors/real/mailbox-port.ts:197-203` reconstructs `username@domain_name` and refuses on any non-exact (case-insensitive) match. Worst case is a *failed* cancel → attempt cap → give-up row (N-b/N-c/N-d), never a cancel of someone else's subscription. Held.
- **Day-29 timing vs monthly renewal.** `computeWarmupDay` (`warmup.ts:8-11`) makes day 29 begin at 28.0 elapsed days from `warmup_started_at`, which is stamped from the same `startWarmup` call that creates the subscription (`provisioning.ts:79-83`). Cancel lands comfortably inside the first ~30-day vendor month. Held (contingent on A1 being fixed so the sweep runs at all).
- **Tenant isolation in the sweep.** Every statement in `warmup-cancel.ts` carries `tenant_id = ?` (`:65-70,87-92,98-103,120-125`), and there is a dedicated cross-tenant test (`test/warmup-cancel.test.ts:206-219`). Held.
- **`released_at` skip.** `:66` excludes torn-down mailboxes, with a test at `:221-232`. Correct — teardown already released the mailbox vendor-side.
- **Tick failure isolation.** `tick.ts:171-175` wraps the sweep in try/catch and the sweep itself grades each mailbox independently and never throws (`warmup-cancel.ts:82-113`), so a vendor hiccup cannot delay sends. Held.
- **Sandbox never spends.** `withSpendCeiling` short-circuits on `ctx.adapters.kind === "sandbox"` (`spend-ceiling.ts:211`), which backs `security.html:9`'s new "the free sandbox … cannot spend" line. Held.
- **`_redirects` syntax.** All five lines are valid Cloudflare Pages rules; the new `/AGENTS.md → https://raw.githubusercontent.com/… 301` is a permitted external redirect with an explicit status. Held.
- **Sitemap.** Parsed as XML: 35 `<url>` entries, **zero** missing `lastmod`, zero duplicate `<loc>`, dates plausible (19 × 2026-08-02 for touched pages, the rest older). Held.
- **`workers.dev` sweep.** Exactly **two** files retain it — `site/_headers:9` (CSP `connect-src` dual-host, deliberate) and `site/README.md:39` (documented fallback note). Zero in user-facing copy, the server card, `openapi.yaml`, or `llms.txt`. (The brief said "3 remnants"; the third is a second mention inside the same `README.md:39` line.) Held.
- **JSON-LD integrity.** All 24 blocks across every `site/**/*.html` parse; the rewritten FAQ answer at `faq.html:124` is not mirrored into the FAQPage block, so no structured-data drift. Held.
- **Stale count/status claims.** Zero occurrences of "12 tools" / "17 tools" / "19 tools" / "21 tools" / "24 tools" / "sandbox only" / "not live yet" anywhere in `site/`; live `tools/list` returns 25. Held.
- **Pricing arithmetic in the new security copy.** "$49/mo platform plus $10/mailbox" reconciles with the $99/5-mailbox figure used across `faq.html`, `pricing.html`, and `tools.ts`. Held.
- **"Bundled at no extra charge."** `spend-ceiling.ts:44` prices the add-on inside `COST_MAILBOX_CENTS` (our COGS: $3.90 slot + $3.00 warmup) against a $10/mailbox customer price — the customer genuinely pays no separate warmup line. Held.
- **Schema migration ordering.** `tenant-do.ts:196-200` adds both new columns via `addColumnIfMissing` with a NULL default for `warmup_cancelled_at`, so an existing DO whose mailbox is already past day 28 is picked up by the catch-up query rather than skipped. Correct by construction (moot until A1).

---

## Buyer-agent read (attack #8) — post-fix surfaces only

- **(a) Hard 5/day cap in week one — YES, correct now.** Deciding lines: `guide-cold-email-deliverability.html:102` ("a real server-side cap your agent cannot exceed … Days 1-7: 5 sends/mailbox/day"), `faq.html:124`, `mcp/tools.ts:67,79`. This was round-1's B2 and it now holds on **both** send paths: the tick enforces inline, and `reply` goes through `sendWithGuards`. The residual over-read is N-g (health can pin a warmed mailbox below the ladder).
- **(b) Pool warmup bundled during the ramp — YES. Then auto-cancelled — NO.** Deciding lines: `faq.html:124`, `guide-cold-email-deliverability.html:111`. The "bundled" half is now true and was round-1's B1. The "then automatically cancelled" half is what A1 refutes: no scheduler reaches the sweep.
- **(c) Production live with real billing — YES.** Deciding lines: `security.html:8` ("Self-serve billing (Stripe live mode) is active"), `server-card.json` `"status":"live"`, live `tools/list` = 25 tools. The buyer would, however, also carry away A2's false conclusion that spend is budgeted per tenant.

## UNVERIFIABLE

- **InboxKit's actual `/warmup/cancel` response shape**, and specifically what it returns for an already-cancelled subscription (N-d). The adapter's `CancelWarmupResponse` (`vendors/real/mailbox-port.ts:279-282`) is self-labelled "contract captured from docs 2026-08-02" and the docs do not state repeat-cancel behavior. *Resolves by:* one real cancel + one repeat cancel against a live subscription at first ramp completion, or a vendor support answer.
- **Whether any warmup subscription already exists in production.** Needs the InboxKit dashboard; `ROADMAP.md:25` indicates Mordy has not provisioned yet. *Resolves by:* founder checking the InboxKit console. Does not change A1.
- **Post-deploy behavior of the new copy and `_redirects`.** The site diff is uncommitted; live `coldrig.dev/faq` still serves the pre-wave copy and `/AGENTS.md` still 404s. *Resolves by:* re-fetching both after the Pages deploy.

---

## NEW (out of scope, no verdict weight)

- `ROADMAP.md:113` already ledgers that `setup_infrastructure`'s "Async — returns { jobId }" is untrue (provisioning is synchronous). The tool description edited in this diff (`mcp/tools.ts:67`) still carries that clause.
- `ACTIVATION.md:50` instructs the operator to "stop the tick" during an engine redeploy. There is no mechanism to stop — or start — the tick (see A1); the runbook step is unexecutable as written.

---
---

# ROUND 2 — targeted re-verify of the fix round (2026-08-02, same day)

**Ref:** `git rev-parse HEAD` = `df67a421361b0a50ccbf2453a3f57de5c4d83cfb`. HEAD advanced by exactly one commit since round 1 (`8b3695c` → `df67a42`, a one-line `ROADMAP.md` ledger entry recording A1's adjacency); the wave itself is still the uncommitted working tree. Read-only git throughout.

**VERDICT: SHIP.** Both BLOCKING findings are closed, verified against the production trigger rather than against the builder's description. All eight folded non-blockers are closed or materially improved. Residuals below are NON-BLOCKING and none is a claims-fidelity defect.

**Battery re-run by me:** root `npm run typecheck` exit **0**; `apps/platform` **125 files / 1157 tests passed**, exit 0 (matches the builder's claim exactly); `apps/engine` 126 passed (4 skipped); `apps/dashboard` 143 passed. Spot-ran the latter two because `ops-summary.ts` changed the `TenantOpsSummary.actionsInWindow` shape.

## A1 — CLOSED

The production chain is real and I verified every hop rather than reading the diff's description of it: `wrangler.toml` `crons = ["*/5 * * * *"]` → `index.ts:206` `scheduled()` → `scheduled.ts:39` `runWarmupCancelSweepAllTenants` → `admin/ops-sweep.ts:174-188` (enumerates via the same `listAllTenantIds` the dunning and deliverability lanes use) → `stub.warmupCancelSweep()` → `tenant-do.ts:786-788` → `runWarmupCancellationSweep`.

The RED proof exists and does what is claimed. `test/warmup-cancel.test.ts:259-276` drives `worker.scheduled(createScheduledController(), env, ctx)` — the real exported handler with a real controller — with no direct sweep call and no `tick()`, then asserts `warmup_cancelled_at` is non-null and the action row is `WARMUP_CANCELLED`. On round-1 code `runScheduledOpsSweep` had no warmup lane, so line 274 would fail; the proof is genuinely red-on-old. A second test at `:249-257` pins the DO RPC itself.

Per-tenant failure isolation holds: `ops-sweep.ts:178-186` wraps each tenant's stub call in its own try/catch and counts errors without aborting the loop, and the per-tenant sweep grades each mailbox independently and never throws.

`runTick` was **not** wired into the cron — `scheduled.ts` contains no `tick()` call, so automatic campaign sending stays unarmed. Confirmed by reading the whole file.

**Ruling on the dual driver (`runTick` still calls the sweep at `tick.ts:171-175`): harmless, keep or drop at the builder's discretion.** Both markers make it idempotent; `tick()` remains unreachable in production, so the second driver only fires in tests and the sandbox demo, where `SandboxMailboxPort.cancelWarmup` no-ops. The one interleaving I could construct — a concurrent `tick()` and cron sweep both reading `warmup_cancel_attempts` before either writes — produces a lost update that *under*-counts attempts, i.e. more retries, never fewer. Safe direction.

## A2 — CLOSED

`site/security.html:8` now reads: *"every real vendor-spend call is atomically reserved against a monthly spend ceiling **on the vendor account** before it's allowed to run — reserved first, not just logged after the fact."* I attacked it for a surviving isolation parse and found none: "on the vendor account" names the shared InboxKit account explicitly, and no reading assigns a budget to a tenant.

Each clause re-checked against `spend-ceiling.ts`: "atomically reserved" = the single conditional UPDATE at `:229-239`; "monthly" = `period_key` `YYYY-MM` (`:105-108`); "before it's allowed to run" = the reserve precedes `fn()`; "every real vendor-spend call" survives the two exceptions — sandbox tenants short-circuit at `:211` but make no real vendor calls, and `cancelWarmup` is unwrapped because it *stops* spend rather than incurring it.

## Folded non-blockers

- **N-a — CLOSED, and I re-ran my round-1 evasions against the new detectors.** Re-keying on the `.email…send(` CHAIN rather than an `adapters.` prefix catches **all five** round-1 evasions: bracket-on-email, bundle-alias (`const a = ctx.adapters; a.email.send(…)`), method handle, bracket-on-send, and optional chaining — the accidental one. I also confirmed the claimed no-false-positive property empirically by running both detector sets over the real tree: `apps/platform/src` yields exactly `engine/guarded-send.ts` and `engine/tick.ts`, with zero alias hits, and zero hits of either kind in `packages/shared/src`, `apps/engine/src`, `apps/dashboard/src`. The deliberate decision *not* to lexer-match bundle aliasing is correct and well-argued — the resulting call still trips the chain scan. Residual is adversarial-only: `email?.["send"]?.(…)` (optional-call after a bracketed member), a computed-variable member (`a[k1][k2](…)`), and `Reflect.get(…)` still evade. None is writable by accident; closing them needs a parser, not a better regex.
- **N-b — IMPROVED, not fully closed. This is the one place the fix does less than the framing suggests.** `gaveUpWarmupCancels` is now its own `TenantOpsSummary` field (`ops-summary.ts:165`), aggregated into `OpsDigest` (`ops-sweep.ts:274`) and pushed as a `watchdogAlerts` line (`ops-sweep.ts:301-305`) — deliberately kept out of `deliverability.actionsInWindow`, which is right. But the founder does not *receive* the digest: `buildOpsDigest` takes no mailer, and its only consumers are `scheduled.ts:41` (`console.log`, visible only in `wrangler tail`) and the pull endpoint `GET /admin/ops/digest`. The channel that actually reaches the founder's inbox is the watchtower's OpsMailer, and `gaveUpWarmupCancels` is not a watchtower check. So the give-up has moved off the customer-only surface onto the owner surface — a real improvement — but it is still a pull, not a push. Ledger it; it is a pre-existing property of the digest, not a defect this wave introduced.
- **N-c — CLOSED.** `warmup-cancel.ts:113-118` writes `warmup_cancel_gave_up_at`; `warmup_cancelled_at` is never touched on the give-up path, restoring the schema invariant. Both columns independently stop the sweep (`:77`), with a test at `test/warmup-cancel.test.ts:183`.
- **N-d — CLOSED on the question asked; one residual below.** The three-state grading is correct and the inconclusive path genuinely cannot mark a subscription cancelled: only `state === "absent"` returns success (`mailbox-port.ts:141`), while `"active"` and `"inconclusive"` both throw retryable. Four adapter tests pin it (`test/real-mailbox-port.test.ts:185,198,215,229`), including a 500 on the list lookup. Disambiguating by asking the vendor rather than matching error text is the right instinct for this adapter.
- **N-e — CLOSED, and the NULL trap I went looking for is not there.** `warmup-cancel.ts:78` adds `source != 'byo_connected'`. I attacked the three-valued-logic case — if `source` were NULL on rows in a pre-existing DO, `NULL != 'byo_connected'` is NULL, silently excluding real mailboxes and leaking money forever. It cannot happen: `tenant-do.ts:219` adds the column as `TEXT NOT NULL DEFAULT 'provisioned'`, so SQLite backfills existing rows. Writing it as `!=` rather than `= 'provisioned'` is the right default direction, and the comment says why. Test at `test/warmup-cancel.test.ts:197`.
- **N-f — CLOSED.** `server-card.json:5` and `openapi.yaml:4` are now `0.2.2`, matching both the live `serverInfo` (re-verified against `api.coldrig.dev` this session) and `server.json:9`. The CLI surfaces (`llms.txt:49`, `docs.html:102`, `for-agents.html:109`, `agent-evaluation.md:52`, `guide-mcp-cold-email.html:244`) correctly stay `0.2.1`, matching `npm view agent-cold-email version`.
- **N-g — CLOSED.** Both pages now carry an explicit ceiling-not-entitlement caveat naming the exact failure ("a throttled mailbox can sit at 5/day indefinitely") and directing the reader to the live `dailyCap` over the published schedule.
- **N-h — CLOSED.** `test/reply-send-guard.test.ts:211-249` patches the email port to throw, asserts `sent_today` is unchanged from before the attempt, then proves the mailbox is still usable by driving a real retry through the HTTP route and asserting exactly one increment.

## Residual NON-BLOCKING findings (new this round)

- **R1 — the 5-minute cron cadence turns the attempt cap into a ~20-minute retry budget.** `MAX_CANCEL_ATTEMPTS = 5` (`warmup-cancel.ts:33`) with no backoff and no time-based spacing, driven by `crons = ["*/5 * * * *"]`, means attempts land at t=0, 5, 10, 15, 20 minutes. **A transient InboxKit outage lasting 20 minutes permanently exhausts the budget** and files a give-up for a subscription that would have cancelled fine an hour later — producing exactly the recurring charge the founder ruling exists to stop. This coupling is new: the cap was sized against a tick that never ran. Detected (R1's outcome does reach the digest via N-b) and recoverable by hand, so non-blocking, but the cheap fix is spacing attempts by elapsed time rather than by invocation count.
- **R2 — the new lane sits second in the cron, ahead of the watchtower, contradicting `scheduled.ts`'s own stated ordering rule.** That file places webhooks last "so a webhook fan-out failure can't delay the health/dunning/watchtower legs above" (`:44-45`) and says the same of the reserve reaper (`:49-51`). Warmup-cancel is also vendor fan-out and is placed at `:39`, before dunning, digest and watchtower. Worst case per mailbox on a hanging vendor is bounded but large: `resolveMailboxUid` + `/warmup/cancel` + up to 10 `/warmup/list` pages at `REQUEST_TIMEOUT_MS = 30_000` each ≈ 360s, sequential across tenants, ahead of the founder's outage alarm. Steady state is one DO RPC per tenant and zero vendor calls (the marker means cancels happen once), so this is a brownout-shaped risk, not a normal-path one. Moving the lane below `runWatchtower` costs nothing.
- **R3 — the `absent` determination has an unsafe default and no test.** `mailbox-port.ts:186` returns `"absent"` when `page >= (body.pages ?? 1)`. If the vendor omits `pages` on a full first page, that evaluates true on page 1 and reports absent after inspecting only 100 subscriptions — the money-leaking direction, in the one check written specifically to avoid it. `pages` is typed optional (`:344`). Neither the multi-page walk nor the last-page branch is exercised: the only `absent` fixture is `IK_WARMUP_LIST_EMPTY` (`test/fixtures/inboxkit.ts:150-157`), which short-circuits on `subscriptions.length === 0`. A missing `pages` should read as inconclusive.
- **R4 — stale comments inside `warmup-cancel.ts`, one of which contradicts the N-c fix 80 lines below it.** `:31` still says "At the cap the mailbox **is marked cancelled** so the sweep stops" — precisely the behavior N-c changed at `:113-118`. A future reader trusting that comment would re-conflate the two markers. Also stale on the driver: `:24` ("OBSERVED here instead, from the tick"), `:29` ("every tick forever"), `:45` ("Runs from the tick"), `:50` ("picked up on the next tick"), and `tick.ts:165-166` ("Runs from the tick because it makes a VENDOR call"). `engine/README.md`, the `tenant-do.ts` docstring, `SPEC.md` and `scheduled.ts` were all correctly updated to the cron — this module was not.

## Builder's own attack pointers — ruled

- **(a) cron lane ordering** — real, see R2. No *correctness* coupling: the runner's per-tenant try/catch and the sweep's internal grading mean the warmup lane cannot abort or corrupt any later leg. The coupling is latency only.
- **(b) the 100×10 page-walk ceiling at scale** — not a practical risk, and it fails safe. The walk covers 1,000 active subscriptions against a ledgered tier plan topping out near 80-100 mailboxes; and note the count is platform-wide, since all tenants share one InboxKit workspace (founder ruling 2026-07-31). Exceeding it returns `"inconclusive"`, which throws and retries — it does not silently report a cancel. The scale question is fine; R3's missing-`pages` case is the one that actually bites.
- **(c) SPEC driver-agnostic rewording** — `SPEC.md:38,152` now say "an automatic scheduled platform sweep with bounded retry", which is accurate and survives a future driver change. `site/faq.html:124` and `site/guide-cold-email-deliverability.html:111` name no driver at all, which is correct. The mismatch left over is inside `warmup-cancel.ts` and `tick.ts` — see R4.

## Attacks that FAILED this round

- **Is the cron proof vacuous?** Checked that `worker.scheduled` is the real export and `createScheduledController()` a real controller, that the test seeds a tenant reachable by `listAllTenantIds`, and that it asserts durable state (`warmup_cancelled_at`, the action row) rather than a spy call. It is a genuine end-to-end proof.
- **Can the give-up marker be reached without a vendor attempt?** No — `warmup_cancel_gave_up_at` is written only inside the catch block at the attempt cap.
- **Does the BYO filter's `!=` silently drop legitimate mailboxes via NULL?** No — see N-e.
- **Can `"inconclusive"` reach a success return?** No — traced every return in `warmupSubscriptionState` and both call-site branches in `cancelWarmup`.
- **Did the fix round regress the round-1 held items?** Re-ran the detector false-positive scan, the version cross-check against live `serverInfo` and npm, and the full platform suite. Nothing regressed; the suite grew 1143 → 1157.
- **Was `runTick` quietly armed?** No `tick()` call anywhere in `scheduled.ts`, `ops-sweep.ts`, or any route. Campaign auto-send remains unarmed, as required.

## UNVERIFIABLE (carried, unchanged)

- InboxKit's real `/warmup/cancel` and `/warmup/list` wire shapes, including whether `pages` is always present (R3) and whether `status`/`include_cancelled` are honored. Both contracts are self-labelled "captured from docs 2026-08-02". *Resolves at* the first live ramp completion, or a vendor support answer.
- Whether any warmup subscription exists in production yet.
- Post-deploy behavior of the site copy and `_redirects` (the site diff is still uncommitted).
