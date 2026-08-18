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

