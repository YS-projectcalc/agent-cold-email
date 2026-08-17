# Class sweep — monitoring completeness ("a narrowed view read as the whole truth")

**Date:** 2026-08-17 · **Sweeper:** class-sweeper (opus, xhigh) · **Mode:** READ-ONLY
**Ground ref:** `9d3ec7e9021eb234c6f633540f0cca2aaa99cf2b` on `main`
**Tree state at sweep time:** dirty only in `.claude/agent-memory/spec-builder/` and `docs/research/backlink-outreach-targets-2026-08-17.md`; no `apps/platform/src` file modified. Sibling agents are editing this worktree — re-ground before acting on this inventory.

---

## 1. Class definition

The brief's definition is **correct and kept**, with one **widening** that matters for coverage:

> Any monitoring/observability read that consumes a FILTERED, BOUNDED, or PAGINATED view while treating it as the complete truth — where growth or a new enum value silently narrows what is watched.

**Correction — add a third sub-mechanism.** Three of the strongest members below contain **no `WHERE` clause and no `LIMIT` at all**. A sweep that hunts only filters and bounds misses them. The full mechanism has three spellings:

- **(a) Enum/status allowlist** — the set is defined by an enumerated list of values; a new member value exits the watched set with no error.
- **(b) Bound / page** — the read caps rows and either publishes no truncation signal, or publishes one the consumer never reads.
- **(c) Substrate or config split** — a member of the monitored population lives outside the store being read, is conditionally omitted (skip-dark), or is a hardcoded constant. Nothing is filtered; the row simply never exists.

**One-sentence mechanism, covering all three:** *the read's own result is the only evidence of its completeness, so **absence is indistinguishable from health**.*

That corollary is the invariant every member violates, and it is the thing the guard must restore: **a monitoring read must publish the denominator it was drawn from.**

---

## 2. Search coverage

### Lexical (every pattern run)

| Pattern | Scope | Hits triaged |
|---|---|---|
| `LIMIT [0-9?]` / bare `LIMIT` | `apps/platform/src/**/*.ts`, tests excluded | 45 raw → 28 SQL `LIMIT`s |
| `status *= *'[a-z_]+'`, `status IN (`, `!== "…"`, `=== "…"` on `billing_state`/`billingState` | same | 16 distinct literal comparisons |
| `page\|limit\|per_page\|offset\|cursor\|has_more\|total` | `vendors/real/inboxkit-client.ts`, `inboxkit-domain-port.ts`, `mailbox-port.ts`, `domain-port.ts` | full pagination contract read |
| `\.toArray\(\)` | `engine/deliverability.ts`, `mailbox-eligibility.ts`, `warmup.ts`, `ops-summary.ts` | all unbounded reads confirmed |
| `insertTenantIndex\|tenants_index` | src | enumeration source traced to a single writer |
| `MAX_SURFACED_MESSAGES\|listSurfacedTenantMessages` | src | preview-vs-complete pair traced |
| `email_sent_at\|emailSentAt\|markSupportTicketsEmailed` | src | read/write asymmetry found |
| `'closed'\|"closed"` | src | **zero writers** — the digest's accidental completeness |
| `recentActions\|last 20\|most recent` | src | truncated-history surfaces |
| `DEAD_MAN_INTERVAL_MS\|SWEEP_STALE_MS\|LEG_ALERT_AFTER_SWEEPS` | `admin/watchtower-grading.ts` | thresholds pinned |
| `unhealthy=1\|/admin/ops/checks\|sweepAgeSeconds\|support/digest` | `**/*.md` (archive excluded) | doc/claim surface |
| `status` + `CHECK(`/`DEFAULT`/`INDEX` | `apps/platform/migrations/*.sql` | **no CHECK constraint on any status column** |
| `ops/checks\|support/digest\|ops/digest\|ops/waitlist\|/status` | `site/openapi.yaml` | zero — admin surface is undocumented publicly |
| `admin/ops\|support/digest\|watchtower` | `site/`, `tools/` | zero consumers |

### Semantic (surfaces read in full, that grep cannot catch)

Per the coverage ledger, the surfaces that under-counted in prior sweeps here were covered **first**: downstream consumers of a signal (not just its writer), the two-store split, sandbox-vs-real divergence, docs/claims asserting the missing mechanism, cron lanes duplicating engine entry points, migration SQL vs runtime DDL.

- **The watch spec itself** — `HANDOFF.md:20` (leg definitions), `HANDOFF.md:10` (two-store caveat), `~/.claude/mordy-watch/last-seen.json` (live baselines + actual polled fields). The cron prompt is **session-scoped and not on disk** — see §5.
- **Whole files read:** `routes/admin-support.ts`, `routes/admin-ops.ts`, `routes/status.ts`, `admin/db.ts`, `admin/support-kb.ts`, `admin/ops-sweep.ts`, `admin/watchtower.ts`, `admin/watchtower-alerts.ts`, `admin/watchtower-infra.ts`, `admin/sweep-signals.ts`, `engine/ops-summary.ts`, `scheduled.ts`.
- **Partial reads:** `watchtower-do.ts` (alarm + heartbeat), `engine/reporting.ts`, `engine/activity.ts`, `engine/infrastructure-status.ts`, `engine/tenant-messages.ts`, `engine/deliverability.ts`, `engine/mailbox-eligibility.ts`, `engine/lifecycle.ts`, `engine/clock-migration.ts`, `engine/contact-operator-reconcile.ts`, `db.ts`, `schema.ts`.
- **Vendor port contracts** — `vendors/real/inboxkit-domain-port.ts:135-181`, `vendors/real/mailbox-port.ts:225-261` (the in-repo COMPLIANT pagination template).
- **Config / CI:** `apps/platform/wrangler.toml` `[triggers] crons = ["*/5 * * * *"]`.
- **Migration SQL:** all 17 files scanned for status enums and CHECK constraints (`0002`, `0008`, `0012`, `0017`, `0018` read).
- **Claim surfaces:** `ACTIVATION.md:20,93,100,103`, `ROADMAP.md:28,60`, `HANDOFF.md`, `mcp/tools.ts` tool descriptions, `apps/platform/src/routes/README.md:73-75`, `site/openapi.yaml`.
- **Excluded:** `.claude/worktrees/agent-*/` copies (ledger: they inflate repo-wide greps).

---

## 3. Inventory

### IN — watch spec (5)

| Site | Verdict | Mechanism + concrete blind-spot scenario |
|---|---|---|
| `HANDOFF.md:20` leg 2 (InboxKit) | **IN (b)** | Posts `{"page":1,"limit":50}` to `/domains/list` + `/mailboxes/list` and never reads `pages`/`total`. Row 51+ is invisible with no error. Not hypothetical: the published pricing curve sells up to **60 mailboxes per tenant** (`admin/support-kb.ts:36-42`), so ONE top-tier tenant silently truncates the watch. The platform's own adapters do this correctly — `vendors/real/inboxkit-domain-port.ts:162-181` walks pages, reads `body.pages`, and **throws** at the ceiling rather than under-reporting; `vendors/real/mailbox-port.ts:241-261` returns `"inconclusive"`. The compliant template is in-repo and the watch is the only violator. |
| `HANDOFF.md:20` leg 1 (support digest) | **IN (a)** | Spec says "tickets"; the endpoint returns `status IN ('open','escalated')` only (`admin/db.ts:158`). Complete **only by accident**: `'closed'` exists in the TS union (`admin/db.ts:20,134`) but has **zero writers** anywhere in src. The first close/snooze/reopen feature blinds the list AND its counts simultaneously (see P2). |
| `HANDOFF.md:20` (leg roster) vs `last-seen.json` | **IN (c)** | The spec enumerates **four** legs. `last-seen.json` carries an `opsDigest` block (`watchdogAlerts`, `provisioningFailureCount`, `pastDueCount`, `errors`) that can only come from `GET /admin/ops/digest` — **a fifth leg in no version of the spec** (corroborated by `docs/adversarial/agent-channel-product-audit-2026-08-17.md:20` probing it live). A session resuming from `HANDOFF.md` recreates 4 legs and silently drops the only surface carrying past-due, disputed, MRR, waitlist and windowed `gaveUpWarmupCancels`. |
| `HANDOFF.md:20` leg 3 dead-cron tell | **IN (c)** | The tell is "stale shared `updatedAt` >15min". `updated_at` advances only for checks **reconciled that sweep**, and most are not reported every sweep: `failure_signals` is omitted inside the grading dead band (`admin/watchtower.ts:216-227`), per-entity checks emit only while unhealthy or clearing (`:280-308`), `cron_legs` only on a graded streak (`admin/sweep-signals.ts:96-112`), `engine` only when configured. The tell rests **entirely** on `do_storage` being pushed unconditionally (`admin/watchtower.ts:106`) — an undocumented single point of dependence. Make `do_storage` conditional the way `engine` already is and the dead-cron tell dies with no symptom. |
| `ACTIVATION.md:20` + `:100` | **IN (c), already ledgered** | The 5-minute external prober is declared a **PREREQUISITE for real sending** and is still open while real sending is live. Leg 4 is the de-facto substitute at a **2-hour** cadence against a **15-minute** staleness threshold (`SWEEP_STALE_MS`, `admin/watchtower-grading.ts:62`). Genuinely mitigated by the WatchtowerDO dead-man alarm, which is self-rearming and independent of both D1 and the cron (`watchtower-do.ts:86-95,120-140`) — listed because the watch spec presents leg 4 as the dead-man watch and it is not sized to be one. |

### IN — platform (7)

| Site | Verdict | Mechanism + concrete blind-spot scenario |
|---|---|---|
| `admin/db.ts:155-161` `listOpenAndEscalatedSupportTickets` | **IN (a)** | The instance. Status allowlist, no LIMIT. One added status = silently unwatched tickets. |
| `admin/db.ts:163-171` `countSupportTicketsByStatus` | **IN (a) — the amplifier** | The COUNT half hardcodes **the same two statuses** as `SUM(CASE …)` columns over an unfiltered table. So a consumer cross-checking the digest's `counts` against its `tickets` array gets agreement while both are blind. This is precisely why the digest cannot self-detect its own narrowing, and it is the cheapest fix anchor (`COUNT(*)` as `total` is one column away). |
| `admin/ops-sweep.ts:624` `provisioningFailureCount: 0` | **IN (c)** | A hardcoded literal in the founder's rollup, mirrored verbatim into `last-seen.json`'s `opsDigest.provisioningFailureCount: 0` and read there as evidence. A monitored number structurally incapable of being non-zero. The code comment (`:591-594`) is honest that no signal exists; the JSON field on the wire is not, and the watch consumes the wire. |
| `admin/ops-sweep.ts:567-582` digest bucketing | **IN (a)** | `billing_state` is bucketed by an if-ladder (`past_due` / `canceling`\|`canceled` / `disputed`) and `activeByPlan` keys off tenant `status === "active"`. `billing_state` has no CHECK constraint (`schema.ts:17`, `DEFAULT 'none'`). A new value falls in **no** bucket: the tenant still counts in `tenants.total` but vanishes from every lifecycle number the founder reads. Same shape as the support-status instance, one table over. |
| `engine/reporting.ts:130-141` | **IN (a)** | `pausedMailboxes`/`throttledMailboxes` are equality counts against two `deliv_status` literals; `burningDomains` counts `status='burning'`. A third value is counted nowhere — invisible in both `account().deliverability` (customer) and `buildOpsDigest`'s `deliverability` block (founder), which sums exactly these. |
| `routes/admin-ops.ts:79-82` `GET /admin/ops/waitlist` | **IN (b)** | Returns `{count: entries.length}` where `entries` is capped at `limit = 1000` (`db.ts:296`). Past 1000 leads it reports `count: 1000` **as the total**, with no truncation signal — while the true total already exists one function away (`countWaitlistEmails`, `db.ts:289`, used by the digest). A truncated page relabelled as a count. |
| `admin/watchtower.ts:110-123` engine check | **IN (c)** | The `engine` check is omitted from the results array entirely when `ENGINE_BASE_URL` is unset. An env var lost in a deploy **deletes a check from the monitored set**: no row is written, `/admin/ops/checks` never lists it, and its absence reads as health on every downstream surface including leg 3. The skip-dark behaviour is deliberate and correct; the gap is that nothing anywhere asserts the expected check **roster**. |

### IN — consumed-as-complete, smaller blast radius (3)

| Site | Verdict | Mechanism + concrete blind-spot scenario |
|---|---|---|
| `engine/infrastructure-status.ts:175` | **IN (b)** | `messages:` is a fixed cap-5 preview (`engine/tenant-messages.ts:59,194-206`) returned with **no total and no `hasMore`**. The customer's coding agent — the only operator this product has — is told to poll `infrastructure_status.messages[]` (`mcp/tools.ts:371`) and cannot tell a 6th operator message exists. `list_messages` is the complete cursor-paginated surface, but nothing in the response points at it. |
| `admin/db.ts:157` (digest SELECT column list) | **IN (c)** | The SELECT drops `email_sent_at` and `message_id`. `contact_operator` tickets insert with `email_sent_at NULL` and are stamped only after a successful ops email (`engine/contact-operator.ts:125`); a failed send leaves NULL to "roll into the NEXT successful send" (`:129`) — which never arrives if that tenant never writes again. **No surface anywhere distinguishes "the founder was emailed this" from "nobody was."** Ledger shape: type-boundary field drop hides the discriminator. |
| `engine/reporting.ts:150-153` `recentActions … LIMIT 20` | **IN (b)** | Surfaced via `account().deliverability.recentActions` and described in `mcp/tools.ts:171` with no truncation marker. A burst >20 silently hides the earliest. Lower severity: `engine/activity.ts:40-80` is the complete cursor-paginated surface over the same rows. |

### OUT (with the reason each is immune)

| Site | Why immune |
|---|---|
| `admin/watchtower.ts:465-484` `readAllCheckRows` | No LIMIT, no filter; `unhealthyCount` is computed over ALL rows **before** the `?unhealthy=1` filter (`routes/admin-ops.ts:70-71`). The no-cap decision is stated in the route doc (`:60-66`). |
| `admin/watchtower.ts:441-444`, `:486-508` | Full-table, unfiltered. (Unbounded growth is a separate, already-ledgered item — ROADMAP `## Open` NB-2. Its failure direction is a D1 error → `runLeg` → `cron_legs` alert, i.e. loud.) |
| `readAllCheckRows`'s `healthy: row.status === "healthy"` | An unknown status value maps to `healthy: false` — fail **loud**, the safe direction for a monitor. |
| `admin/db.ts:212-215` `listAllTenantIds` | `SELECT id FROM tenants_index`, no filter, no LIMIT. Every sweep enumerates every tenant including suspended and terminated (terminate does `UPDATE … status` at `db.ts:209`, never DELETE). Over-inclusive, never blind. |
| `admin/ops-sweep.ts:473-503` send-pipeline leg deadline + per-tenant budget | Bounded **by design**, but it reports `skippedForLegDeadline`/`budgetExpiries`, those are read by `admin/sweep-signals.ts:31-68` → the `cron_legs` alert, and the cycle-derived rotation (`:471`) guarantees eventual coverage. **This is the compliant template for a bounded sweep.** |
| `vendors/real/inboxkit-domain-port.ts:156-181`, `vendors/real/mailbox-port.ts:241-261` | Walk pages, read `body.pages`, and on exceeding `MAX_*_PAGES` **throw** / return `"inconclusive"` rather than under-report. **The compliant template to cite when fixing watch leg 2.** |
| `engine/activity.ts:40-80`, `engine/tenant-messages.ts:258-283`, `engine/list-leads.ts`, `engine/inbox.ts` | `limit + 1` fetch with explicit `hasMore` → `nextCursor`. Truncation is on the wire. |
| `site/openapi.yaml` | Documents no admin/ops endpoint — there is no published contract asserting completeness. |
| `db.ts:158-178` `insertDashboardSession`'s `LIMIT ?2` | An eviction bound inside a DELETE, not a read. |
| `apps/platform/migrations/*.sql` | No monitoring read lives in SQL. **Not members — but the guard site**: no status column anywhere carries a `CHECK` constraint, which is what makes an enum grow without passing a reviewer. |

### UNCERTAIN (3) — none dropped

| Site | What is uncertain | What would settle it |
|---|---|---|
| `engine/ops-summary.ts:323-409` `readSendPipelineSignals` | Every aging/due window is computed off `ctx.clock.now()` — the **tenant's** clock, not wall clock. On a tenant whose `clock_mode` never migrated (`engine/clock-migration.ts:48-59`: "call ONCE per tenant, guarded by `clock_mode != 'real'`"), a frozen clock makes `agingPendingDomains`, `agingPendingPushes` and `dueNonDemoPendingSends` silently empty or silently permanent — the exact ledger hazard. Live evidence says it is CORRECT for Mordy (`domain_dns_aging` fired at ~480h, matching real elapsed). | Enumerate every path that creates a `tenant_profile` row and assert each reaches `migrateTenantClockToReal` before its first watchtower scan; plus a live `SELECT clock_mode, COUNT(*)` across tenants. |
| Support-ticket lifecycle | No code path writes `'closed'` and there is no close/ack endpoint, so leg 1's list and `last-seen.json.ids` grow monotonically forever. Whether that is a defect or the intended design (founder reads and ignores) is a product call, not a code call. | A founder ruling on whether an operator reply closes the ticket. |
| Watch leg 1 change-detection | `last-seen.json.maxCreatedAt` implies new-ticket detection keys on `createdAt >`. If so, a **status change on an existing ticket** (open→escalated) carries no `createdAt` change and is invisible to the watch. `HANDOFF.md:20` does not specify the comparison. | Read the actual cron prompt text — it is session-scoped and **not on disk**, so I could not verify it. |

---

## 4. Systemic guards

### Platform — ONE guard: *every monitoring read publishes its denominator*

New module `apps/platform/src/admin/monitoring-completeness.ts`, exercised by the cron sweep and pinned by test. Two halves, one idea:

**(1) Denominator on the wire.** Every admin/monitoring response that returns a filtered or capped list gains a sibling total drawn from an **unfiltered** `COUNT(*)`, and the sweep raises a new watchtower check `monitoring_completeness` when `listed + explicitly-excluded != total`:
- `/admin/support/digest` → `counts.total` (plain `COUNT(*)` on `support_tickets`) plus `counts.closed`; the route asserts `open + escalated + closed === total`. A status nobody accounted for makes that arithmetic fail **loudly**, which is the whole point.
- `/admin/ops/waitlist` → `count` becomes `countWaitlistEmails()` (the real total) and the response gains `truncated: entries.length < count`.
- `buildOpsDigest` lifecycle → gains `unbucketed` (tenants whose `billing_state` matched no if-branch) and pushes a `watchdogAlerts` line whenever it is non-zero.
- `buildOpsDigest` → `provisioningFailureCount` becomes `null` (honestly "no signal") rather than a `0` that reads as a measurement.

**(2) Roster on the wire.** `GET /admin/ops/checks` gains `expected: string[]` — the always-on probe names (`d1`, `do_storage`, `cron_sweep`, `cron_legs`, plus `engine` when `ENGINE_BASE_URL` is set) — and `missing: string[]` for any expected name with no row. A check deleted by a lost env var, a rename, or a refactor becomes **visible to the consumer** instead of merely absent.

**Why one guard and not a lint rule.** Three of the ten IN members contain no `WHERE` and no `LIMIT` — a rule that flags `status IN (` cannot see `provisioningFailureCount: 0` or the skip-dark `engine` check. The defect is a missing denominator, not a syntax.

**Cheap schema half, worth naming separately.** Add `CHECK (status IN ('open','escalated','closed'))` to `support_tickets` and the equivalent on `billing_state`, in a new migration. Adding an enum value then **requires** touching a migration, forcing the author past the readers. The repo already applied this reasoning deliberately once: `schema.ts:220-221` chose a separate column over a third `dns_status` value precisely because "every reader in this codebase branches on `dns_status != 'ready'`".

### Watch spec — ONE guard: *every leg asserts its own denominator*

Rewrite `HANDOFF.md:20`'s leg list so each leg carries an assertion the cron prompt **executes**, not a description:

1. **leg 1** — assert `counts.open + counts.escalated === tickets.length` **and** `counts.total === open + escalated + closed`. A mismatch **is** "a status was added"; alarm on it.
2. **leg 2** — send `{"page":1,"limit":100}`, then assert `pages <= 1 && total === rows.length`; otherwise walk further pages or alarm. Cite `vendors/real/inboxkit-domain-port.ts:162-181` as the in-repo template.
3. **leg 3** — assert `missing` is empty, and that at least one row's `updatedAt` is within 15 min, **naming `do_storage` explicitly** as the row the dead-cron tell depends on, so a future change to it breaks the spec visibly.
4. **leg 4** — unchanged, plus: the 2-hour cadence does NOT satisfy the 15-minute dead-man; the WatchtowerDO alarm is primary and the external prober (`ACTIVATION.md:100`) is still the designed backstop.
5. **leg 5 (NEW — currently in use, undocumented)** — `GET /admin/ops/digest`: record `pastDueCount`, `lifecycle.disputed`, `gaveUpWarmupCancels`, `errors`, `unbucketed`; note that `provisioningFailureCount` carries no information.

### Failing-test sketch (revert-fail-restore)

`apps/platform/test/monitoring-completeness.test.ts`:

```ts
test("the support digest reports every ticket status, not an allowlist", async () => {
  await insertSupportTicket(env, { /* … */ status: "open" });
  await insertSupportTicket(env, { /* … */ status: "escalated" });
  // a status the triage path does not write today — adding one must not
  // silently shrink the digest
  await env.DB.prepare(
    `INSERT INTO support_tickets (id, from_email, subject, body, tenant_id, category,
     draft, status, created_at, message_id, source, email_sent_at)
     VALUES (?,?,?,?,?,?,?,'snoozed',?,NULL,'email',NULL)`,
  ).bind(/* … */).run();

  const { counts } = await (await app.request("/admin/support/digest", { headers: adminAuth })).json();

  expect(counts.total).toBe(3);                                        // REDS today: `total` is undefined
  expect(counts.open + counts.escalated + counts.closed).toBe(counts.total); // REDS today: 2 !== 3
});

test("GET /admin/ops/checks names the checks it expected but did not find", async () => {
  // watchtower_state seeded with `do_storage` only
  const { expected, missing } = await (await app.request("/admin/ops/checks", { headers: adminAuth })).json();
  expect(expected).toContain("cron_legs");
  expect(missing).toContain("cron_legs");                              // REDS today: both fields absent
});
```

The first reds against `admin/db.ts:163-171` exactly as written (no `total` column, two hardcoded statuses) and greens once the denominator lands — a clean revert-fail-restore.

**Stated limitation:** the watch-spec guard has **no in-repo test**. Its only enforcement is the spec text plus the fact that leg 1's mismatch assertion is executable inside the cron prompt itself. Do not let it be reported as covered by the suite.

---

## 5. Confidence — what a second sweep should check

- **The watch cron prompt was not readable.** It is session-scoped and not on disk (`~/.claude/mordy-watch/` holds only `last-seen.json`; no crontab, no `~/.claude/crons`). Every watch-side finding is inferred from `HANDOFF.md:20` + the shape of `last-seen.json`. **UNCERTAIN-3 is unresolvable without it.**
- **Concurrent sibling agents.** Four `docs/adversarial/*-2026-08-17.md` artifacts are in flight this session (channel-audit and others); I grepped them but did not read them end to end. Some findings here may already be owned elsewhere.
- **Not swept:** `spikes/`, and `site/` static pages for a status widget (grep found no consumer of the admin surface, but the pages were not read).
- **Sampled, not exhaustive:** tenant-DO-side reads inside `deliverabilitySweep`/`tick`. A second pass should score **every** `ctx.sql.exec` in `engine/` for a status-equality filter feeding a COUNT that reaches an ops surface — that is the shape of P5, and I found it by reading rather than by grep.
- **Ground ref `9d3ec7e9`** — the tree is live and mutating. Re-verify before acting.
