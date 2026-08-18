# Scale-readiness audit — coldrig platform at 100–500 tenants

**Frozen record.** Adversarial audit, 2026-08-17. Ref: `main` @ `2689e03dc65478aeeeb0ddb02464522e52a98c75`
(working tree carried only sibling-session edits to `ROADMAP.md` / agent-memory; no source file was
modified by this audit, and the temporary probe file was removed).

Founder order (`ROADMAP.md ## Now`, 2026-08-17): *"make sure it fully operational for 100's of customers."*

---

## VERDICT

**SCALE-READY: NO.**

Three independent ceilings, in the order a growing platform hits them:

| # | Ceiling | Breaks at | Nature |
|---|---|---|---|
| 1 | Platform-wide monthly vendor spend ceiling (`$150`, `690¢`/mailbox) | **~21 live mailboxes, platform-wide** | config knob — founder raises it |
| 2 | InboxKit plan slots on ONE shared workspace, vendor top tier ≈100 | **~100 mailboxes ⇒ ~20–33 paying customers** | hard product/vendor architecture ceiling |
| 3 | Cron-sweep subrequest fan-out (measured **8.0 DO RPCs/tenant**) | **~122 total tenants** (incl. demo/churned) | hard platform ceiling; takes the dead-man with it |

Ceiling 2 is the one that actually answers the founder's question: **at the current one-shared-workspace
vendor architecture the platform structurally cannot serve hundreds of paying customers**, regardless of
what the code does. Ceiling 3 is the one that breaks the *control plane* — including for demo tenants,
which are minted by unauthenticated `POST /signup` at up to 5000/day.

Everything else below is real but survivable with knobs and follow-on work.

---

## Method

Every number here was produced by running code at this ref, not by reading it.

- **Subrequest / RPC counts and per-leg wall clock:** a temporary instrumented probe wrapped `env.DB`
  and every `DurableObjectNamespace` with counting proxies and drove the real
  `runScheduledOpsSweep` at 5 / 20 / 50 / 100 / 200 seeded tenants under
  `@cloudflare/vitest-pool-workers`. All legs returned `errors: 0` at every step, so the counts are of
  a fully-working sweep, not a degraded one.
- **Permanent alert-write amplification:** a probe seeded one real mailbox + one real provisioned
  domain, seeded their two `watchtower_state` rows as if each had alerted once, then ran five
  consecutive sweeps and counted results and D1 writes; then released both and re-ran.
- **Watchtower CPU:** the two clearing loops from `admin/watchtower.ts:280-308` re-implemented verbatim
  and benchmarked on plain node across tenant counts.
- **Engine state growth:** `EngineStore.compact()`'s exact sequence (`JSON.stringify` → `writeSync`
  loop → `fsyncSync`) benchmarked against synthetic state at 10k / 100k / 500k / 2M cumulative sends.

Where a Cloudflare platform number could not be confirmed from this checkout it is tagged
**[platform-limit: verify]** and the finding states what survives without it.

---

## Findings

### S1 · BLOCKER · Cron sweep is 8 DO RPCs per tenant with no cap, and the leg it starves last is the dead-man heartbeat

`runScheduledOpsSweep` runs eleven legs (`apps/platform/src/scheduled.ts:66-131`). Six of them
independently call `listAllTenantIds` (`apps/platform/src/admin/db.ts:212` — `SELECT id FROM
tenants_index`, no `LIMIT`, no status filter, so churned and terminated tenants are swept forever) and
then loop **serially** over every tenant issuing a DO RPC:
`admin/ops-sweep.ts:45` (dunning), `:187` (deliverability), `:225` (warmup cancel), `:291`
(provisioning reconcile), `:325` (webhooks), `:454` (send pipeline), plus `:539` (digest) and
`admin/watchtower.ts:182-212` (watchtower tenant scan). `opsSummary` alone is called **three times per
tenant per tick** (dunning, digest, watchtower).

Measured, on the real sweep, zero leg errors at every step:

| tenants | D1 statements | DO RPCs | total subrequests | wall ms (in-process) |
|---|---|---|---|---|
| 5 | 23 | 45 | 68 | 537 |
| 20 | 23 | 165 | 188 | 569 |
| 50 | 24 | 405 | 429 | 969 |
| 100 | 24 | 805 | 829 | 2207 |
| 200 | — | — | ~1629 | 5185 |

Slope is exactly **8.0 DO RPCs per tenant**; `subrequests(N) ≈ 8N + 29`. That crosses **1,000 at
N = 122**.

The failure shape is worse than "the sweep gets slow". `runLeg` (`scheduled.ts:47-54`) catches a leg
throw and continues — so once the invocation's subrequest budget is exhausted, *every remaining leg
throws immediately and is silently swallowed*. The **last** leg is the dead-man heartbeat
(`scheduled.ts:131`), which is deliberately last precisely so it means "this tick ran to completion".
It never runs. `WatchtowerDO.alarm()` (`apps/platform/src/watchtower-do.ts:120-145`) then grades the
cron STOPPED and pages the founder — for a cron that is running fine and completing six of eleven
legs. `GET /status` simultaneously returns 503 `sweep_stale`.

So above the threshold the platform reports "the scheduler is dead" while the thing that actually
stopped is automatic sending, and nothing says so.

**[platform-limit: verify]** The Cloudflare per-invocation subrequest cap (docs put it at 1,000 on
Paid) and whether DO RPCs count toward it could not be confirmed from this checkout — miniflare does
not enforce it (200 tenants ≈ 1629 subrequests, no error), and the OSS `workerd` binary carries no
such string. **What survives regardless of that number:** the measured 8-RPC-per-tenant slope, the
serial iteration, and the fact that the heartbeat is the last thing in line behind it.

*Fix class:* replace per-tenant RPC fan-out with the D1/Analytics read-model already named as the
scale path in `apps/platform/src/admin/README.md:130-137` and `ARCHITECTURE.md #3`; until then, chunk
the sweep across ticks with a persisted cursor and write the heartbeat FIRST, not last.

---

### S2 · BLOCKER · One account-wide slot counter caps the whole platform's live mailboxes at the InboxKit tier

`DEFAULT_INBOXKIT_PLAN_SLOTS = 10` (`apps/platform/src/engine/spend-ceiling.ts:47`), reserved against a
**single D1 row** `vendor_slot_state WHERE id = 1` (`:284-287`). This is not per-tenant — it is the
platform's total live mailbox count, because the founder ruled one shared InboxKit workspace for all
tenants.

The vendor ladder (`docs/research/vendor-costs-mailforge-inboxkit-2026-07-12.md:34`) tops out at
**Enterprise, 100 slots included**. At a realistic 3–5 mailboxes per customer that is a hard ceiling of
**20–33 concurrent paying customers**, reached long before any code path breaks. Raising
`INBOXKIT_PLAN_SLOTS` past the purchased tier does not create capacity; it converts graceful
`capacity_pending` back-pressure into opaque mid-saga vendor errors (already documented at
`docs/adversarial/provisioning-pipeline-deep-dive-2026-08-05.md:212-224`, which also notes there is no
reconciliation against actual InboxKit occupancy anywhere in the tree).

Compounding, same file: `DEFAULT_SPEND_CEILING_CENTS = 15000` (`:43`) is likewise **platform-wide per
calendar month**, and `DEFAULT_COST_MAILBOX_CENTS = 690` (`:44`). That is **21 mailboxes per month
across all tenants** before every subsequent provision throws `CapacityPendingError` (`:196-201`) and
the tenant is parked in `capacity_pending`.

*Fix class:* this is a vendor-architecture decision, not a code fix — multi-workspace (or a second
vendor account) per N customers, plus occupancy reconciliation against the vendor's own count, plus a
per-tenant sub-allocation of the platform ceiling so one tenant cannot consume the month.

---

### S3 · BLOCKER · No InboxKit rate limiting anywhere, against a documented 10 req/min bulk limit, with a single 2-second retry

`InboxKitClient.request` (`apps/platform/src/vendors/real/inboxkit-client.ts:53-88`) has a 30s timeout
and nothing else: no token bucket, no queue, no cross-tenant concurrency control. `ACTIVATION.md:14`
records the vendor's **bulk provisioning rate limit as 10 req/min**; a live probe recorded 10/5min on
one endpoint (`docs/research/cf-registrar-domain-connect-2026-07-28.md:28`).

`mapInboxKitError` grades 429 retryable (`vendors/real/inboxkit-errors.ts:24`) but **`Retry-After` is
never read** — grep for it across the vendors tree returns nothing — and the mailbox readiness ladder
is a single 2-second backoff: `MAILBOX_READY_BACKOFF_MS = [2_000]`
(`apps/platform/src/engine/mailbox-provisioning.ts:66`). At 10 req/min the window per request is 6s, so
a 429 retries into another 429 and the saga fails.

One tenant provisioning 3 domains × 3 mailboxes is ~25–30 InboxKit calls — roughly 3 minutes of
rate-limit-bound work on its own. Two customers checking out simultaneously in the shared workspace
contend directly, and the loser sees provisioning failure rather than a queue.

*Fix class:* a shared serialized provisioning queue (a single DO) with a token bucket sized to the
vendor limit and `Retry-After`-aware backoff.

---

### S4 · LIE · `cron_legs` conflates by-design rotation skips with genuine leg failure, and pins permanently unhealthy at scale — blinding every leg alert

`collectLegSignals` (`apps/platform/src/admin/sweep-signals.ts:31`) folds three counters into one
observation: `["errors", "budgetExpiries", "skippedForLegDeadline"]`, and `:95` grades the tick
unhealthy if **any** of them is non-zero.

`skippedForLegDeadline` is set every cycle the send-pipeline leg cannot reach every tenant within
`SEND_PIPELINE_LEG_DEADLINE_MS = 150_000` (`admin/ops-sweep.ts:361`, set at `:474-479`). That is not a
fault — it is the rotation working exactly as designed. At scale it is non-zero on **every tick,
permanently**.

Once an episode is announced, `decideAlert` (`apps/platform/src/admin/watchtower-policy.ts:203-218`)
returns `suppressed` on every subsequent tick, re-alerting at 6h then once per 24h. So the steady state
is: one identical "ops sweep legs unhealthy" email per day, forever, describing normal operation — and
**a genuinely dying leg (deliverability erroring on every tenant, the digest leg throwing) produces no
new alert at all**, only an edited `detail` string on an already-suppressed row.

This is the cry-wolf class the platform has already been burned by, re-armed by the guard built to
prevent it.

*Fix class:* split `skippedForLegDeadline` out of the failure signal (it is a capacity metric, not an
error), or grade it against expected coverage-per-hour rather than per-tick.

---

### S5 · LIE / DEGRADE · Every entity ever alerted re-emits a health result and a D1 write on every tick forever — and survives customer churn

**Measured.** Seeded one real mailbox and one real provisioned domain on an activated tenant, seeded
their two `watchtower_state` rows as if each had alerted once, then ran five consecutive sweeps:

```
AMPLIFICATION {"seededEntityResultsPerTick":[2,2,2,2,2],"watchtowerWritesOver5Ticks":20}
```

Both entities re-emit a healthy `CheckResult` on **every** tick, and each result costs one
`upsertWatchtowerState` D1 write in `reconcileAlerts` (`admin/watchtower.ts:354-361`). Then the mailbox
was `released_at`-stamped and the domain set `status='released'` — i.e. the customer churned:

```
AFTER_RELEASE {"stillEmitted":["domain_dns_aging:amp-example.com","cred_push_aging:sales@amp-example.com"]}
```

Still emitted. The ownership filters in the two clearing loops
(`admin/watchtower.ts:280-286`, `:302-308`) test `provisionedDomainNames.includes(domain)` and
`mailboxProvenance.some(...)`, and **neither source filters released rows**:
`engine/ops-summary.ts:304-310` selects every mailbox the tenant has ever held, and `:396-399` selects
every provisioned domain with no `status` filter.

There is **zero** `DELETE FROM watchtower_state` in `apps/platform/src` (grep; the only hits are test
teardown). So the per-tick D1 write cost grows monotonically with the platform's *lifetime cumulative*
count of entities that ever hit an alert, and never comes back down when customers leave. That cost is
additive to the 8N in S1.

The unbounded growth of `watchtower_state` is already an open ROADMAP item (correctly — credit where
due). The **per-tick write amplification** and the **survival across release/churn** are the parts that
are not ledgered anywhere.

*Fix class:* filter both ownership sets to live entities, and retire a check row once it has been
healthy for a retention window.

---

### S6 · DEGRADE · The send pipeline's "285s worst case < 300s cron period" invariant omits the six unbounded legs above it

`admin/ops-sweep.ts:354-361` states the design invariant plainly: *"True worst case is this plus one
tenant budget — 285s, under the 300s cron period, which is what keeps a wedged engine from making every
sweep overlap the next."*

That arithmetic is `SEND_PIPELINE_LEG_DEADLINE_MS (150s) + SEND_PIPELINE_TENANT_BUDGET_MS (135s)`. It
silently assumes the six legs that run **before** it (`scheduled.ts:66-84`) cost zero. None of them
carries a deadline, a budget, or a cursor.

Measured, in-process, with zero network and zero real per-tenant work:

```
LEGS  50 tenants: deliverability 143 · dunning 179 · digest 140 · watchtower 240 · warmupCancel 87 · webhooks 95 → pre-sendPipeline 884ms (17.7 ms/tenant)
LEGS 200 tenants: deliverability 999 · dunning 877 · digest 618 · watchtower 634 · warmupCancel 669 · webhooks 736 → pre-sendPipeline 4533ms (22.7 ms/tenant)
```

That is a floor, not an estimate: in production each of those 6N calls is a real DO hop with real SQL.
At 500 tenants and a conservative 25–50 ms per RPC, the pre-pipeline legs alone are 75–150s, making the
true worst case **360–435s against a 300s period** — overlapping sweeps, which is the exact condition
the stated invariant exists to prevent.

*Fix class:* give every leg a deadline and a rotation cursor, not just the send pipeline; or move to
the read-model so the legs stop being O(N) RPC.

---

### S7 · DEGRADE→BLOCKER · Engine state is unbounded and compaction is a synchronous full-state rewrite that freezes the single-threaded daemon

`EngineStore` keeps `sends` (keyed by idempotency key) and `threads` (keyed by Message-ID) in memory
and in a JSON snapshot **forever** — grep for prune/retention/evict across `apps/engine/src` returns
only `mailbox-store.ts:77-80`, which self-documents that its tombstones are *"retained FOREVER (never
pruned) … revisit with a retention/GC policy if it ever isn't."* Nothing prunes `sends`/`threads` at
all.

`compact()` (`apps/engine/src/store.ts:310-326`) runs every 500 recorded sends
(`:54 DEFAULT_COMPACT_EVERY_RECORDED = 500`) and does `JSON.stringify(whole state)` → a `writeSync`
loop → `fsyncSync` — **all synchronous**, on a process that is a single `createServer`
(`apps/engine/src/index.ts:77-102`; no `cluster`, no `worker_threads`) shared by every tenant.

Measured (node, real fsync):

| cumulative sends | snapshot | stringify | sync write + fsync | **event loop frozen** | heap |
|---|---|---|---|---|---|
| 10,000 | 1.7 MB | 10 ms | 30 ms | **40 ms** | 10 MB |
| 100,000 | 17.3 MB | 176 ms | 66 ms | **242 ms** | 67 MB |
| 500,000 | 88.2 MB | 913 ms | 217 ms | **1,130 ms** | 324 MB |
| 2,000,000 | 357.7 MB | 4,186 ms | 740 ms | **4,925 ms** | 1,229 MB |

At 100 tenants × 50 sends/day the platform reaches 500k cumulative sends in ~100 days: from then on
**every 500th send freezes all sends and polls for all tenants for 1.1 seconds**, ~50× a day. At 2M it
is a 4.9-second freeze and a 1.2 GB resident heap on a droplet — plus the same cost again at boot,
since `loadState` reads the snapshot and then replays the full log on top (`:144-147`).

`MailboxCredentialStore.flush()` (`apps/engine/src/mailbox-store.ts:274-283`) has the same shape —
`writeFileSync(JSON.stringify(this.state))` on **every credential push** — over a state that includes a
never-pruned `idempotency` map and never-pruned `tombstones`.

*Fix class:* retention/GC on `sends`/`threads`/`idempotency`/`tombstones`, async or incremental
compaction off the request path, and a real datastore before the snapshot passes ~50 MB.

---

### S8 · DEGRADE · Cross-tenant operator reads have no pagination or cap

No `LIMIT`, no cursor, no truncation on any cross-tenant read:
`admin/db.ts:155-161` `listOpenAndEscalatedSupportTickets` (selects the full `body` column for every
open + escalated ticket ever), `:324-330` `listPendingScreeningReviews`, `admin/watchtower.ts:465-484`
`readAllCheckRows`, and their routes at `routes/admin-ops.ts:67-82`. The `/admin/ops/checks` route's
own comment (`:61-66`) acknowledges this and defers to the open `watchtower_state` growth item.

Per S5, `watchtower_state` is a lifetime-cumulative table, and the same is true of support tickets. The
support digest at 500 tenants is an unbounded response built from unbounded row bodies.

Note the split, which is to the codebase's credit: **per-tenant** reads consistently do carry bounds
(`engine/activity.ts:67`, `engine/inbox.ts:179`, `engine/list-leads.ts:143`, `engine/lifecycle.ts:197`,
`engine/tenant-messages.ts:202,269`, `engine/reporting.ts:153`). The gap is cross-tenant only.

ROADMAP already promotes the same class for the *newly shipped* read endpoints (2026-08-17, citing a
13.8 MB response at 50k rows). These are the older siblings of that class.

---

### S9 · DEGRADE · Every signup pulls the entire ~17k-row SDN list into the Worker

`getActiveSdnEntries` (`apps/platform/src/ofac/sdn-list.ts:91-104`) selects every row of the active
list version and `JSON.parse`s each `tokens_json`, with no cache and no index-assisted narrowing. Its
own doc comment concedes *"an unindexed full-version scan is acceptable at pilot scale."* At 500
signups that is ~8.5M row reads and 8.5M JSON parses in Worker CPU. Cheap in D1 billing, expensive in
the one budget that matters.

---

### S10 · DEGRADE · The watchtower's per-tenant × per-check-name clearing loops are quadratic

`admin/watchtower.ts:280-286` and `:302-308` iterate the **entire** `reported` set (every check name the
platform has ever recorded, platform-wide) once per tenant, and the inner ownership test is itself a
linear scan. Benchmarked verbatim at 10 mailboxes/tenant:

| tenants | check names | CPU ms |
|---|---|---|
| 100 | 1,400 | 54 |
| 200 | 2,800 | 149 |
| 300 | 4,200 | 374 |
| 500 | 7,000 | 1,233 |

Clean N² curve. **Self-refuted down from BLOCKER:** only entities that have *actually* alerted enter
`reported`, so on a healthy platform the constant is small and this is nowhere near a CPU-limit
problem. It becomes one only in the world S5 creates — where names accumulate for life and never
retire. Graded DEGRADE, and conditional on S5.

---

### S11 · DEGRADE · Serial per-mailbox polling under one shared tenant budget stretches send/reply cadence at scale

`runPollInbox` (`apps/platform/src/engine/reply-processor.ts:262-275`) polls each mailbox **serially**,
one engine round trip apiece, and poll+tick share a single `SEND_PIPELINE_TENANT_BUDGET_MS = 135_000`
(`admin/ops-sweep.ts:352`). At 10 mailboxes and a realistic ~200 ms Gmail/IMAP round trip that is ~2s
per tenant, so the 150s leg deadline covers roughly 75 tenants per cycle. At 500 activated tenants each
one is polled and ticked about once every 35 minutes rather than every 5 — reply-detection latency and
send cadence degrade by ~7×.

The rotation (`admin/ops-sweep.ts:471-481`) makes this *fair* rather than *starving*, which is good
design. But per S4 the only signal that it is happening is folded into a check that is permanently
unhealthy anyway.

---

## Attacks that FAILED (why the passes above are meaningful)

- **"`skippedForLegDeadline` is silently dropped"** — refuted. `sweep-signals.ts:31` explicitly covers
  it. This attack is what turned into S4 (it is *reported*, just conflated), and it is the reason S4 is
  graded LIE rather than a silent-degradation finding.
- **"Leg isolation breaks at scale / one wedged tenant kills the sweep"** — held. Every fan-out leg has
  a per-tenant `try/catch` with an `errors` counter (`ops-sweep.ts:104-110, 191-195, 229-233, 299-304,
  329-332, 497-502`; digest at `:545-551`). Driven at 200 tenants: no cross-leg contamination, no
  aborted sweep.
- **"A new unbounded `IN (...)` has reappeared against D1's 100-param ceiling"** — held.
  `markSupportTicketsEmailed` is still chunked at 98 with the two fixed params accounted for
  (`admin/db.ts:106-124`), and the SDN ingest is still 16 rows × 6 columns (`ofac/sdn-list.ts:26`). The
  prior finding's fix is intact at this ref.
- **"Module-level in-memory Maps keyed by tenant in the Worker"** — refuted. Grep across
  `apps/platform/src` found no module-level mutable tenant-keyed state; every `new Map`/`new Set` is
  either request-scoped or a constant lookup table.
- **"Per-tenant read surfaces are unbounded too"** — refuted. They consistently carry `LIMIT ?`
  (enumerated in S8). The unbounded-read defect is genuinely cross-tenant-only.
- **"Stripe webhook watermark contention at high event volume"** — refuted, and there is no surface for
  it: `billing_event_order` is per-lane inside **each tenant's own DO storage**
  (`engine/billing.ts:490-546`), not a shared D1 table, so cross-tenant webhook volume creates no
  contention point at all. The per-lane split (rather than one global watermark) is also the correct
  design.
- **"Signup is unthrottled, so demo tenants can be minted without bound"** — held. `routes/signup.ts`
  applies a per-IP limiter *and* a global one (`:20-36`, 200/min, 5000/day) through the atomic
  `RateLimiterDO`. Note the interaction though: 5000 demo tenants/day is ~40× the S1 threshold, and
  demo tenants are swept identically to paying ones.
- **"The digest is zeroed out by one wedged tenant"** — held; per-tenant catch with an `errors`
  counter (`ops-sweep.ts:542-552`).

---

## UNVERIFIABLE (not folded into the verdict)

1. **The actual Cloudflare per-invocation subrequest cap, and whether DO RPCs count toward it.**
   Miniflare does not enforce it (200 tenants ≈ 1629 subrequests, clean run) and the OSS `workerd`
   binary carries no matching string. *Resolves at:* seeding ~150 tenants in a staging Worker and
   watching a real cron tick under `wrangler tail`.
2. **The scheduled-handler CPU ceiling.** `wrangler.toml` sets no `[limits] cpu_ms`, so the sweep runs
   on whatever the account default is. *Resolves at:* setting `limits.cpu_ms` explicitly and measuring
   a deployed tick.
3. **Real production DO RPC latency.** Every wall-clock number here is in-process miniflare — a floor,
   not a forecast. *Resolves at:* a staging measurement.
4. **Gmail API per-mailbox quota headroom and the warmup ramp at 1000+ mailboxes.** No live
   credentials in this environment; the engine's Gmail path was never exercised. *Resolves at:* an
   activation-gate measurement against a real workspace.
5. **InboxKit's current live rate limit, slot ladder, and pricing.** Taken from in-repo research dated
   2026-07-12 / 2026-07-28, not re-verified against the vendor today.
6. **Whether `AUTOSEND_DISABLED` and `PROVISIONING_RECONCILE_ENABLED` are armed in production.** If
   the latter is armed it adds a **seventh** O(N) DO-RPC leg (`ops-sweep.ts:291`), moving the S1
   threshold from ~122 down to ~110 tenants.

---

## NEW — out of scope, no verdict weight

- **`mailboxProvenance` rides in every cross-tenant aggregation.** `engine/ops-summary.ts:304-310`
  returns every mailbox row a tenant has ever held, on all three `opsSummary` calls per tick — including
  the dunning sweep, which reads none of it. An unbounded per-tenant array multiplied by 3N RPCs.
- **The engine authenticates every tenant with one shared bearer secret** (`apps/engine/src/auth.ts`,
  used at `router.ts:52,73,80,87`). Tenant isolation on the send path lives entirely in the Worker; the
  droplet has no tenant concept at its boundary. Fine for one customer, worth a decision before
  hundreds.
- **`GET /admin/ops/checks` sorting is done in JS over the full unbounded row set**
  (`routes/admin-ops.ts:70-74`) rather than in SQL.
