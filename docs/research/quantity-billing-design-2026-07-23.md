# Quantity-billing migration — design (2026-07-23)

Status: DESIGN ONLY (no source edits). **AMENDED 2026-07-24** after adversary review
(`docs/adversarial/quantity-billing-design-review-2026-07-24.md`, verdict SHIP-AFTER-FIXES, 1 BLOCKING)
and founder rulings below. The blocking B1 (meter definition) is now RULED; N1–N5 folded in. Re-verify
by the adversary before the build lane dispatches.
Author: design lane (opus). Grounded in source with `file:line` cites (every cite verified against the tree this session).

Scope: migrate coldrig billing from the stale 3-tier flat model to the founder-ratified continuous
per-mailbox curve, with durable Stripe Prices, coupon-riding subscriptions, an agency bundle that the
mechanics must not preclude, and a per-mailbox quantity that tracks real provisioned capacity.

## Founder rulings (ledger-bound, 2026-07-24) — settle these; do not relitigate

1. **Billing meter = ACTIVE / PROVISIONED mailbox count** (not the committed/selected count the original
   draft proposed). *Delegation + criterion:* the founder delegated the committed-vs-provisioned call on
   the criterion "whatever is cleaner and understandable and user friendly." *Resolution (main-loop
   ruling on that criterion):* the ACTIVE/PROVISIONED meter — one number, the bill follows reality,
   deprovision auto-lowers it, and it matches both SPEC §18 ("provisioned mailbox is the billing meter …
   a fully deprovisioned mailbox no longer counts", `SPEC.md:219-223`) and the public pitch
   ("$10/**active** mailbox", `SPEC.md:179`, `site/pricing.html:61`). This closes adversary B1 and
   removes the committed-vs-provisioned divergence the original draft carried.
2. **Downgrades: NO prorated credit.** A mailbox removal is effective immediately for provisioning
   (the row is released now) but does **not** refund the current cycle → `proration_behavior: "none"` on
   every quantity **decrease**. Quantity **increases** prorate normally (`create_prorations`).
3. **Agency bundle = FOLLOW-ON.** Keep the §6 sketch; it is explicitly deferred (build the per-tenant
   quantity model first).

---

## 0. TL;DR — the recommended shape (amended)

- **Stripe mechanic: licensed per-unit quantity on durable Prices — two line items on one subscription:**
  a flat **platform** item (`qty 1`, $49/mo) + a **mailbox** item (`qty = max(5, the tenant's live
  PROVISIONED real-mailbox count)`, $10/mo each). Not metered usage, not graduated tiers. Invoice reads
  `Coldrig platform $49.00` + `Mailbox × N $N0.00`. This is the literal §18 formula
  (`SPEC.md:221` — "$49 + ($10 × provisioned mailboxes), minimum 5").
- **The billing meter is the live PROVISIONED count** — `COUNT(*) FROM mailboxes WHERE tenant_id = ? AND
  released_at IS NULL` (the query already used at `quota.ts:52-56` and `lifecycle.ts:166`), floored at 5.
  **Billing FOLLOWS provisioning**, not the reverse: a provision raises the count, a release lowers it,
  and the Stripe quantity is reconciled to that count. Every mailbox **addition** is gated by a
  quote-before-add confirm (§18 "no silent capacity addition", `SPEC.md:223`) folded into the existing
  provisioning intents — there is **no separate committed-count lever**; `set_mailbox_plan` is deleted
  (see §2).
- **Downgrade** (release) syncs the lower quantity with `proration_behavior: "none"` (no credit, effective
  next cycle for billing, immediate for provisioning); **upgrade** (provision) prorates normally.
- **Durable Prices** created idempotently by a `lookup_key`-keyed bootstrap that is a **required arm-time
  step before checkout opens** and is race-safe on the lazy path (handles Stripe's duplicate-`lookup_key`
  error), replacing the inline `price_data` at `stripe-client.ts:85-99`. Same code path test + live.
- **Collapse `launch`/`growth`/`scale` to one paid plan `managed`** (§18 already retired the tiers —
  `SPEC.md:236`; the site already ships the curve — `site/pricing.html:61-117`; **zero live subscribers**,
  so no data migration). `$299`/`$799` are superseded by the curve ($249/$649), not stranded.
- **Coupon:** MORDYPILOT (60%-off, single-use) attaches at the **subscription/customer** level with
  `duration: forever` → every invoice and every future quantity bump inherits the 60% off automatically;
  the discount % is **stored locally at checkout** so MRR/quote apply it without a Stripe round-trip.
- **Failure atomicity:** record-before-push (the mailbox row / `released_at` IS the durable record) + an
  idempotent **set-to-N** reconcile sweep (mirrors `reapStaleReservations`, `spend-ceiling.ts:329-360`).
  A Stripe push failure never fails a provision.

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
(`qty = max(5, live provisioned count)`). Why over the elegant single graduated line: the founder reads
raw Stripe invoices, and `$49 platform + Mailbox × N` is exactly the sentence the pricing page tells
customers (`site/pricing.html:89`). Two items also keep the mailbox line **always present with qty ≥ 5**,
so there is never a lazy "create the add-on item on the 6th mailbox" branch (the failure mode of the
"$99-base + $10-per-additional" Model B). The minimum is a one-line clamp
(`Math.max(5, provisioned)`), not a Stripe-tier config we can misread.

**The meter (amended per founder ruling 1): the live PROVISIONED count drives the quantity.**
`billableMailboxes = max(5, COUNT(*) FROM mailboxes WHERE tenant_id = ? AND released_at IS NULL)` — the
exact query `quota.ts:52-56` and `lifecycle.ts:166` already run. Billing **follows** provisioning: the
Stripe mailbox-item quantity is a mirror reconciled to that count, never a separately-committed number.
The min-5 floor always applies to an active subscription (a tenant that deprovisions everything but stays
subscribed pays the $99 minimum).

**`set_mailbox_plan(N)` is DELETED — decision + justification.** Under a committed meter it was the sole
lever; under the active meter a committed number that billing ignores is dead weight (CLAUDE.md rule i,
YAGNI — and it would reintroduce exactly the committed-vs-provisioned divergence adversary B1 killed). §18's
"no silent capacity addition" (`SPEC.md:223`) is satisfied where the count actually changes — at the
**provisioning intents** — by folding a quote-before-add confirm into them, not by a separate plan number:

```
Every mailbox-ADD intent (setup_infrastructure, request_managed_mailboxes, a future add_mailboxes):
  1. proposedCount = currentProvisioned + requestedDelta
  2. quote = quoteProvisionedMailboxes(proposedCount)   # pricing.ts:43 → {mailboxes, monthlyCents, …}
  3. return the quote (new count + projected monthly, incl. any stored discount %); require confirm
  4. on confirm: provision (existing path) → mailbox rows inserted (released_at NULL) → count rises
  5. syncMailboxQuantity(ctx): set-to-N mirror to Stripe, proration create_prorations (increase)

Every mailbox-REMOVE intent (a symmetrical deprovision/remove_mailboxes intent — NEW; the customer-
initiated downgrade path, distinct from teardown):
  1. release the mailbox rows (set released_at = now) — effective immediately for provisioning
  2. syncMailboxQuantity(ctx): set-to-N mirror to Stripe, proration_behavior "none" (NO credit; ruling 2)
```

`quota.capFor` becomes `min(mailbox count already provisioned + request, MAX_SELF_SERVE_MAILBOXES)` — a
flat 60-mailbox self-serve ceiling, not the retired tier lookup. `syncMailboxQuantity` recomputes the
settled count and issues one **absolute set-to-N** to the stored mailbox subscription-item id. It fires
**only while `billing_state='active'`** (teardown/freeze never call it — §7), which is what keeps a
teardown-driven release from pushing `qty=0` into a dunning/canceling subscription. The no-drift machinery
(record-before-push + set-to-N + active-only reconcile) is unchanged; it is now anchored on the real
provisioned count instead of a committed number.

**⚠️ Burn-replacement must be made bill-neutral — it is NOT today (adversary B2-rework; see §7.1).** The
original amendment claimed `REPLACE_DOMAIN`'s "release-then-provision nets to zero," but that is
**factually wrong against the code**: `applyReplaceDomain` (`deliverability-actions.ts:113-124`) only
**pauses** the burned domain's mailboxes (`pauseDomainMailboxes`, `:76` — sets `deliv_status='paused'`,
NOT `released_at`) and then provisions N replacements. `released_at` is set in exactly ONE place — full
teardown (`lifecycle.ts:184`). So the burned mailboxes keep `released_at IS NULL`, keep counting, and the
autonomous reconcile pushes **set-to-2N** — a silent doubling. The design now **mandates** a release
increment (§7.1) that makes the retire leg genuinely release the burned mailboxes, so the swap nets to
zero. The autonomous reconcile is only safe **because** that increment is required.

**Proration rules (per founder ruling 2):**
- **Increase (a provision raises the count):** `proration_behavior: "create_prorations"` — bill the
  partial-period cost of the added mailboxes on the next invoice. The quote is returned and confirmed first.
- **Decrease (a release lowers the count):** `proration_behavior: "none"` — **no mid-cycle credit**; the
  release is immediate for provisioning, the lower amount takes effect at the next renewal. This is the
  founder's ruling, and it also closes the thrash vector (provision 50, drop them in an hour → near-zero
  proration while we already paid InboxKit a full slot buy).

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
`lookup_key`. Cache the resolved `price_id → lookup_key` in a **D1 `stripe_prices` table**
(`lookup_key, mode, price_id, created_at`; new migration `0013_stripe_prices.sql`, following
`migrations/0011_vendor_spend_ledger.sql`) so checkout resolves ids without a round trip and drift is
auditable. Version suffix (`_v1`) lets a future price change create `_v2` without mutating historical
subscriptions.

**Race-safety + required arm step (adversary N3 — the lookup-then-create is NOT atomic).** Two concurrent
first-checkouts can both `GET` nothing and both `POST` the same `lookup_key`; Stripe rejects the second
(duplicate `lookup_key`, absent `transfer_lookup_key`) and that checkout would 500. Two mitigations,
**both required**:
1. **Running `ensureStripePrices` at ARM time (via the admin endpoint) is a REQUIRED step before checkout
   is opened** — it pre-creates the Prices out of the customer request path, so the common case never
   races. Add it to `ACTIVATION.md` as a gated step (test mode first, then live), sequenced before the
   Stripe-key swap flips `isRealSpendArmed`.
2. **The lazy path handles the duplicate idempotently:** on a duplicate-`lookup_key` create error,
   **re-fetch by `lookup_key` and use the existing Price** (never surface the error to checkout). So even
   if two requests race before the arm-time bootstrap ran, both converge to the same Price.

Fail closed if the bootstrap still can't resolve a Price (no silent fallback to inline `price_data` — that
would reintroduce the un-couponable, un-durable shape).

Checkout then references Prices by id with `line_items[0] = {price: platformId, quantity: 1}`,
`line_items[1] = {price: mailboxId, quantity: max(5, provisioned-at-checkout)}` — replacing
`stripe-client.ts:85-99`. (At the checkout moment a brand-new tenant has 0 provisioned → quantity floors
at 5 = the $99 minimum; the count then tracks real provisioning as setup runs — §2.)

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
- **`quota.capFor`** returns a flat `MAX_SELF_SERVE_MAILBOXES` (60) mailbox ceiling and
  `ceil(mailboxes/3)` domains (bundled, `SPEC.md:225`), replacing `PLAN_QUOTAS[plan]` (`quota.ts:24-30`).
  61+ mailboxes routes to a custom quote (`SPEC.md:234`), not self-serve. There is no per-tenant committed
  number — the cap is the flat self-serve ceiling and the meter is the live provisioned count (§2).
- **Blast radius of the literal change (all cited):** `isPaidPlanTier` consumers —
  `tenant-do.ts`, `provisioning.ts:113`, `ops-summary.ts:126`, `engine/activation.ts`, `quota.ts:25`,
  `billing.ts` (screening guard `provisioning.ts:236`), `pricing.ts:56`. `PLAN_QUOTAS` code consumers —
  `ops-summary.ts:126`, `quota.ts`, `billing.ts`, and the three shared files. ⚠️ `admin/support-kb.ts` is
  **NOT** a PLAN_QUOTAS code consumer (adversary N2) — its only `PLAN_QUOTAS` mention is a comment
  (`support-kb.ts:29`) noting it deliberately does NOT import it; `draftBillingAnswer` (`:32-36`) is
  **hardcoded customer-facing prose** with the stale `$99/$299/$799` ladder + a `$13/mailbox` rate that
  contradicts the $10 curve. It will NOT be touched by "update PLAN_QUOTAS consumers" — it must be
  rewritten by hand from the single pricing source (see §11).
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

## 6. Q5 — Agency bundle (DEFERRED — founder ruling 3: FOLLOW-ON; sketch only; mechanics must not preclude it)

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
`platform` (qty 1), `workspace` (qty = #workspaces, driven by workspace create/delete), `mailbox`
(qty = pooled provisioned count, driven by `syncMailboxQuantity` over the pool). Each is the same
`set-to-N` call on its item. **The core mechanic does not preclude this** — that is the design guarantee
being asserted here.

**What it DOES require (why build may defer):** a billing-account → N-workspace data model. Today the
platform is one-tenant-per-DO with per-tenant billing; an agency needs one owner subscription spanning
child workspaces (each still an isolated TenantDO for sending). That is a multi-tenant-ownership lift
(auth, workspace switching, pooled quota) larger than the quantity migration itself. Recommend: ship the
per-tenant quantity model first; scope the agency ownership model as a follow-on that reuses these exact
Stripe items.

---

## 7. Q6 — Billing-state-machine integration (freeze / dunning / teardown / G3)

**The trap the brief names:** a frozen tenant's mailboxes get released → provisioned count → 0 → does
that push `qty=0` to Stripe and fight dunning recovery? **Resolution: `syncMailboxQuantity` is DECOUPLED
from teardown/freeze. It fires ONLY from the customer-initiated provision/release intents while
`billing_state='active'`; teardown and the reconcile sweep both skip non-active tenants.**

- **Dunning (`past_due`):** sends pause, but the Stripe quantity is **untouched** — the customer still
  owes for the mailboxes they have; recovery (`billing.ts:307`) restores sends with no quantity change.
  Teardown does not run on `past_due`, so no release lowers the count. `syncMailboxQuantity` is a no-op
  (not active).
- **Freeze (`disputed`/`canceling`/`canceled`) + teardown:** teardown releases mailboxes for **vendor
  cost cleanup + G4 slot decrement** (`lifecycle.ts:165-194`, `releaseMailboxSlots`) — it must **not**
  call `syncMailboxQuantity`. On voluntary cancel we cancel the *subscription* at Stripe (stops all
  billing); on an involuntary freeze the subscription is already `past_due`/disputed. Lowering an item
  quantity on a subscription that's being canceled is meaningless and risks a spurious proration credit —
  so skip it. Because `syncMailboxQuantity` guards on `billing_state='active'`, a teardown-driven release
  can never reach the Stripe quantity path.
- **Guard:** every customer-initiated add/remove intent calls `assertNotLifecycleFrozen(ctx, …)`
  (`billing-state.ts:53-60`) — a frozen tenant cannot provision or deprovision (it must re-subscribe via
  `/checkout` first). `syncMailboxQuantity` itself also re-reads `billing_state` and no-ops unless active,
  as defense-in-depth.
- **G3 activationState / capacity_pending (adversary N1 — now DISSOLVES under the active meter):** if a
  provision hits the G2 spend ceiling or the G4 slot cap, the mailbox **never provisions** — it never gets
  a row with `released_at IS NULL`, so it **never enters the billed count**. The tenant goes
  `capacity_pending` (`spend-ceiling.ts`) and is **NOT billed for the held capacity** — the bill only ever
  reflects mailboxes that actually came up. This is the whole payoff of the active meter: no customer is
  ever charged for capacity the platform structurally cannot deliver. (Under the rejected committed meter,
  the aggregate of tenants' committed counts could exceed the account-wide `INBOXKIT_PLAN_SLOTS=10`
  (`spend-ceiling.ts`) and a tenant could pay for undeliverable slots — that oversell risk is gone.)
  **Residual (one line):** aggregate PROVISIONED demand across all tenants can still hit the account slot
  cap, so a new provision attempt is held `capacity_pending` until the founder raises the plan —
  **unbilled and honest** (surfaced via G3 `activationState`, `ops-summary.ts` account()).

### 7.1 REQUIRED build increment — release burned mailboxes on `REPLACE_DOMAIN` (adversary B2-rework)

**The root pattern (name it — adversary's framing).** Deleting the committed number (`set_mailbox_plan`)
removed the **pre-authorized-headroom invariant** that used to consent unattended provisioning: under the
committed model the customer had agreed to pay up to N, so a background provision under N was pre-consented.
Under the active meter there is no such pre-authorization, so the governing rule becomes:

> **Bill-invariance for unattended paths:** any action that runs on the cron / tick without a customer in
> the loop MUST be bill-**neutral or bill-lowering**. An autonomous action may never RAISE the billed
> count. (There is no autonomous bill-raising path today once burn-replacement is made neutral; any FUTURE
> one needs its own explicit-consent design — flag it then, none exists now.)

`REPLACE_DOMAIN` is the one existing autonomous path that adds mailboxes, so it must net to zero on the
meter. Today it does not (§2 ⚠️). **The build must release the burned domain's mailboxes as part of the
retire leg**, reusing the existing teardown release path (CLAUDE.md rule c — do NOT reimplement):

- **Touchpoint:** `applyReplaceDomain` (`deliverability-actions.ts:113-124`). Immediately after the
  unconditional retire (`status='burning'` + `pauseDomainMailboxes`, `:120-124`) and **before** the
  replacement-vs-withhold decision, RELEASE the burned domain's mailboxes: vendor `mailbox.release` +
  revoke pushed credentials + stamp `released_at` + decrement the G4 slot counter by the `slot_counted`
  count. Placing it on the unconditional retire leg makes **all three** sub-paths bill-neutral-or-lowering:
  replacement succeeds → release N then provision N = **net 0**; replacement withheld (cap hit, `:125-137`)
  or its vendor call throws (caught, `:167+`) → release N, no provision = **−N** (honest, `proration_behavior
  "none"`, no credit). Never +N.
- **Reuse, don't reimplement:** extract the teardown release loop (`lifecycle.ts:160-194`) into a shared
  `releaseMailboxes(ctx, { domainId? })` helper — `domainId` given ⇒ `AND domain_id = ?` (REPLACE_DOMAIN);
  omitted ⇒ all tenant mailboxes (teardown). Both call it. **Preserve the revoke-BEFORE-mark ordering**
  (`lifecycle.ts:180-186`: `revokePushedMailboxCredentials` then `UPDATE released_at`) so a crash between
  the vendor release and the mark leaves the row unmarked and a retry re-attempts both idempotently.
- **Sync placement:** `applyReplaceDomain` calls `syncMailboxQuantity(ctx)` after the retire+release+
  replacement-attempt settles (covering success, withheld, and caught-failure branches), so the meter
  reflects reality in every branch; the active-only reconcile sweep (§8.5) is the backstop.
- **G4 slot un-leak:** releasing the burned mailboxes decrements `vendor_slot_state.slots_used`
  (`releaseMailboxSlots`, `spend-ceiling.ts:371-376`) — fixing the vendor-slot leak the current
  pause-only path also causes, independently of billing.

**NOT in class (do not over-apply the release):** `HARD_PAUSE_DOMAIN` (`applyHardPauseDomain`,
`deliverability-actions.ts:214-229`, `status='paused_primary'`) and the soft cap-halving throttle
(`:232+`) **pause without retiring or replacing** — they add no mailboxes and the paused mailboxes are
still retained capacity we pay the vendor for, which §18 explicitly counts ("temporarily health-paused …
counts", `SPEC.md:223`). They must keep counting; releasing them would wrongly stop billing recoverable
capacity. The release-on-burn rule is scoped to the **retire-and-replace** path only.

---

## 8. Q7 — Failure atomicity (record-before-push + reconcile; the house pattern)

The codebase already uses record-before-push + reconcile for credential pushes
(`maybePushProvisionedMailbox`, swallow-and-retry) and for spend reservations
(`reapStaleReservations`, `spend-ceiling.ts:329-360`). Apply the same:

1. **The durable record IS the mailbox rows.** The source of truth for "how many mailboxes this tenant
   has" is `COUNT(*) FROM mailboxes WHERE released_at IS NULL` — written by the provision path
   (`provisioning.ts:88-105`, row insert) and the release path (`released_at = now`) **before** any Stripe
   call. There is no separate committed number to keep consistent with reality; reality is the record.
2. **The desired Stripe quantity is DERIVED, and the push is idempotent by SET-not-INCREMENT.**
   `desired = max(5, provisionedCount)`. `syncMailboxQuantity` sets the Stripe item quantity **to
   `desired`** (absolute), never `+1`. A missed/duplicated push self-heals: the next sync recomputes the
   same `desired` and sets it. Store `mailbox_qty_synced` (last value Stripe confirmed) on the tenant;
   `synced != max(5, provisionedCount)` marks drift.
3. **Never fail the customer action on a Stripe hiccup.** If provisioning already spent real vendor money
   (`provisioning.ts:68-105` — the slot buy committed), a failed Stripe quantity push must not roll it
   back. Swallow, leave `synced` stale, let the sweep retry — exactly `maybePushProvisionedMailbox`'s
   contract (`provisioning.ts:138`).
4. **Ordering makes the reverse impossible.** Provision path: vendor buy → mailbox row insert →
   (later) `syncMailboxQuantity`. "Provision failed" ⇒ no row, count unchanged, nothing to unwind. We
   never push a higher quantity *before* the capacity is durably recorded — the count only rises after the
   row exists.
5. **Reconcile sweep** (new, scheduled alongside `reapStaleReservations`): for each **active** paid tenant
   where `mailbox_qty_synced != max(5, provisionedCount)`, re-issue the set-to-N (increase prorates,
   decrease `proration_behavior: "none"`). Bounded, idempotent, fail-closed, active-only (a frozen/canceled
   tenant is skipped, so the sweep never pushes into a dunning subscription — §7).

---

## 9. Code touchpoints for the build lane (file:line)

**Shared (`packages/shared/src`):**
- `types.ts:7` — `TenantPlan` → `demo | free | managed`.
- `pricing.ts:9-23` — retire `PaidPlanTier`/`PLAN_QUOTAS`; keep the curve constants (`:29-34`) +
  `quoteProvisionedMailboxes` (`:43-54`) as the authority; `isPaidPlanTier` → `isPaidPlan` (`:56-58`).
- `intents.ts:64-67` — `CheckoutInput` → `{ mailboxes: int().min(5).max(60), interval: enum(["month","year"]).default("month") }`.
  No `SetMailboxPlanInput` (deleted — §2). Add a quote-before-add `confirm`/`quoteOnly` field to the
  add-mailbox intents (`SetupInfrastructureInput`, `RequestManagedByoMailboxesInput`) and a new
  `RemoveMailboxesInput` for the customer-initiated downgrade path.

**Platform billing:**
- `billing/stripe-client.ts` — add `ensureStripePrices()`, `setSubscriptionItemQuantity()`,
  `getSubscription()` (resolve item ids); rewrite `createStripeCheckoutSession` (`:72-120`) to two durable
  Price line items + quantities; adjust `PROMO_ELIGIBLE_PLAN` gate (`:44`) to the single `managed` plan;
  **delete** `reportUsageRecord` (`:137-158`, deprecated metered path).
- `engine/billing.ts` — `checkout.session.completed` (`:253-289`): capture `stripe_subscription_id` +
  resolve/store the two subscription-item ids + **store the discount %** off the event's `discount`/
  `total_details` object (N5) + set `mailbox_qty_synced` from the quantity actually sent at checkout
  (`max(5, provisioned-at-checkout)`); **delete** `reportUsageToStripeIfConfigured` (`:409-427`) and its
  call site; add `syncMailboxQuantity(ctx)` (the derived set-to-N helper) + the reconcile sweep entry.
- `engine/provisioning.ts:113-130` — remove the per-mailbox Stripe usage report; decide whether to keep
  the local `recordUsage` ledger 'usage' write for internal COGS (recommend keep, rename intent) or drop.
  After a provisioning batch completes (and while active), call `syncMailboxQuantity(ctx)`. Cap the
  provision loop by `quota.capFor` (flat 60), not a committed number.
- `engine/quota.ts:24-30, 49-57` — `capFor` returns a flat `MAX_SELF_SERVE_MAILBOXES` (60), not
  `PLAN_QUOTAS[plan]`. The existing `released_at IS NULL` count (`:52-56`) is reused verbatim as the
  billable meter.
- `engine/ops-summary.ts:125-126` — `mrrCents` from `PLATFORM_FEE_CENTS + MAILBOX_PRICE_CENTS ×
  max(5, provisionedCount)` × `(1 − storedDiscountPct)`, not `PLAN_QUOTAS[plan]`.
- **New/changed intents (§2):** fold a quote-before-add confirm into `setup_infrastructure`
  (`engine/provisioning.ts:198`) and `request_managed_byo_mailboxes` (`engine/byo-intake.ts`); add a new
  `remove_mailboxes` deprovision intent (route + TenantDO method + MCP tool) that releases rows
  (`released_at`) then `syncMailboxQuantity`. All guard `assertNotLifecycleFrozen`. `set_mailbox_plan` is
  NOT built.
- `engine/lifecycle.ts` — teardown must **not** call `syncMailboxQuantity` (§7); leave the existing
  `releaseMailboxSlots` (`:194`) untouched. **Extract** the release loop (`:160-194`) into a shared
  `releaseMailboxes(ctx, { domainId? })` (revoke-before-mark ordering preserved), reused by teardown and
  by REPLACE_DOMAIN (§7.1).
- **`engine/deliverability-actions.ts:113-124` (REQUIRED, adversary B2-rework — §7.1):** on the
  `REPLACE_DOMAIN` retire leg, call `releaseMailboxes(ctx, { domainId: action.domainId })` (vendor release
  + revoke + `released_at` + G4 decrement) so the burned mailboxes stop counting; then `syncMailboxQuantity`
  after the replacement settles. Without this the autonomous reconcile double-bills (set-to-2N). Do NOT
  touch `HARD_PAUSE_DOMAIN` (`:214`) or the throttle (`:232`) — pause-only, §18-counts.
- `vendors/real/billing-port.ts` + `vendors/sandbox/billing-port.ts` — add `setSubscriptionQuantity`
  (+ `ensurePrices`) so the sandbox path is exercised in tests without a live Stripe call; real stays a
  coded stub until arm (`NotActivatedError`).

**Data model:**
- `tenant_profile` new columns via `ensureColumnMigrations`/`addColumnIfMissing`
  (`tenant-do.ts:154, 296`): `mailbox_qty_synced INTEGER NOT NULL DEFAULT 0` (drift detection only —
  NOT a committed meter), `stripe_platform_item_id TEXT`, `stripe_mailbox_item_id TEXT`,
  `billing_interval TEXT NOT NULL DEFAULT 'month'`, `checkout_discount_pct INTEGER NOT NULL DEFAULT 0`
  (N5 — the % off captured at checkout, for MRR/quote without a Stripe round-trip). No `mailbox_plan_qty`
  (the meter is the live `released_at IS NULL` count, not a stored number). All defaults keep existing
  (demo) rows byte-identical.
- New D1 migration `migrations/0013_stripe_prices.sql` — `stripe_prices(lookup_key, mode, price_id, created_at)`.

**Claim surfaces (coordinated batch — see §11).**

---

## 10. Test strategy — two tiers: hermetic unit/fixtures + a REQUIRED Stripe test-mode gate

**Tier 1 — hermetic (no network, the default suite):**
- **Sandbox BillingPort drives the mechanic.** `setSubscriptionQuantity`/`ensurePrices` get sandbox
  implementations that record intents idempotently (mirroring `SandboxBillingPort.recordUsage`,
  `vendors/sandbox/billing-port.ts`), so quantity math, proration *selection* (which behavior we pass),
  and reconcile logic are unit-tested with zero network.
- **Webhook fixtures** = static JSON events fed to `applyStripeWebhookEvent` (`test/webhook-subscriptions.test.ts`
  pattern): `checkout.session.completed` capturing item ids + initial quantity + the discount %; a
  subscription carrying a `percent_off` discount; a mid-cycle `subscription.updated`.
- **Behavior-asserting tests that FAIL on old code** (CLAUDE.md rule e): `quoteProvisionedMailboxes(10)`
  → 14900; checkout builds two line items with `qty [1, max(5,provisioned)]`; a provision raises the count
  and calls `syncMailboxQuantity`; a `remove_mailboxes` releases rows and syncs with `proration_behavior
  "none"`; the reconcile re-pushes only when `synced != max(5, provisionedCount)`; teardown does NOT call
  the sync; add-intents return a quote and refuse when frozen; `mrrCents` = curve × (1 − discount), not
  tier table.
- **Guard tests:** no checkout path emits inline `price_data` (must use a resolved durable Price id);
  `reportUsageRecord`/`reportUsageToStripeIfConfigured` are gone (grep-guard).

**Tier 2 — REQUIRED Stripe TEST-MODE verification at build (adversary N4).** Stripe semantics that a
self-authored sandbox cannot prove — and that are the hardest-to-reverse money behaviors — MUST be
verified against **real Stripe test mode** (`sk_test_` keys, no live charge) before the lane closes, not
deferred to arm. Exact scenarios to run and assert against real Stripe responses:
1. **Coupon-ride to a FUTURE bump:** create a subscription with a `percent_off: 60, duration: forever`
   coupon; bump the mailbox item quantity mid-cycle; **assert the resulting proration invoice line is
   discounted 60%** (the coupon rides to new charges, not just the first invoice).
2. **Increase prorates:** raise quantity mid-cycle → assert a positive prorated line for the added
   mailboxes on the upcoming invoice.
3. **Decrease does NOT credit:** lower quantity with `proration_behavior: "none"` → assert **no credit
   line / no negative proration** is created and the new amount takes effect next renewal (founder ruling 2).
4. **`lookup_key` uniqueness / duplicate handling:** run `ensureStripePrices` twice concurrently against
   test mode → assert it converges (no un-handled duplicate-`lookup_key` 400 reaches a checkout) — the N3
   race path.
5. **60%-off still collects a card (adversary N-r1):** create a checkout with the 60%-off coupon and
   `payment_method_collection: "if_required"` → assert a card **is** collected (invoice total > $0 after
   60% off) and the **first invoice succeeds**. A discounted-but->$0 subscription created without a card
   fails on its first renewal — this is the arm-blocking failure the sandbox cannot catch.
This is a build-time gate captured as an artifact (per the ROADMAP "no artifact = the review didn't
happen" rule), separate from the hermetic suite; it needs test keys, so it runs where those are available.

---

## 11. Claim-surface batch (must land together with the mechanic)

- `site/pricing.html` — **already on the curve** (`:61-117`); update only the "billing rolling out /
  Stripe still on test keys" line (`:164`) at arm time.
- `site/openapi.yaml:48-49` — `/signup` + checkout description says "no live paid/Stripe checkout path
  yet"; update the `/checkout` request schema from a plan enum to `{mailboxes, interval}` and the
  operation copy. Check `:893-901` (BYO managed-mailbox pricing note).
- **`apps/platform/src/admin/support-kb.ts:32-36` (adversary N2) — customer-facing, MUST rewrite.**
  `draftBillingAnswer` is hardcoded prose quoting the retired `$99/$299/$799` ladder + a `$13/mailbox`
  rate that contradicts the $10 curve; it drafts replies to inbound billing-support emails
  (`support-inbound.ts` / `routes/admin-support.ts`). Rewrite the prose to the §18 curve ($49 platform +
  $10/mailbox, min 5/$99; $249 at 20, $649 at 60; 61+ = custom quote), dropping `$13`. Not covered by
  "update PLAN_QUOTAS consumers" (§4) — it deliberately does not import the table.
- **MCP** (`apps/platform/src/mcp/tools.ts`, `schemas.ts`) — add a `remove_mailboxes` tool; fold the
  quote-before-add confirm into `setup_infrastructure`/`request_managed_mailboxes`; the `account` tool
  description (`tools.ts:163`) should reflect per-provisioned-mailbox quantity billing; the mailbox count
  is capped by the flat 60 self-serve ceiling, not a tier. No `set_mailbox_plan` tool.
- `ACTIVATION.md:10` — reconcile the stale $99/$299/$799 "signed off" line (2026-07-12) to the §18 curve;
  the Stripe live-KYC (`:21`) + webhook-secret (`:23`) steps stay; **add a REQUIRED gated step: run
  `ensureStripePrices` in test mode, then live, BEFORE opening checkout** (N3 — sequenced before the key
  swap flips `isRealSpendArmed`).
- `SPEC.md:236` — flip "core billing migration pending" to done once shipped; the tier table in §18 stays
  as the reference curve. (No §18 meter reconciliation needed — the founder ruled the meter as
  provisioned/active, which is what §18 already says.)
- Out-of-scope, flag-while-in-file (adversary NEW): `support-kb.ts:45` says "~12 tools" — a stale count vs
  the ~24-tool claim elsewhere; unrelated to billing, note for a separate sweep.

---

## 12. Founder questions — ALL RULED 2026-07-24 (nothing outstanding blocks the build)

The three questions the original draft raised are resolved by the rulings at the top of this doc:
1. **Meter (was the blocking B1):** RULED **active/provisioned** — the bill follows real provisioned
   mailboxes; deprovision auto-lowers it; no committed-vs-provisioned divergence. (§2, §7, §8 reworked.)
2. **Remove-proration:** RULED **no mid-cycle credit** — `proration_behavior: "none"` on decreases. (§2.)
3. **Agency bundle:** RULED **follow-on** — sketch kept, build deferred. (§6.)

No remaining founder question gates this lane. Two operational items to *inform* (not decide):
- **N1 residual:** aggregate provisioned demand across all tenants can hit the account-wide
  `INBOXKIT_PLAN_SLOTS` cap, holding a new provision at `capacity_pending` (unbilled) until the founder
  raises the InboxKit plan. Existing G2/G4 back-pressure, now purely a provisioning/ops signal (no billing
  consequence under the active meter), surfaced via the founder capacity alert + G3.
- **N-r2 copy note (dispute-won recovery):** a `disputed` tenant is torn down (mailboxes released, §7); a
  later won dispute (`billing.ts` `charge.dispute.closed`) flips `billing_state='active'` on the same
  subscription → the active-only reconcile pushes `set-to-max(5,0)=5` → the tenant pays the **$99 floor
  with 0 live mailboxes** until it re-provisions. This is honest and §18-consistent (an active subscription
  pays the min-5 floor), but the recovery/support copy should say it plainly so it isn't a surprise.

---

## 13. Pre-brief for the adversary re-verify (what the amendment changed)

The blocking B1 is closed by the founder ruling (active/provisioned meter); N1–N5 are folded in. Re-attack
the REWORK, not the settled parts:
- **Active-meter timing edges:** is "billing follows provisioning" airtight across every ordering —
  provision batch mid-way, burn-replacement (release-then-provision within `REPLACE_DOMAIN`), a provision
  that partially fails after some rows landed, re-subscribe after cancel, and the min-5 floor when
  provisioned drops to 0 on an active sub? `syncMailboxQuantity` fires on the settled count + the
  active-only set-to-N reconcile is the claimed defense (§8) — try to make Stripe qty diverge from
  `max(5, released_at IS NULL count)`.
- **Bill-invariance of unattended paths (§7.1):** `REPLACE_DOMAIN` is now made bill-neutral by the
  mandated burned-mailbox release (release N on retire, provision N → net 0; withheld/failed → −N, never
  +N). Attack that: is the release genuinely on the unconditional retire leg (so the cap-hit and
  vendor-throw branches are also ≤0)? Does the extracted `releaseMailboxes` preserve revoke-before-mark?
  Is there ANY other autonomous (cron/tick) path that can RAISE the billed count without a customer in the
  loop (the invariant forbids it)?
- **Quote-before-add sufficiency (customer-initiated paths):** does folding the §18 quote+confirm into
  `setup_infrastructure`/`request_managed_mailboxes` + the new `remove_mailboxes` cover **every**
  customer-initiated path that changes the count?
- **Coupon ride + proration** are UNVERIFIABLE until the Tier-2 test-mode gate (§10 N4) runs — confirm the
  four scenarios are the right coverage and that `payment_method_collection: "if_required"` still collects
  a card at 60%-off (>$0).
- **N3 race path:** is "arm-time pre-create (required) + duplicate-`lookup_key` re-fetch on the lazy path"
  actually race-free, including the find-or-create **Product** step, not just the Price?
- **Deprecation risk:** licensed-quantity items + `lookup_key` current under pinned `2024-06-20`
  (`stripe-client.ts:12`); removing the usage-records path strands nothing.
- **MRR/coupon:** `mrrCents` now folds `checkout_discount_pct` — does anything downstream still assume
  `PLAN_QUOTAS[plan].priceCents`, and is the stored-% honest when a coupon is `repeating` (expires) vs
  `forever`?
