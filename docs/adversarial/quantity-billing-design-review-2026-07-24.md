# Adversarial design review — Quantity-billing migration

**Reviewer:** adversary (fresh context) · **Date:** 2026-07-24
**Target:** `docs/research/quantity-billing-design-2026-07-23.md`
**Ground ref:** `main` @ `71fb17f` (design committed). Every code/spec cite re-derived against this tree.
**Read-only git; no live Stripe calls.**

## VERDICT: SHIP-AFTER-FIXES — 1 BLOCKING

The Stripe mechanic (two licensed line items on durable `lookup_key` Prices), the freeze/dunning/teardown decoupling, the set-to-N reconcile, and the latent metered-vs-licensed bug deletion are all sound and correctly grounded. But the design's **billing meter (committed count) contradicts the canonical, founder-ratified SPEC §18 (provisioned count) and the founder's own "$10/active mailbox" ruling**, and buries that deviation as a narrow sub-question. That must be ruled by the founder — and SPEC §18 reconciled — before the build lane opens.

---

## Findings

### BLOCKING

**B1 · lens 1 (spec-vs-code line-trace) + lens 6 (attack the design) · The committed-count meter contradicts SPEC §18's provisioned-count meter and the founder's "per active" ruling — and the deviation is under-surfaced.**

- **Ground truth.** SPEC §18 (`SPEC.md:219,223`, "founder-ratified provisional curve, 2026-07-14 — canonical product intent") is explicit: *"Value metric = **provisioned mailbox**/month"*; *"'Provisioned mailbox' is the billing meter. A mailbox counts while configured and retained for the tenant—including while warming, send-ready, or temporarily health-paused… **A fully deprovisioned mailbox no longer counts.**"* The founder's ruling that drives this (`SPEC.md:179`) is worded *"$49 platform + $10/**active** mailbox."*
- **What the design does instead.** The meter is the **selected/committed** count (`mailbox_plan_qty`, set only via `set_mailbox_plan(N)`); provisioning fills headroom *under* it and never lowers it (design §2, §7). The two meters DIVERGE whenever committed ≠ provisioned:
  - A tenant commits 10 but provisions 6 → billed for **10**. SPEC §18 → **6**.
  - A tenant provisions 10, then deprovisions 4 → billed for **10** until it manually calls `set_mailbox_plan(6)`. SPEC §18: *"a fully deprovisioned mailbox no longer counts"* → **6**.
- **The design's justification is a misread.** §2 (line 138) leans on §18's parenthetical *"(tracks reserved underlying capacity)"* to call committed-billing "the honest reading of §18." But that parenthetical explains why a **retained** mailbox (warming/paused — i.e. still provisioned) counts; it is directly contradicted by the very next sentence's *"a fully deprovisioned mailbox no longer counts."* Nothing in §18 licenses billing for **unprovisioned committed slots**.
- **Why it's blocking, not a taste call.** The committed model has real merits (no-drift-by-construction; it closes the provision-50-drop-in-an-hour thrash-refund vector). It may well be the right product. But it is a **material deviation on the single most founder-sensitive axis — what the customer is billed for — from the canonical ratified spec AND the founder's own "per active" words**, and the design frames it as settled, surfacing only the narrow Open Q2 ("bill-on-commit while `capacity_pending`… name it in copy") rather than "committed vs provisioned/active" as the #1 ruling. This is the #1 thing the founder would be angry about (a customer commits 10, uses 6, is billed $149 for 6 active, against a "$10/active" pitch).
- **Fix (before build):** put "committed vs provisioned/active meter" squarely to the founder as the top ruling. If he rules **committed**, amend SPEC §18 to match (otherwise the canonical spec and the shipped money path diverge — a documentation-integrity break on the billing contract). If he rules **active/provisioned**, the core mechanic (`set_mailbox_plan` as the sole meter) needs rework toward a provisioned-count meter that still satisfies §18's quote-before-add rule. Build must not dispatch until this is ruled.

### NON-BLOCKING

**N1 · lens 7 (G4 interplay) · Systemic oversell: committed-billing beyond the shared vendor slot pool bills for undeliverable capacity.** `INBOXKIT_PLAN_SLOTS` (default 10) is an **account-wide** cap shared across ALL tenants (`spend-ceiling.ts`); `MAX_SELF_SERVE_MAILBOXES=60` caps only a single tenant. With committed-billing there is no commit-time slot-headroom check, so the **sum** of tenants' committed counts can exceed the plan, and a tenant billed for 20 can sit `capacity_pending` (only 10 slots exist account-wide) — having **paid for capacity the platform structurally cannot deliver** until the founder upgrades InboxKit. The design flags the single-tenant `capacity_pending` (Open Q2) but not this aggregate oversell. Recommend: gate `set_mailbox_plan(N)` on available slot headroom (reject/queue an over-commit), or accept overselling with a founder alert + honest copy — this is more than "name it in copy." Largely dissolves under an active/provisioned meter (B1).

**N2 · lens 4 (stale-claim kill class) · The claim-surface batch (§11) omits a customer-facing stale-price surface, and §9 mischaracterizes it.** `apps/platform/src/admin/support-kb.ts:33-42` (`draftBillingAnswer`) is **hardcoded prose** — its own comment says it is *deliberately NOT re-imported from `PLAN_QUOTAS`* — quoting *"Launch $99/mo, Growth $299/mo, Scale $799/mo, Custom $49 platform + $13/mailbox/mo."* That is the retired 3-tier ladder PLUS a **$13/mailbox** rate that contradicts the $10 curve. It is **customer-facing**: `support-inbound.ts` / `routes/admin-support.ts` use it to draft replies to inbound billing-support emails. The design lists it in §9's code blast radius as a *"PLAN_QUOTAS consumer,"* which is wrong — a builder who "updates PLAN_QUOTAS consumers" will not touch this prose, leaving the stale ladder live — and omits it from §11's customer-facing batch. Add `support-kb.ts` (prose rewrite to the curve, drop `$13`) to the §11 coordinated batch.

**N3 · lens 6 (bootstrap idempotency) · The `ensureStripePrices` "idempotent by construction" claim is not race-safe.** The lookup-then-create is not atomic across concurrent first-checkouts: two requests before any Price exists both `GET` nothing then both `POST` create the same `lookup_key` → Stripe rejects the second (duplicate `lookup_key`, absent `transfer_lookup_key`) → that checkout 500s. Same race on the find-or-create Product. First-deploy-only and narrow, but real. Fix: (a) make running `ensureStripePrices` at ARM time via the admin endpoint a **required step before opening checkout** (pre-creates the Prices out of the customer path), and (b) handle the duplicate-`lookup_key` error idempotently (re-fetch by key, use the existing).

**N4 · lens 8 (test strategy) + money-correctness · The highest-risk Stripe behaviors are verified only against a self-authored sandbox.** Coupon %-off riding to FUTURE quantity-bump invoices, proration direction/amount on add/remove, licensed set-to-N, and `lookup_key` uniqueness are all asserted against a `SandboxBillingPort` the builder writes to match their model of Stripe — never against real Stripe. **Stripe TEST MODE is not a live charge**; the design should require a test-mode verification of the coupon-ride + proration crux at build, not defer all Stripe-semantics verification to arm (these are the hardest-to-reverse money behaviors).

**N5 · MRR-with-coupon under-specified.** `mrrCents` must fold the discount (design §11, §13), but the design never says to **store the discount % locally** (captured from `checkout.session.completed`'s discount object, alongside the item ids). Without it, `mrrCents`/quote can't apply the 60% without a Stripe round-trip. Capture the discount at checkout completion.

---

## Attacks that failed (why the SHIP-able parts are meaningful)

- **Latent metered-vs-licensed bug — CONFIRMED, deletion correct.** Checkout builds a **licensed** inline `price_data` item (`stripe-client.ts:85-99`, no `usage_type` → licensed); `reportUsageRecord` posts to `/subscription_items/{id}/usage_records` (`stripe-client.ts:149`, metered-only); arming it would 400. Inert today (`reportUsageToStripeIfConfigured` no-ops without `STRIPE_SECRET_KEY` + a stored `stripe_subscription_id`, `billing.ts:409-419`). The migration's deletion is right — the licensed quantity **is** the per-mailbox charge; keeping both double-counts.
- **Coupon-ride Stripe semantics (lens 3) — accurate.** A subscription-level `percent_off` with `duration: forever` discounts every invoice for the subscription's life, **including** the proration lines a mid-cycle quantity bump adds (Stripe applies subscription discounts to the invoice subtotal at finalization for the discount's duration). "Single-use" (the promotion code's redemption limit) and "forever" (the discount's duration) are orthogonal and coherent. `payment_method_collection: "if_required"` collects a card at 60%-off (invoice > $0). Build must confirm the actual coupon object is `duration: forever` (config, not mechanic).
- **No-drift of the mirror (lens 5) — holds.** `mailbox_plan_qty ⟷ Stripe qty` is kept by **set-to-N (absolute, not increment)** + record-before-push + reconcile-on-`synced≠plan` + an active-only guard. Races are benign (both writers converge to the same N); a lost confirmation self-heals on the next sweep; re-subscribe overwrites the item ids at `checkout.session.completed`; canceled/`past_due` tenants are skipped by the active-only guard, so teardown-driven release never pushes `qty=0` into dunning. The mirror never silently diverges. (The divergence from the *provisioned* count is the committed-model choice — B1, not a drift bug.)
- **Freeze/dunning/teardown decoupling (§8) — coherent.** Quantity sync fires only from `set_mailbox_plan` while `billing_state='active'` (+ `assertNotLifecycleFrozen`, `billing-state.ts:53-60`); teardown releases mailboxes for vendor/slot cleanup (`lifecycle.ts:165-194`, `releaseMailboxSlots`) without touching Stripe qty; dunning leaves qty untouched and recovery restores sends with no qty change. No teardown-driven `qty=0` fights dunning.
- **Collapse code blast radius (§9) — cites verified.** `CheckoutInput` plan enum (`intents.ts:65`), `PLAN_QUOTAS` $99/$299/$799 (`pricing.ts:19-23`), `isPaidPlanTier` (`pricing.ts:57`) are as cited; `packages/cli/.../campaign.ts` `launch`/`scale` correctly excluded (campaign subcommand, not tiers). Site "launch"/"scale" hits are `launch_campaign`/prose, not pricing tiers.

## UNVERIFIABLE (needs a real Stripe test-mode call — not foldable into the verdict)

Every Stripe-behavior claim is unverified until a real (test-mode) call: coupon-ride to future quantity-bump invoices, proration direction/amounts on add vs remove, `lookup_key` uniqueness + `transfer_lookup_key` handling, licensed set-to-N quantity semantics under a discount. The design defers these to arm; N4 recommends pulling the coupon-ride + proration verification into the build against Stripe test mode.

## NEW (out-of-scope) observations — no verdict weight

- `ACTIVATION.md:10` still "signs off" $99/$299/$799 (design §1 notes it as stale); fold into the same claim-surface batch as N2 so no signed-off surface contradicts the curve.
- `support-kb.ts`'s "~12 tools" (line ~45) is a separate stale count from the 24-tool claim elsewhere — unrelated to billing, flagging while in the file.

---

## Round 2 — rework verify (2026-07-24)

**Target:** the amended design (`docs/research/quantity-billing-design-2026-07-23.md` @ `fbd4285`), reworked to the founder-ruled ACTIVE/PROVISIONED meter (`set_mailbox_plan`/`mailbox_plan_qty` deleted; `remove_mailbox` intent added; N2–N5 folded). Focused re-attack of the rework.

### VERDICT: SHIP-AFTER-FIXES — 1 BLOCKING (new, introduced by the active-meter rework)

B1 is genuinely closed (the meter is now provisioned, language clean) and N1 dissolves as claimed. But the active meter + the active-only reconcile sweep, combined with the EXISTING `REPLACE_DOMAIN` behavior, silently doubles a customer's bill on a routine deliverability event — and the design asserts that path is "cost-neutral" on a factually wrong reading of the code.

### BLOCKING

**B2-rework · lens 1 (spec-vs-code) + lens 6 · Autonomous burn-replacement silently doubles the billed count; the design's "cost-neutral" claim is contradicted by the code.**

- **The claim.** §2 (line 168) / §13 (line 522): a burn-replacement's "release-then-provision nets to the true final count" and `REPLACE_DOMAIN` auto-replacement is "cost-neutral," so it needs no quote.
- **The code.** `applyReplaceDomain` (`deliverability-actions.ts:120-124,~173`) retires the burning domain (`status='burning'`) and `pauseDomainMailboxes` sets `deliv_status='paused'` — it does **NOT** set `released_at` and does **NOT** release the mailboxes at the vendor. `released_at` is set in exactly ONE place: full tenant teardown (`lifecycle.ts:184`). No burned-domain cleanup sweep releases them later (grep: only `status='burning'` reads/reporting exist). So the burned mailboxes keep `released_at IS NULL`.
- **The consequence.** The billing meter is `COUNT(*) WHERE released_at IS NULL` (§8.1). After `REPLACE_DOMAIN`: N burned-but-paused mailboxes (still counted) + N replacements (counted) = **2N**. The active-only reconcile sweep (§8.5) then computes `desired = max(5, 2N)` and pushes **set-to-2N** to Stripe — autonomously, on the cron, with **no quote and no confirm**. That is a silent capacity addition (violates SPEC §18 `SPEC.md:223` "no silent capacity addition"), it bills the customer for dead burned mailboxes, and it also leaks the burned InboxKit vendor slots (G4). Burn-replacement is a routine event (it is why `REPLACE_DOMAIN` exists), so this is the exact surprise-2x-invoice scenario the founder would be furious about.
- **Fix (design amendment, before build):** `REPLACE_DOMAIN` (and any burn/retire path) must RELEASE the burned domain's mailboxes — set `released_at`, call `mailbox.release` at the vendor, and decrement the G4 slot counter — so the replacement truly nets to zero (release N, provision N → count unchanged → no silent addition, no double-bill, no slot leak). The design must specify this build task and correct the "cost-neutral" assertion; as written, a builder trusting "it nets" ships the double-bill.

### NON-BLOCKING

**N-r1 · The required test-mode gate (§10) omits the 60%-off card-collection assertion.** The four scenarios (coupon-ride, increase-prorates, decrease-no-credit, `lookup_key` duplicate) are well-chosen, but the design flags in §13 (line 524) that `payment_method_collection: "if_required"` must still collect a card at 60%-off (>$0) and does NOT make it one of the required assertions. A discounted-but->$0 subscription created without a card fails on the first invoice — add it as scenario 5.

**N-r2 (minor) · Dispute-won recovery bills the floor with 0 live mailboxes.** A `disputed` tenant is torn down (mailboxes released, §7); a later won dispute (`billing.ts` `charge.dispute.closed`) sets `billing_state='active'` on the same subscription → the reconcile sweep pushes `set-to-max(5,0)=5` → the tenant pays the $99 floor with 0 live mailboxes until it re-provisions. §18-consistent (an active sub pays the min-5 floor), but worth a copy note.

### Attacks that failed

- **B1 residual language sweep — clean.** Every "committed" mention in the amended doc is contrastive (naming the rejected model); the meter is uniformly provisioned/active; `set_mailbox_plan`/`mailbox_plan_qty` are deleted; the mirror is "reconciled to that count, never a separately-committed number" (line 141). No residual committed behavior.
- **N1 dissolution — verified.** A provision that hits the G2 ceiling / G4 slot cap never runs `fn()` (the `withSpendCeiling` reserve rejects first, provisioning-core review) → no mailbox row → `released_at IS NULL` count unchanged → never billed. A partially-failed batch bills only the rows that landed (floored at 5). The active meter genuinely removes the committed-model oversell-billing.
- **Dunning recovery (past_due) — clean.** Teardown does not run on `past_due` (§7), so no release lowers the count during dunning; recovery restores sends with the count unchanged and the reconcile sweep no-ops (`synced == max(5,count)`). No phantom billing.
- **No-drift machinery — sound.** `desired = max(5, provisionedCount)` set-to-N (absolute) + record-before-push + active-only reconcile; a lost confirmation self-heals; re-subscribe overwrites the item ids at `checkout.session.completed`; canceled/`past_due` are skipped. Stripe qty cannot silently diverge from `max(5, released_at IS NULL count)` — EXCEPT that the count itself is wrong after `REPLACE_DOMAIN` (B2-rework).
- **Test-mode gate now in-lane (my r1 N4 addressed).** §10 makes the Stripe test-mode verification a REQUIRED gate before the lane closes, not deferred to arm — the right posture for the coupon/proration crux.

### UNVERIFIABLE

The Stripe-behavior claims (coupon-ride, proration direction, `lookup_key` uniqueness, licensed set-to-N under a discount) remain unverified until the §10 Tier-2 test-mode gate actually runs — now required in-lane, which is the correct resolution of r1 N4.

### B2-rework CLOSED — final ack (2026-07-24)

**B2-rework is CLOSED. FINAL DESIGN VERDICT: SHIP.** The amendment (new §7.1, on `main` @ `f3ca625`) resolves it correctly; all three ack points verified:

1. **§7.1 closes B2.** The new §7.1 REQUIRED increment releases the burned domain's mailboxes on `REPLACE_DOMAIN`'s **unconditional retire leg, before** the replacement-vs-withhold decision (vendor `mailbox.release` + revoke + `released_at` + G4 slot decrement), so all three sub-paths are bill-neutral-or-lowering: replacement succeeds → release N then provision N = **net 0**; withheld / vendor-throw → release N, no provision = **−N**; never +N. The two false "cost-neutral" passages are corrected: the §2 line-168 claim is rewritten, and lines 173-181 add an explicit ⚠️ that names the code reality (`pauseDomainMailboxes` sets `deliv_status='paused'` not `released_at`; `released_at` only at `lifecycle.ts:184`) and states "the autonomous reconcile is only safe **because** that increment is required." Residual-language sweep clean — every remaining "nets/neutral" mention is either the corrected ⚠️, the §7.1 mandate, or the pre-brief re-attack framing.
2. **The `releaseMailboxes` extraction is sound.** The real teardown loop (`lifecycle.ts:160-194`) is exactly: `SELECT … WHERE released_at IS NULL` → `mailbox.release` → count `slot_counted` → `revokePushedMailboxCredentials` → `UPDATE released_at` → `releaseMailboxSlots` after the loop. §7.1's extract into `releaseMailboxes(ctx, {domainId?})` (add `AND domain_id = ?` when scoped, both teardown and REPLACE_DOMAIN call it) is a behavior-preserving refactor, and it explicitly preserves the revoke-**before**-mark ordering (the i3i4-r2 crash-safety hardening).
3. **"No other autonomous bill-raising path today" — verified.** `mailbox.provision` is centralized in `provisioning.ts` (spend-ceiling coverage test), and its two wrappers have exactly three callers: `runSetupInfrastructure` (customer intent, quote+confirm), `requestManagedByoMailboxes` (customer — MCP tool `tools.ts:281` + route `byo-domains.ts:36`, quote+confirm), and `REPLACE_DOMAIN` (the sole autonomous path, now §7.1-neutral). `HARD_PAUSE_DOMAIN`/throttle are correctly carved out (pause-only, add no mailboxes; paused-retained capacity §18 explicitly counts). Nothing in `scheduled.ts`/`tick.ts` provisions except the deliverability sweep's `REPLACE_DOMAIN`. The governing rule ("unattended paths must be bill-neutral or bill-lowering, never bill-raising without explicit consent") holds and is now documented.

N-r1 folded (test scenario 5: 60%-off still collects a card + first invoice succeeds); N-r2 carried as a copy note. Every blocking finding across both rounds is now resolved — the design is safe to build.

---

## Build review (2026-07-24)

**Target:** the quantity-billing BUILD, branch `worktree-quantity-billing-20260724` @ `3063181` (8 commits, base `5b1edf7`). **Read-only git; ran the battery + independently re-ran the Stripe TEST-MODE gate.**

### VERDICT: SHIP-AFTER-FIXES — 1 BLOCKING (deviation 4, a small §18-letter fix; the rest is thoroughly verified, including an independent real-Stripe re-run).

The build is strong: 5 of 6 deviations hold, the §7.1 fix I required has a genuine RED-proof, the metered-400 path is fully deleted, MRR is curve-based, and I re-ran the Tier-2 Stripe test-mode gate myself — 5/5, confirming the coupon-ride/proration/card-collection money-crux against real Stripe. The one blocker is that the default mailbox-ADD path returns no price, leaving §18's "no silent capacity addition" enforced on removes but not adds.

### BLOCKING

**D4-build · lens 1 (spec-vs-code) + lens 6 · The default add path is a silent capacity addition; §18 is enforced on REMOVE but not ADD.** `SetupInfrastructureInput.quoteOnly` defaults `false` and is "backward-compatible" (`intents.ts:25`); on `quoteOnly:false` the intent provisions and returns only `{ jobId }` (`provisioning.ts:210`) — it does **not** return the proposed new count + projected monthly price. SPEC §18 (`SPEC.md:223`) requires: *"Before any mailbox addition, both the agent response and billing UI must return the proposed new count and projected monthly price; no silent capacity addition."* The build enforces explicit consent on the REMOVE path (`RemoveMailboxesInput.acknowledged: z.literal(true)`, never defaulted) but NOT on the ADD path — backwards from §18, whose rule is specifically about *additions*. **Mitigations (substantial):** the MCP tool description discloses the exact formula ($10/mailbox + $49, min 5) and instructs `quoteOnly:true` first, and the agent chose the count — so §18's SPIRIT (no bill surprise; the agent has the formula + count) is met even on the default path; only the LETTER (the response returns the price) is unmet. **Resolvable by EITHER:** returning the quote (new count + projected monthly) in every provision response / requiring an explicit confirm on add (symmetric with remove) — OR a founder ruling that formula-disclosure + quote-first-instruction satisfies §18 (a ratification, like the committed-vs-active call). Build should not self-certify §18-add compliance without one of these.

### Deviations judged — 5 of 6 HELD

1. **Direct `stripe-client` sync (not per-tenant BillingPort) — HELD.** `syncMailboxQuantity` (`billing.ts:527`) reads `stripe_mailbox_item_id` from the tenant's OWN `tenant_profile WHERE id = ctx.tenantId` — per-tenant isolated (no cross-tenant item-id confusion). Fail-safe: the Stripe call is in a try/catch that swallows and NEVER throws (`:562-565`), leaves `mailbox_qty_synced` stale for the reconcile — a Stripe outage can never fail the provision. Active-guarded (`:537`).
2. **`ensureStripePrices` off the port — HELD.** Account-level bootstrap, no per-tenant isolation concern; YAGNI is fair.
3. **Reconcile in `deliverabilitySweep` not a D1 sweep — HELD.** It's in the `deliverabilitySweep` DO RPC (`tenant-do.ts:720`), which the cron (`runDeliverabilitySweepAllTenants`) invokes for EVERY tenant → runs for all active paid tenants incl. zero-deliverability-activity ones; active-only + set-to-N + no-op-on-no-drift, so it's a cheap heal-any-drift backstop, not just a REPLACE_DOMAIN trigger.
4. *(BLOCKING — above.)*
5. **`site/pricing.html` no-edit — HELD.** No `$299`/`$799`/Growth; the only tier-ish label is "Scale / 60 / $649" — a curve size-preset, not the retired SKU.
6. **`recordUsage` local ledger kept — HELD.** Per-mailbox-MONTH internal COGS (`provisioning.ts:119`), explicitly labeled "NOT the customer's bill," surfaced as `account().usageCents`; the account tool description states the real per-mailbox flat billing. No per-send/metered-sends implication.

### Standard lanes — all clean

- **Battery (ran myself):** platform **780/780 (112 files)**; CLI `typecheck` + `build` clean (tier collapse didn't break it); `wrangler` dry-run clean; workspace typecheck clean.
- **Tier-2 Stripe test-mode gate — independently RE-RAN, 5/5:** (a) coupon %-off rides the future quantity bump (recurring 8000, discount 4800 = 60%; proration line discounted) · (b) increase prorates (+3200) · (c) decrease creates zero credit lines · (d) concurrent `ensureStripePrices` converge to one Price/`lookup_key` · (e) 60%-off checkout collects a card + first invoice paid (3960). This verifies the money-crux against real Stripe — closing r1 N4 and r2 N-r1 live.
- **§7.1 RED-proof — genuine:** `burn-replace-billing.test.ts` asserts the reconcile pushes set-to-N (6) not 2N (12); reverting `releaseMailboxes` fails it at 2N (my exact B2 scenario); withheld-branch pushes the floor (5), never +N.
- **Metered-400 path DELETED — zero orphan callers** (`reportUsageToStripeIfConfigured`/`reportUsageRecord`/`usage_records` grep empty). Closes r1's latent-bug find.
- **`checkout.session.completed` capture idempotent under retry:** event-id dedup (`INSERT OR IGNORE webhook_events`); `captureSubscriptionState` runs only on first delivery; absolute UPDATE.
- **MRR curve:** `monthlyRevenueCents(provisionedCount, checkout_discount_pct)`, gated on `isPaidPlan && billing_state='active'` — consistent with the meter.
- **`AUTHED_PATH_PATTERNS`:** `/remove-mailboxes` added (authed customer mutation).
- **Secrets:** gate reads `sk_test_` from the gitignored `.dev.vars` at runtime, enforces `sk_test_`, never prints it; no `sk_` literal committed.

### UNVERIFIABLE / NEW

- `account().usageCents` surfaces internal per-mailbox COGS to the customer's agent — not a metered-sends claim and the tool clarifies real billing, but a slightly confusing number for a customer surface (minor; consider dropping from the customer view or renaming).
