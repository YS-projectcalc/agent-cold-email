# Quantity-billing migration — design (2026-07-23)

Status: DESIGN ONLY (no source edits). Adversary attacks this before any build lane opens.
Author: design lane (opus). Grounded in source with `file:line` cites (every cite verified against the tree this session).

Scope: migrate coldrig billing from the stale 3-tier flat model to the founder-ratified continuous
per-mailbox curve, with durable Stripe Prices, coupon-riding subscriptions, an agency bundle that the
mechanics must not preclude, and an agent-driven quantity lever that never drifts from provisioning.

---

## 0. TL;DR — the recommended shape

- **Stripe mechanic: licensed per-unit quantity on durable Prices — two line items on one subscription:**
  a flat **platform** item (`qty 1`, $49/mo) + a **mailbox** item (`qty = the tenant's selected mailbox
  count, floored at 5`, $10/mo each). Not metered usage, not graduated tiers. Invoice reads
  `Coldrig platform $49.00` + `Mailbox × N $N0.00`. This is the literal §18 formula
  (`SPEC.md:221` — "$49 + ($10 × provisioned mailboxes), minimum 5").
- **The billing meter is the tenant's SELECTED (committed) mailbox count, not the live provisioned
  count.** One agent-facing lever — `set_mailbox_plan(N)` — quotes the new price, and on confirm both
  (a) updates the Stripe mailbox-item quantity (prorated) and (b) opens/closes provisioning headroom.
  Billing and provisioning move together *through this one intent* and never drift. §18's
  "no silent capacity addition" rule (`SPEC.md:223`) forbids a pure auto-drive from the provision path.
- **Durable Prices** created idempotently by a `lookup_key`-keyed bootstrap, replacing the inline
  `price_data` at `stripe-client.ts:85-99`. Same code path in test and live mode (mode follows the key).
- **Collapse `launch`/`growth`/`scale` to one paid plan `managed`** (§18 already retired the tiers —
  `SPEC.md:236`; the site already ships the curve — `site/pricing.html:61-117`; **zero live subscribers**,
  so no data migration). `$299`/`$799` are superseded by the curve ($249/$649), not stranded.
- **Coupon:** MORDYPILOT (60%-off, single-use) attaches at the **subscription/customer** level with
  `duration: forever` → every invoice and every future quantity bump inherits the 60% off automatically.
- **Failure atomicity:** record-before-push + an idempotent **set-to-N** reconcile sweep (mirrors
  `reapStaleReservations`, `spend-ceiling.ts:329-360`). A Stripe push failure never fails a provision.

---

## 1. Ground truth — current state (verified)

**Pricing today (stale, two half-built mechanisms):**
- 3 flat tiers `launch/growth/scale` = `$99/$299/$799`, quotas 5/20/60 mailboxes
  (`packages/shared/src/pricing.ts:19-23`). `CheckoutInput` is a plan **enum**
  (`packages/shared/src/intents.ts:64-67`). `TenantPlan = demo|free|launch|growth|scale`
  (`packages/shared/src/types.ts:7`).
- Checkout builds an **inline** subscription line item — one price, `qty 1`, flat `priceCents`
  (`stripe-client.ts:85-99`), `mode: subscription`. No durable Stripe Price object exists yet
  (SPEC §18 said inline "until metered billing creates durable Prices — that day is now").
- A **second, orthogonal** metering path exists and is half-wired: on every mailbox provision, paid
  tenants call `recordUsage(MAILBOX_MONTHLY_FEE_CENTS=600, …)` into the local ledger **and**
  `reportUsageToStripeIfConfigured(ctx, 1, …)` (`provisioning.ts:113-130`), which posts to Stripe's
  `subscription_items/{id}/usage_records` endpoint (`stripe-client.ts:137-158`).
  ⚠️ **Latent bug (flag for adversary):** that endpoint only accepts **metered** items, but checkout
  creates a **licensed** item (`stripe-client.ts:85-88`, no `usage_type` → licensed). If armed as-is it
  would 400. It is currently inert (`reportUsageToStripeIfConfigured` no-ops without `STRIPE_SECRET_KEY`
  + a stored `stripe_subscription_id`, `billing.ts:409-419`). The 2¢ per-send fee was already deleted
  whole-class (`ACTIVATION.md:22`); this **per-mailbox** meter was not. The migration removes it — the
  licensed quantity *is* the per-mailbox charge; keeping both double-counts.

**The already-ratified curve the migration must land on (`SPEC.md:217-236`):**
> Value metric = provisioned mailbox/month + a $49/month platform fee. Paid minimum 5 mailboxes.
> **Monthly price = $49 + ($10 × provisioned mailboxes), minimum 5 mailboxes / $99.**
Reference points: 5→$99, 10→$149, 20→$249, 60→$649 (`SPEC.md:230-233`). Sends are **not** a meter.
"A mailbox counts while configured and retained … A fully deprovisioned mailbox no longer counts."
"Before any mailbox addition, both the agent response and billing UI must return the proposed new count
and projected monthly price; no silent capacity addition" (`SPEC.md:223`).

**Helpers already built ahead (07-14) but with ZERO consumers** (the migration wires them in):
`quoteProvisionedMailboxes()`, `PLATFORM_FEE_CENTS=4900`, `MAILBOX_PRICE_CENTS=1000`,
`MINIMUM_BILLABLE_MAILBOXES=5`, `MAX_SELF_SERVE_MAILBOXES=60` (`pricing.ts:29-54`).

**The provisioned-mailbox count (billing-relevant) is a solved query already used in two places:**
`COUNT(*) FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL` (`quota.ts:52-56`,
`lifecycle.ts:166`). Release is a soft `released_at` timestamp, **not** a delete (`lifecycle.ts:165-194`).

**Slot accounting (G4) is NOT the billing quantity — do not conflate.** `vendor_slot_state.slots_used`
is a single **account-wide** row (`id=1`) counting InboxKit plan slots across ALL tenants — the vendor
cost cap (`spend-ceiling.ts:119-122, 246-258, 371-376`). Per-tenant billable count is the
`released_at IS NULL` query above. `slot_counted` on the mailbox row (`schema.ts:213`,
`provisioning.ts:101-104`) records whether a mailbox consumed a *real* vendor slot, read at teardown to
decrement the account counter — unrelated to what the tenant is billed.

**Billing state machine (must integrate cleanly):** `FROZEN_BILLING_STATES = disputed|canceling|canceled`
(`billing-state.ts:19`); a frozen tenant does no spend-incurring work (`isLifecycleFrozen`,
`billing-state.ts:31-33`). Webhook handlers are STICKY against freezes (`billing.ts:260-266, 300-305,
333-337`). Dunning suspends after 4 failures / escalates after 2, or immediately on a permanent decline
(`admin/dunning.ts:14-15, 46-51`). `provisioning_state = ok|capacity_pending` feeds G3 activationState
(`schema.ts:39-45`). MRR is reported from the tier table today (`ops-summary.ts:125-126`,
`mrrCents = PLAN_QUOTAS[plan].priceCents`) — must move to the quantity formula.

**Real-spend arming + webhook security:** `isRealSpendArmed` ORs Stripe/engine/InboxKit/registrar
signals (`billing.ts:39-50`); `/webhooks/stripe` fails closed (503) without `STRIPE_WEBHOOK_SECRET`
(`ACTIVATION.md:23`); Stripe API pinned `2024-06-20` (`stripe-client.ts:12`) — matches the
promotion-codes gotcha on the ledger. **ACTIVATION.md:10 is stale** — it "signs off" $99/$299/$799;
§18 (07-14) superseded it. Reconcile as part of the claim-surface batch.

---

## 2. Q1 — Stripe mechanic: licensed quantity (recommended) vs metered vs graduated tiers

| Option | Fit | Proration | Coupon %-off rides | Invoice readability | Agent-driven |
|---|---|---|---|---|---|
| **Licensed per-unit quantity** (recommend) | ✅ mailbox count is a deliberately-set number, not accreting usage | ✅ automatic on `qty` change | ✅ subscription-level coupon hits all lines + future bumps | ✅ `Mailbox × N` explicit line | ✅ one `POST /subscription_items/{id}` set-to-N |
| Metered usage records | ❌ meters *consumption over a period*; a retained mailbox isn't consumption; endpoint deprecated by Stripe | ❌ manual partial-month math | ⚠️ works but opaque | ❌ summed at period end, not a clear count | ❌ increment semantics drift on retries |
| Graduated tiers on ONE price | ⚠️ works, encodes `$99 min + $10 each` in Stripe tiers | ✅ automatic | ✅ | ❌ single opaque line; the $49-vs-$10 split disappears for a human reading the dashboard | ✅ |

**Recommendation: two licensed line items** — a flat `platform` item (`qty 1`) + a `mailbox` item
(`qty = selected count, floored at 5`). Why over the elegant single graduated line: the founder reads
raw Stripe invoices, and `$49 platform + Mailbox × N` is exactly the sentence the pricing page tells
customers (`site/pricing.html:89`). Two items also keep the mailbox line **always present with qty ≥ 5**,
so there is never a lazy "create the add-on item on the 6th mailbox" branch (the failure mode of the
"$99-base + $10-per-additional" Model B). The minimum is a one-line clamp
(`Math.max(5, selected)`), not a Stripe-tier config we can misread.

**Proration rules (recommend):**
- **Add (raise qty):** `proration_behavior: "create_prorations"` — bill the partial-period cost of the
  added mailboxes on the next invoice. Honest: they have the capacity now. `set_mailbox_plan` returns the
  quote first (§18 quote-before-provision).
- **Remove (lower qty):** `proration_behavior: "none"` — the lower quantity takes effect at the next
  renewal, **no mid-cycle credit**. This closes a real abuse/asymmetry: a mid-cycle credit on remove lets
  a tenant thrash (provision 50, drop them an hour later) paying near-zero proration while we already
  paid InboxKit a full slot buy. "You keep the capacity you paid for until period end" is standard SaaS
  and removes the vector. (Founder-toggleable to immediate-credit if desired — see Open Q3.)

**The agent-driven reality (the crux of Q1):** the customer's coding agent must not silently move price.
So the meter is the **selected/committed count**, changed only through an explicit, quoted intent:

```
set_mailbox_plan(N):
  1. quote = quoteProvisionedMailboxes(N)            # pricing.ts:43 — returns {mailboxes, monthlyCents, …}
  2. return quote to the agent; require confirm       # §18 no-silent-addition (SPEC.md:223)
  3. on confirm:
     a. UPDATE tenant_profile SET mailbox_plan_qty = N        (local source of truth, durable FIRST)
     b. sync Stripe: set mailbox-item quantity → N (prorate per add/remove rule)   (mirror, reconcilable)
     c. provisioning headroom is now N; setup_infrastructure / request_managed_mailboxes fill it
        (release lowers via the same intent, never below what's still provisioned unless deprovisioning)
```

Provisioning (`provisioning.ts`) fills headroom **under** `mailbox_plan_qty`; it never raises billing on
its own. `quota.capFor` becomes `min(mailbox_plan_qty, MAX_SELF_SERVE_MAILBOXES)` instead of the tier
lookup. This is the honest reading of §18 ("tracks reserved underlying capacity") and it makes drift
structurally impossible: **one number (`mailbox_plan_qty`) is what Stripe mirrors and what provisioning
is capped by.** (Alternative "live-provisioned-count is the meter" is viable ONLY if every provision is
itself gated behind a quote+confirm — which collapses back into this design. Present both; recommend this.)

---

## 3. Q2 — Durable Products/Prices (idempotent bootstrap, replaces inline `price_data`)

Create durable Prices keyed by stable `lookup_key`s, mode-agnostic (the secret key decides test vs live):

| lookup_key | product | interval | unit_amount |
|---|---|---|---|
| `coldrig_platform_monthly_v1` | Coldrig Platform | month | 4900 |
| `coldrig_mailbox_monthly_v1` | Coldrig Mailbox | month | 1000 |
| `coldrig_platform_yearly_v1` | Coldrig Platform | year | 49000 |
| `coldrig_mailbox_yearly_v1` | Coldrig Mailbox | year | 10000 |

**Bootstrap (`ensureStripePrices(secretKey)`):** `GET /v1/prices?lookup_keys[]=…&active=true`; for any
missing key, create the Product (find-or-create by a deterministic metadata tag) then the Price with that
`lookup_key`. Idempotent by construction (the lookup gates the create). Cache the resolved
`price_id → lookup_key` in a **D1 `stripe_prices` table** (`lookup_key, mode, price_id, created_at`;
new migration `0013_stripe_prices.sql`, following `migrations/0011_vendor_spend_ledger.sql`) so checkout
resolves ids without a round trip and drift is auditable. Run it lazily at first checkout AND expose an
admin arm-time endpoint. Fail closed if it can't complete (no silent fallback to inline price_data — that
would reintroduce the un-couponable, un-durable shape). Version suffix (`_v1`) lets a future price change
create `_v2` without mutating historical subscriptions.

Checkout then references Prices by id with `line_items[0] = {price: platformId, quantity: 1}`,
`line_items[1] = {price: mailboxId, quantity: max(5, selected)}` — replacing `stripe-client.ts:85-99`.

---

## 4. Q3 — Collapse the three tiers (reconcile explicitly)

§18 already ruled it: "The continuous curve removes the old $99→$299 bundle cliff … The current code
still models legacy launch/growth/scale fixed tiers; that implementation is stale … must not be treated
as the final billing contract" (`SPEC.md:236`). The **site already ships the curve** — 5/10/20/60 at
$99/$149/$249/$649 with a live `$49 + $10×N` calculator (`site/pricing.html:61-117`), and there are
**zero live subscribers** (greenfield). So:

- **Retire `PLAN_QUOTAS` (the 3-tier table)** as the billing/quota authority. `$299`/`$799` are
  *superseded* by $249/$649, not stranded — they were never sold.
- **`TenantPlan` → `demo | free | managed`** (one paid literal). `isPaidPlanTier` → `isPaidPlan`
  (true for `managed`). Preset "sizes" (Start 5 / Common 10 / Growing 20 / Scale 60) are pricing-page
  affordances that all POST the same `{mailboxes: N}` — they are not distinct SKUs.
- **`quota.capFor`** returns `min(mailbox_plan_qty, MAX_SELF_SERVE_MAILBOXES)` mailboxes and
  `ceil(mailboxes/3)` domains (bundled, `SPEC.md:225`), replacing `PLAN_QUOTAS[plan]` (`quota.ts:24-30`).
- **Blast radius of the literal change (7 non-test files, all cited):** `isPaidPlanTier` consumers —
  `tenant-do.ts`, `provisioning.ts:113`, `ops-summary.ts:126`, `engine/activation.ts`, `quota.ts:25`,
  `billing.ts` (screening guard `provisioning.ts:236`), `pricing.ts:56`. `PLAN_QUOTAS` consumers —
  `admin/support-kb.ts`, `ops-summary.ts:126`, `quota.ts`, `billing.ts`, and the three shared files.
  Tier string literal also in `stripe-client.ts:44` (PROMO_ELIGIBLE_PLAN). (NB: `packages/cli/src/commands/campaign.ts:15`'s `"launch"`/`"scale"` are the `campaign launch` **subcommand**, NOT pricing tiers — not a touchpoint.)
  Because there are zero rows, no DB `plan`-value backfill is needed; a fresh signup mints `demo` and
  checkout flips it to `managed`.

**Recommended: collapse to `managed`.** Lower-churn alternative (keep `launch` as the sole paid literal,
drop `growth`/`scale`) avoids touching a few string literals but leaves a 60-mailbox account named
"launch" — reject on honesty grounds.

---

## 5. Q4 — Annual (keep it simple and honest)

Annual = same two-item structure on the **yearly** Prices (`_yearly_v1`), `unit_amount = 10× monthly`
(§ brief: "≈ 2 months free"). Do **not** run a separate monthly add-on subscription alongside an annual
base — Stripe prorates a mid-year quantity change over the **remaining** annual term natively, so adding a
mailbox in month 7 charges the prorated remainder of that mailbox's $100/yr. One subscription, one
interval, honest proration. Interval is chosen at checkout (`CheckoutInput.interval: "month"|"year"`) and
fixes the Price ids used. Coupon %-off rides identically. No new mechanic — annual is a Price-id swap.

---

## 6. Q5 — Agency bundle (design sketch; build may defer; mechanics must not preclude it)

**The problem, with math.** At 50 mailboxes / 8 clients, per-tenant pricing multiplies the platform fee:
8 × $49 + 50 × $10 = **$392 + $500 = $892** (the "Instantly kill"). The agency winner lands ~$605–631.
The $500 mailbox line is COGS-linked and roughly fixed; the killer is the 8× platform fee.

**Fix — charge the platform fee ONCE and add a thin per-workspace fee over a POOLED mailbox count:**

> **Agency = $49 platform (once) + $10 / workspace + $10 / mailbox (pooled, 5-mailbox account minimum).**

At 50 mbx / 8 clients: `$49 + 8×$10 + 50×$10 = $49 + $80 + $500 = $629` — inside the $605–631 band,
undercutting our own $892 by $263. (Dial the workspace fee to $7 → $605 at the band floor if the founder
wants to win outright.) **Margin protected:** the $10 mailbox line already carries its ~$6 COGS + margin;
the $49 platform and the ~$0-marginal-COGS workspace fee are near-pure margin → the bundle still clears
~50%. **Self-protecting against cannibalization:** a 1-workspace "agency" costs `$49 + $10 + 5×$10 = $109`
> the $99 starter, so no single-client buyer gains by taking the agency rate; savings only accrue with
real client count.

**Stripe shape:** identical primitives — one agency subscription with **three** licensed items:
`platform` (qty 1), `workspace` (qty = #workspaces), `mailbox` (qty = pooled count). The quantity lever
(`set_mailbox_plan` / a `set_workspaces`) is the same `set-to-N` call on another item. **The core
mechanic does not preclude this** — that is the design guarantee being asserted here.

**What it DOES require (why build may defer):** a billing-account → N-workspace data model. Today the
platform is one-tenant-per-DO with per-tenant billing; an agency needs one owner subscription spanning
child workspaces (each still an isolated TenantDO for sending). That is a multi-tenant-ownership lift
(auth, workspace switching, pooled quota) larger than the quantity migration itself. Recommend: ship the
per-tenant quantity model first; scope the agency ownership model as a follow-on that reuses these exact
Stripe items.

---

## 7. Q6 — Billing-state-machine integration (freeze / dunning / teardown / G3)

**The trap the brief names:** a frozen tenant's mailboxes get released → provisioned count → 0 → does
that push `qty=0` to Stripe and fight dunning recovery? **Resolution: quantity sync is DECOUPLED from
teardown/freeze. It fires ONLY from `set_mailbox_plan` while `billing_state='active'`.**

- **Dunning (`past_due`):** sends pause, but `mailbox_plan_qty` and the Stripe quantity are **untouched**
  — the customer still owes for the committed capacity; recovery (`billing.ts:307`) restores sends with
  no quantity change. Teardown does not run on `past_due`.
- **Freeze (`disputed`/`canceling`/`canceled`) + teardown:** teardown releases mailboxes for **vendor
  cost cleanup + G4 slot decrement** (`lifecycle.ts:165-194`, `releaseMailboxSlots`) — it must **not**
  touch Stripe quantity. On voluntary cancel we cancel the *subscription* at Stripe (stops all billing);
  on an involuntary freeze the subscription is already `past_due`/disputed. Lowering an item quantity on
  a subscription that's being canceled is meaningless and risks a spurious proration credit — so skip it.
- **Guard:** `set_mailbox_plan` calls `assertNotLifecycleFrozen(ctx, "set_mailbox_plan")`
  (`billing-state.ts:53-60`) — a frozen tenant cannot change its plan (it must re-subscribe via
  `/checkout` first, same as it already cannot provision). This is what stops teardown-driven release
  from ever reaching the Stripe quantity path.
- **G3 activationState / capacity_pending:** unchanged. If `set_mailbox_plan` raises headroom but the
  subsequent provision hits the G2/G4 ceiling, the tenant goes `capacity_pending` (`spend-ceiling.ts`) —
  the customer is *billed for the plan they bought* while provisioning catches up once the founder raises
  the ceiling. That is the intended "reserved capacity" semantics (§18), and it is surfaced honestly by
  G3 (`ops-summary.ts` account() `activationState`). Flag for founder (Open Q2): billing the committed
  count while `capacity_pending` means a tenant can pay before all mailboxes are live — acceptable under
  "reserved capacity," but name it in the checkout/quote copy.

---

## 8. Q7 — Failure atomicity (record-before-push + reconcile; the house pattern)

The codebase already uses record-before-push + reconcile for credential pushes
(`maybePushProvisionedMailbox`, swallow-and-retry) and for spend reservations
(`reapStaleReservations`, `spend-ceiling.ts:329-360`). Apply the same:

1. **Local first, always.** `set_mailbox_plan` writes `mailbox_plan_qty` (durable, DO SQLite) **before**
   any Stripe call. `mailbox_plan_qty` is the source of truth for both billing intent and provisioning cap.
2. **Push is a mirror, and idempotent by SET-not-INCREMENT.** Sync sets the Stripe item quantity **to N**
   (absolute), never `+1`. A missed/duplicated push self-heals: the next sync sets the same N. Store
   `mailbox_qty_synced` (last value Stripe confirmed) alongside `mailbox_plan_qty`; `synced != plan`
   marks drift.
3. **Never fail the customer action on a Stripe hiccup.** If provisioning already spent real vendor money
   (`provisioning.ts:68-105` — the slot buy committed), a failed Stripe quantity push must not roll it
   back. Swallow, leave `synced != plan`, let the sweep retry — exactly `maybePushProvisionedMailbox`'s
   contract (`provisioning.ts:138`).
4. **Ordering makes the reverse impossible.** Provision path: vendor buy → mailbox row insert →
   (later) reconcile quantity. "Provision failed" ⇒ no row, no headroom consumed, nothing to unwind. We
   never push a higher quantity *before* the capacity is durably recorded.
5. **Reconcile sweep** (new, scheduled alongside `reapStaleReservations`): for each active paid tenant
   where `mailbox_qty_synced != mailbox_plan_qty` and `billing_state='active'`, re-issue the set-to-N.
   Bounded, idempotent, fail-closed (drift over-restricts nothing — it just re-pushes).

---

## 9. Code touchpoints for the build lane (file:line)

**Shared (`packages/shared/src`):**
- `types.ts:7` — `TenantPlan` → `demo | free | managed`.
- `pricing.ts:9-23` — retire `PaidPlanTier`/`PLAN_QUOTAS`; keep the curve constants (`:29-34`) +
  `quoteProvisionedMailboxes` (`:43-54`) as the authority; `isPaidPlanTier` → `isPaidPlan` (`:56-58`).
- `intents.ts:64-67` — `CheckoutInput` → `{ mailboxes: int().min(5).max(60), interval: enum(["month","year"]).default("month") }`;
  add `SetMailboxPlanInput = { mailboxes, confirm? }`.

**Platform billing:**
- `billing/stripe-client.ts` — add `ensureStripePrices()`, `setSubscriptionItemQuantity()`,
  `getSubscription()` (resolve item ids); rewrite `createStripeCheckoutSession` (`:72-120`) to two durable
  Price line items + quantities; adjust `PROMO_ELIGIBLE_PLAN` gate (`:44`) to the single `managed` plan;
  **delete** `reportUsageRecord` (`:137-158`, deprecated metered path).
- `engine/billing.ts` — `checkout.session.completed` (`:253-289`): capture `stripe_subscription_id` +
  resolve/store the two subscription-item ids + set `mailbox_plan_qty`/`mailbox_qty_synced` from the
  selected count; **delete** `reportUsageToStripeIfConfigured` (`:409-427`) and its call site; add the
  quantity-sync helper + the reconcile sweep entry.
- `engine/provisioning.ts:113-130` — remove the per-mailbox Stripe usage report; decide whether to keep
  the local `recordUsage` ledger 'usage' write for internal COGS (recommend keep, rename intent) or drop.
  Cap the provision loop by `mailbox_plan_qty` (via `quota.capFor`).
- `engine/quota.ts:24-30, 49-57` — `capFor` from `mailbox_plan_qty` + `MAX_SELF_SERVE_MAILBOXES`, not
  `PLAN_QUOTAS`.
- `engine/ops-summary.ts:125-126` — `mrrCents` from `PLATFORM_FEE_CENTS + MAILBOX_PRICE_CENTS × mailbox_plan_qty`
  (× coupon factor if present), not `PLAN_QUOTAS[plan]`.
- **New intent** `set_mailbox_plan` — route + TenantDO method + MCP tool; guards
  `assertNotLifecycleFrozen`; returns the quote before mutating.
- `vendors/real/billing-port.ts` + `vendors/sandbox/billing-port.ts` — add `setSubscriptionQuantity`
  (+ `ensurePrices`) so the sandbox path is exercised in tests without a live Stripe call; real stays a
  coded stub until arm (`NotActivatedError`).

**Data model:**
- `tenant_profile` new columns via `ensureColumnMigrations`/`addColumnIfMissing`
  (`tenant-do.ts:154, 296`): `mailbox_plan_qty INTEGER NOT NULL DEFAULT 0`,
  `mailbox_qty_synced INTEGER NOT NULL DEFAULT 0`, `stripe_platform_item_id TEXT`,
  `stripe_mailbox_item_id TEXT`, `billing_interval TEXT NOT NULL DEFAULT 'month'`. All default to values
  that keep existing (demo) rows byte-identical.
- New D1 migration `migrations/0013_stripe_prices.sql` — `stripe_prices(lookup_key, mode, price_id, created_at)`.

**Claim surfaces (coordinated batch — see §11).**

---

## 10. Test strategy (Stripe fixtures — NO live calls in tests)

- **Sandbox BillingPort drives the mechanic in tests.** `setSubscriptionQuantity`/`ensurePrices` get
  sandbox implementations that record intents idempotently (mirroring `SandboxBillingPort.recordUsage`,
  `vendors/sandbox/billing-port.ts`), so quantity math, proration selection, and reconcile logic are
  unit-tested with zero network.
- **Webhook fixtures** = static JSON event objects fed to `applyStripeWebhookEvent` (the existing
  `test/webhook-subscriptions.test.ts` pattern) covering: `checkout.session.completed` capturing item ids
  + initial quantity; a subscription with a 60%-off discount object present; a mid-cycle `subscription.updated`.
- **Behavior-asserting tests that FAIL on old code** (CLAUDE.md rule e): `quoteProvisionedMailboxes(10)`
  → 14900; checkout builds two line items with `qty [1, max(5,N)]`; `set_mailbox_plan` returns the quote
  before mutating and refuses when frozen; reconcile re-pushes only on `synced != plan`; teardown does NOT
  call the quantity sync; MRR = curve, not tier table.
- **Coupon-ride test:** a subscription carrying a `percent_off` discount, then a quantity bump → assert the
  local projected charge applies the 60% to the new total (the code path that computes `mrrCents`/quote
  under an active discount).
- **Guard tests:** a coverage test that no checkout path emits inline `price_data` (must use a resolved
  durable Price id); assert `reportUsageRecord`/`reportUsageToStripeIfConfigured` are gone (grep-guard).

---

## 11. Claim-surface batch (must land together with the mechanic)

- `site/pricing.html` — **already on the curve** (`:61-117`); update only the "billing rolling out /
  Stripe still on test keys" line (`:164`) at arm time.
- `site/openapi.yaml:48-49` — `/signup` + checkout description says "no live paid/Stripe checkout path
  yet"; update the `/checkout` request schema from a plan enum to `{mailboxes, interval}` and the
  operation copy. Check `:893-901` (BYO managed-mailbox pricing note).
- **MCP** (`apps/platform/src/mcp/tools.ts`, `schemas.ts`) — add the `set_mailbox_plan` tool; the
  `account` tool description (`tools.ts:163`) should reflect quantity billing; the
  `request_managed_mailboxes` count is capped by `mailbox_plan_qty` headroom, not a tier.
- `ACTIVATION.md:10` — reconcile the stale $99/$299/$799 "signed off" line to the §18 curve; the Stripe
  live-KYC (`:21`) + webhook-secret (`:23`) steps stay; add "run `ensureStripePrices` in test then live."
- `SPEC.md:236` — flip "core billing migration pending" to done once shipped; the tier table in §18 stays
  as the reference curve.

---

## 12. Open founder questions (only genuinely his — ≤3)

1. **Remove-proration policy:** on downgrade, **no mid-cycle credit** (recommended — takes effect next
   renewal; closes the thrash-refund vector) vs immediate prorated credit? Default to no-credit unless he
   says otherwise.
2. **Bill-on-commit while `capacity_pending`:** the tenant is billed for the selected count as soon as
   checkout completes, even if provisioning is still filling headroom or held at a spend/slot ceiling.
   That is the "reserved capacity" reading of §18 — confirm, and confirm the quote/checkout copy says so.
3. **Agency ownership model:** ship per-tenant quantity now and scope the agency workspace-account model
   as a follow-on (recommended), or is the agency bundle in-scope for this same lane? (Mechanics are ready
   either way — §6.)

---

## 13. Pre-brief for the adversary (known soft spots to attack)

- The **selected-count-is-the-meter** decision vs the brief's "update from the provision/release path"
  framing — is §8's decoupling airtight against every add/remove/teardown/freeze/re-subscribe ordering?
- **Coupon ride** under multiple line items + a mid-cycle quantity bump — verify Stripe applies a
  subscription-level `percent_off` to the *new* invoice total, not just the first invoice, and that
  `payment_method_collection: "if_required"` still collects a card when 60%-off leaves a >$0 balance.
- **Reconcile sweep** correctness: can a `set-to-N` race a concurrent webhook or a teardown and land a
  stale N? (The `synced != plan` + active-only guard is the claimed defense.)
- **Deprecation risk:** confirm licensed-quantity subscription items + `lookup_key` are current Stripe
  API under the pinned `2024-06-20` (`stripe-client.ts:12`), and that removing the usage-records path
  strands nothing.
- **MRR/coupon reporting** now has to fold the discount into `mrrCents` — does anything downstream assume
  `PLAN_QUOTAS[plan].priceCents`?
