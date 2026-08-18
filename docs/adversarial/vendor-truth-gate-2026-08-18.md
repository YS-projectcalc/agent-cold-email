# Vendor-truth wave — fresh-context adversary gate (classes A–F remediation)

> Re-emitted after worktree reap destroyed the original; content unchanged from the gate as authored at `d4daca3`.

**Frozen record.** Ref `d4daca3afc77b661af3468b4ed7e17cfa40a631f` (merge of lane 1 `37f10f4` + lane 2 `4ebffd9` on base `8c87c79`), branch `feat/vendor-truth-2026-08-18`, worktree `.claude/worktrees/vendortruth`. Verified at pass start AND end; read-only git throughout. Date 2026-08-18.
Scope graded = `git diff 8c87c79 HEAD` (61 files, +3854/−320). Checklist = the ROADMAP `## Open` 2026-08-18 SCOPE RULING + WAVE ADDENDUM.
Vendor probes were READS only (no writes, no spend). Production admin probes were GETs only.

## VERDICT: **SHIP**

Every blocking-class attack failed. Six NON-BLOCKING findings, none of which gates the deploy; the two that touch shipped guards are recorded so the next wave does not inherit them as "reviewed and fine".

**Both lanes' checklist items are present and behave as specified.** The two highest-risk items in the ruling — the shared grader scoped to *throwing* branches only, and the zod seam at the vendor read surface — were the two most likely to break something, and both survived direct attack (the first by construction, the second by live payload validation against all five read endpoints).

---

## LIVE-STATE CORRECTION (read this before acting on the brief's priority 1)

**The brief's priority-1 premise is STALE. The pilot's incident resolved itself under the OLD code at 2026-08-18T18:22:37Z, before this gate ran.**

Evidence, all read-only:

| Probe | Result |
|---|---|
| `GET /admin/tenants/ten_91aab24a-…/provisioning-state` | `requestIdempotency` now holds `setup_infrastructure:apd-setup-a-2mbx` at **`status: "done"`**, `createdAt` 1787077357414 = **2026-08-18T18:22:37Z** |
| `POST /warmup/list` (vendor) | **2** active subscriptions: `mordytee11` (created 08-17T20:40Z) and **`mordytee12` (created 2026-08-18T18:22:55Z)** |
| `GET /billing/wallet` (vendor) | `credits_used` 35 → **38** since the canon probe: exactly 3 credits = one `/warmup/add` |

`engine/idempotency.ts` only writes a `'done'` row for a **terminal** settle (a non-terminal outcome deletes the claim row; a throw deletes it too), so `done` means the saga completed. The founder's wallet top-up unblocked the customer's same-key retry, which enrolled mordytee12's warmup 18s into the run and settled terminal.

Consequences for this gate:
- The deploy is **no longer emergency-urgent for that retry** — that key is settled and will replay, not re-run.
- The E1 pre-check is nonetheless now **load-bearing for the next attempt on that address**: with the vendor holding a subscription for mordytee12, the merged code's `warmupSubscriptionState` → `"active"` → adopt-and-mark path spends nothing, where the old code would have called `/warmup/add` a second time ($3/mo, forever). Verified by reading `startWarmupUnlessAlreadyRunning` against the live `/warmup/list` payload.
- Both domain intents are `committed` and both carry live `domains` rows, so **neither trips the new orphan checks**. `goauthorpitchdesk.com` remains `dnsStatus: "pending"` with 0 mailboxes — unchanged by this wave, still owed a fresh `setup_infrastructure` key.
- Still true and still invisible: `GET /admin/ops/checks` names `mailbox_provisioning:mordytee11@…` and **nothing for mordytee12**. That is the class-C blind spot lane 2 closes going forward.

---

## Findings (none blocking)

### NB-1 · lens 2/8 · The grader's 404-by-shape premise is FALSE at the live vendor

`inboxkit-errors.ts:70-76` grades a 404 as operator-actionable when the body is a bare `{code, message}` envelope, on this stated premise:

> "A gateway-shaped 404 (`{code, message}`, no `error` field …) means the ROUTE does not exist, not that a resource is missing: an app-level 'not found' arrives in the `{error:true}` envelope instead."

**Live-refuted.** A valid route with a nonexistent resource returns exactly the gateway shape:

```
GET /v1/api/email-insights/mailbox/nonexistent-uid-zzz999/health
HTTP 404
{"code":404,"message":"Mailbox not found or you don't have access to it"}
```

So a genuinely deleted/foreign mailbox is graded "an operator can clear this and your same retry completes" — which is false; no operator action makes a nonexistent mailbox resolvable.

**Why NON-BLOCKING:** only two call sites interpolate a resource into a path — `getHealth` and `showMailboxCredentials`. `getHealth`'s throw is caught per-mailbox at `engine/infrastructure-status.ts:133-137` and degraded to `vendorHealth: "unknown"`; `showMailboxCredentials`' 404 is the deliberate route-does-not-exist case; and its caller swallows push failures. No path today converts the mis-grade into customer-visible behaviour. `mapInboxKitError`'s other 14 sites pass identifiers in the BODY, so a bad id there returns a 200-`{error:true}`, not a 404.

**Fix direction (not applied):** grade the 404 by OP rather than by body shape — `showMailboxCredentials` is operator-actionable because its path is an unverified guess; `getHealth`'s 404 is a genuine absence.
**Verification:** live read-only probe (above) + traced both call sites and their catch arms.

### NB-2 · lens 5/7 · Tripwire (b) accepts a pure SELECT as a "durable claim" — PROVEN by mutation

`test/vendor-truth-scan.ts:305-323` — `CLAIM_MARKERS`, documented as *"A durable record that survives a throw and proves money MAY have moved"* — includes **`readMailboxIntent(`**, which is a `SELECT` (`engine/provision-intents.ts:238-246`). A read records nothing and survives no throw.

**Proven, not inferred.** Running the shipped scanner over `mailbox-provisioning.ts` with the one genuine claim (`markMailboxIntent`) removed before the billed call, leaving the read and the pre-check in place:

```
mutation applied: true
offenders with ONLY readMailboxIntent as the 'claim': []      <-- guard PASSES an unguarded billed effect
control (no claim marker at all): [ 'startWarmupUnlessAlreadyRunning:mailbox.startWarmup(' ]
```

**Why NON-BLOCKING:** today's only site satisfying the claim half via this marker also writes a real `markMailboxIntent` before the call, so the live tree is correctly guarded. The defect is in the guard's future-proofing: a new saga leg that reads an intent and then buys would ship green.
**Verification:** executed the repo's own `findUnguardedBilledEffects` / `isAllowedSplitGuard` against in-memory mutations of the real source (no writes to the tree).

### NB-3 · lens 4 · Tripwire (a)'s scan root is narrower than its stated claim

The grader tripwire is titled *"no permanent vendor refusal is graded by hand without a written reason"*, but `vendor-truth-coverage.test.ts:51-57` scopes it to `apps/platform/src/vendors/real/**` plus `engine-mailbox-client.ts`. Running the same scanner across `apps/platform/src` + `apps/engine/src` + `packages/shared/src` finds **3 unallowed hand-built permanent `VendorError`s the guard cannot see**:

- `apps/platform/src/engine/mailbox-acquisition.ts` — "…held by the provider but reported as no longer usable…"
- `apps/platform/src/engine/mailbox-acquisition.ts` — "…could not be created after an automatic retry…"
- `apps/platform/src/engine/mailbox-provisioning.ts` — "…the provider now reports it as no longer usable…"

**Why NON-BLOCKING:** all three are platform-composed messages about a vendor VERDICT already obtained (the vendor-verdict class fix), not gradings of a vendor refusal, and none is in the wave's scope ruling. But a future engine-layer hand-graded refusal ships unflagged, and the guard's title implies otherwise.
**Verification:** executed `findHandBuiltPermanentSites` + `isAllowedPermanent` over all three roots.

### NB-4 · lens 1 · The canon this wave cites does not exist in the branch

`docs/adversarial/class-sweep-vendor-truth-2026-08-18.md` is **untracked**, living only in the main checkout's working tree; `ROADMAP.md`'s scope ruling is likewise uncommitted on `main`. At this HEAD:

```
$ git cat-file -e HEAD:docs/adversarial/class-sweep-vendor-truth-2026-08-18.md
fatal: path '…' does not exist in 'HEAD'
$ grep -rl "class-sweep-vendor-truth-2026-08-18" apps packages site | wc -l
38
```

**38 source files cite a document absent from the tree that contains them.** Per project law ("no artifact = the review didn't happen"), the frozen record and the ORDER entry must land in the same merge as the code.

### NB-5 · lens 5 · `provisioningFailureCount` now measures something narrower than its name — class D inside class D's own fix

`admin/ops-sweep.ts` correctly replaces the hardcoded `0` with a real cross-tenant sum, but that sum is `mailboxOrphans.length + domainOrphans.length` — orphaned intents past the 30-minute grace, NOT provisioning failures generally (a terminal `setup_failed` row or a `capacity_pending` stop contributes nothing). The narrowing is explained in a TS docstring and is **invisible in the response**, which is precisely class D's shape. The accompanying watchdog alert text is accurate; the digest number is the one that misleads.

**Why NON-BLOCKING:** operator-facing only, direction-of-error is under-reporting a count that was previously a hardcoded lie, and the name was kept deliberately for API stability.

### NB-6 · Battery is load-sensitive: one full run went RED on a 5s timeout in an untouched file

First full run: **1 failed | 1830 passed**, exit 1 — `test/byo-intake.test.ts > pollByoDomainDns > flips to active once the sandbox scan reports delegated/records-applied`, `Test timed out in 5000ms` (wall 145,954ms under parallel load). That file is not in the wave's diff. Isolation run: **27/27 passed, exit 0**. Clean full re-run: **190/190 files, 1831 passed, 1 skipped, exit 0**. Not a regression; recorded because "the suite is green" was true on the second attempt, not the first, and the wave adds ~1,000 test lines to the parallel load.

---

## Attacks that FAILED (this is what makes the SHIP mean something)

**Lens 6/7 — the guard that would have reopened a closed class.** The completeness pass warned that class A's guard, written as "route all N branches through the shared grader", would reopen the vendor-verdict class at the two `inconclusive` sites. **The scope warning was heeded and holds structurally, not by convention:** `inboxKitAppError` hard-codes `retryable: false` and exposes no way to force it true, so a mechanical re-routing pass *cannot* flatten the two retryable throws. Verified all five sites survive: `mailbox-port.ts:119` (`provisioningState` unknown-token), `:301`/`:312` (`warmupSubscriptionState`), `:454` (`findExactMailbox`) still RETURN `inconclusive` with no throw; `inboxkit-domain-port.ts:202` and `:350` still hand-build `retryable: true`.

**Lens 2 — would the new zod seam brick provisioning at deploy?** This was the highest-risk item: `.optional()` accepts `undefined` but NOT `null`, and an over-strict schema converts a working vendor into an outage. **Live-validated every schema against the real payload**, field by field:

| Endpoint | Schema | Live result |
|---|---|---|
| `POST /domains/list` | `ListDomainsResponseSchema` | `error` bool, `message` str, `total`/`pages` int; 3 rows, every read field (`uid`,`name`,`status`,`connection_type` str; `assigned_mailboxes` int; `nameservers`,`actual_nameservers` arrays) present and correctly typed; unknown keys (`status_counts`, `limit`, …) dropped |
| `GET /domains/available` | `CheckAvailabilityResponseSchema` | `error`/`banned`/`available` all bool |
| `POST /mailboxes/list` | `ListMailboxesResponseSchema` | `error` bool; row `uid`/`domain_name`/`username`/`status` all str |
| `POST /warmup/list` | `ListWarmupSubscriptionsResponseSchema` | `error` bool, `total`/`pages`/`current_page` int, `mailbox_email` str, nested `mailbox.uid` str |
| `GET /email-insights/mailbox/{uid}/health` | `MailboxHealthResponseSchema` | `success` bool; `data.{status,last_event_at}` str, `{total_7d,total_30d,bounce_rate_30d}` int |

No `null` in any required-or-typed position. **The seam does not brick anything.** As a bonus the health probe confirms the F1 fix end-to-end: live `bounce_rate_30d: 0` → `bounceRate: 0` (the vendor genuinely said zero), with `reputationScore`/`complaintRate`/`placementRate` correctly `null` rather than the old fabricated 50 and NaN.

**Lens 2 — class B's fix reproducing class B.** The canon's Finding 6 was that a camelCase reader under `body as T` would report the wallet healthy forever. `watchtower-vendor.ts:100-111` reads `credits_remaining` / `auto_topup_enabled` through `unknown` and **fails loud** on any other shape. Fed the REAL live body (`credits_remaining: 53`, `auto_topup_enabled: true`) — parses and reports healthy with the true count; a missing/renamed field returns `healthy: false` with the offending body. Dark-gating returns `[]` (absence of a check), never a healthy row.

**Lens 7 (regression ring) — can a NORMAL in-flight provision trip a `mailbox_orphan` alert?** No. The grace is 30 min from `mailbox_intents.updated_at`, and the normal path from `'bought'` to the `mailboxes` row is a bounded `awaitMailboxReady` backoff plus one warmup call. `'committed'` is deliberately excluded from the orphan statuses. Traced the whole saga's status writes.

**Cross-lane — do lane 1's new transitions leave lane 2's checks stuck unhealthy (immortal rows)?** No, and the mechanism is deliberate. The clear loops guard on `mailboxIntentEmails` / `domainIntentCandidates`, which are `SELECT DISTINCT … ` **unconditional on status**, so a released or reconciled intent still clears. Confirmed nothing anywhere `DELETE`s an intent row (`markMailboxIntentsReleased` sets status `'released'` and deletes only the idempotency + dispatch rows). Had the ownership set been derived from `mailboxProvenance`, the alert could never have cleared — the code says so and it is right.

**Does lane 1's release-success path clear lane 2's orphan check?** Yes: release → `released_at` written → status `'released'` → out of the orphan statuses → clear emitted as `no_longer_applicable` (`nowLive` is correctly false, since `mailboxProvenance` requires `released_at === null`).

**Would a resolved-name-differs-from-candidate provision raise a false `domain_orphan`?** No. `markDomainIntent(ctx, key, "committed", purchased.domain)` rewrites `candidate_domain` to the ACTUAL adopted/bought name (`provision-intents.ts:381-388`, called at `provisioning.ts:370`), so the `NOT EXISTS` join against `domains.domain` matches.

**Priority 6 — release() absent-at-vendor on a row we wrongly believe we own: is billing correct?** Yes, and this is the direction that matters. Billing counts `mailboxes WHERE released_at IS NULL` (`syncMailboxQuantity`), so writing `released_at` for a resource the vendor does not hold **stops** billing the customer for a phantom — the exact over-bill the canon's Finding 1+2 identified. Nothing downstream assumes a vendor call occurred; `revokePushedMailboxCredentials` runs before and is independent. The two non-absence outcomes keep their old grades (inconclusive → retryable throw; non-exact match → permanent refusal).

**Priority 4 — does any consumer still branch only on `'terminal'`?** No. Enumerated every severity consumer: the TS union, `openapi.yaml:2199` enum, `mcp/tools.ts:86` and `:350` descriptions, and the DB read path `toSeverity` (which now recognises `operator_pending` and still refuses to invent it for an unknown value). `apps/dashboard` and `packages/cli` do not branch on message severity at all. `AdminOperatorMessageInput` correctly stays two-rung per the ruling. `policyFor` falls through to the 2-observation debounce for the new check names, which is right because — unlike the one-shot `mailbox_provisioning:` reports — the orphan and vendor checks are re-observed every tick.

**Does the dedup refresh actually change severity when a held setup later dies?** Yes — both branches share `dedupKey: failed:<domain>` and the refresh is `UPDATE tenant_messages SET severity = ?, body = ?, action_hint = ?, …`, so the row cannot be left claiming `operator_pending` under a terminal body.

**Lens 4 — the `ackedAt` rename's blast radius.** Confined to `OperatorTenantMessage` (the admin surface). `openapi.yaml`'s `Message` schema keeps `readAt`, correctly, because openapi documents no `/admin/*` path and the agent-facing field is unchanged. No dashboard/CLI reader of `readAt` exists.

**Lens 4 — E4's second call site.** `findAdoptableDomain` now throws instead of returning `null`, and the new per-candidate try/catch at `provisioning.ts:598-608` is not the only caller: `provisioning.ts:301-302` (the adopt-before-buy leg) is deliberately left to propagate — which is the money-critical direction, since that is the call site immediately followed by `domain.buy`. `/domains/list`'s body-level failure is `retryable: true`, so it surfaces as a retryable failure, not a false terminal.

**Do the tripwires actually bite?** Yes, proven by mutation of the real sources: dropping `{ operatorActionable: true }` from `showMailboxCredentials` makes it an unallowed offender under tripwire (a); removing the pre-check + claim from `startWarmupUnlessAlreadyRunning` flags it under tripwire (b). The allowlists were read entry by entry — no entry is a lie, three are honestly marked STILL OPEN (both `oauth-mint` arms and `domains/remove`) rather than silently graded, and the suite enforces both directions (a stale entry matching nothing is itself a failure) plus a minimum reason length.

**`warmup_duplicates` reporting healthy on an inconclusive lookup** — attacked as a false-healthy; held. It is a documented choice, and a genuine vendor outage is not silent because `vendor_wallet` runs on the same call family and fails loud.

---

## Battery evidence (real exit codes, no pipes)

```
$ npm run typecheck                       # 6 tsc projects: dashboard, engine, platform, cli, shared
TYPECHECK_EXIT=0

$ npx vitest run                          # run 1
 Test Files  1 failed | 189 passed (190)
      Tests  1 failed | 1830 passed | 1 skipped (1832)
PLATFORM_TESTS_EXIT=1                     # byo-intake.test.ts, 5000ms timeout (see NB-6)

$ npx vitest run test/byo-intake.test.ts  # isolation
 Test Files  1 passed (1)
      Tests  27 passed (27)
SOLO_EXIT=0

$ npx vitest run                          # run 2, clean
 Test Files  190 passed (190)
      Tests  1831 passed | 1 skipped (1832)
   Duration  568.98s
RERUN_EXIT=0
```

A first attempt with `--reporter=basic` exited 1 having run ZERO tests (the reporter module failed to load). Recorded as a harness trap, not a repo defect: **an exit code from a vitest invocation whose reporter failed to load is not a test result.**

`@coldstart/*` resolves into THIS worktree (`node_modules/@coldstart/shared -> ../../packages/shared`), verified before trusting any run.

---

## UNVERIFIABLE (never folded into the verdict)

1. **The funds-refusal wire shape on `/warmup/add` and `/mailboxes/buy`** (non-2xx vs 200-`{error:true}`) — the wallet is funded (53 credits, auto-topup ON at a trigger of 10), and draining it to find out costs real money. The fix handles both paths, so this is a completeness question, not a correctness one. *Carried from canon Part 6 #1.*
2. **Whether `FUNDING_PATTERNS` matches the real refusal wording.** Only the domains/register 402 wording is live-captured (`"Insufficient wallet balance to purchase mailboxes"` — matches pattern 1). The `/warmup/add` refusal text is unknown. Fail-open by construction, so a miss degrades to today's behaviour. Resolved by a live capture at the next refusal.
3. **`/warmup/cancel` semantics under duplication** — if two subscriptions exist for one mailbox, does one cancel clear both? Vendor question; makes `warmup_duplicates` actionable rather than merely observable. *Carried.*
4. **What status a delinquent/suspended InboxKit workspace returns on READS** (the 402/403 arm's blast radius). Do not induce it; ask InboxKit.
5. **`oauth-mint` endpoint reality** (both allowlist STILL-OPEN entries). Assume broken until a live mailbox confirms.
6. **The orphan checks firing for real** — no tenant currently has an orphaned intent (the pilot's two are both `committed` with live rows), so the unhealthy arm is proven only by its unit tests, never by production data. Resolved by the first real orphan, or by an intentional staging fixture.
7. **`GET /admin/ops/checks` growth under per-address check names** — 13 rows today across 63 tenants, unpaginated. Cannot be measured until orphan checks actually fire at fleet scale. Already routed to train 6 (S8).

---

## NEW (out of scope, no verdict weight)

- **`toSeverity` makes the new rung rollback-unsafe in one direction.** A row stored as `operator_pending` and read by a Worker rolled back to the previous version resolves to `action_required` — telling an agent to act when no action of its own can work. Inherent to adding a rung; worth knowing before any rollback that follows this deploy.
- **`evaluateVendorChecks` adds 2 vendor requests per watchtower tick** (1 wallet + 1 warmup page today, up to 11 if the workspace ever exceeds 10 warmup pages). Comfortably inside the 10 req/min limit at pilot scale, and it is account-wide (not per-tenant), so it does not fan out with tenant count. Interacts with train 6's S3 rate-limit work.
- **The `vendor_wallet` unhealthy detail embeds `JSON.stringify(body)`** — the whole wallet payload, including balances, into an operator alert email. Operator-only surface and consistent with existing check details, but it is the first check that puts a vendor's financial payload in an email body.
