# Adversary gate — BYO teardown lane (2026-08-06)

**Ref:** worktree `/Users/yaakovscher/dev/coldstart-worktrees/byo-teardown`, branch
`byo-teardown-2026-08-06`, HEAD `369bfdca691ca2d2f1e1dbf3e28be17181812676`.
Diff under review: `git diff main...byo-teardown-2026-08-06` — 4 files,
+520/-28 (`engine/byo-intake.ts`, `engine/byo-teardown-alert.ts` (new),
`engine/lifecycle.ts`, `test/lifecycle-byo-teardown.test.ts`).
Tree verified clean before and after review; git read-only throughout.

## VERDICT: **SHIP** — 0 blocking, 4 non-blocking.

The founder ruling is genuinely enforced, and the enforcement survived every
destructive-direction attack I could construct. No path was found by which a
`connected`/`unknown` domain or a `provider='byo'` mailbox reaches a vendor
release, and no tenant-controlled path was found that flips an existing
`purchased` row to `connected`. The four findings below are real but none of
them breaks the ruling; two are surface/copy defects, one is a discriminator
choice that leaves a narrow legacy subset uncovered, one is stale comments.

## Battery (re-derived, not accepted)

| Check | Command | Result |
|---|---|---|
| Lane tests | `npx vitest run test/lifecycle-byo-teardown.test.ts` | 1 file, **10/10 passed** |
| Full platform | `npx vitest run` (apps/platform) | **153 files, 1403 tests, all passed** (501s) |
| Typecheck | `npm run typecheck` (root, 4 workspaces) | **clean** — engine, platform, cli, shared |

Builder's claim of `153f/1403t` is exact.

**Revert-fail independently confirmed** (in an isolated `git archive` sandbox with
symlinked `node_modules`, never in the shared worktree): reverting **only** the
mailbox gate (`if (m.provider !== "byo")` → unconditional release) turns exactly
2 tests RED and leaves 8 green —

```
× teardown issues ZERO mailbox.release calls for a byo mailbox …
× the REPLACE_DOMAIN call surface … likewise never vendor-releases a byo mailbox
AssertionError: expected [ 'sales@byo-connected.com', …(1) ] to deeply equal [ 'sales@vendor-owned.com' ]
```

Reverting **both** gates turns 8/10 RED; the 2 that stay green are the
purchased-domain control and the intake-stamp assertion, which is correct.

---

## Findings

### F1 · NON-BLOCKING · The unresolved-connection-type action writes internal ops copy onto two CUSTOMER read surfaces

`lifecycle.ts:326-328` calls `logAction(ctx, "DOMAIN_TEARDOWN_UNRESOLVED_CONNECTION_TYPE", …)`,
which inserts into `deliverability_actions` (`deliverability-actions.ts:40`). That
table is read verbatim by `engine/activity.ts:62-63` (the tenant's `activity`
tool / dashboard feed) and `engine/reporting.ts:150-162` (the tenant report).

**Verification method — executed.** A probe teardown with one NULL-`connection_type`
domain, then reading the two engine functions the routes call:

```
activity item: {"kind":"deliverability","label":"DOMAIN_TEARDOWN_UNRESOLVED_CONNECTION_TYPE",
 "target":"legacy-leak.com","detail":{"reason":"teardown reached this domain with no recorded
 connection type; treated as connected (never released) — a human should confirm at the vendor"}}
report action: { …identical detail… }
```

`routes/activity.ts` has **no lifecycle-freeze guard**, so a canceled or
abuse-terminated tenant can still read this back.

**Failure scenario:** a customer cancels; their own activity feed tells them we
do not know whether we own their domain and that "a human should confirm at the
vendor" — internal operational uncertainty and an internal instruction, rendered
as customer-facing copy.

**This is a named, previously-ruled class.** `docs/adversarial/warmup-wave-final-review-2026-08-02.md:91`
(finding N-b) established it for `WARMUP_CANCEL_GAVE_UP`, naming the same two
readers, and `engine/ops-summary.ts:247-252` carries the ratified remedy comment:
"that table is read by the tenant's activity feed and report — surfaces the
CUSTOMER sees and cannot act on." The new build applies half the remedy (it does
email the founder, which N-b's subject did not) but reintroduces the customer-side
half, and unlike N-b's remedy the new action is **not** counted in the owner
digest's `actionsInWindow`.

Vendor-identity leak specifically does NOT occur — the string says "the vendor"
generically, so `vendor-failure.ts`'s founder rule and its tripwire hold.

**Suggested direction:** keep the row (it is a useful audit trail) but move the
operator instruction into the email only, leaving a customer-safe detail; or
route the ops half through `ops-summary.ts` the way N-b's remedy did.

---

### F2 · NON-BLOCKING · The unknown-domain alert fires PER DOMAIN, serialized, with no dedup

`lifecycle.ts:329` — `await alertUnresolvedDomainConnectionType(ctx, d.domain, mailer)`
sits **inside** the per-domain loop.

**Verification method — executed.** A probe tenant seeded with 12
NULL-`connection_type` domains, one teardown:

```
PROBE1 emails=12
PROBE1 activity rows=12
```

Twelve founder emails and twelve feed rows from a single cancel, each send
awaited serially inside the teardown.

**Why it matters:** every domain row written before `connection_type` existed
takes this branch, so the population is exactly "tenants provisioned before the
column shipped" — including the incident customer. The platform's own anti-spam
convention for repeated notices is a dedup key (`schema.ts:963-967`,
`tenant_messages.dedup_key`, added because "the exact unbounded-action-row class
the incident gate caught twice"); this alert has no equivalent. One email listing
the N unresolved domains carries the same information.

Bounded, non-destructive, and teardown is idempotent (the `teardown_records`
anchor means it runs once per tenant), which is why this is non-blocking.

---

### F3 · NON-BLOCKING · The mailbox gate keys on `provider`, where every sibling BYO gate in this codebase keys on `source='byo_connected'` — leaving legacy BYO rows exposed

`lifecycle.ts:216` gates on `m.provider !== "byo"`. Three other places treat
`source='byo_connected'` as the authoritative BYO discriminator:
`mailbox-eligibility.ts:59`, `warmup-cancel.ts:77`, and — decisively —
`clock-migration.ts:73-76`, whose own comment says `source = 'byo_connected'`
"can only ever be a customer's own connected mailbox … Neither is guessed."

`byo-mailbox-composition.ts:115` writes **both** columns, and it is the only
writer of either value. So `source` is a strictly stronger signal: always
present, never guessed, never written by a vendor path.

**Verification method — executed.** Probe seeding the exact pre-`provider`-column
row shape (`source='byo_connected'`, `provider` unset → column DEFAULT `''`) and
calling `releaseMailboxes` with a recording port:

```
PROBE4 mailbox release calls = ["owner@byo-legacy.com"]
```

The customer's own mailbox is handed to `MailboxPort.release`.

**Failure scenario at arming:** `RealMailboxPort.release` (`vendors/real/mailbox-port.ts:240-241`)
begins with `resolveMailboxUid(email)`, which the module documents as throwing
"PERMANENTLY while the mailbox is unlistable" (`:77-78`). A mailbox InboxKit never
issued is unlistable forever, so the release throws out of `releaseMailboxes` →
out of `teardownTenant` → the tenant's cancel (or an abuse-terminate) fails,
partially applied, and retries hit the same wall. Not vendor-destructive, but a
permanent teardown wedge on a customer-owned resource.

**Self-refutation (why NON-BLOCKING, not blocking):**
- Reachability is compound. It needs (a) a BYO mailbox connected between
  2026-07-17 (`217ca2b`, feature landed) and 2026-08-06 (`ce51294`, the commit
  that added the literal `provider='byo'`), **and** (b) a tenant whose one-shot
  clock migration never backfilled it, **and** (c) InboxKit armed.
- For a **paid** tenant, `tenant-do.ts:225` runs the migration on rehydrate and
  `clock-migration.ts:102` backfills `provider='byo'` from `source='byo_connected'`
  — so (b) requires the migration to fail persistently.
- For a **non-paid** tenant, `tenant-do.ts:223` (`if (!isPaidPlan(row.plan)) return virtual`)
  means the migration never runs — but `factory.ts:137` (`useSandbox = isDemoOrFree || …`)
  hands that tenant `SandboxMailboxPort`, whose release is an in-memory no-op.
  The non-paid escape route is inert.
- This is **not a regression**: on `main` every BYO mailbox took the vendor
  release. The diff strictly shrinks the exposed set. Grading it blocking would
  be scoring an improvement as a defect.

**Suggested direction:** one clause — gate on
`m.provider !== "byo" && m.source !== "byo_connected"` (requires adding `source`
to the SELECT at `lifecycle.ts:189`). The builder's stated risk-direction
argument ("skipping `''` would strand a REAL vendor resource") is sound for a
**bare** `''` row and I accept it; it does not apply to `'' + source='byo_connected'`,
which the migration itself treats as certain.

---

### F4 · NON-BLOCKING · Two load-bearing comments in the diff are false as of the same commit

1. `lifecycle.ts:283-284` — "'unknown' (no discriminator — every BYO row,
   **byo-intake.ts's registerByoDomain never sets this column**, AND any
   pre-existing legacy row)". `byo-intake.ts:192` in this same commit sets it to
   `'connected'`. The comment describes the pre-fix world and, read literally,
   tells a future maintainer that BYO domains ride the `unknown` backstop — which
   is precisely what this commit stopped being true.
2. `lifecycle.ts:170-171` — "every caller (teardownTenant AND
   deliverability-actions.ts's REPLACE_DOMAIN) inherits it". There are **three**
   callers: `engine/billing.ts:927` (`removeMailboxes`, the customer downgrade
   path) also calls `releaseMailboxes`. Behaviourally harmless — the gate is at
   the root, so it inherits correctly — but the enumeration is the evidence the
   comment offers for its own completeness claim, and it is short by one.

Verified by `grep -rn "releaseMailboxes" apps/platform/src` and by reading
`billing.ts:925-931`.

---

## Attacks that FAILED (what makes this SHIP mean something)

**Lens 1 — spec-vs-code trace.** Opened `schema.ts` and verified the builder's
claim that the `provider=''` invariant is real, not invented: `schema.ts:329-341`
literally contains "`''` IS LOAD-BEARING, NOT A BUG (adversary round-2, R8;
reaffirmed by the 2026-08-06 gate) … Do NOT 'fix' the `''` exclusion". The claim
is real and correctly cited.

**Lens 6 — attack the design: can a `purchased` domain be misclassified `connected`?**
Enumerated every writer of `domains.connection_type`. Exactly three:
`provisioning.ts:265` (INSERT), `byo-intake.ts:191` (INSERT), and
`domain-dns.ts:104-109` (the only UPDATE). The UPDATE is guarded by
`if (recorded !== "unknown") return recorded` (`domain-dns.ts:88`), so it can only
move `unknown → purchased/connected`, never `purchased → connected`. Both
`DomainPort.buy` implementations return `connectionType: "purchased"` hard-coded
(`inboxkit-domain-port.ts:219`, `sandbox/domain-port.ts:67`). **There is no path,
tenant-controlled or otherwise, that demotes a purchased row.** HELD.

**Tenant-controlled flip via BYO intake.** `registerByoDomain` performs an
INSERT with a fresh `newId("dom")` — it never UPDATEs an existing row, so a
tenant registering a domain they also purchased through us produces a second row
and the purchased row still releases. HELD.

**Teardown racing the wave-1 legacy classifier.** `teardownTenant` snapshots
`connection_type` in one SELECT (`lifecycle.ts:295-300`) and never re-reads. A
concurrent `resolveDomainConnectionType` can only write to a row the snapshot
already read as `unknown`, and the stale outcome is "don't release + alert" —
the safe direction, and alerted. The destructive direction is unreachable. HELD.

**Encoding / value-space abuse at the destructive branch.** Swept 14 hand-built
`connection_type` values through a real teardown: `"purchased"`, `"PURCHASED"`,
`" purchased "`, `"purchased "`, `"Purchased\n"` release; `"connected"`,
`"CONNECTED"` do not; `""`, `"   "`, `null`, `"purchase"`, `"byo"`, `"unknown"`,
`"own"` all fall to `unknown` and alert.

```
PROBE5 released=["v0-co.com","v1-co.com","v2-co.com","v9-co.com","v13-co.com"]
PROBE5 alerts=7
```

The `.trim().toLowerCase()` normalisation at `lifecycle.ts:304-305` is symmetric
and matches `domain-dns.ts:55-56`. No near-miss token reaches the release. HELD.

**Alert failure wedging teardown.** Injected a mailer whose `send` throws:

```
PROBE3 mailerCalls=1 domainsReleased=2 releaseCalls=["purchased-a.com"]
```

Teardown completed, the purchased domain still released, summary returned. The
`try/catch` at `byo-teardown-alert.ts:33-38` covers both sync throws and rejected
promises, and `createOpsMailer` (`ops-mailer.ts:84-86`) is a two-branch selector
that cannot throw, so the default-parameter evaluation is safe too. HELD.

**Local-cleanup completeness for skipped rows.** Traced every step in
`releaseMailboxes` against the gate: the `mailbox_cred_pushes` tombstone
(`:208-213`) is BEFORE the gate and synchronous; `slot_counted` accounting
(`:219`), `revokePushedMailboxCredentials` (`:222`), the `released_at` +
`deliv_status='paused'` mark (`:223-228`), `markMailboxIntentsReleased` (`:235`)
and `releaseMailboxSlots` (`:238`) are all AFTER or outside it. Only the single
`ctx.adapters.mailbox.release` line is conditional. `billableMailboxCount`
(`:128-131`) counts `released_at IS NULL`, so a byo row stops being billable
identically. Same for domains: the `UPDATE domains SET status='released'`
(`lifecycle.ts:334-338`) is outside the branch and runs for all three classes.
HELD.

**`revokePushedMailboxCredentials` on a BYO mailbox.** Reads
`mailbox-credential-push.ts:275-287`: it calls `client.removeMailbox(email)`
against OUR engine's credential store, gated on `client.isConfigured`, wrapped in
a swallow-and-log. It touches our stored copy only, never the customer's account.
Correct for BYO. HELD.

**Abuse-terminate inheriting the gates + severing send.** `terminateTenant`
(`lifecycle.ts:451-456`) calls the same `teardownTenant`, so both gates apply
identically. Send capability for a byo row is severed three ways over:
`released_at` set, `deliv_status='paused'`, tenant `status='suspended'` freezing
the tick — and `mailbox-eligibility.ts:59` excludes `source='byo_connected'`
outright in this build. HELD.

**Single vendor release call site.** `grep -rn "\.release("` across
`apps/platform/src` + `packages` returns exactly two sites, both in
`lifecycle.ts` (`:217` mailbox, `:308` domain), both gated. `applyReplaceDomain`
does no vendor domain release at all. HELD.

**Exactly two `domains`-row writers.** `grep -rn "INTO domains"` in `src`
returns `provisioning.ts:265` and `byo-intake.ts:191`. HELD.

**No per-mailbox liability booking.** Only one `ledger_entries` insert exists in
the teardown path and it is inside the `purchased` branch (`lifecycle.ts:312-321`),
keyed idempotently on `liability:<tenant>:<domainId>`. HELD.

---

## UNVERIFIABLE (not folded into the verdict)

1. **Whether `INBOXKIT_API_KEY` / `INBOXKIT_WORKSPACE_ID` are armed in prod.**
   `factory.ts:137` makes the mailbox port sandbox whenever `inboxKitConfig` is
   absent, so the entire mailbox half of this lane may currently be dark. This
   decides whether F3 is live or pre-arm-only. *Resolves by:* reading the
   deployed Worker's secret list.
2. **Whether any live tenant holds a pre-2026-08-06 BYO mailbox row with
   `provider=''`.** *Resolves by:* the U2 pre-arm provenance read
   (`ops-summary.ts` `mailboxProvenance`) across live tenants — the runbook
   ACTIVATION.md already prescribes.
3. **True cross-request DO input-gate interleaving of two concurrent teardowns.**
   My repro was a same-context re-entrant call, which hit
   `UNIQUE constraint failed: teardown_records.tenant_id` at `lifecycle.ts:367` —
   showing two full teardowns ran. That shape is artificial; the real interleave
   needs two HTTP requests against a live DO. Note the window is **not new**:
   `main` awaited `domain.release` in the same loop position. *Resolves by:* two
   concurrent `POST /cancel` against a deployed DO.
4. **Live-surface drive (lens 3).** No dev server or prod credentials here. I
   drove `getActivityFeed` / `getDeliverabilitySummary` / `teardownTenant` /
   `releaseMailboxes` — the engine functions the routes call — not the HTTP
   routes end-to-end. F1's leak is proven at the engine boundary; the rendered
   dashboard string was not observed.

---

## NEW — out of scope, no verdict weight

- **`REPLACE_DOMAIN` over-provisions a replacement for a BYO mailbox.**
  `deliverability-actions.ts:162-172` computes `inboxesEach` as
  `COUNT(*) FROM mailboxes WHERE domain_id = ?` with no `provider` /
  `source` filter, so a burned domain carrying 2 vendor + 1 byo mailbox
  provisions **three** paid vendor mailboxes on the replacement — we buy a
  billable mailbox to replace a customer-owned one we never paid for.
  Pre-existing on `main` (untouched by this diff), but this lane sharpens the
  asymmetry: we now correctly decline to release that mailbox at the vendor
  while still counting it as capacity to re-buy.
- **Teardown retains the customer's own SMTP password / OAuth refresh token.**
  `mailboxes.transport_json` (`byo-mailbox-composition.ts:113-127` writes the
  secret verbatim) is never cleared by `releaseMailboxes` or `teardownTenant`.
  After an abuse-termination we hold a live credential for an offboarded
  customer's own mailbox indefinitely. Pre-existing, and arguably the
  mirror-image of the risk the founder ruling addresses — worth a ruling of its
  own.
- **`registerByoDomain` has no duplicate/uniqueness check.**
  `byo-intake.ts:123-200` never checks whether the tenant already has a row for
  that domain, so a tenant can create unbounded `domains` rows for one name.
  Not destructive under the new gate (all such rows are `connected` and never
  released), but it inflates `domainsReleased`, the teardown alert volume, and
  `pickReplacementDomain`'s `owned` set.
- **`TeardownSummary.domainsReleased` now counts rows that were never released
  at the vendor** (`lifecycle.ts:360`, `domains.length`). The doc comment was
  updated to say "reclaimed", but the field name and the admin surface
  (`admin/terminate.ts:18`) still read as "released". No external doc asserts the
  stronger meaning (grep of `*.yaml`/`*.md`/`*.json` found only a panel-03
  archive reference), so this is naming drift, not a wrong number on a live
  surface.

---

## Method notes

- Git strictly read-only (`rev-parse`, `log`, `show`, `diff`, `status`, `archive`).
- All probe tests were written into `apps/platform/test/zzz-adversary-probe.test.ts`,
  executed, and **deleted**; `git status --porcelain` is empty at review close and
  HEAD is unchanged at `369bfdc`.
- The revert-fail proof ran entirely inside
  `git archive HEAD | tar -x -C <tmp sandbox>` with symlinked `node_modules` —
  the shared worktree source was never mutated.
- `npm run build` was deliberately NOT run (it regenerates committed dashboard
  bundle artifacts in a shared worktree — see the wave-2 gate's cleanup note).
