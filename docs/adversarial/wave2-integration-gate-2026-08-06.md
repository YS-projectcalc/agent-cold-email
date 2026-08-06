# Wave-2 combined-diff integration gate — 2026-08-06

**Target:** worktree `/Users/yaakovscher/dev/coldstart-wt-integration2`, branch
`integrate/2026-08-06-wave2`, HEAD `22d792e` (re-verified at review END: still
`22d792e`, branch unchanged). Diff under review: `git diff 64d5eee..HEAD`
(9 commits — six lane merges + Inc-D + NEW-4/docs; 85 files, +7374/-365).

**VERDICT: NO-SHIP — 2 BLOCKING.**

Both blocking findings were reproduced by EXECUTION against real entry points
(the DO constructor via `evictDurableObject`, the signed `POST /webhooks/stripe`
route, and the real `runScheduledOpsSweep` cron function). Both are invisible to
the wave's own battery, which is genuinely green at this ref.

## Battery (run by this gate, at `22d792e`)

| Leg | Result |
|---|---|
| platform vitest (standalone) | 152 files / **1390 passed**, 0 failed, exit 0 |
| engine vitest | 16 files / **136 passed**, 2 files / 4 skipped, exit 0 |
| `npm run typecheck` ×5 | clean, all 5 passes |
| `npm run build` | clean (wrangler dry-run deploy succeeded) |

The suite being green is the point: neither blocking defect is expressible in
any existing fixture.

---

## BLOCKING 1 — the one-shot clock migration RETIRES the paying customer's real domain

**Lens 5 (fixture realism) + lens 6 (attack the design) + lens 2 (run it).**
**Verification: EXECUTED**, three independent entry points.

`engine/clock-migration.ts:151-159` retires every `source='provisioned'`,
`status='active'` domain that has no live non-`sandbox` mailbox attached:

```sql
UPDATE domains SET status = 'retired'
 WHERE tenant_id = ? AND source = 'provisioned' AND status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM mailboxes m
     WHERE m.domain_id = domains.id AND m.provider != 'sandbox' AND m.released_at IS NULL
   )
```

A domain with **zero mailbox rows** satisfies `NOT EXISTS` trivially, so it is
retired. That is exactly the stated shape of the real paying customer (real
domain adopted via the shipped path with `connection_type` recorded, ZERO
mailboxes), and it is also the documented mid-saga state of every provision:
`engine/mailbox-provisioning.ts`'s own invariant 2 says the `mailboxes` row is
inserted ONLY AFTER the vendor confirms the mailbox, so the entire window
between domain buy and mailbox-ready is "real domain, zero mailbox rows".

The code comment at `clock-migration.ts:135-150` states the correct requirement
— *"this must fail toward NOT retiring on that ambiguity"* — and then implements
a discriminator that fails toward RETIRING on the zero-mailbox case. The
mailbox-attachment check only protects a domain that already carries a live real
mailbox. **The hedge the builder wrote is precisely the hedge that does not hold
on the customer's shape.**

There is no available discriminator that would have worked:
`SandboxDomainPort.buy` returns `connectionType: "purchased"`
(`vendors/sandbox/domain-port.ts:67`), identical to the real port, and both
insert sites go through the same `provisioning.ts:265` statement with `source`
defaulting to `'provisioned'`. So this is a DESIGN gap, not a coding slip.

### Executed repros

| Entry point | Result |
|---|---|
| DO constructor (`evictDurableObject` → real constructor) | `clock_mode:'real'`, `dom_real` → **`retired`**, delta `-55,295,999,985` ms (≈ −640 d) |
| Real Stripe `checkout.session.completed` via `handleStripeWebhook` | `dom_real` → **`retired`** |
| Mid-saga shape (domain bought, mailbox unconfirmed) | `dom_real` → **`retired`** |
| **`runScheduledOpsSweep(env)` — the ordinary 5-min cron, no operator action** | `dom_real` → **`retired`** |

The cron result is the severity driver: the first scheduled tick after deploy
constructs every tenant DO, so this fires automatically within five minutes of
deploy, with no operator step and no way to intervene.

### Why it is unrecoverable

`'retired'` is terminal — grep of every `domains.status` writer
(`clock-migration.ts:152` → `'retired'`, `lifecycle.ts:251` → `'released'`,
`deliverability-actions.ts:126/262` → `'burning'`/`'paused_primary'`) finds
**no writer anywhere that sets a domain back to `'active'`**. And the migration
is one-shot, guarded by `clock_mode != 'real'`, which the same transaction
stamps — so it cannot be re-run to correct itself.

Executed downstream probe (`ORPHAN-PROBE`):

- `activeForCap: 0` — `engine/quota.ts:57` counts only `status='active'`, so the
  platform now believes the tenant owns **zero** domains and a subsequent
  `setup_infrastructure` passes the provisioning cap.
- `inDedupeSet: 1` — `engine/provisioning.ts:40`'s `ownedDomainNames` is
  status-BLIND, so the retired name stays excluded from lookalike candidates and
  the next provision buys a **different** domain. With the registrar armed
  (2026-07-29) that is real second spend, while the paid-for domain is orphaned.
- `blocksReadoption: 1` — `engine/provisioning.ts:65`'s `findAdoptableDomain`
  treats anything not `'released'` as already-tracked, so the adopt-before-buy
  RECOVERY path can never bring it back either.

Net: the customer's paid-for domain is silently marked retired, still registered
and billed at the vendor, invisible to the platform's active set, and
recoverable only by hand-SQL against his DO.

### Sibling in the same class (same root cause, narrower reachability)

The provenance backfill's catch-all (`clock-migration.ts:85-88`) resolves ANY
unclassified row to `provider='sandbox'`, and the retirement then sets
`released_at` + `deliv_status='paused'`. EXECUTED (`PRESLOT-MAILBOX`): a REAL
provisioned mailbox whose `slot_counted` reads the column DEFAULT `0` comes out
`{provider:'sandbox', released_at:<set>, deliv_status:'paused'}` — permanently
disabled (the design review's own round-2 note establishes `'paused'` is STICKY:
zero writers of `='healthy'` anywhere), dropped from the billing meter
(`COUNT(*) WHERE released_at IS NULL`) and from send eligibility.

**The root defect both halves share:** the migration resolves "unknown
provenance" to "sandbox" (destructive) when a fail-safe option was already in
hand. `schema.ts`'s own `provider` comment argues that `''` is load-bearing
BECAUSE the eligibility picker excludes it — i.e. leaving a row unclassified is
already safely non-sending. Retiring on unknown buys nothing and costs the
customer's real resources.

Reachability caveat, stated honestly: the MAILBOX half needs a real InboxKit
mailbox row predating the `slot_counted` column, and the builder's own comment
claims production has never migrated a tenant with any real mailbox provisioned
— that population may be empty today. The DOMAIN half is **not** empty: the
paying customer's domain is stated to exist, and the mid-saga shape is
structurally reachable for every future paid tenant.

---

## BLOCKING 2 — one global event watermark across six independent lanes silently drops the chargeback freeze AND a paid checkout

**Lens 7 (regression ring) + lens 6 (attack the design) + lens 8 (money/compliance surface).**
**Verification: EXECUTED** through the real signed `POST /webhooks/stripe` route.

The F3 fix stores a SINGLE watermark row (`billing_event_order`, `id=1`) and
refuses any handled event whose `created` is below it
(`engine/billing.ts:374-380`, applied at `:477` on first delivery and at `:462`
in the completion pass). `HANDLED_STRIPE_EVENT_TYPES`
(`billing/stripe-webhook.ts:37-44`) contains all six subscribed types.

But those six types are **independent state machines** on independent Stripe
objects — a Dispute, a Subscription and an Invoice have no causal ordering
relationship with each other. Stripe does not guarantee cross-object delivery
order, and this wave's own finding-2 mechanism (any handler throw → 500 →
redelivery hours later) manufactures out-of-order delivery as a routine event.
The watermark is monotonic and never resets, so **once any handled event at time
T is applied, every handled event emitted before T is permanently refused, in
every lane.**

### Executed repro A — the chargeback freeze is dropped

Real route, real fixtures (`postDisputeWebhook` / `postWebhook`):

1. `checkout.session.completed` at `T0` — applied.
2. `customer.subscription.updated` (status `active`, a routine renewal) at
   `T0+300` — applied, watermark := `T0+300`.
3. `charge.dispute.created` emitted at `T0+120`, delivered third.

Response: `{"received":true,"applied":false,"duplicate":false,"stale":true}`,
HTTP **200**. Profile: `billing_state` stays **`"active"`** — expected
`"disputed"`.

The D5 chargeback lane is the control whose own code comment says *"a dispute
WAVE could get our whole master Stripe account frozen, so we freeze the
disputing tenant FAST"*. It never fires. There is **no alert** on a stale
refusal (grep for `stale` in `routes/webhooks.ts` and
`billing/webhook-routing-alert.ts` returns nothing), and there is **no
self-heal**: Stripe redelivers the same event with the same `created`, so every
retry is refused forever, and a later `charge.dispute.closed` (won) is a no-op
because its `UPDATE` is scoped `WHERE billing_state = 'disputed'`.

**This is a regression introduced by this wave.** Before the watermark existed
the dispute applied.

### Executed repro B — a paid checkout is dropped

Same mechanism, money-in direction. `customer.subscription.updated` at `T0+300`
delivered before `checkout.session.completed` emitted at `T0`:

Response: `{"applied":false,"duplicate":false,"stale":true}`, HTTP 200.
Profile shows **`screened_at: null`** — the OFAC screening never ran.

The refusal skips the checkout branch's ENTIRE effect set: customer/subscription
id capture, discount capture, `clearTeardownRecord`, `reactivateFromDunning`,
`recordDunningCycleBasis`, the event-keyed ledger credit row, `screenTenant`
(the compliance gate), and `captureSubscriptionState`. That is the same
fail-OPEN compliance loss finding 2 was written to close, reintroduced through a
different door — and the platform itself generates `customer.subscription.updated`
events routinely via `syncMailboxQuantity`, so the watermark advances on its own
schedule.

**Design statement:** the schema comment scopes the intent correctly — stop a
stale `invoice.payment_failed` regressing a RECOVERED payer, i.e. ordering
WITHIN the billing-state lane. It was implemented as a global cross-lane
watermark. The refusal rule is right for same-lane supersession and wrong for
cross-lane, where the older event carries information the newer one does not
replace.

---

## Attacks that FAILED (what makes the non-blocking parts meaningful)

| # | Lens | Attack | Why it held |
|---|---|---|---|
| 1 | 4 deploy/arm | New DO columns unreachable on existing DOs | All five (`provider`, `clock_mode`, `clock_migration_delta_ms`, `clock_migrated_at`, `push_seq`) have `addColumnIfMissing` entries (`tenant-do.ts:334-352, 373`); the four new tables are `CREATE TABLE IF NOT EXISTS` inside `TENANT_DO_SCHEMA`, which runs on every construction |
| 2 | 4 deploy/arm | D1 migration 0016 not applied / applied after deploy | `apps/platform/package.json:8` — `wrangler d1 migrations apply … --remote && wrangler deploy`. Migration precedes deploy; ordering correct |
| 3 | 4 deploy/arm | `AUTOSEND_DISABLED` unarmable (the NEXT_PUBLIC-style gap) | Declared `env.ts:210`, documented `ACTIVATION.md:75,79`; suppression-only so no `wrangler.toml` entry is needed — it ships unset by design and is set via `wrangler secret put` |
| 4 | 2 run it | Kill switch does not actually silence the leg | EXECUTED `runSendPipelineAllTenants` with `AUTOSEND_DISABLED='1'` → `{disabled:true, tenantsScanned:0}`; `runScheduledOpsSweep` still completed every other leg |
| 5 | 2 run it | First live cron cycle sends / storms alerts / blows the budget | EXECUTED `runScheduledOpsSweep` on a 13-tenant population (12 demo + 1 paid) after evicting all DOs: zero sends, paid `clock_mode → 'real'`, demo stays `'virtual'`, whole sweep 413 ms |
| 6 | D | The five-rung ladder assertions do not pin the constants | They import the real symbols and compare them (`send-pipeline-budget.test.ts:178-199`): `100s < ENGINE_REQUEST_TIMEOUT_MS(120s) < BUDGET(135s) <= DEADLINE(150s)`, `150+135=285 < CRON_PERIOD(300s)`, `120s < SEND_CLAIM_TTL`. Reverting the timeout to 180s breaks rung 3 |
| 7 | C | Double-send at the new 120s/135s/300s constants | The 120s abort surfaces as a RETRYABLE `VendorError`; the engine's send idempotency answers a retry `409` (in-flight) and returns the SAME cached Message-ID, and `424 SendUnverifiedError` grades PERMANENT so a dangling dispatch is DROPPED rather than duplicated. `withTenantBudget` abandons but never cancels, and every effect the abandoned RPC can still land is behind the atomic row claim |
| 8 | 8 money | Guarded re-buy can spend more than once | Cap enforced at `mailbox-provisioning.ts:263` (`attempts >= MAX_BUY_DISPATCHES=2`); `claimBuyDispatch` increments BEFORE the spend in one `UPDATE … RETURNING` statement, so two concurrent provisions cannot both read the same count |
| 9 | 8 money | A false "absent" verdict drives a real re-buy | A non-exact keyword hit THROWS from `findExactMailbox` → caught as `{unconfirmed, lookup_failed}` → never spends. Absence additionally needs two agreeing polls AND `ABSENCE_MIN_AGE_MS` (15 min) measured on `RealClock`, not the tenant-controllable virtual clock |
| 10 | F | Vendor-name leak on the full tree | Tripwire widened to `packages/shared/src` and passes; independent grep for `inboxkit\|namecheap\|mailgun\|sendgrid\|postmark` across `apps/platform/src` + `packages/shared/src` + `apps/dashboard/src` outside `vendors/` and the allowlist returns **comments only**. New customer-visible string `retrySetupMessageBody` uses the abstract `step` label, never `err.message` |
| 11 | 7(i) | Completion pass + `reconcileClockWithDurablePlan` + F3 compose wrongly | The completion pass re-checks staleness before finishing (`billing.ts:462`), and `reconcileClockWithDurablePlan` reads plan from DISK rather than the call's result — a superseded checkout leaves `plan='free'` so no flip occurs. (The refusal rule itself is BLOCKING 2, but the composition is right.) |
| 12 | — | Duplicate `applyStripeWebhookEvent` definition | **Self-refuted.** Two reads disagreed because my shell's cwd had drifted to the main repo (`/Users/yaakovscher/dev/coldstart` @ `c82564e`, pre-wave code). Re-grounded with absolute paths; the review worktree has exactly one definition and was never mutated |

---

## NON-BLOCKING

1. **Citation to a file that does not exist.** `vendors/real/email-port.ts:60`
   says *"test/send-pipeline-ladder.test.ts asserts the whole ladder"*. No such
   file — the assertions are in `test/send-pipeline-budget.test.ts:166-199`. The
   control exists; only the pointer is wrong. Verification: read + `ls`.
2. **Orphaned schema comment.** `schema.ts:528-539`'s "Event-ordering watermark
   for billing-state transitions" block runs straight into the dunning-cycle
   comment at `:540` with no separator, so it documents
   `CREATE TABLE dunning_cycle_basis`; `billing_event_order` below carries no
   header of its own. Verification: read.

## UNVERIFIABLE (not folded into the verdict)

1. **Real Stripe cross-object delivery ordering frequency.** BLOCKING 2's
   mechanism is proven; how often production delivers out of order is not
   measurable here. Resolved by: the Stripe dashboard delivery log, which shows
   per-delivery timestamps and our response bodies.
2. **The paying customer's actual live row shape.** I seeded the shape named in
   the brief. Whether his tenant today has exactly zero mailboxes, and whether
   any pre-`slot_counted` real mailbox rows exist anywhere in production,
   needs a read against the live DO. Resolved by: a read-only probe of his
   `domains`/`mailboxes` rows before deploy — worth doing regardless, since this
   migration cannot be re-run.
3. **Live-surface drive (lens 3).** No running service in this environment; all
   execution was through the in-process Workers test harness against the real
   route/RPC/cron functions, not a deployed URL.
4. **InboxKit `/mailboxes/list` keyword-index lag.** `ABSENCE_MIN_AGE_MS`'s own
   comment admits the premise is unverified against a live account. 15 min is
   conservative and fails toward not re-buying, so it is not a finding — but it
   remains an unverified vendor premise.

## Suggested disposition (the gate flags; it does not fix)

- BLOCKING 1: make the retirement require positive evidence of sandbox origin
  rather than absence of contrary evidence, and leave unknown-provenance rows
  unclassified (`''`) — which the eligibility picker already excludes — instead
  of retiring them. Whatever the fix, re-attack the zero-mailbox and mid-saga
  shapes specifically; no current fixture expresses either.
- BLOCKING 2: scope the watermark per lane (or per event type) rather than one
  global row, and alert on a stale refusal instead of answering a silent 200.

---

# ROUND 2 — re-gate of the two blockers

**Target:** same worktree, branch `integrate/2026-08-06-wave2`, HEAD **`27ba269`**
(one commit atop `22d792e`, 7 files, +389/−110). Re-grounded at round-2 start
AND at round-2 end: still `27ba269`, branch unchanged, `git status` clean.
Scope per the convergence contract: **my two round-1 findings only**, judged
against the round-1 checklist, plus the new surface each fix creates. Anything
outside that is listed separately as NEW and carries no verdict weight.

**ROUND-2 VERDICT: SHIP.** Both BLOCKING findings are CLOSED, verified by
re-executing my exact round-1 repros. Every original F3 protection re-verified
intact. Three items are reported as NEW/residual below — none of them is a
regression of either fix, and none blocks this wave.

## Battery at `27ba269`

| Leg | Result |
|---|---|
| platform vitest (standalone) | 152 files / **1393 passed**, 0 failed, exit 0 |
| `npm run typecheck` ×5 | CLEAN ×5 |
| `npm run build` | CLEAN |

(152 files / 1393 vs round-1's 152 / 1390: the fix added 3 tests to two existing
files. The run started before my throwaway files existed, so the number is the
project's own, not inflated by mine.)

## BLOCKING 1 — CLOSED

Fix: `clock-migration.ts` retirement now additionally requires
`EXISTS (SELECT 1 FROM mailboxes m WHERE m.domain_id = domains.id AND m.provider = 'sandbox')`
(positive evidence), and the provenance catch-all `UPDATE … SET provider='sandbox'`
is DELETED — only the two positive signals (`source='byo_connected'` → `'byo'`,
`slot_counted=1` → `'google'`) back-fill; everything else stays `''`.

My exact round-1 repros, re-executed — all now pass, and the summary dropped its
`classified.sandbox` counter, so the deletion is real rather than bypassed:

| Repro | Round 1 | Round 2 |
|---|---|---|
| A1 Mordy shape, real DO constructor | `retired` | **`active`** (clock still flips to `real`) |
| A2 Mordy shape, checkout webhook | `retired` | **`active`** |
| A3 mid-saga (domain bought, mailbox unconfirmed) | `retired` | **`active`** |
| A4 ordinary 5-min cron, no operator action | `retired` | **`active`** |
| A5 sibling: real mailbox predating `slot_counted` | `provider:'sandbox'`, `released_at` set, `paused` | **`provider:''`, `released_at:null`, `deliv_status:'healthy'`** |

### New-surface attacks on the fix — all HELD

- **Does it still retire what it SHOULD?** EXECUTED: a genuine sandbox-era
  domain carrying a `provider='sandbox'` mailbox is still `retired`, and its
  mailbox still `released_at` + `paused`. The fix does not under-retire the case
  NEW-4 was written for.
- **Under-retention now possible?** EXECUTED: a sandbox-era domain with ZERO
  mailboxes is now left `active`. **Harmless, and NEW-4's rationale still
  holds** — the hazard NEW-4 named is `evaluate()` reaching
  REPLACE_DOMAIN/HARD_PAUSE_DOMAIN on a phantom domain, but that path is gated
  by `if (d.sends < thresholds.minSampleSends) continue`
  (`deliverability.ts:191`) and `gatherDomainStats` sums over mailboxes filtered
  `released_at IS NULL`. A domain with no mailboxes has no sends and can never
  reach a burn decision. The aggregate hazard is in fact already closed by the
  MAILBOX retirement alone; the domain retirement is belt-and-braces.
- **Mixed attachment.** EXECUTED: a domain carrying BOTH a `'sandbox'` mailbox
  and an unclassified (`''`) LIVE mailbox is NOT retired — `provider != 'sandbox'`
  matches `''`, so the `NOT EXISTS` leg fails. Correct, safe direction.
- **Does any path still ASSUME `provider` is classified post-migration?** Swept
  every consumer outside `vendors/`. Only three differentiate: the eligibility
  picker (`mailbox-eligibility.ts:58`) explicitly excludes `''`;
  `ops-summary.ts:277`'s `mailboxProvenance` deliberately surfaces the raw
  columns (it IS the U2 human-resolution path); and
  `mailbox-credential-push.ts:229` skips only `'sandbox'` — but neither push
  path can reach a pre-existing `''` row (`maybePushProvisionedMailbox` runs at
  provision time on a record whose provider is always stamped at insert, and
  `reconcileMailboxCredentialPushes` is scoped to rows already in
  `mailbox_cred_pushes`). No path assumes classification.

## BLOCKING 2 — CLOSED

Fix: `billing_event_order` re-keyed to one row PER LANE (`billing` =
checkout/subscription/invoice; `dispute` = `charge.dispute.*`), and refusal now
requires BOTH (1) older than that lane's mark and (2) an actual `billing_state`
conflict (`intendedBillingState` vs current). Stale refusals now fire
`alertUnroutableStripeEvent` from `routes/webhooks.ts`.

My exact round-1 repros, re-executed through the real signed
`POST /webhooks/stripe`:

| Repro | Round 1 | Round 2 |
|---|---|---|
| B1 late-arriving earlier-emitted `charge.dispute.created` | `{applied:false, stale:true}`, `billing_state:'active'` | **`{applied:true, frozen:true}`, `billing_state:'disputed'`** |
| B2 checkout after a later subscription event | `{applied:false, stale:true}`, `screened_at:null` | **`{applied:true}`, `screened_at` SET** |

### Original F3 protections — all re-verified INTACT (EXECUTED)

- **Stale `invoice.payment_failed` after a recovery**: a DISTINCT failure
  emitted before the recovery, delivered late → `stale:true`, `billing_state`
  stays `'active'`. Held.
- **Canceled-tenant resurrection via the COMPLETION PASS**: half-applied
  checkout (claim + in-flight marker) + a later `subscription.deleted`, then the
  redelivery → refused, tenant stays `canceled`/`free`. Held.
- **Ties apply**: `payment_failed` at the same `created` second as the recovery
  → `applied:true`, `past_due`. Held.
- **Unordered applies without advancing**: event with `created` deleted →
  `applied:true`, and the `billing` lane mark stayed at its prior value. Held.

### New-surface attacks on the two-condition rule

- **Stale `dispute.closed(won)` lifting a NEWER freeze** — EXECUTED: refused
  (`stale:true`), tenant stays `disputed`. HELD. This is condition (2) doing
  real work: intended `'active'` vs current `'disputed'` is a genuine conflict.
- **Stale checkout after a cancellation** — EXECUTED: refused, stays
  `canceled`/`free`. HELD.
- **Builder's flagged residual (stale non-conflicting checkout overwriting
  `stripe_subscription_id` via COALESCE)** — CONFIRMED PRE-EXISTING ON MAIN, not
  a regression. `git show c82564e:…/billing.ts` has the identical
  `stripe_subscription_id = COALESCE(?, stripe_subscription_id)` at line 371 and
  **zero** occurrences of `isStaleBillingEvent` — so on main EVERY late checkout
  applies and overwrites. This fix strictly NARROWS the window (a conflicting
  stale checkout is now refused). Correctly ledgered separately.

---

## NEW / residual (reported separately — no verdict weight, per convergence discipline)

**N-1 (residual of BLOCKING 2's fix, NON-BLOCKING) — within the dispute lane,
distinct dispute OBJECTS still share one watermark.** EXECUTED: dispute A opens
(T+200) and is WON (T+800) → `billing_state` back to `'active'`; a genuine,
DISTINCT dispute B on a different charge, emitted at T+400 and delivered after
A's closure, is refused (`stale:true`) and the tenant is NOT frozen.
Condition (2) does not save it because A's win moved the state back to
`'active'`, making B's `'disputed'` a "conflict". **Reachability is narrow:** it
needs B's delivery delayed past A's RESOLUTION. Stripe retries for roughly 3
days while disputes typically resolve in weeks, so the window is a fast-closed
inquiry plus a multi-day retry backoff — not empty, but not the common case.
**Materially lower severity than round-1's version: this now ALERTS** (the
refusal path fires `alertUnroutableStripeEvent`), so it is visible rather than
silent. Fix direction if pursued: key the dispute lane's mark per dispute id, or
skip condition (2) for `dispute.created` (a freeze is never a regression).

**N-2 (pre-existing within the wave at `22d792e`, NOT a round-2 regression) — a
REFUSED stale `invoice.payment_failed` still counts as a dunning strike.**
EXECUTED: after a recovery, three DISTINCT stale failures each returned
`stale:true` and changed no state, yet
`SELECT COUNT(*) … type='invoice.payment_failed' AND rowid > basis` returned
**3**. Cause: `applyStripeWebhookEvent` claims the event into `webhook_events`
BEFORE the staleness check — verified identical at `22d792e`
(claim at :445, stale check at :477), so the round-2 fix did not introduce it;
the wave's staleness guard did, by creating the first-ever divergence between
"recorded" and "applied". Consequence: `ops-summary.ts:199`'s
`billingFailureCount` inflates, so a customer who recovered can be suspended on
their FIRST genuine subsequent failure — the exact grace-period skip audit
finding 6 was written to fix. Only bites once the tenant is genuinely
`past_due` (the dunning sweep only visits past_due tenants), which is why this
is a real but second-order defect. Fix direction: count only APPLIED failures
(a flag on the row, or record the claim after the staleness decision).

**N-3 (NOT reachable for this ship; standing hazard) — `billing_event_order`
changed PRIMARY KEY within the wave, and `CREATE TABLE IF NOT EXISTS` never
alters an existing table.** EXECUTED: a DO carrying the `22d792e` shape
(`id INTEGER PRIMARY KEY CHECK (id=1)`) answers HTTP **500** on the next billing
webhook with `Error: no such column: lane at offset 57: SQLITE_ERROR`. There is
no `addColumnIfMissing`-style handling and no table-reshape migration path.
**Not reachable for this ship** — `billing_event_order` was introduced at
`22d792e`, which is unmerged and undeployed, so no production DO holds the old
shape. It matters in two ways: (a) if `22d792e` ever reached a preview/staging
environment, those DOs' billing lanes are hard-broken until the table is
dropped; and (b) it is a standing hazard — once this wave ships, any future
re-shape of `billing_event_order`, `webhook_event_inflight`,
`dunning_cycle_basis` or `mailbox_buy_dispatches` has the same failure with no
migration mechanism, and the test suite cannot catch it because every test DO is
created fresh from the current schema.

## Round-1 non-blocking items

- Orphaned schema comment (round-1 NON-BLOCKING 2): **FIXED** — the
  "Event-ordering watermark" block now sits above `billing_event_order`.
- `email-port.ts:60` citing the non-existent `test/send-pipeline-ladder.test.ts`
  (round-1 NON-BLOCKING 1): still present at `27ba269`. Cosmetic.

## UNVERIFIABLE (carried forward, unchanged)

Real Stripe cross-object delivery-order frequency; the paying customer's actual
live row shape (**still the highest-value pre-deploy action: read his
`domains`/`mailboxes` rows before deploying, because this migration cannot be
re-run**); live-surface drive against a deployed URL; the InboxKit
`/mailboxes/list` keyword-index lag premise behind `ABSENCE_MIN_AGE_MS`.

## FINAL VERDICT FOR THE WAVE: **SHIP**

Both blockers are genuinely closed — re-derived by executing the same repros
that failed in round 1, not by re-reading the diff — and neither fix broke what
it was built on top of (all four original F3 protections re-verified by
execution). N-1 and N-2 are real defects worth ledgering, but both are narrow,
N-2 pre-dates the round-2 fix, and N-1 is now alerted rather than silent. N-3 is
not reachable for this ship.

