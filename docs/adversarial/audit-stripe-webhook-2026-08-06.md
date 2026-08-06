# Full-boundary audit — STRIPE WEBHOOK (signature verification + replay)

Gap #3 of the founder-ordered full boundary audit. Method: fault-inject the REAL entry point
(`POST /webhooks/stripe` driven through `SELF.fetch`), assert DURABLE state in the target TenantDO,
never trust a green sandbox.

- **Ground ref:** `git rev-parse HEAD` = `64d5eee46e1c8bc5d33bc10972aff179f04b4d7a` (main checkout,
  `/Users/yaakovscher/dev/coldstart`). Working tree clean apart from the pre-existing untracked
  `apps/platform/src/.claude/`.
- **Baseline suite at this ref:** `npx vitest run` (apps/platform) → **140 files / 1271 tests, 0 failures.**
  The suite is genuinely green and carries every defect below.
- **Method:** two throwaway attack files (`test/zz-audit-stripe-webhook.test.ts`,
  `test/zz-audit-stripe-webhook2.test.ts`, 15 executed attacks) driving the real Hono route and the real
  `TenantDO`. Both **DELETED**; no source edits; git read-only.
- **Live context:** live Stripe keys armed since 2026-07-23; first paying customer since 2026-07-28.
  This boundary guards real money state.

## VERDICT: **FAIL** — 3 BLOCKING findings

Highest-priority fix: **finding 1** — tenant resolution reads `data.object.metadata.tenantId`, a field only
2 of the 6 subscribed Stripe event types actually carry. The chargeback-freeze lane and (near-certainly) the
dunning lane are **dead in production**, silently, returning `200 {"applied":false}` on every real delivery.

---

## Findings

### 1 · BLOCKING · Tenant resolution depends on a metadata field that real invoice and dispute events do not carry — the dunning and chargeback lanes never fire in prod

**Lens:** 5 (fixture realism) + 1 (spec-vs-code line-trace).

`extractStripeTenantId` (`apps/platform/src/billing/stripe-webhook.ts:58-68`) resolves the tenant from
`event.data.object.metadata.tenantId`, falling back to `client_reference_id`. The only place either value is
ever set is `createStripeCheckoutSession` (`apps/platform/src/billing/stripe-client.ts:93-99`), which sets
`client_reference_id`, `metadata[tenantId]` **on the Checkout Session**, and
`subscription_data[metadata][tenantId]` **on the Subscription**. Nothing writes metadata onto an Invoice or a
Dispute — the app makes no Invoice or Dispute API calls at all (`stripe-client.ts` only touches
checkout sessions, prices, products, `GET /subscriptions`, and `POST /subscription_items`).

Against the six event types the switch handles (`apps/platform/src/engine/billing.ts:359-514`, matching the
six enabled on endpoint `we_1TvzMVIb6OQwXi7wi354H35z`):

| Event type | Carries `metadata.tenantId`? | Resolves? |
|---|---|---|
| `checkout.session.completed` | yes — we set session metadata + `client_reference_id` | ✅ |
| `customer.subscription.updated` | yes — we set `subscription_data[metadata]` | ✅ |
| `customer.subscription.deleted` | yes — same | ✅ |
| `invoice.payment_failed` | **no** — invoice metadata is its own; subscription metadata lands under `subscription_details.metadata` | ❌ |
| `charge.dispute.created` | **no** — a Dispute is created by Stripe from a charge, with `metadata: {}` | ❌ |
| `charge.dispute.closed` | **no** — same | ❌ |

**Failure scenario.** A real cardholder chargeback fires `charge.dispute.created`. The route verifies the
signature, resolves no tenant, and returns `200 {"received":true,"applied":false,"reason":"no tenant
reference on event"}`. `billing_state` never becomes `'disputed'`, the tick's freeze guard never engages,
and the disputing tenant keeps sending. The D5 chargeback lane exists specifically because "a dispute WAVE
could get our whole master Stripe account frozen" (`engine/billing.ts:457-461`, SPEC §12) — that control is
inert. Identically, a failed renewal fires `invoice.payment_failed`, resolves nothing, and the tenant never
goes `past_due`: no dunning email, no escalation, no suspension, and `last_decline_code` never recorded. A
customer whose card dies keeps full paid service indefinitely.

**Verification method — EXECUTED.** Delivered validly-signed realistic payloads through the real route:

```
A4 REALISTIC invoice.payment_failed   -> 200 {"received":true,"applied":false,"reason":"no tenant reference on event"}
   account after: billingState "active"   (unchanged — dunning never fired)
A4 REPO-FIXTURE invoice.payment_failed -> 200 {"received":true,"applied":true,"duplicate":false}
   account after: billingState "past_due" (the shape the tests use — and only that shape — works)
A4 REALISTIC charge.dispute.created   -> 200 {"received":true,"applied":false,"reason":"no tenant reference on event"}
   account after: billingState "active"   (freeze never fired)
```

The realistic invoice fixture carried `metadata: {}` plus `subscription_details.metadata.{tenantId}`; the
realistic dispute carried `id/charge/payment_intent/amount/reason/status` and `metadata: {}`.

**Why the green suite hides it.** Every in-repo fixture hand-places `metadata.tenantId` on the invoice or
dispute object — `test/webhook.test.ts:32-38`, `test/dispute.test.ts:20-21`,
`test/lifecycle-freeze.test.ts:49-51`, `test/lifecycle-digest.test.ts:52-54`. That is a shape Stripe never
emits for these objects. The tests pass by construction.

**Residual (state honestly).** The dispute half is certain from the object graph alone: a Dispute has no
parent-subscription metadata to inherit and no `client_reference_id`, and there is no
customer→tenant index to fall back on (the code comment at `stripe-webhook.ts:50-51` explicitly declines to
build one). The invoice half rests on Stripe copying subscription metadata to
`subscription_details.metadata` rather than `invoice.metadata` on modern API versions. **The code documents
its own unverified premise** — `stripe-webhook.ts:53-56`: *"per Stripe's invoice-metadata-inheritance
behavior, onto invoices raised from it — the exact inheritance shape is verified against real Stripe at
activation."* Activation happened 2026-07-23; there is no artifact anywhere in the repo recording that the
check was performed.

**60-second decisive check, zero risk:** Stripe Dashboard → Developers → Webhooks → the live endpoint →
recent deliveries → open any `invoice.payment_failed` or `charge.dispute.*` delivery and read the **response
body**. `{"applied":false,"reason":"no tenant reference on event"}` confirms; `{"applied":true}` refutes the
invoice half (the dispute half stands either way).

**Fix direction.** Resolve the tenant from more than one field: add
`data.object.subscription_details.metadata.tenantId` for invoices, and for disputes/charges add a
`stripe_customer_id → tenantId` D1 index (the platform already stores `stripe_customer_id` on
`tenant_profile`). A tenant-resolution miss on a *handled* event type should also alert rather than silently
200 — today an unroutable dispute is indistinguishable from an irrelevant event.

---

### 2 · BLOCKING · Guard-before-effect on the checkout path: the dedup claim commits before the effect, so an ordinary Stripe API hiccup permanently loses the event — including the sanctions-screening gate

**Lens:** 7 (regression ring — same class as the dunning F2 finding) + 2 (RUN it).

`applyStripeWebhookEvent` claims the event id **first** (`engine/billing.ts:347-355`,
`INSERT OR IGNORE INTO webhook_events`) and only then applies effects. Inside
`checkout.session.completed`, the effects run **after** an awaited Stripe round trip:
`captureSubscriptionState` at `:388-390` → `getSubscription` → `fetch` that **throws on any non-2xx**
(`billing/stripe-client.ts:234`). Everything after that await — `clearTeardownRecord`,
`reactivateFromDunning`, the ledger entry, and `screenTenant` (`:392-403`) — is lost when it throws, while
the dedup row and the `billing_state='active'` UPDATE have already committed.

**Failure scenario.** Stripe returns 429/500/503 (or the request times out) on `GET /v1/subscriptions/{id}`
during a real checkout webhook. The route 500s, Stripe retries the same event id, the retry short-circuits on
the dedup row and returns 200. Stripe's delivery log shows one failure then a success — it looks recovered.
Durably:

- `stripe_mailbox_item_id` stays **NULL**. `captureSubscriptionState` (`:616-632`) is its only writer and it
  is only reachable from this now-permanently-deduped handler; its only consumer,
  `syncMailboxQuantity`, bails at `:566` when it is null. Quantity billing for that customer is dead
  forever — they can provision up to 60 mailboxes and keep paying the checkout-time quantity.
- `screenTenant` never runs, so `screening_status` stays at the **default `'clear'`** and `screened_at` stays
  NULL. This is fail-**open** on a compliance control: the crashed tenant ends up *more* activated than a
  clean one, breaking the `isPaidPlanTier ⟹ screened-at-least-once` invariant that
  `docs/adversarial/ga-gates-design-review-2026-07-23.md:127` relies on.
- The checkout ledger entry is never written.

**Verification method — EXECUTED**, control vs. crash on two fresh tenants (the crash forced by pointing
`STRIPE_SECRET_KEY` at a bogus key so the real `getSubscription` call fails):

```
B1 CLEAN checkout    -> screening_status "review", screened_at 1786019150923, ledgerRows 2, ACTIVATED false
B1 crash delivery #1 -> 500 {"error":"internal error","code":"internal"}
B1 crash delivery #2 -> 200 {"received":true,"applied":false,"duplicate":true}     <-- retry is a NO-OP
B1 CRASHED checkout  -> screening_status "clear", screened_at null, ledgerRows 1, ACTIVATED true
B1 CRASHED after a later subscription.updated(active) -> screened_at STILL null, ledgerRows STILL 1
```

The retry returning `duplicate:true` proves the dedup row survived the throw — writes before the awaited
fetch are committed, exactly as the dunning F2 class predicted. `ACTIVATED true` on the crashed tenant vs
`false` on the clean one is the fail-open. No later event repairs it.

`invoice.payment_failed`, `customer.subscription.*` and the dispute cases are fully synchronous between claim
and effect, so this window is specific to `checkout.session.completed` — the one handler that takes real money.

**Residual.** Executed under vitest-pool-workers/miniflare; production workerd DO commit semantics are not
byte-identical. The direction is the same regardless: the awaited `fetch` at `:389` is an unambiguous
commit boundary *after* the claim.

**Fix direction.** Record the dedup claim **after** the effects, or reconcile: on a duplicate hit, re-derive
whether the effect actually landed (e.g. `stripe_mailbox_item_id IS NULL AND stripe_subscription_id IS NOT
NULL` ⟹ finish the job) rather than returning early. Move `screenTenant` and the ledger write ahead of the
Stripe round trip so an API hiccup cannot skip the compliance gate.

---

### 3 · BLOCKING · No event-ordering guard: a redelivered stale `invoice.payment_failed` de-activates and then suspends a current, paying customer

**Lens:** 6 (attack the design) + 7 (regression ring vs the 2026-08-06 dunning F3 fix).

No handler reads `event.created` or any sequence number; the last write wins.
`customer.subscription.updated` guards only against the frozen set
(`billing.ts:416-421`), and `invoice.payment_failed` writes `past_due` unconditionally outside that set
(`:449-453`). Stripe does not guarantee event ordering, and finding 2 above *manufactures* out-of-order
delivery: any event that 500s is redelivered hours later.

**Failure scenario.** A renewal fails → `invoice.payment_failed` is emitted (and its delivery 500s or is
simply delayed). The customer fixes the card; the subscription recovers and
`customer.subscription.updated{active}` lands, restoring `billing_state='active'`. Stripe then redelivers the
stale `payment_failed`. It applies. `billing_state` regresses to `past_due`, which fails the
`billingState === "active"` conjunct in `isTenantActivated` (`engine/activation.ts:34-41`), so on the very
next `buildAdapters()` the tenant's **real vendor adapters are swapped for sandbox ones** — a paying
customer's campaigns silently stop reaching real inboxes. Nothing self-heals: Stripe emits no further
`customer.subscription.updated` because nothing changed on its side, and `invoice.paid` /
`invoice.payment_succeeded` are neither subscribed nor handled (they fall to `default:` at `:512-513`). The
armed 5-minute cron then suspends the account.

**Verification method — EXECUTED**, end to end through the real route and the real dunning sweep endpoint:

```
B2 baseline (paying, recovered)   -> billing_state "active",   status "active",    ACTIVATED true
B2 stale payment_failed           -> 200 {"received":true,"applied":true,"duplicate":false}
B2 AFTER stale payment_failed     -> billing_state "past_due", status "active",    ACTIVATED false
   /account activationState: "suspended"
B2 dunning sweep (POST /admin/ops/dunning-sweep)
   -> {"scannedTenants":3,"pastDueTenants":1,
       "results":[{"tenantId":"ten_8a5ca…","cycle":4,"action":"suspend","applied":true}],"errors":0}
B2 AFTER dunning sweep            -> billing_state "past_due", status "suspended", ACTIVATED false
```

**The webhook side does not hold its half of the dunning F3 fix.** F3 made the suspend conditional on
`billing_state='past_due'` at suspend time; that guard is fully satisfied by state a stale webhook wrote.
A conditional write is only as good as the freshness of what it conditions on.

**Fix direction.** Persist the highest applied `event.created` (or the invoice/subscription period) per
tenant and refuse to apply an older billing-state transition; and/or handle `invoice.paid` as the explicit
recovery signal instead of relying on `customer.subscription.updated` firing again.

---

### 4 · NON-BLOCKING · `Stripe-Signature` timestamp is parsed but never checked — no replay tolerance window at all

**Lens:** 8 (signed surface).

`verifyStripeSignature` (`billing/stripe-webhook.ts:25-47`) extracts `t`, folds it into the signed string,
and never compares it to the current time. Stripe's `constructEvent` enforces a 300-second default
tolerance; this implementation enforces none. The function's own docstring (`:19-24`) claims it verifies
"`t=<timestamp>,v1=<hmac>`" — it verifies only the HMAC.

**Verification method — EXECUTED.** All four accepted with `200 {"applied":true}`:

```
A1 stale-timestamp(-2h)    -> 200 {"received":true,"applied":true,"duplicate":false,"plan":"managed"}
A1 stale-timestamp(-1y)    -> 200 …applied:true…
A1 future-timestamp(+10y)  -> 200 …applied:true…
A1 non-numeric-t           -> 200 …applied:true…      (t="not-a-number")
```

**Why NON-BLOCKING (self-refutation).** Producing any of these requires the endpoint secret, so this is not
a forgery vector. Exact replays are blocked by the per-DO `webhook_events` dedup, which never expires — I
confirmed there is no `DELETE FROM webhook_events` and no `storage.deleteAll()` anywhere in
`apps/platform/src`. It is a defence-in-depth gap: anyone who obtains a raw captured delivery (log, proxy,
archived request) can replay it indefinitely against any tenant DO that has not already recorded that event
id, and the docstring overstates what is enforced.

---

### 5 · NON-BLOCKING (arms an outage at the next secret rotation) · Only the LAST `v1` signature in the header is checked

**Lens:** 8 (signed surface) + 4 (deploy/arm-time plumbing).

`new Map(header.split(",").map(kv => kv.split("=")))` (`stripe-webhook.ts:26-32`) keeps the **last**
occurrence of a duplicated key. Stripe's header carries *one or more* signatures, and during an endpoint-secret
roll it signs with both the old and the new secret and emits a `v1` for each; Stripe's own libraries accept
if **any** matches.

**Verification method — EXECUTED.** Same body, same timestamp, two `v1` values (one valid for the configured
secret, one for a different secret):

```
A3 valid-v1 FIRST, other second -> 400 {"error":"invalid stripe-signature"}
A3 other-v1 FIRST, valid second -> 200 {"received":true,"applied":true,"duplicate":false,"plan":"managed"}
```

Acceptance depends entirely on Stripe's ordering within the header. During a secret rotation this can 400
every delivery — checkout completions and payment failures both — until Stripe's retries exhaust and the
events are dropped. The prod secret has already been rotated once (test → live, 2026-07-23).

**Fix:** collect **all** `v1` values and accept if any verifies. Combine with finding 4 — both live in the
same six-line function.

---

### 6 · NON-BLOCKING · The dunning "cycle" is a lifetime count of `invoice.payment_failed` rows that never resets on recovery

**Lens:** 6 (attack the design). *Overlaps the dunning lane — flagged here because the counter's storage is
the webhook dedup table.*

`billingFailureCount` is `SELECT COUNT(*) FROM webhook_events WHERE type='invoice.payment_failed'`
(`engine/ops-summary.ts:146-148`), unfiltered by time or billing cycle, and
`decideDunningAction` suspends at 4 (`admin/dunning.ts:16, 47-51`). Nothing decrements or windows it on
recovery.

**Verification method — EXECUTED.** Three failures, then a full recovery to `billing_state='active'`, then a
single new failure:

```
B4 lifetime payment_failed count AFTER full recovery -> 3
B4 state after recovery -> billing_state "active"
B4 sweep after ONE new-cycle failure
   -> results:[{"tenantId":"ten_26c3d66b…","cycle":4,"action":"suspend","applied":true}]
B4 state after sweep -> status "suspended"
```

A customer who had a rough month a year ago is suspended on their **first** failure thereafter, skipping the
entire four-strike grace period the design specifies. Window the count to the current billing period, or
reset it on a recovery transition.

---

### 7 · NON-BLOCKING · The 413 body cap is bypassed by omitting `Content-Length`

**Lens:** 4. The cap reads the *declared* `content-length` header (`routes/webhooks.ts:22-25`) before
`c.req.text()`. A chunked/streamed request has no such header, so `Number(undefined)` is `NaN`,
`Number.isFinite` is false, and the cap is skipped — the full body is materialised and HMAC'd before the
signature check rejects it. This is the exact parse-cost amplifier class panel-03 finding #8 claimed to close.

**Verification method — EXECUTED**, 200,314-byte body:

```
A9 WITH content-length         -> 413 {"error":"request body too large"}
A9 NO content-length (streamed) -> 400 {"error":"invalid stripe-signature"}   <-- body fully read + hashed
```

Low impact (the Workers runtime imposes its own ceiling), but the guard as written only stops honest clients.

---

### 8 · NON-BLOCKING · A signed event naming an unknown tenant returns 500

**Lens:** 4. `c.env.TENANT.idFromName(tenantId)` always resolves, so the route instantiates a DO for an
unknown id and `requireContext()` throws.

**Verification method — EXECUTED:** `B3 unknown-tenant signed event -> 500 {"error":"internal error","code":"internal"}`.

Stripe retries a 500 for ~3 days and counts it toward endpoint auto-disable. Combined with the already-open
ROADMAP item where the sandbox endpoint still points at prod and 400s on every delivery, one poison event is
an availability risk to the whole live webhook endpoint. A permanently-unroutable event should 200 with a
logged alert, not 500.

---

## Attacks that FAILED (this is what makes the PASS'd sub-areas meaningful)

**Signature verification is genuinely the cross-tenant guard, and it holds.** Every forgery attempt was
rejected 400 with zero state change:

| Attack | Result |
|---|---|
| No `stripe-signature` header at all | `400 invalid stripe-signature` |
| Valid-shape signature computed with a wrong secret | `400` |
| **Tenant swap** — sign body for tenant A, POST the body with A replaced by victim B | `400`; victim verified untouched: `plan "demo", billingState "none"` |
| `v1=` present but empty | `400` |
| `t=` present, `v1` absent | `400` |
| `v0` only (correct HMAC, wrong scheme label) | `400` |

I could find **no path to cross-tenant reach without the secret.** Both tenant-carrying fields
(`metadata.tenantId`, `client_reference_id`) are server-set at checkout creation
(`stripe-client.ts:93-99`), no customer-facing surface can influence them, and the app publishes no
Payment Links.

**Fail-closed on an unset secret holds.** `routes/webhooks.ts:29-32` returns 503 before reading the body
(re-confirmed by the existing `test/webhook-security.test.ts:38-46`, which mutates the binding and asserts it).
The test environment uses a fixed in-repo secret `whsec_test_secret_for_vitest`
(`test/hermetic-env.ts:45`), never a real one, and the hermetic binding sweep neutralises every ambient
`.dev.vars` key — no real secret can leak into a test run.

**Replay/double-delivery is correctly deduped.** Two concurrent deliveries of the same signed event and a
third sequential one:
`{applied:true,duplicate:false}` / `{applied:false,duplicate:true}` / `{applied:false,duplicate:true}`,
with exactly **1** checkout ledger row and **1** `webhook_events` row. No double upgrade, no double
payment-state flip. DO single-threading serialises the `INSERT OR IGNORE` claim correctly.

**Unhandled event types are inert.** `customer.subscription.trial_will_end` → `200 {"applied":false,
"duplicate":false}` with a byte-identical `/account` before and after. Stripe will not retry forever, and no
side effect fires. (It does consume a dedup row — harmless.)

**Dedup durability holds.** No `DELETE FROM webhook_events` and no `storage.deleteAll()` exists anywhere in
`apps/platform/src`, so the replay guard cannot be aged out or reset by a teardown.

**Handler failures 5xx rather than 2xx-and-lose.** A throw maps through `toErrorResponse` to
`500 {"error":"internal error","code":"internal"}` (`src/index.ts:151-159`) — Stripe retries, which is the
right transport behaviour. (What the retry then *does* is finding 2.)

## Sub-area verdicts

| Sub-area (brief) | Verdict |
|---|---|
| 1. Signature verification — forgery, wrong secret, fail-closed | **PASS** on forgery/fail-closed; **FAIL** on tolerance window (finding 4) and multi-signature rotation (finding 5) |
| 2. Replay / double delivery | **PASS** — findings 4/5 do not defeat the dedup |
| 3. Event-type handling + cross-tenant reach | **FAIL** — findings 1 and 8. Cross-tenant reach: **PASS**, no path found without the secret |
| 4. Ordering / races | **FAIL** — finding 3 (and finding 6) |
| 5. Failure handling (5xx vs 2xx-and-lose; crash between dedup and effect) | **FAIL** — finding 2. 5xx behaviour itself is correct |

## UNVERIFIABLE (not folded into the verdict)

1. **Whether real Stripe `invoice.payment_failed` payloads carry `metadata.tenantId`** — no Stripe
   credentials used here and I did not touch the live account. *Resolution:* the dashboard delivery-response
   check described in finding 1 (60 seconds, read-only). The dispute half of finding 1 does not depend on this.
2. **Production DO commit semantics under a mid-handler throw** — executed against
   vitest-pool-workers/miniflare, not workerd. *Resolution:* deliver a `checkout.session.completed` in Stripe
   test mode against a deployed preview with a network fault injected on `GET /v1/subscriptions`, then read
   `stripe_mailbox_item_id` / `screened_at`. The awaited `fetch` at `billing.ts:389` makes the outcome
   near-certain either way.
3. **Live prod state for the first paying customer** — whether that tenant's DO holds any
   `invoice.*` or `charge.dispute.*` `webhook_events` rows would empirically settle finding 1. Requires the
   prod `ADMIN_TOKEN` and a live call; not attempted.

## NEW (out of scope, no verdict weight)

- `readDeclineCode` (`billing.ts:316-329`) is dead in production for as long as finding 1 stands — the
  handler that calls it never runs. It is also reached only after the tenant resolves, so the A5
  permanent-decline fast-path has never executed against a real event.
- `charge.dispute.closed(won)` shares finding 1's resolution failure, so even a manually-set `disputed`
  freeze could not be lifted by the won-dispute event.
- Every fixture across `webhook.test.ts`, `dispute.test.ts`, `lifecycle-freeze.test.ts` and
  `lifecycle-digest.test.ts` encodes the same unrealistic shape. Fixing finding 1 without rewriting those
  fixtures to real Stripe shapes would leave the class reopenable.
