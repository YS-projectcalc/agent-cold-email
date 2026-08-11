# Adversary gate — Inc5 reconcile-sweep lane (2026-08-11)

**Branch** `inc5-reconcile-sweep-2026-08-11` · **worktree** `~/dev/coldstart-wt-inc5-sweep`
**Ground ref:** `git rev-parse HEAD` = `8fef36539dd4f7c181f54fd86e870e7b0220db74`, on base `9d87bc3`.
Reviewer: fresh-context adversary, read-only git, no fixes authored.

> **This document has two rounds. Round 1 (below) is a frozen record — its verdict is
> SUPERSEDED. The lane's current verdict is ROUND 2 at the bottom of this file: SHIP.**

---

# ROUND 1 (`8fef365`) — frozen

## VERDICT: **NO-SHIP** — 1 BLOCKING

The lane's two commits are otherwise sound and one of them fixes a test that is **red on
`main` right now**. But the new sweep's D1 query is unbounded in bound parameters and dies at
exactly the table size the guard it serves is documented to produce.

---

## Battery, re-derived independently

| Check | Result |
|---|---|
| `apps/platform` vitest | **168 files / 1571 tests passed**, exit 0 |
| root `pnpm typecheck` | exit 0 |
| root `pnpm build` (`wrangler deploy --dry-run`) | exit 0 |

Matches the builder's claim exactly. Re-run a second time after deleting my throwaway attack
files: still 168/1571, exit 0, worktree diff-clean.

> Harness note: `pnpm --filter @coldstart/platform test --run` resolves a **global** vitest from
> `~/.npm-global` and fails all 168 files with `Failed to load url cloudflare:test-internal`.
> That is a toolchain artifact, not a lane defect. Run `apps/platform` with the workspace binary
> (`../../node_modules/.bin/vitest run`).

---

## FINDINGS

### BLOCKING-1 · lens 2 (would it actually run? RUN it) + lens 5 (fixture realism)
**The reconcile sweep exceeds D1's 100-bound-parameter ceiling and throws — at the table size
the storm guard's own header documents as its steady-state maximum.**

`apps/platform/src/engine/contact-operator-reconcile.ts:71-77` builds one statement with
`1 + candidates.length` bound parameters, with **no chunking and no `LIMIT` on the candidate
query**:

```ts
const candidates = ctx.sql
  .exec<CandidateRow>(`SELECT id, emailed_at FROM agent_contact_log WHERE tenant_id = ? AND created_at < ?`, ctx.tenantId, cutoff)
  .toArray();
if (candidates.length === 0) return { reaped: 0 };

const placeholders = candidates.map(() => "?").join(", ");
const ticketed = await ctx.env.DB.prepare(`SELECT id FROM support_tickets WHERE tenant_id = ? AND id IN (${placeholders})`)
  .bind(ctx.tenantId, ...candidates.map((c) => c.id))
```

**The repo already learned this exact class and wrote it down.**
`apps/platform/src/ofac/sdn-list.ts:13-19`: *"Cloudflare D1's REAL per-statement limit is 100
bound parameters — empirically confirmed (101 params throws `D1_ERROR: too many SQL variables`,
100 succeeds)."* The new code reimplements the anti-pattern that comment exists to prevent.

**Failure scenario (executed end to end, no fault injection):**

1. *Exact threshold.* 98 candidates (99 params) → OK, reaped 98. 99 candidates (100 params) →
   OK, reaped 99. **100 candidates (101 params) → `D1_ERROR: too many SQL variables at offset
   359: SQLITE_ERROR`.** 101 → same. (Local D1 ceiling probed independently: 50/99/100 accepted,
   101/102/118/119/120 rejected — identical to the production constant the repo documents.)
2. *Reachability from the REAL guard, not a hand-seed.* Replayed 23 hours of a tenant sitting at
   the documented cap through the production `admitContactOperatorCall` (real 5/hr cap, real
   24h retention prune): **admitted 115, log rows 115, sweep candidates 115 → sweep THREW.**
   The guard's own header states the invariant: *"at 5 admissions/hour the table cannot exceed
   ~120 rows"* (`contact-operator-guard.ts`). 120 > 100. The builder's own documented
   steady-state maximum is above the ceiling.
3. *The sweep reaps zero.* With 118 orphans seeded: `orphanRowsStillLeaked: 118`. Every leaked
   rate-cap slot and every phantom-dedup row survives — the sweep is dead precisely when the log
   is largest, i.e. exactly the storm state it exists to clean up after.
4. *It takes the whole tenant's sweep down with it.* `tenantStub(t).deliverabilitySweep()` throws;
   `runDeliverabilitySweepAllTenants(env)` → `{tenantsSwept: 2, errors: 2}`. The
   `runDeliverabilitySweep(ctx)` control-loop result computed at `tenant-do.ts:1155` is
   discarded, because the new `await` at `tenant-do.ts:1176` sits between it and `return result`.
5. **It pages the founder with a false platform-health alert.** `LEG_ALERT_AFTER_SWEEPS = 3`
   (`admin/watchtower-grading.ts:50`). Four consecutive `runScheduledOpsSweep(env, {mailer})`
   ticks with one >100-row tenant produced:

   > Subject: `[coldrig] Ops sweep legs: UNHEALTHY`
   > *"The ops sweep has been reporting failures on consecutive ticks — non-zero counters:
   > `deliverability.errors=3`."*

   Fifteen minutes of a single tenant hitting its documented cap turns the platform UNHEALTHY.
   This is the cry-wolf class (`the founder once got 160 alert emails`) that the Inc5 storm guard
   was built to prevent, re-armed by the fast-follow that cleans up after it.

**Verification method:** executed in the real vitest-pool-workers harness against real D1 and
real DO storage. Findings 1-4 use **no fault injection at all** — the error comes from D1 itself.
Finding 5 uses only `SandboxOpsMailer` (the repo's own alert-assertion pattern).

**Self-refutation attempted and failed:**
- *"Harness artifact?"* No — the local ceiling measured 100-accept/101-reject, which is exactly
  the production constant `ofac/sdn-list.ts` empirically confirmed against real D1. Two
  independent sources agree.
- *"Is 100 rows actually reachable?"* Proven by executing the production admission function, not
  by seeding. Requires ~20h of a tenant at the cap with distinct `(body, urgency)` — a stuck agent
  retrying with varying error text is the canonical shape, and it is the exact scenario the cap
  exists for. This is the one axis that argues for severity reduction; it does not remove the
  defect, and the consequence set includes a false founder page.
- *"Does retention bound it under 100?"* No — 24h retention × 5/hr = ~120.
- *"Is `candidates` bounded elsewhere?"* No `LIMIT`, no chunk, no cap anywhere on the read.

**Direction of fix (not authored here):** chunk the `IN` at ≤99 ids per statement (the
`sdn-list.ts` `INSERT_BATCH_SIZE` precedent), or bound the candidate read with a `LIMIT` and let
successive 5-minute ticks drain the backlog.

---

### NON-BLOCKING-1 · lens 6 (attack the design) — **RULING on the disclosed `emailed_at` residual: SHIP-ACCEPTABLE**

The builder disclosed that held-claim release reconstructs the batch by exact-match on
`emailed_at` (no batch-id column) and claimed *"worst case is a healthy row's body re-included in
a future email."* **I attacked that bound on four axes and it holds exactly as stated** — but the
comment's account of *how often* it fires is wrong, and that should be corrected in the ledger.

- **The bound is exact.** Executed: an orphan co-drained with a healthy ticketed row → sweep
  reaps the orphan, releases the healthy row (`emailed_at` → `null`), and the **next** ops email
  re-carries the already-delivered body (`nextEmailReCarriesDeliveredBody: true`).
  **Non-amplifying:** email 1 carries it, emails 2 and 3 do not — it is re-stamped on the re-ride
  and never rides again. One duplicate paragraph in one ops email, then done.
- **It cannot release a claim on a row whose ticket exists *and whose email actually went out
  before the orphan died*.** The mailer sits **after** the D1 ticket insert
  (`contact-operator.ts:82-110` try block, send at :112+), so an orphan (no ticket) means its
  email provably never sent. Releasing its batch is the *correct* action.
- **It cannot corrupt the 10-minute throttle** — I raised this as a candidate finding and then
  **refuted my own finding**. A naive fixture showed `MAX(emailed_at)` → `null`. Re-derived on the
  realistic path: the *sender* row that stamps a batch is younger than the 15-minute reap TTL, so
  it is never a candidate and its stamp survives (`maxEmailedAtBefore === maxEmailedAtAfter`,
  `nextCallEmailedImmediately: false`). **`ISOLATE_DEATH_REAP_TTL_MS` (15 min) >
  `EMAIL_THROTTLE_MS` (10 min) is a load-bearing, currently-undocumented invariant** — anything
  that lowers the reap TTL below 10 minutes opens a real throttle bypass. Worth a comment.
- **No over-delete, no cross-tenant bleed.** 40 rows, half ticketed: exactly the 20 orphans died,
  all 20 survivors ticketed, zero ticketed rows deleted. Same log-row id present in two tenants
  with a ticket in only one: tenant A reaped 1, tenant B reaped 0, no bleed.

**Correction the ledger should carry:** the builder frames this as a timestamp-collision hazard.
It is not — it is the **ordinary co-drain path** (orphan sits held → a later successful call
drains and emails it alongside a healthy held row → 15 min later the sweep reaps the orphan and
releases its co-claimants). No millisecond collision required. Separately, I confirmed same-
millisecond `emailed_at` collisions **are** reachable through the real REST path (5 parallel
`needs_human` calls → `[…264, …275, …276, …277, …277]`, 4 distinct of 5; the sequential control
gave 5 distinct). Both routes land inside the same verified bound, so the ruling stands.

### NON-BLOCKING-2 · lens 7 (regression ring) — latent second instance of the BLOCKING-1 class
**DO SqlStorage enforces the same 100-parameter ceiling as D1** (measured: 99 ids OK, 100 ids →
`too many SQL variables at offset 375`). The sweep's `revokeAdmission → releaseEmailClaim(ctx,
heldIds)` (`contact-operator-guard.ts:208-214`) has the same unbounded dynamic `IN`. **Not
independently reachable today** — `stampEmailed` only ever stamps `held.slice(0,
MAX_HELD_BODIES_PER_EMAIL)`, so ≤11 rows share any one `emailed_at`. Flagged because it is the
same shape and its safety rests entirely on a constant in a different file.

### NON-BLOCKING-3 · lens 7 — `maskTransitionPhrases` can hide a genuinely stale claim
Corpus blast radius is **exactly one verdict**: `HANDOFF.md` × 27 (`true` → `false`). Across all
28 claim surfaces × {17,19,21,24,25,26,27,28}, nothing else changed, and no retired count is
claimed anywhere even with the mask reverted. Attacks that got through on crafted text:
- **Arrow chains hide the middle number.** `"grew 17→19→21 tools"`, n=19: flagged unmasked,
  **not** flagged masked (the global regex consumes `17→19`, leaving `→21`).
- **A downward arrow hides its right-hand number.** `"rolled back 28→24 tools"`, n=24: flagged
  unmasked, not masked — here 24 is the count being *claimed*, not history.

Both need prose nobody writes in this corpus today, and the guard partly self-protects: masking
the *current* count would red the `SURFACES_THAT_STATE_THE_COUNT` presence half (fail-loud). The
4 new regression tests do pin the intended behavior, and the documented `bareCountCellRe`
immunity is correct (it requires a comma immediately after the digit, which `<td>27→28,` cannot
satisfy). Suggest widening the mask to consume full arrow *chains*, not just pairs.

### OUT-OF-SCOPE-NEW (positive) — **`main` is currently RED and this lane fixes it**
`RETIRED_TOOL_COUNTS = [17, 19, 21, 24, 25, 27]` (`site-tool-count-claims.test.ts:205`) — **27 is
retired**, and `HANDOFF.md` is byte-identical at `9d87bc3` and `HEAD`. I ran the base commit's own
test file (`git show 9d87bc3:…` into a throwaway) against the tree:

```
× HANDOFF.md never claims a retired tool count (17/19/21/24)
AssertionError: HANDOFF.md still claims retired tool count(s): 27: expected [ 27 ] to deeply equal []
      Tests  1 failed | 96 passed (97)
```

The `8fef365` matcher fix is load-bearing, not cosmetic: it repairs a genuine failing test that
the Inc5 ledger commit introduced into `main`.

---

## Attacks that FAILED (why the pass on everything else is meaningful)

| Lens | Attack | Why it held |
|---|---|---|
| 1 | Spec-vs-code line-trace of every citation in the new file | All accurate: gate doc `563-568` does say the sweep must not be recorded as closing the concurrent-twin residual; `RESERVE_REAP_TTL_MS = 15*60*1000` (`spend-ceiling.ts:55`); `REQUEST_IDEMPOTENCY_PENDING_CLAIM_TTL_MS = 10*60*1000` (`idempotency.ts:26`); the compensation try/catch is `contact-operator.ts:82-110`. |
| 1 | Does the sweep silently claim to close the concurrent-twin residual? | No. The file header states the opposite explicitly and cites r3's own correction. ROADMAP `## Open` keeps both 2026-08-11 bullets distinct. |
| 3 | Phantom closure through the REAL surface, not a unit shim | Drove `POST /messages/contact-operator` with a real bearer token. Before the sweep: `201` with `phantom_ticketMissingInD1: true` (5 orphans = whole cap leaked). After `tenantStub(t).deliverabilitySweep()`: `201`, **real D1 ticket present, `source:'agent'`**, log rows back to 1. Rate slot correctly freed, not over-freed. |
| 1 | Mixed-clock / VirtualClock reap hazard on a sandbox tenant | Held. `contactOperator` stamps `created_at` with `new RealClock().now()` (`contact-operator.ts:61`), never `ctx.clock`; the sweep passes `new RealClock().now()`. Executed on a `demo` tenant: `clock_mode: "virtual"`, `multiplier: 1440`, `created_at` within **3 ms** of real now, fresh row **not** reaped. |
| 1 | Reap-a-live-admission via the 15-min TTL | Held. The compensable window is one D1 read + one D1 write inside a DO RPC — bounded by the Worker request budget, ~2 orders of magnitude under 15 min. The builder's own "1 minute old is not reaped" test pins the near edge. A >15 min forward clock step would be needed to reap in flight; a backward step fails closed (fewer reaps). |
| 2 | Over-delete of healthy ticketed rows | Held (40-row mixed fixture, see NON-BLOCKING-1). |
| 2 | Cross-tenant bleed via a shared log-row id | Held — both the DO read and the D1 read are `tenant_id`-scoped. |
| 5 | Sibling isolation on the real all-tenants path | Held. Fault-injected the reconcile's D1 read for one tenant only: `runDeliverabilitySweepAllTenants` counted the error and the healthy sibling's orphan was still reconciled in the same run. |
| 5 | Cost/blast bound of an always-on per-tenant leg | Held-with-note. Empty-log tenant: **0** reconcile D1 reads (the `candidates.length === 0` early return). Tenant with one old ticketed row: **1** read per sweep, i.e. one extra D1 read per 5 min for 24h after any `contact_operator` use. Bounded and acceptable. |
| 5 | Ordering — does the new leg break legs that run after it? | Held. It is last; `pruneTenantMessages` and both mailbox legs complete before it. The only casualty of a throw is the discarded `result` (folded into BLOCKING-1). |
| 6 | Scope honesty | Held. `git diff --stat 9d87bc3..HEAD` = exactly the 4 claimed files. `git diff` over `contact-operator-guard.ts`, `contact-operator.ts`, `schema.ts`, `migrations/`, `packages/` = **0 lines**. Dedup logic and schemas untouched. |
| 7 | Do the 4 new matcher regression tests pin real behavior? | Held — they exercise `claimsToolCountOf` directly and cover both arrow glyphs, spacing, and the must-still-fire standalone case. |

## UNVERIFIABLE

1. **Production D1 (not just local miniflare D1) rejecting 101 params.** No prod credentials, no
   deploy from this gate. Mitigated to near-certainty: the local ceiling measured 100/101 exactly,
   matching `ofac/sdn-list.ts:13-19`'s note that this was empirically confirmed against real D1.
   *Resolved by:* `wrangler d1 execute coldstart-platform-db --remote` with a 101-parameter
   statement.
2. **A real isolate death.** Cannot be induced in-harness; orphans are seeded directly (the same
   model the builder's own tests use, and the correct one — the point is that no in-request code
   survives). The *post-death state* is faithfully reproduced; the death event is not executed.
3. **Whether the `cron_legs` alert reaches a live mailbox in production.** Proven to compose and
   fire through `SandboxOpsMailer`; real `OPS_ALERT_EMAIL` delivery not exercised. *Resolved by:*
   an ops-mailer arming check on the deployed Worker.

## NEW (out-of-scope) observations, no verdict weight

- `pnpm --filter @coldstart/platform test` picks up a **global** vitest and reds all 168 files
  with `cloudflare:test-internal`. Worth pinning in the repo's test docs — it looks like a
  catastrophic regression and is not one.
- `ISOLATE_DEATH_REAP_TTL_MS (15m) > EMAIL_THROTTLE_MS (10m)` is load-bearing for held-claim
  safety (see NON-BLOCKING-1) and is documented nowhere.
- The `MAX_HELD_BODIES_PER_EMAIL = 10` constant is what keeps `releaseEmailClaim`/`stampEmailed`
  under the DO-SQL 100-parameter ceiling. That coupling is undocumented in both files.

---

# ROUND 2 (`ec9426e`) — the fix round

**Ground ref:** `git rev-parse HEAD` = `ec9426e588e26a762b7cb0c979201bd03ec08670`.
Stack: `9d87bc3` (base) → `edb1b21` → `8fef365` → `ec9426e`. Delta = 8 files, 415 insertions.
Reviewer: same fresh-context adversary, read-only git, no fixes authored. Judged against
round 1's FIXED checklist; genuinely new observations are listed separately with no verdict
weight.

## VERDICT: **SHIP** — 0 blocking, affirmative clean pass

Round 1's BLOCKING-1 is closed, and I re-derived the closure independently at every chunk
boundary rather than accepting the builder's own boundary tests. The fix round also ran the
class sweep round 1 asked for and found **two more members**, one of which
(`engine/demo.ts`) is a genuine pre-existing production defect on `main` that had nothing to
do with this lane. Every round-1 attack that passed still passes at the new chunk seams.

## Battery, re-derived independently

| Check | Result |
|---|---|
| `apps/platform` vitest (`../../node_modules/.bin/vitest run`) | **169 files / 1589 tests passed**, exit 0 |
| root `pnpm typecheck` | exit 0 |
| root `pnpm build` | exit 0 |

Exactly the counts the brief predicted. Re-run after deleting my throwaway attack files:
still 169/1589, exit 0, worktree diff-clean except this document.

## Round-1 checklist — closure re-derived

### BLOCKING-1 (D1 100-param ceiling) — **CLOSED**

`contact-operator-reconcile.ts` now chunks at `CANDIDATE_CHUNK_SIZE = 99` (99 ids + 1
`tenant_id` = exactly the measured ceiling) and queues the chunks into one `env.DB.batch()`.
Verified independently:

- **Boundary sweep, my own fixtures, exact reap counts:** n = 98, 99, 100, 101, 197, 198, 199,
  250 → `reaped=n, left=0` for every one, zero `D1_ERROR`. Round 1's failing case (n = 100)
  now reaps 100.
- **No off-by-one at any seam** — the highest-value chunking regression. 199 candidates with 12
  ticketed rows deliberately placed at indices 0, 1, 50, 97, 98, 99, 100, 101, 150, 196, 197,
  198 (i.e. straddling both seams): **reaped exactly 187, 12 survivors, 0 healthy rows deleted,
  0 orphans survived.** The builder's own seam test only places one healthy row and relies on
  unspecified `SELECT` ordering to land it in chunk 2; mine pins both sides of both seams.
- **Cross-tenant isolation at scale** — 150 identical ids in two tenants, tickets for all of
  them in tenant B only: A reaped 150, B reaped 0, no bleed.
- **The hot-path shape change is safe** — a single-candidate tenant still reaps through
  `batch()`, and an empty-log tenant still issues **0 `prepare` calls and 0 `batch` calls**
  (the `candidates.length === 0` early return survived the refactor).

### The one genuinely new risk chunking could have introduced — **attacked and clean**

Chunking a single read into N statements creates a way for a *partial* result to be read as
"these candidates have no ticket", which would **delete healthy ticketed rows**. That is the
catastrophic direction and it does not occur:

- **D1 `batch()` never returns partial.** Probed directly with a deliberately-invalid statement
  in a 2-statement list, both orders: `THREW: D1_ERROR: no such table:
  table_that_does_not_exist` in both. It never returns a short array, an empty `results`, or a
  `success:false` entry the code would silently union as "no tickets".
- **A mid-batch failure reaps nothing and the next tick recovers fully.** 120 orphans + 30
  healthy ticketed rows spanning both chunks, failure injected at the `batch()` layer:
  the sweep threw, **150 rows remained (zero partial reap)**, and the next healthy tick reaped
  exactly 120 with all 30 healthy survivors intact and none deleted. Chunking introduced no
  torn state the unchunked version couldn't produce.

### NON-BLOCKING-1 (the `emailed_at` residual) — ruling UNCHANGED, invariant now pinned

The residual itself is untouched by this delta and my round-1 ruling stands: ship-acceptable,
bound verified exact and non-amplifying. The round-1 observation that
`ISOLATE_DEATH_REAP_TTL_MS (15m) > EMAIL_THROTTLE_MS (10m)` is a load-bearing, undocumented
invariant is now a real assertion over both imported constants
(`contact-operator-reconcile.test.ts`, "R-inc5 — the reap-vs-throttle ordering ladder"), not a
comment. That is the right shape: it fails if either constant moves.

### NON-BLOCKING-2 (`releaseEmailClaim`) — **CLOSED**

Chunked at 99 by a synchronous `for` loop. **The no-await invariant holds**: `grep -n
"await\|async"` over `contact-operator-guard.ts` returns only comment lines — zero in code.
Verified behaviorally too, with the same recipe the prior gate used to prove DO atomicity:
**100 parallel `POST /messages/contact-operator` calls → 5 × 201, 95 × 429, 5 log rows, 1 email
claim, 5 D1 tickets** against a cap of 5. Boundary probe: 98, 99, 100, 101, 198, 199, 200 ids
all released fully (`stillClaimed=0`), no partial release.

### NON-BLOCKING-3 (matcher chain hole) — **CLOSED**

`maskTransitionPhrases` widened to `/\b\d{1,3}(?:\s*(?:→|->)\s*\d{1,3})+\b/g`. Re-ran round 1's
crafted holes against old and new:

| case | unmasked | OLD mask | NEW mask |
|---|---|---|---|
| `17→19→21 tools`, n=21 | flags | **flags (r1 hole)** | does not flag |
| `17->19->21 tools`, n=21 | flags | **flags (r1 hole)** | does not flag |
| `17->19→21 tools` (mixed glyph), n=21 | flags | **flags** | does not flag |
| `17 → 19 → 21 tools` (spaced), n=21 | flags | **flags** | does not flag |
| `17→19→21→24 tools`, n=24 | flags | does not flag | does not flag |

Crucially the widening did **not** cost precision:
- **Corpus blast radius is still exactly one verdict** — `HANDOFF.md × 27` — across 28 surfaces
  × 8 numbers, identical to the old mask. No retired count (17/19/21/24/25/27) is claimed
  anywhere under the new mask.
- **A standalone claim of a number that also appears in a chain still fires:** `"grew 17→19→21
  tools; and 21 tools remain"`, n=21 → still flagged. This was the main way widening could have
  gone wrong; it did not.
- Hyphen ranges (`24-28 tools`) and dates (`2024->2028`) remain unmasked, as documented.
- **ReDoS sanity on the new nested quantifier:** 4 pathological inputs (2000-link chain, 5000
  digit+space runs, near-miss arrows, trailing arrows with no final digit) all complete in
  **0–1 ms**. No catastrophic backtracking.

The downward-arrow case (`"rolled back 28→24 tools"`) is unchanged — and it was never a *chain*
hole: the old single-pair regex masked it too. Skipping it is **defensible on the merits**, not
a dodge: it needs a tools *removal* to produce the phrase and a later re-addition to make the
number retired again, and the guard partly self-protects because masking a doc's only statement
of the current count reds the `SURFACES_THAT_STATE_THE_COUNT` presence half. See NEW-1 for the
bookkeeping caveat.

## The class sweep the fix round ran — verified complete, and it found a real bug

I ran my own inventory (`grep -rn 'map(() => "?")'` plus every `IN (${` interpolation across
`apps/platform/src` and `packages`) and it matches the builder's set exactly — **no missed
site**:

| site | status | my verification |
|---|---|---|
| `contact-operator-reconcile.ts:98` | chunked 99 | boundary-probed 98–250 |
| `contact-operator-guard.ts:232` `releaseEmailClaim` | chunked 99 | boundary-probed 98–200 |
| `admin/db.ts:115` `markSupportTicketsEmailed` | chunked **98** | arithmetic RED-proved, below |
| `demo.ts:88` `thread_labels` | chunked 99 | RED-proved through the real RPC, below |
| `contact-operator-guard.ts:241` `stampEmailed` | OUT, ≤10 | caller always passes `held.slice(0, MAX_HELD_BODIES_PER_EMAIL)` — same file, 15 lines apart |
| `demo.ts:55/66/72-75/173/176` campaign ids | OUT, ≤3 | `DemoRunInput.campaigns.max(3)` (`packages/shared/src/intents.ts:247`) |
| `demo.ts:160/165` `oooEmails` | OUT, ~50 | **measured 49** on a real 200-lead run |
| `ofac/sdn-list.ts:125` | pre-existing, chunked 16×6 | unchanged |

**`markSupportTicketsEmailed`'s 2-fixed-param arithmetic is right, and 98 is required, not
cautious.** I hand-built the pre-fix statement with 99 ids (2 + 99 = 101 params):
`THREW: D1_ERROR: too many SQL variables at offset 370`. So a 99-chunk would have been a bug and
98 is exactly correct. Functional probe at 97/98/99/100/195/196/197/200 ids: every id stamped,
cumulative counts exact (97 → 195 → 294 → 394 → 589 → 785 → 982 → 1182), no throw at any size.

**`engine/demo.ts` was a genuine pre-existing production defect.** Driven through the real
`TenantDO.demoRun()` RPC: a 200-lead run produces **200 distinct thread ids**, and
`resetPriorDemoState`'s pre-fix statement over that exact list
`THREW: too many SQL variables at offset 346`. So before this commit, the next `/demo/run` for
any tenant whose prior run used more than ~100 leads threw. Post-fix I confirmed the cleanup
does not merely avoid throwing but **actually completes**: `thread_labels` went from 49 rows to
**0**, with zero survivors in either chunk half, and demo semantics are unchanged (second run
returned normally, `sent=1` for its 1 lead). The `ooo` OUT-ruling is measured, not asserted: 49
labels for 200 leads, consistent with `EXTRA_KIND_CYCLE`'s 4-cycle (`demo-seed.ts:40`).

## The replaced fault injection — fails via the INTENDED mechanism

The builder disclosed that the old mock reached `batch()` and threw an unrelated error while the
same assertions still passed. **Both halves of that disclosure are accurate**, verified by
replicating each shape:

- New WeakSet/`batch()`-layer intercept: fired (`batchInterceptFired: true`), and the error
  reaching the caller is exactly `"simulated transient D1 read failure"`.
- Old stub shape (swapping `.bind()`'s return for an `{all}` object): produces
  `D1_ERROR: Failed to parse body as JSON, got: ZodError … at D1DatabaseObject.queryExecute` —
  an unrelated miniflare parse error, confirming the old test was a false green.

Self-caught false-greens reported honestly are worth saying out loud; this one was.

## Round-1 attacks re-run at the new seams — all still hold

Phantom closure end-to-end through the real REST route (before: `201` with the ticket absent
from D1; after `deliverabilitySweep()`: `201` with a real `source='agent'` D1 ticket) ·
over-delete across mixed ticketed/orphan sets at every chunk seam · cross-tenant bleed at 150
rows · sibling isolation under `batch()`-layer fault injection · empty-log tenants still cost
zero D1 work · DO-atomic 5/hr cap under a 100-way parallel burst.

## NEW (out-of-scope) observations — no verdict weight

1. **The skipped downward-arrow case is not actually ledgered.** The brief describes it as
   "deliberately SKIPPED for the ledger", but as of `ec9426e` the only record of it anywhere in
   the repo is round 1 of *this* document (line 161). `ROADMAP.md` is not in the delta. The skip
   is defensible on the merits; the bookkeeping half of it has not happened yet.
2. **`markSupportTicketsEmailed`'s multi-chunk `batch()` branch is unreachable in production.**
   Its only caller passes `[ticketId, ...heldIds]`, bounded to ≤11 by
   `MAX_HELD_BODIES_PER_EMAIL`. Correct defense-in-depth, but the branch is exercised only by
   tests — worth knowing if it is ever cited as "proven in production".
3. **Two different single-chunk conventions.** `markSupportTicketsEmailed` branches to `.run()`
   for one statement; `reconcileOrphanedAdmissions` always uses `batch()`. Cosmetic, but it
   means the reconcile hot path (one chunk) now runs inside an implicit transaction where it
   previously used `.all()`.
4. **`releaseEmailClaim`'s chunk loop is now N statements where it was one.** Synchronous, so no
   interleaving, but a mid-loop failure would leave a partial release. Unreachable today (≤10
   ids); noted because the seam is new.

## UNVERIFIABLE (round 2)

1. **Production D1 (vs local miniflare) `batch()` failure semantics.** My partial-result attack
   was run against local D1, which threw cleanly in both orderings. Cloudflare documents batch
   as transactional, which agrees, but I could not drive the real service. *Resolved by:* a
   `wrangler d1 execute --remote` batch containing one invalid statement.
2. **Whether the pre-fix `demo.ts` defect was a permanent wedge or self-healing.** The pre-fix
   statement demonstrably throws, so the next `/demo/run` failed; whether the DO rolled back the
   preceding `DELETE campaigns` (making it a permanent wedge) or committed it (making it
   transient) I did not determine. Does not affect the verdict — the fix is correct either way.
3. **The static ordering-ladder assertion under mutation.** Confirmed by inspection to be a real
   comparison of two genuinely imported constants; I did not mutate the source to watch it red,
   since that would mean editing a shared live worktree.
