# Wave 1+2 integration gate — combined adversary review

**Ref:** worktree `/Users/yaakovscher/dev/coldstart/.claude/worktrees/channelfix`,
branch `feat/channel-truth-2026-08-17`, **HEAD `3d2c194`** (`git rev-parse HEAD`
run at review start; tree clean, `git status --porcelain` empty). Scope =
`git diff main HEAD` (72 files, +5086/-561). `main` = `2689e03`.

**Date:** 2026-08-18. Read-only git throughout (`status/log/show/diff` only). Two
probe test files were written, executed, and deleted; the tree was clean before
and after.

---

## 1. VERDICT

# NO-SHIP — 3 BLOCKING

The wave's engineering is strong and most of my attacks failed (§4). But the
battery is **not green at HEAD**, and two of the wave's own headline invariants
are violated at sites the wave's own source documents enumerate. All three
blockers were **executed**, not inferred.

| # | Blocking | Where | How verified |
|---|---|---|---|
| B1 | Typecheck RED + 2 suite failures at HEAD | `apps/platform/test/admin-provisioning-state.test.ts:138,144,201` | ran `npm run typecheck`; ran the full suite |
| B2 | Member 5 closed at 1 of the 3 sites its own sweep enumerates — the `d1` check and the **cron dead-man** still bank undelivered announcements | `watchtower-do.ts:165-170` (via `watchtower-infra.ts:55`, `watchtower-do.ts:147`) | 3 probe tests, all reproduced |
| B3 | `remove_mailboxes` records a **partial** release as terminal — F1 violated on a money path | `tenant-do.ts:1019-1025` × `billing.ts:1005` × `lifecycle.ts:286` | probe test, reproduced |

### Battery as actually measured at HEAD

| Leg | Command | Result |
|---|---|---|
| typecheck | `npm run typecheck` | **RED** — 3 errors (`@coldstart/platform`). dashboard / engine / shared / cli clean. |
| platform tests | `npx vitest run` (apps/platform) | **RED** — 186 files: **1 failed / 185 passed**; 1757 tests: **2 failed / 1754 passed / 1 skipped**. 608s. |
| engine tests | `npx vitest run` (apps/engine) | GREEN — 17 passed / 2 skipped; 140 passed / 4 skipped. |
| build | `npm run build --workspaces` | GREEN — `wrangler deploy --dry-run` clean, `tsc -p` clean. |

> **Process note (not a finding, but it explains how a red suite was reported green):**
> `npx vitest run 2>&1 | tail -80` exits **0** even when vitest fails — the pipe
> discards vitest's exit code. My own backgrounded run reported "exit code 0"
> while printing 2 failures. Any verifier that piped through `tail`/`head` and
> trusted `$?` got a false green. Use `set -o pipefail` or read the summary line.

---

## 2. BLOCKING FINDINGS

### B1 · lens 2 (would it run? RUN it) + lens 4 (merge/integration plumbing) · BLOCKING
**The merge at `3d2c194` brought `main`'s `admin-provisioning-state.test.ts` forward without adapting it to the `Settled<T>` signature. Typecheck is red and two tests fail at HEAD.**

`git diff main HEAD --stat -- apps/platform/test/admin-provisioning-state.test.ts`
is **empty** — the file is untouched by the wave (it landed on main at `ca0a7b0`).
It calls the wrapper with the pre-contract signature:

```ts
// apps/platform/test/admin-provisioning-state.test.ts:138
withRequestIdempotency(ctx, "setup_infrastructure:apd-setup-a-2mbx", () => ({
  provisioning: "pending", pendingDomain: "deadco1.com",
}))
```

**Typecheck (`npm run typecheck`):**
```
test/admin-provisioning-state.test.ts(138,82): error TS2322: Type '{ provisioning: string; pendingDomain: string; }' is not assignable to type 'Promise<Settled<unknown>> | Settled<unknown>'.
test/admin-provisioning-state.test.ts(144,115): error TS2322: Type '{ ok: boolean; }' is not assignable to type 'Promise<Settled<unknown>> | Settled<unknown>'.
test/admin-provisioning-state.test.ts(201,119): error TS2322: Type '{ ok: boolean; }' is not assignable to type 'Promise<Settled<unknown>> | Settled<unknown>'.
```

**Runtime (`npx vitest run test/admin-provisioning-state.test.ts`):** esbuild
strips the types, so at runtime `settled.terminal` is `undefined` → falsy → the
non-terminal branch **deletes the claim** and returns `settled.value`
(`undefined`). Both tests that assert a recorded row fail:

```
AssertionError: expected [] to have a length of 1 but got +0
 ❯ test/admin-provisioning-state.test.ts:181:41   (requestIdempotency)
 ❯ test/admin-provisioning-state.test.ts:206:42   (tenant isolation)
Test Files 1 failed | 185 passed (186)
Tests 2 failed | 1754 passed | 1 skipped (1757)
```

**Why it is blocking rather than a test-only nit:** CLAUDE.md makes a quoted-green
typecheck/test run the definition of done, and the ship gate is the battery. It is
also a genuine *semantic* signal, not just a compile nit — see NB-9: the endpoint
the tests cover was built to diagnose wedged setup keys, and under the new
contract it structurally cannot show one. Somebody has to decide what that
endpoint asserts now; the failing tests are that decision surfacing.

**Fix shape:** wrap the three `fn`s in `terminal(...)` / `nonTerminal(...)` and
re-state what each assertion means under the new contract (the second and third
are `{ok:true}` fixtures — plainly `terminal`; the first is deliberately a
non-terminal payload and is the one that needs a real ruling).

---

### B2 · lens 1 (spec-vs-code line-trace) + lens 7 (regression ring) · BLOCKING
**Cached-terminal member 5 is fixed at 1 of the 3 sites its own sweep row names. The two left open are the `d1` check and the cron dead-man — the platform's two checks of last resort.**

`docs/adversarial/class-sweep-cached-terminal-2026-08-17.md:90` enumerates the
member's sites verbatim:

> `admin/watchtower.ts:356-359`; **same shape at `admin/watchtower-infra.ts:55` and `watchtower-do.ts:147`**

Only the first was fixed (`watchtower.ts:433-457` now computes `withheld` and
calls `withheldAlertState`). At the other two, `WatchtowerDO.applyAlert`
persists the transition **before the Worker sends**, and nothing withholds it:

```ts
// apps/platform/src/watchtower-do.ts:165-170
private async applyAlert(key, checkName, healthy, nowMs): Promise<RemoteAlertDecision> {
  const prev = (await this.ctx.storage.get<PersistedAlertState>(key)) ?? null;
  const transition = decideAlert(prev, healthy, nowMs, policyFor(checkName));
  await this.ctx.storage.put(key, transition.next);   // <- unconditional
  return { transition, prevSinceTs: prev?.sinceTs ?? null };
}
```

- `watchtower-infra.ts:53-66` (the `d1` check) then sends and reports `why`
  honestly — but the state has already advanced.
- `watchtower-do.ts:147-149` (the dead-man alarm) persists, then
  `if (email) await trySend(this.mailer, email)` and **discards the result
  entirely** — not even `why` survives.

`decideAlert` on `alerted` returns `{lastAlertTs: nowMs, alertCount: 1}`
(`watchtower-policy.ts:229`), so an undelivered alert banks the announcement:
the next tick takes the PHASE-2 backoff (`:203`) and is silent for
`firstRealertMs` (6h), and on recovery `:192` fires a **RECOVERED** email for an
incident nobody was ever told about. That is verbatim the failure
`withheldAlertState`'s own docblock (`watchtower-policy.ts:236-243`) says this
wave closed. `watchtower-infra.ts`'s new comment claims the opposite of what the
code does — *"a check reported through two stores that describe the same
non-delivery differently is the reporting divergence this wave is about"* — the
`why` was unified; the **state** was not.

**Verification — 3 probe tests, all reproduced** (`test/zz-adversary-probe.test.ts`,
run with `npx vitest run --no-file-parallelism`, since deleted):

| Probe | Expected under the wave's own new contract | Actual |
|---|---|---|
| A1 — `d1`, dark channel, next tick | `action: "alerted"` (re-attempt) | **`"suppressed"`** |
| A2 — `d1`, D1 recovers while channel was dark | no RECOVERED email | **`["[coldrig] D1 database: RECOVERED"]`** |
| B — dead-man, dark alarm then channel restored, cron still dead | `["[coldrig] Ops sweep (cron): UNHEALTHY"]` | **`[]`** (silent 6h) |

**Reachability, stated precisely (self-refutation):** I checked the deployed
binding manifest via `wrangler deploy --dry-run` — `OPS_ALERT_EMAIL` **is** set
(`yaakovscher@gmail.com`) and the `OPS_EMAIL` Send Email binding **is** bound. So
the permanently-dark-channel trigger is *not* the production default. The trigger
is a **send failure**: `E_SENDER_NOT_VERIFIED`, an Email Service 5xx, or a rate
limit — the same trigger the wave's own rewritten test uses
(`watchtower.test.ts:196` throws `E_SENDER_NOT_VERIFIED (dark)`). That narrows
the window but does not close it, and the blast radius is the two checks that
exist precisely because *"silence from this platform right now means nothing"*
(`watchtower-do.ts:143`).

**Fix shapes differ per site (do not paste one into the other):**
- **Dead-man** (`watchtower-do.ts:147-149`) is local — the DO sends itself, so
  move the `storage.put` after `trySend` and apply `withheldAlertState`.
- **`d1`** (`watchtower-infra.ts:55`) straddles the boundary: the DO decides and
  persists, the Worker holds the mailer. It needs either a second RPC that
  applies `withheldAlertState` after a failed send, or moving the persist into a
  `commitAlert(delivered)` call. Pick one and say so in the DO's docblock —
  today that file's comment asserts a parity it does not have.

Related, and **not** a blocker (already ruled out of scope in-repo): W-M1 from
`sweep-completeness-pass-2026-08-17.md:109` — `cron_legs` still emits *"Every
ops-sweep leg completed with zero errors"* while alerts are undeliverable. It
compounds B2 (green monitor + silent alerter) but `sweep-signals.ts:127-131`
explicitly defers it.

---

### B3 · lens 7 (regression ring) + lens 1 · BLOCKING
**Train 2's IN-3 isolation removed the throw that train 1's terminality assertion depends on. `remove_mailboxes` now records a PARTIAL release as terminal, freezes it under the customer's idempotency key, and leaves a still-live mailbox billed to both the customer and the platform.**

The justifying comment at the call site is now false:

```ts
// apps/platform/src/tenant-do.ts:1019-1025
return await withRequestIdempotency(
  ctx,
  idempotencyKey ? `remove_mailboxes:${idempotencyKey}` : undefined,
  // TERMINAL: releaseMailboxes THROWS on any vendor release failure, so a
  // non-throwing return means every selected mailbox was actually released.
  async () => terminal(await removeMailboxes(ctx, input)),
);
```

`releaseMailboxes` no longer throws — IN-3 routed it through `forEachIsolated`
and it now **returns** the failure count (`lifecycle.ts:286`):

```ts
return { releasedCount: outcome.results.length, slotCountedReleased, failedCount: outcome.failures.length };
```

`failedCount` is a NEW signal with exactly **one** of its three consumers wired:

| Caller | `failedCount` |
|---|---|
| `deliverability-actions.ts:176` (REPLACE_DOMAIN) | **handled** — `if (release.failedCount > 0)` |
| `billing.ts:1005` (`removeMailboxes` — the customer money path, behind `terminal()`) | **discarded** |
| `lifecycle.ts:437` (`teardownTenant`) | **discarded** |

`removeMailboxes` destructures `const { releasedCount } = await releaseMailboxes(...)`
and returns normally.

**Executed** (`test/zz-adversary-probe2.test.ts`, since deleted) — 4 live
mailboxes, ask to release 3, vendor permanently 404s one, driving the exact
composition `TenantDO.removeMailboxes` drives:

```
PROBE2 first response      = {"releasedCount":2,"billing":{"provisionedAfter":2,...}}
PROBE2 idempotency row     = {"status":"done","response_json":"{\"releasedCount\":2,...}"}
PROBE2 release calls 1st   = 3 after same-key retry = 3
PROBE2 still-live mailboxes= ["d@partial.com","stuck@partial.com"]
PROBE2 replayed response   = {"releasedCount":2,...}
```

**Failure scenario:** customer's agent POSTs `/remove-mailboxes {count:3}` with
`Idempotency-Key: k1`. Two release, one 404s. Response 200, `releasedCount: 2`,
recorded `status='done'`. The agent — following the platform's own instruction —
retries with the same key: **zero** additional vendor calls, the partial replays,
and `stuck@partial.com` stays live forever. It keeps counting toward
`provisionedMailboxCount`, so `syncMailboxQuantity` keeps billing the customer
$10/mo for it, and the vendor keeps billing the platform. `releaseMailboxes`'
own new `onItemError` comment names the stake exactly: *"an unreleased mailbox
is a LIVE recurring cost on both sides"*, and promises *"a later release retries
this one"* — but the keyed retry is a no-op replay and the unkeyed retry is
relative (`release N more`), so it destroys a **different**, healthy mailbox
instead. There is no reconcile lane that re-attempts a failed vendor release.

This is F1 — *"unfinished outcomes are never recorded by request idempotency"* —
violated at one of the five wrapped call sites, by the merge, on the money path.
The agent-facing claim is also now false
(`mcp/tools.ts:186`): *"a retry carrying the same key returns the first call's
result and releases nothing further"* — true, and that is precisely the wedge.

**Fix shape:** `settleRemoveMailboxes(result)` beside `setup-terminality.ts` —
`failedCount > 0` ⇒ `nonTerminal`. That requires surfacing `failedCount` through
`RemoveMailboxesResult` (`billing.ts:987`), which the customer should see anyway:
today an agent that asked for 3 and got `releasedCount: 2` has no field telling
it why. Sweep `lifecycle.ts:437` in the same change (see NB-6).

---

## 3. NON-BLOCKING

1. **`schema.ts:1047-1048` — a comment this wave ADDED contradicts the rung this wave ADDED.** It says severity is `'info' | 'action_required'` and names
   `TenantMessageSeverity` as the source of truth; that union is
   `"info" | "action_required" | "terminal"` (`tenant-messages.ts:42`). Comment
   only, no behavior.
2. **`mcp/tools.ts:74` (`setup_infrastructure`) never names `provisioning` / `capacity_pending` / `pendingDomain`,** while `site/openapi.yaml:142-151` documents all three. The customer here is an *agent driving MCP*, and the tool
   description still says *"Async — returns { jobId, billing }; poll
   infrastructure_status for progress"* — which, on a `capacity_pending`
   outcome, instructs the agent to poll something that will never progress until
   a human raises a limit. The wave added the discriminator so the agent could
   tell a held provision from a completed one; its primary contract surface does
   not mention it. (`tools.ts:171` does describe `capacity_pending` under
   `account`, so the information is reachable — hence non-blocking.)
3. **`settleSetupInfrastructure`'s TOTALITY claim is false.**
   `idempotency.ts:41-44` and `provisioning.ts:407` both promise the predicate is
   total against a `JSON.parse` of an old row, but `setup-terminality.ts:30`
   does `"quoteOnly" in result` — the `in` operator **throws** on a primitive or
   `null` (verified: `node -e '"quoteOnly" in JSON.parse("null")'` →
   `TypeError: Cannot use 'in' operator...`). It would throw inside the
   synchronous pre-await prefix, 500ing the call. **Not reachable** — no writer
   can produce a non-object `setup_infrastructure:` payload — so this is a false
   claim, not a live defect. Guard with `typeof result === "object" && result !== null`.
4. **`Collapsed<T>` (`provenance.ts:62`) has ZERO consumers** — grep for
   `Collapsed` / `deduplicated` across `apps` + `packages` returns only
   `routes/admin-support.ts:38`, which builds the field ad-hoc without the type.
   **Ruling: REJECT as written** — CLAUDE.md rule (a) "no unused exports" and rule
   (i) "no speculative abstraction, YAGNI" are both hard rules, and the
   justification in the file header is explicitly forward-looking ("a later
   wave"). Cheapest resolution that keeps it: type `admin-support.ts:38`'s return
   as `Collapsed<...>` — one line, zero risk, makes the type real today. Otherwise
   delete it and re-add it in train 4. Non-blocking (type-only, no runtime effect).
5. **Ruling: RATIFY the operator admin route cap** (`admin/schemas.ts:52`,
   `z.enum(["info","action_required"])`). A human operator asserting "the platform
   has permanently stopped" is a claim only code that observed the stop can make.
   `toSeverity` (`tenant-messages.ts:207-211`) correctly reads `'terminal'` back
   and correctly refuses to *default* to it. Sound as designed.
6. **`teardownTenant` (`lifecycle.ts:437`) also discards `failedCount`.** A
   teardown that fails to release mailboxes now completes "successfully" and
   writes a `teardown_records` row while live vendor mailboxes remain. Before
   IN-3 this threw (loud and stuck); now it is quiet and partial. The only
   record is a customer-visible `MAILBOX_RELEASE_FAILED` action row — no ops
   alert. Failure direction changed without an alerting leg to match. Fold into
   B3's fix.
7. **Per-item failure rows crowd the 20-row `recentActions` window.** Isolation
   turned "1 throw per failed call" into up to `domains + domains×inboxesEach`
   `logAction` rows per call (`provisioning.ts:668`, `mailbox-provisioning.ts:159`).
   `deliverability_actions` has **no prune** (unlike `tenant_messages` and
   `webhook_deliveries`), and `reporting.ts:151` reads it `LIMIT 20`. For a
   tenant whose agent retries every ~2h against a permanently-dead ordinal, the
   retry loop's own failure rows evict every other signal from the customer's
   activity view within two calls. Reads are bounded so this is growth +
   observability, not a correctness break.
8. **`openapi.yaml:145-147` says `provisioning: "pending"` means "the last domain's DNS registration is still completing — `pendingDomain` names it".** With
   per-ordinal isolation, *multiple* ordinals can be propagating and only
   `failures[0]`'s domain is named (`provisioning.ts:775`); and
   `pendingDomain: inFlightDomain ?? ""` can be the **empty string**, which is
   undocumented. The singular "the last domain" wording is a leftover from the
   pre-isolation discriminator that the code comment at `:757-765` correctly
   says had to change.
9. **`provisioning-state.ts:2-9`'s docstring is stale in the direction that matters.** It says the endpoint answers *"whether a `setup_infrastructure`
   idempotency key already replays a stale response instead of doing work"*. Under
   the `Settled` contract that question is answered by construction — a
   non-terminal setup writes no row — so `requestIdempotency` is `[]` for exactly
   the wedged-key scenario the endpoint was built to diagnose, and it can no
   longer distinguish "never called" from "called and correctly released". This
   is the same fact B1's two failing tests encode; whoever fixes B1 should decide
   what this endpoint asserts now.
10. **`operatorNotifiedClause` discards `why`.** `DeliveryReason`'s stated purpose
    is *"so an operator surface can distinguish 'we chose not to' from 'we could
    not'"* (`provenance.ts:66-68`), but the clause branches only on `delivered`
    (`:127-129`). At `spend-ceiling.ts:204` a second rejection inside one episode
    carries `why: "suppressed_cooldown"` — the operator *was* told — yet the
    customer reads "We could not confirm that an operator was notified". Errs
    safe (points at `contact_operator`), and `why` does reach an operator surface
    via `mailbox-acquisition.ts:272/287` → `detail_json`, so this is a rendering
    gap, not a dead type.

---

## 4. ATTACKS THAT FAILED (this is what makes the PASSes meaningful)

| Lens | Attack | Why it held |
|---|---|---|
| 1 | **F1 completeness — a non-terminal outcome recorded at another wrapped site.** Read all 5 `withRequestIdempotency` call sites end to end (`tenant-do.ts:728/801/950/1019`, `mailbox-provisioning.ts:231`) and traced every `return` of each wrapped fn. | Held at 4 of 5. `launchCampaign` is fully synchronous and throws on duplicate; `replyToThread` returns only past a confirmed send; `runMailboxProvisioningUnit` returns only past `awaitMailboxReady` with every uncertain branch throwing. **`removeMailboxes` is the one that broke → B3.** |
| 1 | **Other namespaces / sagas that should be wrapped but aren't** — byo-intake, cancel, dashboard, messages. | Held. `requestManagedByoMailboxes`, `connectByoMailbox`, `pollByoDomainDns`, `acknowledgeByoConsent` are unwrapped entirely (`tenant-do.ts:932-946`) — nothing is recorded, so nothing can be replayed stale. `byo-mailbox-composition.ts:49`'s `quoteOnly` shape has no idempotency layer above it. |
| 2/7 | **The CHECK constraint's escape hatches.** `status <> 'done' OR response_json IS NOT NULL`; the `done`+NULL deadlock; `JSON.stringify(undefined)` → NULL bind. | Held. Every writer sets `status` explicitly; no wrapped fn can return `undefined`. The `done`+NULL row is repaired in place by the reclaim branch (`idempotency.ts:152-165`), which is deliberately *not* guarded on `status='pending'` — I re-derived that this is correct and that the old guard matched nothing for such a row. |
| 2 | **Pre-existing recorded 202s (the migration backfill).** | Held as designed. `recordedIsNonTerminal` (`tenant-do.ts:754`) re-classifies the stored payload and re-claims in place before any await (`idempotency.ts:142-146`), clearing the stale body so neither exit resurrects it. Race-safe for the same input-gate reason as the fresh INSERT. |
| 2 | **A throw AFTER vendor effect but BEFORE `terminal()` classification.** | Held. `settleSetupInfrastructure(await runSetup...)` and `terminal(await runMailboxProvisioningUnit(...))` both classify only on a resolved value; a throw deletes the claim and the durable **intent** rows (ordinal-derived / address-derived) carry resumability. Deleting a claim on throw is the documented, correct semantic. |
| 2 | **Replay-during-in-flight race / the 409 pending path.** | Held. SELECT + INSERT/UPDATE are one synchronous input-gate turn before `fn()`'s first await, so a concurrent same-key call can only ever see the claim after it is durable. |
| 3 | **`capacity_pending` leaking to a caller that treats presence-of-`jobId` as success.** | Held at the API layer — `routes/infrastructure.ts:15` returns 202 with the discriminator, `openapi.yaml:142-151` documents it, `reporting.ts:205` + `activation.ts:172` surface it as `activationState`, `apps/dashboard/src/api/types.ts:193` types it. **Weakened only at the MCP tool description → NB-2.** |
| 4 | **Deploy/arm-time plumbing.** New files (`isolated-loop.ts`, `provenance.ts`, `setup-terminality.ts`), new exports, new deps, new env vars/flags. | Held. `packages/shared/src/index.ts` re-exports `provenance.js`; `git diff main HEAD -- "**/package.json"` is **empty** (no new deps); `git diff main HEAD -- env.ts wrangler.toml` is **empty** (no new vars/flags/bindings). `wrangler deploy --dry-run` resolves the full binding manifest cleanly. Nothing in this wave needs arming. |
| 4/7 | **D1 / DO migration safety; the DO-table PK-reshape landmine.** | Held, decisively. `git diff main HEAD \| grep -E '(PRIMARY KEY\|ALTER TABLE\|ADD COLUMN\|CREATE TABLE\|DROP)'` returns **one comment line and nothing else**. No `migrations/*.sql` changed; no `addColumnIfMissing` changed. The only DDL deltas are two DEFAULT flips + one CHECK, all scoped to DOs created from here on, and `schema.ts:508-512` states that limitation explicitly rather than implying a backfill. |
| 5 | **`dns_status` DEFAULT flip `'ready'` → `'pending'` breaking a live DO.** | Held. `CREATE TABLE IF NOT EXISTS` cannot alter a live table, and both writers state the column explicitly (`provisioning.ts:345`, `byo-intake.ts:198`). `tenant-do.ts:372`'s backfill deliberately keeps `'ready'` for rows predating the column — different question, correctly different answer, and the comment says so. |
| 5 | **`abortedAt` vs `failures[0]` interplay — a ceiling breach masked by an earlier ordinary failure.** Walked all four interleavings at both loops. | Held. `abortedAt` is also pushed into `failures` (`isolated-loop.ts:96-99`), so no double-count; `outcome.abortedAt ?? outcome.failures[0]` surfaces the tenant-global cause at both loops (`provisioning.ts:700`, `mailbox-provisioning.ts:194`). The 202 discriminator correctly uses `failures.every(...)` rather than the reported failure, so a benign propagation wait alongside any other failure still falls through to the retryable path. `failures.every` cannot vacuously fire on `[]` because `reportedFailure` is falsy there. |
| 5 | **`abortOn` coverage — a tenant-global condition that should abort but doesn't** (lifecycle freeze, OFAC/screening, registrant). | Held. `assertNotLifecycleFrozen` and `assertWithinProvisioningCap` run **once, above** the loop (`provisioning.ts:691/697`), so a freeze can never arrive mid-loop. Of the 14 error classes in `packages/shared/src/errors.ts`, the only genuinely tenant-global ones reachable inside an ordinal are `CapacityPendingError` and `RegistrarUnarmedError` — both in `abortOn`. `IncompleteRegistrantError` is per-call and pre-flighted. |
| 5 | **Double-counting in `mailboxEmails`.** | Held. `provisionMailboxesForDomain` returns `outcome.results` only when `failures` is empty (it throws otherwise, `mailbox-provisioning.ts:195`), and the per-ordinal callback returns `void`, so `results` cannot accumulate emails twice. |
| 4 (design) | **Per-slot terminal spend — unbounded burn against an all-terminal vendor.** | **RULING: IN SPEC.** Triple-bounded: `MAX_BUY_DISPATCHES = 2` per address forever (`provision-intents.ts:32`), `withSpendCeiling` reserves-then-releases per attempt, and the plan-slot counter gates above that. Isolation raises attempts-per-call from 1 to N but cannot raise lifetime spend per address. The residual is row growth, not money → NB-7. |
| 5/7 | **The loop-isolation tripwire as a no-op / scoped to a twin surface.** | Held, better than most guards I attack. It globs **three** trees (`apps/platform/src`, `apps/engine/src`, `packages/*/src`), asserts non-vacuity by naming real files, proves its own detectors against 7 synthetic sources, and — the part usually missing — has a **stale-entry** assertion that fails if an allowlist entry stops matching. The IN-6 entry was correctly *deleted* rather than left as an unverified claim. Its documented blind spots (call-chain composition, `Promise.all` fan-out, a `try` anywhere in the body) are stated in `loop-isolation-scan.ts:34-51`, and `apps/dashboard` is excluded with a written reason rather than silently. |
| 8 | **Signed/security surface.** | Held — nothing in the diff touches signing. `unsubscribe-token.ts` and `tick-unsubscribe-signing.test.ts` changed, but the diff is per-item isolation around the signing call, not the HMAC input, and `persisted-key-derivations.test.ts` still pins the derivations. |
| 6 (design) | **The `withheldAlertState` recovery rule as an alert storm.** A withheld RECOVERY keeps the episode open and retries forever. | Held. Bounded to one send *attempt* per check per tick, no email once one lands, and the error is in the safe direction (a check reads unhealthy one tick longer). Correct as designed — which is what makes B2's *absence* at the other two stores the finding. |

---

## 5. UNVERIFIABLE (not folded into the verdict)

| # | Attack I could not complete | What would resolve it |
|---|---|---|
| U1 | **Priority 9 — Mordy's live replay, against his real DO.** I traced the code path and it converges (claim released on both the 202-pending and the throw exits, so every ~2h retry does real work rather than replaying), but I could not read his actual `request_idempotency` / `domain_intents` / `dns_status` rows. The brief's assertion that `requestIdempotency=[]` today is taken on trust. | `GET /admin/tenants/<id>/provisioning-state` against prod with the admin token, **before** deploy — note that after this wave that endpoint's `requestIdempotency` array is `[]` by construction (NB-9), so capture it now if the pre/post comparison matters. |
| U2 | **Lens 3 — live-surface drive.** No live flow was driven; this is a source + local-test review only. Everything I executed ran against `@cloudflare/vitest-pool-workers` with sandbox/stub adapters. | Post-deploy: a real `setup_infrastructure` with a repeated `Idempotency-Key` on a staging tenant, asserting the second call does vendor work. |
| U3 | **Real vendor failure modes.** B3 and the `PartlyStuckMailboxPort` probes use a synthetic `VendorError`; whether InboxKit's release endpoint actually returns a permanent 404/403 for a live mailbox is unverified. | One release against a real deleted-at-vendor mailbox, or the vendor's documented error taxonomy. |
| U4 | **B2's trigger rate.** I proved the mechanism and confirmed the channel is configured, but I have no data on how often Cloudflare Email Service sends actually fail for this Worker. | `wrangler tail` / Worker logs grepped for `watchtower: failed to send`. A zero rate would justify downgrading B2 to non-blocking; it would not make the code correct. |

---

## 6. NEW (out of scope, no verdict weight)

- **`deliverability_actions` has no prune sweep** at all, unlike `tenant_messages`
  (`tenant-do.ts:1261`) and `webhook_deliveries` (`webhook-delivery.ts:214`). This
  predates the wave; the wave adds three new writers to it. Worth a ticket.
- **`MAILBOX_RELEASE_FAILED` / `DOMAIN_ORDINAL_FAILED` / `MAILBOX_SLOT_FAILED`
  reach no watchtower check.** They are customer-visible activity rows only. The
  three conditions they name are exactly the ones an operator would want paged
  on, and `ops-summary.ts:141`'s action-count check does not cover them.
- **`releasedCount` silently changed meaning** from *attempted* (`mailboxes.length`)
  to *completed* (`outcome.results.length`) at `lifecycle.ts:286`. Correct, and
  strictly more honest — but it is a wire-visible semantic change to a field the
  MCP tool description documents (`tools.ts:186`), and neither the description nor
  `openapi.yaml` mentions that it can now be less than the requested `count`.

---

## 7. Convergence note for the fix round

Judge the re-review against **B1, B2, B3 only**. The ten non-blocking items and
the three NEW observations carry no verdict weight and must not be traded against
the blockers in either direction. If new findings surface while fixing, report
them separately as NEW rather than folding them into these three.

Re-review must re-run, and quote, all four battery legs on the **merged** HEAD —
with `set -o pipefail` or by reading vitest's summary line directly, per the
process note in §1.

---
---

# RE-ATTACK — round 2, 2026-08-18

**Ref:** same worktree, **HEAD `36bec2d`** ("gate blockers B1-B3 + ratified
cleanups"), one commit past `3d2c194`. `git status --porcelain` empty at start
and end. Read-only git. Three probe files written, executed, deleted.

## R2 VERDICT

# NO-SHIP — B1/B2/B3 all CLOSED, but N1 is BLOCKING as measured

**All three round-1 blockers are genuinely fixed** — verified by re-running my
round-1 probes verbatim, which now pass, plus anti-storm controls I added to
check the fixes did not over-correct. The battery is genuinely green on all six
legs with real exit codes.

**The blocker is N1**, the residual the orchestrator ruled ship-with-disclosure.
It is real, and the disclosed magnitude — *"can release beyond the stragglers by
up to `count`"* — **understates it by an unbounded factor**. Measured: a customer
who asked to release **3** loses **12 and counting**.

### Battery at `36bec2d` — six legs, real exit codes, nothing piped

| Leg | Command | Exit | Result |
|---|---|---|---|
| typecheck (all 5 workspaces) | `npm run typecheck` | **0** | clean |
| platform tests | `npx vitest run` (apps/platform) | **0** | **186/186 files; 1762 passed / 1 skipped** |
| engine tests | `npx vitest run` (apps/engine) | **0** | 17 passed / 2 skipped; 140 passed / 4 skipped |
| dashboard tests | `npx vitest run` (apps/dashboard) | **0** | 29 files; 143 passed |
| cli tests | `node --test test/*.test.mjs` | **0** | 12 pass / 0 fail |
| build | `npm run build --workspaces` | **0** | `wrangler deploy --dry-run` + `tsc` clean |

Exit codes captured with `cmd > log 2>&1; echo $?` — no pipe anywhere, per §1's
process note. Builder's claim (186f/1762p/1skip, typecheck 0, dry-run clean)
**confirmed exactly**. The platform file count is 186 both for the builder and
for me, which also confirms my probe files were never collected.

## Per-blocker re-attack outcome

### B1 — CLOSED ✅
`admin-provisioning-state.test.ts` fixtures now state the word (`terminal(...)` /
`nonTerminal(...)`), and the wave gained a NEW test that pins the semantic rather
than just restoring the green: *"a NON-TERMINAL setup outcome leaves no row —
this lists FINISHED keys only"*, asserting `requestIdempotency` is `[]`. That is
the right shape — it makes the endpoint's post-contract meaning a test rather
than a comment.

Two round-1 non-blocking items were closed in the same change without being
asked for, and both are correct:
- **NB-9** — `provisioning-state.ts`'s docstring now says the endpoint lists
  FINISHED outcomes and that a stale replay "can no longer exist by construction".
- **NB-3** — `setup-terminality.ts:30` now guards
  `typeof result === "object" && result !== null && "quoteOnly" in result`, which
  makes the TOTALITY that two other docstrings promise actually true.

### B2 — CLOSED ✅
The fix is DECIDE → SEND → BANK at both DO-backed sites, with the split done
correctly per site rather than pasted:
- **dead-man** (`watchtower-do.ts:172-181`): sends from inside the alarm, so
  `readAndDecide` → `trySend` → `bankAlert` needs no extra RPC. `trySend` never
  throws, so the bank step always runs.
- **`d1`** (`watchtower-do.ts:81-101` + `watchtower-infra.ts:57-77`): split into
  `decideD1Alert` (persists nothing) and `commitD1Alert`, with the Worker doing
  decide → send → commit. `commitD1Alert` re-derives the transition from the same
  `(prev, healthy, nowMs)` rather than trusting a caller-supplied state, which
  keeps the DO the only thing that decides what the DO stores.

**My round-1 probes, re-run verbatim: 5/5 pass.** Including the three that
reproduced the defect:

| Probe | Round 1 (`3d2c194`) | Round 2 (`36bec2d`) |
|---|---|---|
| `d1`, send fails, next tick | `"suppressed"` ❌ | `"alerted"` ✅ |
| `d1` recovers while channel dark | `["[coldrig] D1 database: RECOVERED"]` ❌ | no RECOVERED ✅ |
| dead-man dark, then channel restored, cron still dead | `[]` ❌ | `["[coldrig] Ops sweep (cron): UNHEALTHY"]` ✅ |

I added **two anti-storm controls** the round-1 probe did not have, because the
obvious way to "fix" this is to over-correct into a per-tick email storm. Both
pass: once a `d1` alert lands the next sweep is `"suppressed"` with exactly one
email total; once a dead-man alert lands the next alarm sends nothing. The fix
closes the silence without reopening the storm.

Grepped for stale callers of the renamed DO method: the only `reconcileD1Alert`
references are the Worker-side function and its one call site
(`watchtower.ts:42,475`). No orphan.

**One residual, NON-BLOCKING** (`watchtower-infra.ts:63-71`): a `commitD1Alert`
that throws is caught and logged, leaving the state un-banked. The comment says
the cost is "at worst a duplicate alert", which is right for an *alerted*
transition — but for a **debounced first observation** (`action: "pending"`) the
un-banked state also loses `unhealthyObs`, so a *persistently* failing commit
would leave the `d1` check re-deciding `"pending"` forever and never confirming.
It needs decide-succeeds-while-commit-fails to persist, which is a narrow DO
storage-write failure, and the failure direction (no alert) is the same one the
catch is protecting against elsewhere. Worth a sentence in the comment; not worth
blocking.

### B3 — CLOSED ✅
`engine/remove-mailboxes-terminality.ts` reads terminality off the result
(`failedCount === 0`), `failedCount` is on the wire in `RemoveMailboxesResult`,
the false justifying comment at `tenant-do.ts:1024` is replaced, and teardown is
swept (`TeardownSummary.mailboxReleaseFailures` + the persisted column).

**Round-1 probe re-run: passes.** After a partial release the idempotency row is
now **absent entirely** (not `done`), and the same-key retry makes real vendor
calls instead of replaying:
```
B3 idempotency row = null          (round 1: {"status":"done", ...})
B3 release calls   = 3 -> after same-key retry = 5   (round 1: 3 -> 3)
```

## Rulings on N1–N3

### N1 — over-release residual: **BLOCKING** (disclosed magnitude is wrong)

**The disclosure says "by up to `count`". Measured, it is `count - failedCount`
per retry, with no terminating condition.**

Executed: 20 live mailboxes, one permanently stuck at the vendor, customer asks
to release **3**, then does what the platform tells it to do — retry the same
key. Six retries:

```
attempt 1: releasedCount=2 failedCount=1 liveAfter=18
attempt 2: releasedCount=2 failedCount=1 liveAfter=16
attempt 3: releasedCount=2 failedCount=1 liveAfter=14
attempt 4: releasedCount=2 failedCount=1 liveAfter=12
attempt 5: releasedCount=2 failedCount=1 liveAfter=10
attempt 6: releasedCount=2 failedCount=1 liveAfter=8
TOTAL DESTROYED = 12   for a customer who asked to release 3
```

**Why it never terminates — two individually-fine properties that are jointly
unsafe.** A mailbox the vendor permanently refuses can never be released, so it
can never leave `released_at IS NULL`, so it is selected on every subsequent
call, so `failedCount ≥ 1` is a **permanent** state, so the outcome is
**permanently non-terminal**, so the key never freezes, so the instructed retry
has no terminating condition — and each pass of that non-terminating retry
destroys `count - failedCount` healthy mailboxes. B3's fix (correctly) made the
outcome non-terminal; what makes that unsafe here is that the retry vehicle is a
**RELATIVE destructive** op. This is the same shape `audit-dashboard-idempotency-2026-08-06`
BLOCKING-2 named for the unkeyed path; the keyed path has now inherited it.

The loss is irreversible in the way that matters: a released mailbox loses its
warmup and its sending reputation, and rebuilding costs real money plus the
platform's own documented four-week ramp.

**A safe retry DOES exist, and I verified it** — this is the cheap way out, so
the fix need not be the ledgered durable-intent fast-follow. Because every
mailbox newer than a straggler was in the same window and succeeded, **the failed
mailboxes are always exactly the newest live rows**, so `count = failedCount`
targets precisely the stragglers. Executed against the hard case (two stuck,
non-adjacent, mid-window, on a 7-mailbox fleet): the derived retry touched
**exactly** `{s1, s2}` and nothing else, and once the vendor healed the total
destroyed was **exactly the 4 the customer asked for**.

**So the ruling is not "this is unfixable" — it is "the guard must be
server-side, and it is cheap."** Any fix must make the retry **absolute**
(target the failed set) rather than relative. Today the platform depends on the
customer's autonomous agent noticing `failedCount > 0`, *not* doing the natural
thing (resend the identical request with the identical key), and recomputing
`count` — while `withRequestIdempotency` silently permits same-key-different-body,
so nothing catches the mistake. That is too much load-bearing weight on an agent
following prose.

I am flagging this rather than deferring to the existing ruling because **the
ruling was made against the wrong number.** Ship-with-disclosure against "up to
3" is a defensible call; against "12 and climbing, irreversibly" it should be
re-made by the founder. If it is re-made and still ships, that is a legitimate
override — but it should be an informed one.

### N2 — the DDL delta: **SOUND** ✅
`teardown_records.mailbox_release_failures INTEGER NOT NULL DEFAULT 0` via
`addColumnIfMissing`. Verified on every axis I attacked:
- **Right mechanism.** `teardown_records` is a per-tenant **DO** table
  (`schema.ts`), and DOs have no numbered-migration path, so `addColumnIfMissing`
  is the established pattern — the same form already used for
  `scheduled_sends.attempts INTEGER NOT NULL DEFAULT 0`. No D1 migration is owed;
  `migrations/` is untouched.
- **Ordering is safe.** `tenant-do.ts:204` execs `TENANT_DO_SCHEMA` (which
  `CREATE TABLE IF NOT EXISTS`-es `teardown_records`) and `:205` calls
  `ensureColumnMigrations()`. The table always exists before the ALTER.
- **SQLite constraint satisfied.** SQLite refuses `ADD COLUMN ... NOT NULL`
  without a non-null DEFAULT; `DEFAULT 0` is supplied.
- **Historical semantics are correct, and I checked the claim rather than
  accepting it.** The justification is "before per-item isolation a failed
  release THREW, so no historical record can describe a partial teardown". Traced
  it: pre-wave `releaseMailboxes` had an unguarded `for` loop, and
  `teardownTenant`'s `INSERT INTO teardown_records` sits *after* the release
  call — so a throw propagated out before any row was written. **DEFAULT 0 is
  exactly right for every pre-existing row.**
- No PK reshape, no rebuild, no read of the column before it is added
  (`readTeardownRecord`'s SELECT runs only via DO methods, i.e. post-constructor).

This is one DDL delta, not zero — §4's "zero DDL" observation no longer holds —
but it is the safe pattern, correctly applied, and it buys a real honesty gain
(a teardown that reclaimed 3 of 4 no longer reads like one that reclaimed 3 of 3).

### N3 — new claims: **TRUE, with one gap that is N1's**
- **`setup_infrastructure` MCP description — TRUE, and it closes round-1 NB-2.**
  It now names `provisioning`, `pending`, `capacity_pending` and `pendingDomain`,
  says *"Its ABSENCE is what says the provision finished; do not read a returned
  jobId as completion"*, and states the not-recorded behaviour. Each claim checks
  out against the code I traced in round 1. It even hedges `pendingDomain` as
  *"names one of them"*, which correctly handles the multi-pending case I raised
  in NB-8 — that round-1 note is now closed too.
- **openapi `Idempotency-Key` — TRUE.** "Only a FINISHED outcome replays"
  matches `withRequestIdempotency` exactly, and naming `/remove-mailboxes`'
  `failedCount` as the discriminator is accurate.
- **`remove_mailboxes` MCP description — TRUE but insufficient.** Every sentence
  is factually right, including the over-release disclosure. The gap is that
  *"ask for what is actually still owed"* is the only safe action and the
  description never says what that value is — it is `failedCount`, which I had to
  derive and verify. A disclosure that names a risk without naming the safe
  action leaves the agent to guess, and the natural guess (resend identical) is
  the destructive one. **If N1 ships as a disclosed residual over my objection,
  this sentence must at minimum say "retry with `count` set to `failedCount`".**
  Separately, and pre-existing: the description says the response contains
  `quote`; the field is `billing`. The fix rewrote this exact sentence and
  carried the inaccuracy forward.

## R2 attacks that failed

| Attack | Why it held |
|---|---|
| B2 over-correction into a per-tick alert storm | Two added controls pass — one email per landed alert, `"suppressed"` thereafter, at both the `d1` and dead-man sites. |
| Stale caller of the renamed `reconcileD1Alert` DO method | Only the Worker-side function of the same name remains; `watchtower.ts:475` is its one call site. Typecheck clean across all workspaces. |
| `commitD1Alert` re-deriving a DIFFERENT transition than the one emailed (concurrent sweep mutating `prev` across the Worker's send await) | Walked all four interleavings. `decideAlert` is pure; a concurrent commit that already banked an announcement is *preserved* by `withheldAlertState` (it reads `previous`, not the proposed state), and a delivered-then-re-derived transition lands on `suppressed`, which regresses nothing. |
| B3 fix leaving the teardown sibling unswept | Swept — `lifecycle.ts:449` destructures `failedCount`, and it reaches both `TeardownSummary` and a persisted column. |
| N2 column read before it is added / on a table that does not yet exist | Refuted by the constructor ordering at `tenant-do.ts:204-205`. |
| N2 `DEFAULT 0` mis-describing historical rows | Refuted by tracing pre-wave control flow: the INSERT is downstream of the throw. |
| B1 fix being a green-restoring edit rather than a semantic ruling | It is a ruling — a new test pins the non-terminal-leaves-no-row invariant, and the module docstring was corrected to match. |

## R2 residuals (non-blocking, carried forward)

1. `commitD1Alert` throw loses `unhealthyObs` on a `pending` transition — see B2
   above.
2. `remove_mailboxes` description says `quote`; the field is `billing`.
3. Round-1 NB-1, NB-4, NB-6, NB-7, NB-10 and the three §6 NEW items are
   untouched by this fix and still stand.

---
---

# RE-ATTACK — round 3, 2026-08-18 (scope: N1)

**Ref:** same worktree, **HEAD `dd3a33a`** ("N1: keyed remove_mailboxes retry is
ABSOLUTE via durable per-key remove-intent"), one commit past `36bec2d`.
`git status --porcelain` empty at start and end. Read-only git. Two probe files
written, executed, deleted.

## R3 VERDICT

# SHIP-AFTER-FIXES — N1 is genuinely CLOSED; ONE new blocking defect in the fix

**N1 is dead.** The round-2 destructive loop, re-driven verbatim, now destroys
**exactly what the customer asked for** instead of 12-and-climbing, and every
attack angle on the intent mechanism held. The battery matches the builder's
claim exactly.

**But the fix reintroduces a class this repo has documented in five separate
files:** `recordRemoveIntent` binds **five parameters per target** in one
un-chunked multi-row INSERT, against a DO SqlStorage ceiling of **100 bound
parameters**. It throws at **21 targets**. `RemoveMailboxesInput.count` is
`.max(60)` and `MAX_SELF_SERVE_MAILBOXES` is 60 — so **two-thirds of the input
range the schema explicitly permits is a hard 500.** It fails CLOSED (throws
before any vendor call, nothing released, nothing destroyed) and the fix is
three lines with an in-repo precedent, which is why this is
SHIP-AFTER-FIXES rather than NO-SHIP.

### Battery spot-check at `dd3a33a` — real exit codes, nothing piped

| Leg | Exit | Result |
|---|---|---|
| `npm run typecheck` (5 workspaces) | **0** | 0 × `error TS` |
| `npx vitest run` (apps/platform) | **0** | **186/186 files; 1764 passed / 1 skipped** |

Builder's claim (186f/1764p/1skip, all-zero exits) **confirmed exactly**.

---

## R3-1 · lens 2 (RUN it) + lens 5 (fixture realism) · BLOCKING
**The new intent write binds 5 params per target with no chunking, against the 100-bound-param ceiling this repo documents in five places. A keyed downgrade of 21+ mailboxes is a hard 500.**

```ts
// apps/platform/src/engine/remove-intents.ts:93-97
ctx.sql.exec(
  `INSERT OR IGNORE INTO mailbox_release_intents (key, tenant_id, mailbox_id, email, created_at)
   VALUES ${targets.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
  ...targets.flatMap((target) => [key, ctx.tenantId, target.mailboxId, target.email, now]),
);
```

`targets.length ≤ min(count, live mailboxes)`, `count` is
`z.number().int().min(1).max(60)` (`packages/shared/src/intents.ts:199`), and
`MAX_SELF_SERVE_MAILBOXES = 60` (`packages/shared/src/pricing.ts:20`). So the
statement binds up to **300** parameters and crosses 100 at 21 targets.

**The repo already knew this, in five files, and solved it in one of them.**
`ofac/sdn-list.ts:13-19`: *"Cloudflare D1's REAL per-statement limit is 100 bound
parameters — empirically confirmed (101 params throws `too many SQL variables`)"*,
and `:26` sets `INSERT_BATCH_SIZE = 16` to chunk **the identical multi-row-INSERT
shape** (`:125` builds `(?, ?, ?, ?, ?, ?)` — six params, chunked at 16 = 96).
`admin/db.ts:102`, `contact-operator-guard.ts:213`, `demo.ts:79` and
`contact-operator-reconcile.ts:52` all carry the same note and all chunk. The new
site is the one that does not.

**Verification — EXECUTED, 4 probes:**

```
control (establish the ceiling on THIS runtime):
  100 params -> OK      101 params -> "too many SQL variables at offset ...: SQLITE_ERROR"   ✓ PASSES

recordRemoveIntent(count: 20)  -> OK          (5 × 20 = 100)
recordRemoveIntent(count: 21)  -> "too many SQL variables at offset 447: SQLITE_ERROR"   (5 × 21 = 105)

the REAL keyed path, 40 live mailboxes:
  removeMailboxes({count: 21}, key) -> {"ok":false,"message":"too many SQL variables at offset 447: SQLITE_ERROR"}
  removeMailboxes({count: 60}, key) -> {"ok":false,"message":"too many SQL variables at offset 447: SQLITE_ERROR"}
```

**Failure scenario:** a tenant with 21+ live mailboxes calls `remove_mailboxes`
with `count: 21` (or anything up to the schema's own max of 60) **and an
idempotency key**. `recordRemoveIntent` throws before `releaseMailboxes` is
reached, so the claim is deleted, the error propagates as a 500, and every retry
fails identically. The downgrade is permanently impossible through the keyed
path.

**The sharpest part: the platform's own advice is what breaks it.** The UNKEYED
path calls `resolveRemoveTargets` (a plain `SELECT ... LIMIT ?`, 2 params) and
works at any count. Only the keyed path writes the intent. AGENTS.md and the MCP
description both say **"always send an idempotency key"** — so the safe,
documented, instructed path is the broken one, and the unsafe one still works.

**Why no test caught it** — the committed regression tests (which are good, and
are my round-2 probes promoted to HTTP-driven tests) use fleets of 15 and 7 with
`count` 3 and 4. This is my standing lesson from the inc5 gate verbatim: the
blocker needs a scale the suite never reaches, and the array's bound lives in a
*different file* (`intents.ts`'s `.max(60)`) from the `map(() => "?")`.

**Fix:** chunk at ≤20 rows, matching `sdn-list.ts`'s `INSERT_BATCH_SIZE`
precedent. Note the source comment's stated reason for one statement — *"a
half-written intent is a smaller target set"* — is **preserved by chunking**: the
atomicity that matters here comes from the DO input-gate turn (every synchronous
write in the turn commits together), not from statement count. `recordRemoveIntent`
is synchronous and runs entirely inside one turn, so a chunked loop is exactly as
atomic. Add a bound assertion or reuse the shared constant so the sixth
occurrence of this class is caught by the guard rather than by a reviewer.

---

## N1 — CLOSED ✅

The mechanism is right, and it is the right mechanism: the destructive mirror of
`provision-intents.ts`, anchored on the same namespaced key as the replay claim,
resolved once and recorded before any vendor call, with the relative `{limit}`
scope **deleted** from the shared executor rather than left as a second way in.

**The round-2 loop, re-driven verbatim** (20 live, one permanently stuck, ask 3,
six same-key retries):

```
a1: rel=2 fail=1 unreleased=["stuck@r3.com"] live=18
a2: rel=2 fail=1 unreleased=["stuck@r3.com"] live=18
a3..a6: identical — live stays 18
TOTAL DESTROYED = 2      (round 2: 12 and climbing)
```

Exactly the 3 asked for, minus the 1 the vendor permanently refuses. `unreleased`
names it on every pass. **The non-terminating destructive loop is gone.**

### Attack angles — all held

| Angle | Attack | Outcome |
|---|---|---|
| **Intent-write atomicity vs the input gate** | Can a crash leave a half-written intent, letting the retry pick a different set? | **HELD.** Traced the call chain: `withRequestIdempotency`'s claim INSERT, then `fn()`'s synchronous prefix — `assertNotLifecycleFrozen`, `recordRemoveIntent`, `stillLiveTargets` — all run **before the first `await`**, i.e. in one input-gate turn, so the claim and the intent commit together. `await fn()` invokes `fn` (running its sync prefix) *before* awaiting. And the write is a single statement, so there is no intra-statement partial. |
| **`INSERT OR IGNORE` with a DIFFERENT resolved set on a racing first call** | Two concurrent first calls resolving different sets could UNION under `PRIMARY KEY (key, mailbox_id)`. | **HELD, three-deep.** The `releaseInFlight` in-memory single-flight rejects the second call before it reaches the engine; `withRequestIdempotency`'s claim is durable pre-await so a concurrent same-key call takes the 409 branch; and `readRemoveIntent`'s early return means a second resolution never even runs. Any one of the three closes it. |
| **Same-key, DIFFERENT body — can a bigger `count` widen the set?** | First call `count: 2`, retry same key `count: 16`, 16 live. | **HELD.** `{"r":1,"f":1,"u":["stuck@r3.com"]}` — destroyed exactly **1**, ever. The recorded set wins; the changed count is ignored and the response describes the recorded intent, so the mismatch is visible rather than silent. Choosing this over a 409 is right: a 409 would punish the exact behaviour the round-2 docs asked for (`count` reduced to `failedCount`) and strand the stragglers. |
| **`stillLiveTargets` vs mailboxes released by OTHER paths** (teardown / REPLACE_DOMAIN) between retries | Release the straggler out-of-band, then retry the key. | **HELD.** `{"r":3,"f":0,"u":[]}` with **0 extra vendor calls**. Reading `released_at` rather than a per-call tally means a member finished by any path is finished, full stop — and the cumulative report is then honest (3 of 3). |
| **The 30-day `request_idempotency` ageout with a permanent intent** | Evict the claim, resend the key. | **HELD in the safe direction.** 0 vendor calls, live count unchanged (5 → 5). Nothing can be destroyed by a reused key because the intent bounds it. See NB-R3-1 for the reporting nuance. |
| **`releaseMailboxes({ ids: [] })`** | An empty explicit set falling through to the unfiltered "all live mailboxes" query — i.e. a downgrade becoming a teardown. | **HELD, and it is explicitly guarded** at `lifecycle.ts:219` with a documented early return. Worth noting how close this was: `{}` (teardown) and `{ids: []}` (nothing owed) are one falsy check apart, and the guard is what keeps them apart. |
| **The relative `{limit}` scope surviving somewhere** | A second caller still passing a relative selection into the executor. | **HELD.** The scope is deleted from the signature; `opts` is now `{ domainId?, ids? }`. Typecheck across 5 workspaces is clean, so no caller still passes `limit`. |
| **Unbounded growth of `mailbox_release_intents`** | INSERT-only with no prune, unlike `request_idempotency`'s 30-day TTL. | **HELD as a practical matter.** Rows are written only on a key's FIRST execution and only when it resolves ≥1 live mailbox, so growth tracks downgrades, not request volume — a retry storm writes nothing. See NB-R3-2 for the one place the schema comment overstates it. |

### N3 re-check (the claim surfaces changed again)
All accurate, and the round-2 gaps are closed: the MCP description now names
`unreleased`, says **"resend the identical request with the same key until
failedCount is 0"** (the safe instruction, which is now the *correct* one because
the retry is absolute), states that the recorded set wins over a changed count,
and says a genuine second downgrade needs a NEW key. `quote` → `billing` is
fixed. AGENTS.md and the openapi `Idempotency-Key` description carry the same
statement. I checked each claim against the code; each is true — **for
`count ≤ 20`.** Every one of them is silent on R3-1, which is the ordinary
consequence of a defect nobody knew about.

---

## R3 non-blocking

- **NB-R3-1 — a reused key after the 30-day ageout reports a success that did not
  happen.** Measured: `{"r":3,"f":0,"u":[]}`, 0 vendor calls, nothing released.
  The response is a true statement about the *recorded intent* ("3 of this
  downgrade's members are released") and the docs do say a second downgrade needs
  a new key — so this is coherent and safe-direction. But an agent that reused a
  key cannot distinguish it from a fresh success, and will believe it downgraded
  while continuing to pay. The clean fix is the one this codebase already named
  and then left with zero consumers: **`Collapsed<T>`'s `deduplicated` flag**
  (`packages/shared/src/provenance.ts:62`, round-1 NB-4). This is its first real
  consumer — wiring it here both closes this and retires that finding.
- **NB-R3-2 — the `mailbox_release_intents` schema comment slightly overstates its
  bound.** It says size is bounded by "the mailboxes a tenant has ever downgraded
  away, not by request volume". A *permanently stuck* mailbox is never released,
  so it is re-resolved under every subsequent NEW key and accumulates one row per
  key. Bounded by distinct keys, not by mailboxes. Small, but the comment is a
  claim.
- Round-2 residuals 1–3 and the round-1 non-blockers not addressed here still
  stand. Round-2 residual 1 (`commitD1Alert` losing `unhealthyObs`) was accepted
  in-code at `watchtower-infra.ts:75-79` — correctly documented as an accepted
  residual rather than silently dropped.

## R3 convergence note

The next round is scoped to **R3-1 only**. N1 is closed and must not be re-scored.
Re-verification needs exactly one thing beyond the battery: drive
`removeMailboxes` with a key at `count` = 21 **and** at the schema max of 60 and
show both return normally — the committed tests' fleets of 15 and 7 cannot see
this, so a green suite is not evidence for it.

---
---

# RE-ATTACK — round 4, 2026-08-18 (scope: R3-1)

**Ref:** same worktree, **HEAD `d6ba57a`** ("R3-1: chunk the remove-intent INSERT
at 20 rows"), one commit past `dd3a33a`. `git status --porcelain` empty at start
and end. Read-only git. One probe file written, executed, deleted.

## R4 VERDICT — and the verdict for the WAVE

# SHIP

R3-1 is closed. Every blocker raised across four rounds is now closed and
re-verified by the probe that originally reproduced it. The battery is green on
every leg with real exit codes. One new NON-BLOCKING note (R4-1) and the carried
non-blockers are listed below; none of them gates the deploy.

### Battery at `d6ba57a` — real exit codes, nothing piped

| Leg | Exit | Result |
|---|---|---|
| `npm run typecheck` (5 workspaces) | **0** | 0 × `error TS` |
| `npx vitest run` (apps/platform) | **0** | **186/186 files; 1766 passed / 1 skipped** |
| `npx vitest run` (apps/engine) | **0** | 140 passed / 4 skipped |
| `npm run build --workspaces` | **0** | `wrangler deploy --dry-run` + `tsc` clean |

Builder's claim (186f/1766p/1skip, typecheck 0) **confirmed exactly**.

## R3-1 — CLOSED ✅

The fix chunks at `RELEASE_INTENT_CHUNK_SIZE = 20`
(`remove-intents.ts:31-38`). The arithmetic is right and the comment shows its
work: 5 params/row with no fixed params ahead of them, so `floor(100/5) = 20` is
the exact ceiling — correctly distinguished from `sdn-list.ts`'s 16, which
rounds a 6-column remainder away.

**My round-3 requirement, driven independently of the committed tests** — every
chunk boundary, on a 60-mailbox fleet, through the production `removeMailboxes`
with a key:

| `count` | chunks | params in largest chunk | result | intent rows |
|---|---|---|---|---|
| **20** | 1 | **100 — the ceiling itself** | released 20, live 60→40 | 20 |
| **21** | 2 | 100 | released 21, live 60→39 | 21 |
| **40** | 2 | 100 | released 40, live 60→20 | 40 |
| **41** | 3 | 100 | released 41, live 60→19 | 41 |
| **60** | 3 | 100 | released 60, live 60→**0** | 60 |

Every one returns `failedCount: 0, unreleased: []` and releases exactly the count
asked for. `count: 21` — the exact value that threw
`too many SQL variables at offset 447` at `dd3a33a` — now completes. I re-ran the
ceiling control in the same file: 100 params still OK, 101 still throws, so the
boundary has not moved under me and `20` sits precisely on it rather than near it.

Two further properties I checked because chunking is where they could break:
- **No duplicate rows across chunks.** Intent row count equals target count at
  every size (20/21/40/41/60), so the `INSERT OR IGNORE` chunk loop is not
  double-writing a boundary row.
- **Replay of a full three-chunk intent.** A same-key retry after a completed
  60-member downgrade re-records nothing (rows 60 → 60) and re-drives nothing,
  returning `releasedCount: 60`. The chunking did not disturb the
  recorded-set-wins property N1 depends on.

### The allowlist entry is honest
`loop-isolation-scan.ts:180-186` adds the chunk loop with the reason *"one
logical `recordRemoveIntent` write split under the 100-bound-param ceiling, not
independent per-target items"*. Checked, and it is the correct call rather than a
papered-over HOL site: the chunks are parts of ONE write, so isolating a failing
chunk and carrying on is exactly the behaviour you do **not** want — it would
manufacture the half-written intent. Same category as `admin/db.ts`,
`demo.ts` and `sdn-list.ts`, which the list already carries. And because the
platform suite is green, `loop-isolation-coverage.test.ts`'s **stale-entry**
assertion passed, which means the entry matches a site the scanner really
detects — it is not a dead entry parked in the list.

### The committed tests are the right vehicle
`remove-mailboxes-idempotency.test.ts` gains HTTP-driven drives at `count: 21`
and `count: 60` that assert the live count, the intent row count, and a
zero-vendor-call replay. They are RED-proven against the unchunked code. Those
are better than my probes (they go through the route, not the engine function),
and they close the "a scale defect is invisible to a suite written from the bug
report" gap for this specific class.

### NB-R3-2 was fixed correctly
The `mailbox_release_intents` schema comment now says size scales with **distinct
keys**, not mailboxes, and explains the exact case I raised — a permanently
refused mailbox is re-resolved under every new key that targets it.

---

## R4-1 · NON-BLOCKING — the new atomicity comment overstates its guarantee

`remove-intents.ts:101-109` justifies chunking with:

> *"the guarantee was never 'one SQL statement', it's the Durable Object's INPUT
> GATE … there is no point between chunks for a crash to land on, so every chunk
> lands or none do, exactly as before chunking."*

The first half is right and is the reasoning I endorsed in round 3. The last
clause is not quite true, and I measured it. **DO SqlStorage writes DO survive an
exception raised later in the same turn and caught** — which is precisely what
`withRequestIdempotency` does with any throw out of `fn`:

```
PROBE: INSERT one intent row, then throw, then CATCH (as withRequestIdempotency does).
       Read back in a SEPARATE runInDurableObject turn:
       rows surviving a caught mid-turn throw = 1        (expected 0 if "none do" held)
```

So the guarantee covers a *crash* (turn never commits) but not a *caught throw
between chunks*. If chunk 2 threw and chunk 1 had landed,
`readRemoveIntent`'s early return would adopt the short set as the whole
downgrade on the retry: the customer's downgrade completes short, reports
`failedCount: 0`, and freezes as terminal — an under-release reported as success.

**Why this is NON-BLOCKING, stated as precisely as I can make it:** there is no
input-dependent way to make chunk 2 throw while chunk 1 succeeds. Every full
chunk binds identically 100 params and the final chunk is smaller, so the param
ceiling can no longer discriminate between them; `INSERT OR IGNORE` suppresses
the only constraint (the composite PK); the table has no other constraint and
every column is fed a non-null value derived once, outside the loop. What remains
is an infrastructure-level storage error landing exactly between two chunks —
which would almost certainly have hit chunk 1 as well. It is also strictly better
than `dd3a33a`, where `count ≥ 21` threw **every** time, and identical to it for
`count ≤ 20` (one chunk).

**Cheap hardening if anyone wants it, no redesign:** the function already ends
with `return readRemoveIntent(ctx, key)`. One length check on that read-back —
throw if it is shorter than `targets` — converts a silent short set into a loud
failure. I would pair it with deleting the key's rows so the retry re-resolves
rather than adopting the short set. Worth a follow-up line, not a round.

---

## Wave summary across four rounds

| Round | HEAD | Verdict | Blockers |
|---|---|---|---|
| 1 | `3d2c194` | NO-SHIP | B1 typecheck+suite RED at HEAD · B2 member 5 fixed at 1 of 3 sites · B3 partial release recorded terminal |
| 2 | `36bec2d` | NO-SHIP | B1/B2/B3 closed · **N1** — the B3 fix made an unbounded destructive retry loop (asked 3, measured 12 destroyed) |
| 3 | `dd3a33a` | SHIP-AFTER-FIXES | N1 closed · **R3-1** — the N1 fix re-committed the 100-bound-param class (threw at 21, `count` maxes at 60) |
| 4 | `d6ba57a` | **SHIP** | R3-1 closed. None. |

Every blocker was closed by a fix I then re-verified with the probe that
originally reproduced it, not by a green suite. Three of the four rounds found
that **the previous round's fix bred the next blocker** — worth remembering when
this pattern recurs: a fix to a correctness invariant deserves the same attack
budget as the original code, and the last fix is always the prime suspect.

## Residuals carried into the deploy (none gating)

1. **R4-1** — the chunk-atomicity comment overstates its guarantee; unreachable
   by input. Cheap hardening above.
2. **NB-R3-1** — a key reused after the 30-day `request_idempotency` ageout
   reports a success that did not happen (safe direction, documented). The clean
   fix is `Collapsed<T>`'s `deduplicated` flag, still the zero-consumer type from
   round 1 NB-4 — this is its first real consumer.
3. **R2 residual 1** — `commitD1Alert` throwing on a `pending` transition also
   loses `unhealthyObs`. Accepted in-code at `watchtower-infra.ts:75-79`,
   correctly documented as an accepted residual rather than dropped.
4. Round-1 NB-1, NB-6, NB-7, NB-10 and the three §6 NEW observations
   (`deliverability_actions` has no prune; the three new `*_FAILED` action kinds
   reach no watchtower check; `releasedCount`'s meaning change is undocumented on
   the wire) are untouched and still stand. The `*_FAILED`-reach-no-check item is
   the one I would put highest on a follow-up list: those three conditions are
   exactly what an operator would want paged on.

