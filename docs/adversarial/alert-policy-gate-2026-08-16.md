# Alert debounce+backoff wave — adversarial gate record (2026-08-16)

**Target:** branch `feat/alert-debounce-backoff-2026-08-16` HEAD `8742830` (merge-base `6b98625`).
**Gate:** fresh-context adversary (opus, xhigh), scratch-clone execution, 9 named attacks + 2 spec-conflict rulings + mutation battery + 60k-timeline property fuzz.
**Verdict: SHIP — 0 blocking, 6 non-blocking notes.**
**Provenance:** the gate agent's verdict was delivered as an agent message to the orchestrating session (the agent's own session survived a compaction of the orchestrator); this file freezes that verdict verbatim below, unedited. Frozen by the orchestrator on 2026-08-16.

---

# VERDICT: SHIP (6 NON-BLOCKING notes, 0 blocking)

Grounded on `8742830` in a scratch clone (`.../scratchpad/gate-clone`, `git clone` + `checkout 8742830`, node_modules symlinked). Merge-base `6b98625`. Live `~/dev/coldstart` was read-only throughout and is unchanged since review start (`4299bfa` on main, same single untracked dir at start and end). I attacked all 9 named lines plus the design itself; nothing I could prove reached blocking. Details below, most severe first.

## Battery and build

| run | result |
|---|---|
| full battery @ `8742830` | 176 files (175 pass / 1 fail), **1687 tests, 1686 pass / 1 fail**, 499s, exit≠0 |
| the one failure | `test/site-tool-count-claims.test.ts > HANDOFF.md states the CURRENT tool count somewhere` |
| same file @ merge-base `6b98625` | 1 failed / 102 passed — **pre-existence confirmed** |
| same file @ main `4299bfa` | 1 failed / 102 passed — see NEW below |
| `npx tsc --noEmit -p tsconfig.json` @ HEAD | exit 0 |
| `npx wrangler deploy --dry-run` @ HEAD | exit 0 |

## Mutation battery (subset of 11 watchtower-relevant files, baseline 81/81 pass)

| mutation | outcome |
|---|---|
| `WATCHTOWER_CONFIRM_OBSERVATIONS` 2→1 | KILLED — 24 failed across 8 files |
| `policyFor(cron_sweep)` → `DEBOUNCED_ALERT_POLICY` | **KILLED — 6 failed, two of them in the UNCHANGED `watchtower-deadman.test.ts`** |
| drop the `mailbox_*` one-shot exemption | **KILLED — 3 failed, one in the UNCHANGED `mailbox-rebuy-guard.test.ts`** |
| drop the `cron_legs` exemption | KILLED — 7 failed, four in the UNCHANGED `sweep-signals` NB-2 block |
| `WATCHTOWER_STEADY_REALERT_MS` 24h→6h | KILLED — 4 failed |
| recovery gate `alertCount > 0` → `>= 0` | KILLED — 5 failed |
| `DEAD_MAN_ALERT_POLICY.steadyRealertMs` → 24h | KILLED — 1 failed |
| `LEGACY_EPISODE_ALERT_COUNT` 2→0 | **SURVIVED — 81/81 still pass** (Finding 1) |

7 of 8 killed. I re-verified each mutation was still applied before believing a green run.

## The two spec-conflict resolutions

**1. One-shot `mailbox_provisioning:` / `mailbox_rebuy:` exemption — UPHELD.** I reproduced the builder's proof independently: removing the exemption reds `mailbox-rebuy-guard.test.ts > name the address and the situation without naming the provider, and do not storm`, a test this wave never touched. I then enumerated every producer that reaches the choke points, working outward from the choke point (`grep -rn "healthy: false" src/` plus the two windowed producers), and classified all thirteen: re-sampled every 5-min tick — `d1`, `do_storage`, `engine`, `failure_signals` (1h trailing window), `tenant_do_wedged:`, `cred_push_aging:`, `send_starved:`, `domain_dns_aging:` (a persistent `dns_status != 'ready'` query, so a gave-up domain keeps returning), `warmup_cancel_gave_up` (24h digest window, ~288 observations); pre-damped — `cron_legs`; one-shot — the two mailbox prefixes; hard-exempt — `cron_sweep`. **No un-exempted one-shot producer exists.** The exemption is exactly as narrow as claimed.

**2. `cron_legs` already 3-tick damped — UPHELD.** The damping is `LEG_ALERT_AFTER_SWEEPS = 3` (`src/admin/watchtower-grading.ts:50`) applied via `gradeSweepStreak` at `src/admin/sweep-signals.ts:96`. Worst case from onset: bad ticks at 5/10/15 min, grade flips false at 15 min, `IMMEDIATE_ALERT_POLICY` pages there — identical to before. A debounce on top would page at 20 min, breaching the ceiling. Removing the exemption reds 7 tests including four pre-existing ones.

## Guardrail timing, every check class

Worst-case wall-clock from onset to first page at the `*/5` cron:

- Debounced classes (`d1`, `do_storage`, `engine`, `failure_signals`, `tenant_do_wedged:`, `cred_push_aging:`, `send_starved:`, `domain_dns_aging:`, `warmup_cancel_gave_up`): **under 5 min before → under 10 min at HEAD**, 15 min if one cron tick is missed. Inside the guardrail; matches the claim at `watchtower-policy.ts:51-53`.
- `cron_legs`: 15 min before and after. Unchanged.
- `cron_sweep`: `SWEEP_STALE_MS` 15 min plus up to one 5-min alarm period, before and after. `watchtower-grading.ts` is not in the diff at all, so both constants are byte-identical.
- One-shot mailbox checks: immediate, before and after.

The D1-outage path is genuinely exercised end to end: `watchtower-d1-outage.test.ts:83-103` drives the real `runScheduledOpsSweep` against a dead DB for two ticks and asserts zero emails on the first, exactly one on the second. Non-vacuous.

I also property-fuzzed the shipped policy directly — 60,000 randomized 120-step observation timelines across all three policies (≈7.2M decisions) checking three invariants: an episode that reaches `confirmAfterObservations` always emails; an episode that emailed always emits `recovered`; no two emails inside the minimum gap. **Zero violations.**

## Findings (all NON-BLOCKING)

**1 · lens 5 · No regression guard on the deploy-day legacy reconstruction.** `src/admin/watchtower-policy.ts:141` (`LEGACY_EPISODE_ALERT_COUNT`) and `:146-156` (`normalizeAlertState`), plus the backfill at `migrations/0018_watchtower_debounce.sql:25-31`, are untested — `grep` for `alert_count|unhealthy_obs|normalizeAlertState|LEGACY_EPISODE` across `test/` returns nothing, and the mutation to 0 survives all 1687 tests. Root cause: `test/setup.ts:50` applies 0018 to an empty D1, so the `UPDATE` is a no-op. The behaviour is nonetheless **correct** — I wrote and ran a 7-case probe (`test/zz-adversary-deployday.test.ts`, since removed, 7/7 pass) that inserts a row in the exact pre-0018 shape, runs the migration's `UPDATE` verbatim, and drives 30h of live cadence: a stuck `domain_dns_aging` check with a 1h-old `last_alert_ts` emits **nothing for 23h**, then exactly one email — i.e. 24h after the last old-code alert, no deploy-day re-announce. A control arm that skips the backfill re-announces two sweeps after deploy and restarts the 6h ladder, so the backfill is load-bearing rather than decorative. The DO-side reconstruction matches: a legacy `d1_alert_state` stays silent for 22h and re-alerts at 23h; a legacy healthy value debounces a new outage normally; a legacy `dead_man_alert_state` keeps the 6h cadence. Recommendation: land that probe (or an equivalent) so a future edit to the credit constant cannot silently reopen deploy-day duplicates.

**2 · lens 8 · The `/admin/ops/checks` no-writes byte-identity guard is now partial.** `test/admin-ops-checks.test.ts:145-156` still snapshots only `check_name, status, since_ts, last_alert_ts, last_detail, updated_at` — the two new columns sit outside its comparison. No defect follows (the route reads through `readAllCheckRows`, a pure `SELECT` at `src/admin/watchtower.ts:466-467`, and the response shape is genuinely unchanged), but the guard no longer spans the row it claims to.

**3 · lens 6 · The watch channel and the inbox can now disagree.** `/admin/ops/checks` serves `status: unhealthy` with `lastAlertTs: null` for a check the founder was never emailed about. This is longer-lived than "one sweep" in one case: `failure_signals` sitting in `gradeFailureSignals`'s dead band (1-2 failed sends, grade `null` = HOLD, result omitted) leaves a pending row in place indefinitely. `HANDOFF.md:23` describes leg 3 polling `?unhealthy=1` 2-hourly and handling NEW issues under the standing grant, so the watch can escalate a flap the debounce deliberately suppressed. The watch's known-unhealthy baseline comparison is name-based and both the names and the response shape are unchanged, so **that** logic is unaffected. The transient is pinned by test (`admin-ops-checks.test.ts:89-94`) but **not** by the route's doc comment at `src/routes/admin-ops.ts:44-66`, which is where a consumer would look.

**4 · lens 1 · Stale cross-reference in the SDN sibling.** `src/ofac/sdn-alert.ts:31-34` says its cooldown "mirrors `WATCHTOWER_COOLDOWN_MS` exactly (`admin/watchtower.ts`)". The constant moved to `admin/watchtower-policy.ts:39`, and the mirror now holds only for the first rung — the watchtower's steady cadence is 24h while SDN stays 6h forever. Comment drift only; SDN is correctly out of the diff.

**5 · lens 5 · The completeness meta-guard's reach is narrower than its promise.** `test/watchtower-policy.test.ts:160-165` parses `CHECK_LABELS` keys plus `^export const …_CHECK = "…"` lines. A future check named by a bare string literal inside a producer escapes it entirely — `warmup_cancel_gave_up` is exactly that shape at `sweep-signals.ts:118` and only gets caught because it also happens to be a `CHECK_LABELS` key.

**6 · NIT ·** `normalizeAlertState` credits `unhealthyObs: 1` to a legacy unhealthy row (`watchtower-policy.ts:153`) while the SQL backfill writes `unhealthy_obs = 2`. Behaviourally inert — PHASE 2 never compares that counter to `confirmAfterObservations` — but the divergence reads as meaningful and deserves a line saying it isn't.

## Attacks that failed

- **Deletion-not-delay hunt beyond the two exemptions** — enumerated all 13 producers from the choke point outward and classified each by observation cadence. Every debounced check is re-sampled or windowed. It held. A dead-band HOLD (`gradeFailureSignals`/`gradeStreak` returning `null`) omits the result rather than reporting healthy, so it does **not** reset the consecutive counter — that is what keeps a windowed check from starving.
- **Dead-man byte-identity** — mutation forced it onto the debounced policy: two unchanged tests in `watchtower-deadman.test.ts` red. Second mutation gave it only the 24h steady rung: the policy test red. `SWEEP_STALE_MS`/`DEAD_MAN_INTERVAL_MS` untouched (`watchtower-grading.ts` absent from the diff). The policy argument is required by the type, and both DO call sites now pass a check name (`watchtower-do.ts:76`, `:145`) rather than inheriting.
- **My strongest candidate blocker, refuted.** I built an env where D1 reads succeed but `INSERT INTO watchtower_state` throws (using the repo's own `dbFailingStatements` helper, whose comment says every commit path must survive that shape). Driving `reconcileAlerts` alone for 24 ticks: **24 emails at merge-base, 0 at HEAD** — a textbook "debounce silences a real outage". Then I drove the real cron entry point, `runScheduledOpsSweep`, for 12 ticks at both revisions: **identical output, 10 × `[coldrig] Ops sweep legs: UNHEALTHY` starting at tick 3.** At both revisions the first check in the batch aborts the loop on its upsert, so per-check alerting was already dead pre-wave; and the pre-damped, debounce-exempt `cron_legs` backstops at 15 min. No regression, and the exemption is what makes the backstop work.
- **Lens 7, the refactor commit.** `bd1cfd7` ("split decideAlert into its two episode phases") sits on top of the behavioural commit and changes the dispatch predicate from `alertCount === 0` to `episode !== null && alertCount > 0`. Rather than read it, I compiled both revisions with esbuild and differentially fuzzed: 9,216 exhaustive single-step cases over the full state cross-product plus 320,000 state-carrying timeline steps. **Zero divergences.** (The only reachable difference would need a negative `alertCount`, which no path produces.)
- **Test honesty, line by line.** Exactly **4** removed assertion lines across the 7 touched files — matching the builder's claim. All verified: `domainCheck.lastAlertTs` T0+2000→T0+3000 (moved to the confirming sweep), `row.last_alert_ts` T0→T0+SWEEP (moved), `row.last_alert_ts` T0+COOLDOWN→confirmedAt+COOLDOWN (moved), and `again[0].action` "alerted"→"pending" **plus** a new assertion that the following sweep is "alerted" — strengthened, not loosened. 61 added assertion lines. I also read the one test whose diff context was truncated (`watchtower.test.ts` multi-check) in full: every downstream assertion intact, a pending pre-step prepended.
- **Recovery semantics.** A confirmed alert still recovers exactly once; an unemailed flap emits nothing in either direction; the debounce re-arms after recovery. Pinned by test and confirmed by the fuzz invariant. The recovery duration line stays honest because `sinceTs` tracks the *first* bad observation, not the confirming one.
- **`/admin/ops/checks` contract.** `readAllCheckRows`'s SELECT names its columns explicitly, so neither new column reaches the response. Nothing branches on `AlertAction`, so the new `pending` value cannot break an exhaustive switch (`alertEmailFor` has a `default: return null`), and `reportCheck`'s callers in `mailbox-acquisition.ts` discard the outcome.
- **SDN sibling.** `git diff --stat 6b98625 8742830 -- apps/platform/src/ofac/` is empty. It carries its own `SDN_ALERT_COOLDOWN_MS` and never imported the moved constant, so the file move could not have touched it.
- **Deploy plumbing.** `apps/platform/package.json:8` runs `wrangler d1 migrations apply --remote && wrangler deploy` — migration before deploy, correct ordering. 0018 follows 0017 with no numbering gap and is registered in `test/setup.ts:21,50`. Build and typecheck clean.

## UNVERIFIABLE

- **The remote D1's actual pre-deploy state.** No live HTTP or wrangler per the brief. My backfill probe assumes each stuck row's `last_alert_ts` is at most ~6h old, which follows from the old 6h ladder for a re-observed check — but I did not read the real rows. Resolve with a read-only `wrangler d1 execute coldstart-platform-db --remote --command "SELECT check_name, status, last_alert_ts FROM watchtower_state WHERE status='unhealthy'"` **before** the migration apply. If any stuck row's `last_alert_ts` is more than 24h old, the backfill lands it on an immediate re-alert on the first post-deploy sweep — one email, not a storm, and not blocking, but worth knowing before the founder sees it.
- **The dead-man alarm's real production latency.** I verified the constants are untouched and the decision logic is unchanged; actual DO alarm scheduler jitter is unmeasurable here.

## NEW (out of scope, no verdict weight)

**CI is red on `main`, not just on this branch.** `site-tool-count-claims.test.ts` fails identically at `6b98625`, at `8742830`, and at main `4299bfa` — it wants `HANDOFF.md` to state the current tool count (28) near "tool"/"intent" and it doesn't. `.github/workflows/ci.yml` runs `npm test` across workspaces, so a PR for this wave will show red for a reason unrelated to it, and merging won't clear it. Worth a one-line HANDOFF.md fix before the same-day deploy so the red doesn't get normalized.
