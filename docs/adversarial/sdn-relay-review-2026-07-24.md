# SDN droplet-relay ingest — adversarial review (2026-07-24)

- **Reviewed ref:** branch `worktree-sdn-relay-20260724` @ `966793b` (base/merge-base `71fb17f`). Reviewed
  EXACTLY this commit; the follow-up throttle commit is out of scope.
- **Scope:** `POST /admin/sdn/ingest` + `SDN_INGEST_TOKEN` auth carve-out, `ingestSdnCsv` + `MIN_SDN_ENTRIES`
  floor, shared `sdn-alert.ts`, the D1 `INSERT_BATCH_SIZE` 100→16 batch fix, `tools/sdn-relay/`, ACTIVATION
  Gate-4 runbook.
- **Method:** read every changed file + the pre-existing read path (screening.ts) and D1 merge internals; ran
  the full platform suite in the worktree (**787 passed / 111 files, exit 0** — the brief's "778" undercounts;
  all green) + `tsc` was green per the builder's ×5 claim (suite green in-worktree). No live Treasury/Keychain
  calls.

## VERDICT: SHIP

The build's own new surfaces are sound: the auth carve-out is correctly scoped and fails closed; the floor
guard is a real RED-proof; the shadow-swap holds its invariant even under a partial `.batch()`; the alert
throttle + once-daily guard behave. No finding is a defect INTRODUCED by `966793b` that blocks a DARK merge
(SDN_INGEST_TOKEN unset by default → no ingest → no swaps → screening stays fail-closed, so nothing new is
reachable in prod until Gate-4 arming). Findings 1–2 are prerequisites to carry into arming, not merge blockers.

---

## Findings

### 1. NON-BLOCKING (fix before Gate-4 arming) — screening read-path TOCTOU fails OPEN, newly reachable because this build makes swaps actually happen

`screenTenant` reads the active version (`screening.ts:72`) and then, in a SEPARATE await, reads that version's
entries (`screening.ts:125`). `swapInSdnList`'s post-flip cleanup (`sdn-list.ts:156`,
`DELETE FROM sdn_entries WHERE list_version != <new>`) deletes the old version's rows. A screen that reads
pointer=V1 just before a concurrent swap flips to V2 and deletes V1's rows then reads V1 entries → gets `[]` →
`matchAgainstSdn(candidates, [])` returns no matches → status **`clear`** (`screening.ts:128`). This is the
opposite of the null-version case (`:107`), which correctly fails CLOSED to `review`. So a sanctioned tenant
can be cleared during the race.

**Why this build matters:** before `966793b`, swaps essentially never succeeded in prod (Treasury 525s every
Worker fetch → `maybeRefreshSdnList` never reaches a successful `swapInSdnList` → `active_version` stays null →
screening always fails closed at `:107`, and `:125` is UNREACHABLE). The relay is what makes a list load and a
daily swap run — transitioning this latent fail-open from unreachable to reachable. It stays unreachable while
the feature is dark (token unset), which is why this is a Gate-4-arming prerequisite, not a dark-merge blocker.

**Fix (one line, cheap, strictly correct):** a real active list is always ≥ `MIN_SDN_ENTRIES` (5000), so an
empty (or below-floor) entry set for a NON-null active version is always an anomaly (race/corruption), never
legitimate — treat it like `:107` and fail CLOSED to `review`. Failure scenario proven by trace, not run (no
concurrency harness); the read path is pre-existing code this diff does not touch, but the diff is the enabling
condition.

### 2. NON-BLOCKING — no staleness/monotonicity guard on ingest; the floor comment overstates stolen-token protection

`ingestSdnCsv` accepts any parse-valid CSV with ≥5000 entries and swaps it in with `listVersion =
sdn-relay-${nowMs}` and `fetched_at = nowMs` — there is NO check that the incoming list is newer than / different
from the active one. Consequences with a stolen (or replayed) token: (a) a naive REPLAY of an old genuine list
is accepted and, worse, sets `fetched_at = now`, which then SUPPRESSES the direct-refresh for 24h
(`sdn-refresh.ts:45`) — the stale list sticks; (b) a doctored ~17k list with targeted names REMOVED (still
≥5000) swaps in and silently drops those names from screening. The code comment "MIN_SDN_ENTRIES makes
stolen-token abuse a no-op" (`sdn-ingest.ts:15`, echoed in `env.ts`) OVERSTATES: only tiny-forgery abuse is a
no-op; staleness and targeted-removal are not. The canonical honesty statement
(`docs/research/ofac-v1-honesty-statement-2026-07-23.md`) is matcher-focused and predates the relay — it does
not cover this ingest residual. The targeted-removal residual is FUNDAMENTAL (unavoidable without a signed feed;
Treasury doesn't sign the CSV), so token secrecy is legitimately the primary control and the runbook handles the
token well — but the build should (a) add a cheap monotonicity guard (reject a `publishedDate`/`fetchedAt`
older-than-current to stop naive replay) and (b) correct the comment + note the residual in the honesty statement.

### 3. NON-BLOCKING — 30 MB body cap is content-length-advisory, bypassable, backstopped only by the platform limit

`admin-sdn-ingest.ts:37` caps on `Number(c.req.header("content-length"))`; a request with NO content-length
(chunked) yields `NaN` → `Number.isFinite(NaN)` false → the cap is skipped and `c.req.text()` materializes the
full body, bounded only by the Workers platform request limit (~100 MB). This is the SAME pattern every
body-reading route here uses (`validate.ts`), so it is not a new weakness; and it is token-gated and fails safe
(a giant body → 500/OOM, never a swap — the floor still guards the list). Parsing the real ~17 MB feed is well
within budget. Worth hardening platform-wide, not here.

## Attacks that failed (why the PASS is meaningful)

- **Auth carve-out scoping (prior "unscoped `*` 401'd everything" scar).** The carve-out lives INSIDE the one
  shared `requireAdminAuth` gate (`require-admin-auth.ts:35`), keyed on `c.req.path === "/admin/sdn/ingest"`
  (exact), mounted via `admin.use("/admin/*", requireAdminAuth)` (`index.ts:77`, scoped to `/admin/*`, not
  `*`). It only ADDS an acceptance path; the ADMIN_TOKEN branch is unchanged, so no other `/admin/*` route
  regresses (tested: SDN token → 401 on `/admin/screening/reviews`; ADMIN_TOKEN → 200 there). An unset
  SDN_INGEST_TOKEN falls through to the 401 (ADMIN_TOKEN-only, never open). Hono is constructed with no
  `strict:false`, so `/admin/sdn/ingest/` (trailing slash) and case variants neither equal the carve-out path
  nor match the route → fail closed; query strings are excluded from `c.req.path` (same endpoint). A method
  variant (GET with the SDN token) passes the carve-out but hits no handler → 404, no data. Test tokens are
  distinct (`ADMIN`≠`SDN`≠`PEPPER`). Held.
- **Forged TINY list.** `MIN_SDN_ENTRIES=5000` rejects a 4-entry CSV to `below-floor` (422), keeps the prior
  list; the RED-proof asserts `active_version`/`entry_count` unchanged (revert the floor → the 4-entry list
  swaps in → assertion fails). Held for the tiny case (see finding 2 for the large-doctored case).
- **D1 batch atomicity vs the shadow-swap invariant.** The `.batch()` is wrapped in a try that, on ANY throw,
  best-effort deletes the partial version and rethrows WITHOUT touching the active pointer (`sdn-list.ts:135`).
  The pointer flip (`:143`) is a SEPARATE statement OUTSIDE the try, so it runs ONLY after a fully-resolved
  batch. Even under the brief's "D1 splits into sub-batches, one commits, next fails" hypothetical, the failed
  statement rejects `.batch()` → catch → no flip → the matcher keeps reading the OLD complete version, and the
  orphaned partial rows are never read (reads filter `WHERE list_version = <active>`) and are cleaned by the
  next swap. Correctness does not depend on batch atomicity. Held.
- **Param ceiling arithmetic.** 16 rows × 6 columns = 96 bound params/statement < D1's documented 100-param
  ceiling. The old `INSERT_BATCH_SIZE=100` → 600 params/statement, above the ceiling — the fix is directionally
  correct. Held.
- **Alert-storm class fix + refresh/ingest shared state.** Both paths funnel through `reconcileSdnAlert`
  (one `sdn_alert_state` row, 6h cooldown). The feared thrash (always-failing direct refresh vs
  always-succeeding daily ingest toggling one streak) is prevented by the once-daily guard: a successful ingest
  sets `fetched_at=now`, so `maybeRefreshSdnList` returns `"fresh"` and does NOT attempt/alert for ~24h
  (`sdn-refresh.ts:45`). 10 consecutive failing ingests → 1 email (tested). Held (see NEW for the residual
  boundary race).
- **`sdn-refresh.ts` "byte-identical" claim.** The parse/swap path is unchanged; the alert was intentionally
  swapped from the old unthrottled `alertSdnRefreshFailure` to throttled `reconcileSdnAlert` (+ a recovery
  email on success) — the class fix, not a regression. The extracted `alertSdnRefreshFailure` dead code is
  correctly deleted. Held.
- **Env wiring / hermetic + spend-armed guards.** `SDN_INGEST_TOKEN` is `?`-optional, categorized in
  `KNOWN_NON_SPEND_ARMING` (so the R3-1 guard passes), allowlisted with a DISTINCT test value in
  `hermetic-env.ts`, and not `// spend-arming` (so the spend-arming pin is unaffected). Held.

## UNVERIFIABLE (no live D1 / Treasury permitted)

- **The 100-param D1 ceiling and thus the fix's NECESSITY are not provable in the suite.** miniflare's D1
  emulation uses SQLite's ~999-param limit, so the OLD 100-row (600-param) code would ALSO pass the miniflare
  tests — the suite proves the NEW code produces a correct list at 5001 entries (~313 statements in one batch)
  but does NOT prove the old code was broken nor that the fix was needed. The 100-param limit IS Cloudflare-
  documented, so the fix is sound; a live-D1 smoke at 17k is what fully closes it.
- **The ~1063-statement single `.batch()` at 17k scale** is builder-claimed-empirical ("1100+"); not
  reproducible here. Verify at arming.
- **Feed-format match.** `push-sdn.sh` fetches `https://sanctionslistservice.ofac.treas.gov/api/
  publicationpreview/exports/sdn.csv`, a DIFFERENT host/path than the Worker's fallback
  `www.treasury.gov/ofac/downloads/sdn.csv`. If that export's column layout differs from what `parseSdnCsv`
  (validated only against fixtures) expects, the real ingest fails LOUD (safe — keeps prior, over-blocks) and
  is caught by ACTIVATION step 5. Confirm the real feed parses at arming.

## NEW (out of scope, no verdict weight)

- **Refresh/ingest boundary race (alerting noise).** `REFRESH_INTERVAL_MS` (24h) equals the daily ingest
  cadence, so `fetched_at` goes stale right around the next daily push; on a day the ingest completes slowly
  (after a 5-min refresh tick fires past the 24h mark), the direct refresh attempts + fails once → 1 spurious
  alert + 1 recovery. Minor noise, not correctness. Mitigation: set the refresh guard interval slightly LONGER
  than the ingest cadence (e.g. 25h), or skip the direct refresh once the relay is the source of truth.
- **Method over-grant.** The carve-out authorizes the SDN token for ANY method on `/admin/sdn/ingest`, not just
  POST; only a POST handler exists today, so a future GET/PUT handler there would inherit the token. Pin the
  carve-out to POST if another verb is ever added.
- **Runbook token hygiene.** `/root/sdn-relay.env` is written via a heredoc (default umask → typically 0644);
  `chmod 600` it. `curl -H "Authorization: Bearer $TOKEN"` is visible in `ps` while running; `openssl`/`echo`
  put the secret in shell history. All low-risk on a single-root droplet, worth tightening.

---

## Throttle delta — commit `7084081` (stacked on `966793b`)

**Delta scope:** the alert-storm fix only — `reconcileSdnAlert()` state machine + singleton `sdn_alert_state`
(migration 0013, mirrors `watchtower_state`), both refresh and ingest funneling through one shared streak, at
most one email per 6h + one recovery email. The delta itself is CLEAN (no findings). Note: the worktree HEAD
advanced from `966793b` to `7084081` DURING my core review, so my core-review reads of `sdn-alert.ts` /
`sdn-refresh.ts` / `sdn-ingest.ts` were already the post-throttle versions — the core "alert throttle held"
conclusions apply to the final merged artifact. Re-ran the SDN alert/refresh/ingest + `watchtower` test files
together: **4 files / 28 tests pass**, no singleton-state cross-contamination.

### Delta attacks that held

- **Edge transitions (state machine).** `failure → success → failure` same day: the success resets
  `failure_streak → 0` and `last_alert_ts → null`, so the second failure hits the `failure_streak === 0` branch
  and re-alerts IMMEDIATELY — it does NOT eat the first streak's cooldown (tested,
  `ofac-sdn-alert.test.ts:100`). `success` with no prior streak → `"healthy"`, no email (tested). Cooldown
  boundary is exact: `T0+COOLDOWN-1 → suppressed`, `T0+COOLDOWN → realerted` (tested `:66`). The RED-proof (20
  failing attempts within cooldown → 1 email, `failure_streak = 21`) reproduces the founder's 160-storm shape
  and fails on the old unthrottled `alertSdnListFailure`. Held.
- **Shared-state semantics.** The single `sdn_alert_state` row answers "is the SDN list loading (via EITHER
  path)?" A recovery via the direct refresh while the relay push is broken is CORRECT, not masking: if the
  refresh loaded a fresh list, screening HAS a fresh list, so there is no incident to alert on. Conversely a
  successful ingest sets `fetched_at`, so the once-daily guard skips the direct refresh for 24h — no
  cross-path thrash. Held.
- **Migration 0013 composition.** `setup.ts` gained BOTH the `import migration13Sql` AND the
  `...statementsOf(migration13Sql)` entry in the applied union (verified in the diff); 0013 is an independent
  singleton table (no FK deps), applied after 0012. The full suite (787) and the 4-file co-run pass. Held.
- **Concurrency on the state row.** `reconcileSdnAlert` is a read-modify-write (read state → decide → UPSERT)
  with no transaction/CAS, so two concurrent failing attempts could send 2 emails or miscount the streak by
  one. Blast radius is a rare duplicate email — it never touches the list or screening — and it MIRRORS
  `admin/watchtower.ts`'s already-accepted non-atomic pattern. Held (accepted residual, consistent with the
  mirror).

### Delta operational note (must reach the founder)

- **Subject lines changed.** Old: `[coldrig] SDN list refresh failed …` / `SDN relay ingest failed (malformed)
  …`. New: `[coldrig] SDN list load failing — kept prior good list` / `… (still) …` / `SDN list load
  RECOVERED`. No code/test consumer references the old subjects (grep: the only "SDN list refresh failed"
  match is a `console.error` LOG line, not an email subject or filter). But the founder was told to Gmail-filter
  on "SDN list refresh failed" — that filter will STOP matching. Tell them to refilter on **"SDN list load"**
  (catches both the failing and RECOVERED subjects).

---

## COMBINED VERDICT (966793b + 7084081): SHIP-AFTER-FIXES

The throttle delta is clean and the relay/ingest code is sound; **merge + deploy DARK is safe as-is** (with
`SDN_INGEST_TOKEN` unset there are no ingests → no swaps → screening stays fail-closed, so nothing new is
reachable). But this branch's SHIP is defined to also **ARM the ingest**, and arming makes the daily swap live —
which exposes **finding 1 (the screening read-path TOCTOU fail-open)** as a *sticky* compliance fail-open: the
gap between `screening.ts:72` (version read) and `:125` (entries read) spans a profile query AND an async
contact-email lookup (a wider window than two adjacent awaits), and a false `clear` is tagged with the real
`listVersion`, so the recovery sweep (which only re-screens the `LIST_UNAVAILABLE_VERSION` sentinel) never
re-evaluates it — a sanctioned tenant cleared during the race stays cleared.

**Required before the ARM step (one line, in `screening.ts` — a file this branch does not currently touch):**
treat an empty (or below-`MIN_SDN_ENTRIES`) entry set for a NON-null active version as fail-CLOSED to `review`,
exactly like the null-version guard at `:107` (a real active list is always ≥5000, so empty is always an
anomaly). Land that, then arm. **Recommended, not blocking:** the monotonicity/staleness guard + the overstated
floor comment (finding 2), and the founder Gmail-filter update above.
