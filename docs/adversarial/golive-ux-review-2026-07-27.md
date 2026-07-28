# Adversarial review — Go-live UX diff (uncommitted)

- **Date:** 2026-07-27
- **Reviewer:** adversary (fresh context)
- **Ground:** worktree `agent-a1087f4bed32ad0d9`, HEAD `a0249705a7800565e861e8315501e5f1c1cdbaa6` (== main HEAD); diff is uncommitted working tree.
- **Scope:** dashboard BillingPage "Go live" section, SandboxBanner, SetupPage checklist step, SignupPage/site work-email sweep, new tests, checkout.test.ts cookie+CSRF pin.

## VERDICT: NO-SHIP (two BLOCKING findings) — equivalently SHIP-AFTER-FIXES with #1 + #2 required.

Battery is green (platform 819/819, dashboard 123/123, engine 95+3 skipped; typecheck 0 errors, 5 workspaces) and the CSRF/auth wiring is correct — but a green suite here co-exists with two shipping defects on a conversion-critical money surface, hidden by happy-path fixtures.

---

## Findings (most severe first)

### 1. BLOCKING — the "Mailboxes to provision" selector and the "$X/mo for N mailboxes" quote do NOT determine the charge (money-path lie)
- **Failure scenario:** A sandbox tenant that exercised the sandbox (SetupPage instructs "Ask the agent to call setup_infrastructure" + "Run a simulated campaign") has, say, 12 provisioned mailboxes. On /billing the aside shows **"Provisioned now: 12"**; the Go-live section defaults to 5 and shows **"$99 /mo for 5 mailboxes"**. Clicking "Go live" POSTs `{mailboxes:5}`, but the server bills the Stripe line item at **`checkoutMailboxQuantity(ctx)=max(5,provisioned)=12` → $169/mo**, not the $99 shown. Symmetrically, a 0-provisioned tenant who picks 60 ("$649") is charged for `max(5,0)=5` = $99. The selector is functionally inert in **both** directions; the quote can be wrong either way.
- **file:line:** `apps/platform/src/engine/billing.ts:151` (`mailboxQuantity: checkoutMailboxQuantity(ctx)`), `:89-94` (counts provisioned, ignores input), `:85-87` (comment admits `input.mailboxes` only "bounds/seeds the quote"); `apps/platform/src/billing/stripe-client.ts:103` (`line_items[1][quantity] = params.mailboxQuantity`); `input.mailboxes` appears **nowhere** in billing.ts except the doc comment (grep-confirmed). UI: `apps/dashboard/src/pages/BillingPage.tsx:43-55`.
- **Verification:** code trace + live render. Screenshot `pw-shots/golive-review-2026-07-27/billing-sandbox-desktop.png` shows "Provisioned now: 12" and "$99 /mo for 5 mailboxes" on the same screen.
- **Why the suite misses it:** `billingPage.test.tsx` fixture uses `mailboxes:0`, so selected(5)==floor(5)==$99 by coincidence, and it mocks `/checkout` to return a canned URL — it structurally cannot observe that the server drops `mailboxes`. (Fixture-realism blind spot.)
- **Pilot caveat:** the named pilot using the 100%-off `MORDYPILOT` coupon pays $0 either way, so acute $ harm is masked for *that* tenant — but the displayed numbers still mislead the pilot, and every non-promo self-serve customer sees a wrong price and an inert control.

### 2. BLOCKING — SetupPage "Go live" checklist step claims "real sending is live" when it isn't (copy-truth)
- **Failure scenario:** The done-predicate is `activationState !== "sandbox"` and the done-copy is a flat **"Billing is active — real sending is live."** In today's unarmed deploy, a tenant who completes checkout lands in **`pending_provisioning`** (`realSendPathLive` is false because engine+InboxKit aren't armed) — the checklist tells them real sending is live when nothing leaves. Same false claim for `screening_hold` (OFAC review), `capacity_pending` (spend/slot hold); for `suspended` (past_due/dispute) and `canceled` even **"Billing is active"** is false.
- **file:line:** `apps/dashboard/src/pages/SetupPage.tsx:60` (predicate), `:78-84` (copy); state machine `apps/platform/src/engine/activation.ts:118-131`, union `:79-86`.
- **Verification:** code trace + screenshot `setup-active-desktop.png` (the "real sending is live" line renders directly under the page's own **unchanged "Sandbox · no real sends"** chip — internal contradiction).
- **Why the suite misses it:** `setupPageGoLiveChecklist.test.tsx` covers only `sandbox` and `active`, and asserts only the checkmark glyph, never the copy — even though the sibling `sandboxBanner.test.tsx` enumerates all 5 post-checkout states. The builder had the full state list and didn't apply it where the wrong claim lives.
- **Fix direction:** gate the "live" copy on `activationState === "active"`; give the paid-but-pending states their own honest line.

### 3. NON-BLOCKING — Go-live section is ungated → already-active tenant can double-checkout (no server guard)
- **Scenario:** The section renders for every state (`BillingPage.tsx:40`, unconditional). Reactivation of `canceled`/`suspended` via `POST /checkout` **is intended** (test output: "reactivate via POST /checkout first"), so those are fine. But an **already-active** tenant clicking "Go live" (plausibly to "add mailboxes", given the "Mailboxes to provision" label) hits `tenant-do.ts:617 checkout()` → `startCheckout` with **no billing_state guard** → in Stripe mode a second Checkout Session/subscription; the DO tracks a single `stripe_subscription_id`, so the webhook overwrites it and the first subscription orphans while still billing.
- **file:line:** `BillingPage.tsx:40`, `apps/platform/src/engine/billing.ts:142-156` (no already-active guard), `apps/platform/src/tenant-do.ts:617`.
- **Verification:** code trace + screenshot `billing-active-desktop.png` (fully-live "Go live" button for an "active"/"Managed" tenant). Exact Stripe duplicate-charge outcome needs a live-Stripe check (see UNVERIFIABLE). Fix: hide/disable the section for already-live states (active/pending_provisioning/capacity_pending), keep it for sandbox + canceled + suspended.

### 4. NON-BLOCKING — BillingPage preview copy contradicts the live checkout for paid tenants
- For a non-sandbox tenant the page still shows header chip **"Preview · paid activation pending"**, aside **"Payment method: Not collected in sandbox" / "Renewal: Not active" / "Save billing controls at activation"** and **"disabled until Stripe quantity billing replaces the legacy test tiers"** — all stale/contradictory beside the working Go-live checkout and the "active" chip. Pre-existing preview copy, but this diff adds a real checkout to the page without reconciling it. `BillingPage.tsx:37,91,92,97,98`. Screenshot `billing-active-desktop.png`.

### 5. NON-BLOCKING — decimal in the number input → confusing generic 400
- The input has no `step`; onChange only clamps, never rounds (`BillingPage.tsx:50`), so a typed "12.5" stays in state, displays "for 12.5 mailboxes", and POSTs `mailboxes:12.5`, which `CheckoutInput`'s `z.number().int()` (`packages/shared/src/intents.ts:73`) rejects → the user sees the raw server error with no hint the decimal was the cause. Low frequency; add `step={1}` + round in onChange.

---

## Attacks that FAILED (PASS is meaningful)
- **CSRF/auth (brief #3):** `apiRequest` sets `X-Coldstart-Client: dashboard` for every non-GET and `credentials:"include"` (`client.ts:22,58,62`); `useCheckout` routes through it; `POST /checkout` is on `AUTHED_PATH_PATTERNS` behind `requireAuth`+`csrfGuard`; new `checkout.test.ts` pins 201-with-CSRF and 403-without-CSRF using real `createDashboardSession`/`cookieApi` helpers. Held.
- **SandboxBanner state derivation:** hides for all 6 non-sandbox states; `ActivationBanner` excludes sandbox, so the two never double-message; `sandboxBanner.test.tsx` enumerates all 5 post-checkout states. Held.
- **Promo-code copy:** `allow_promotion_codes=true` on every session (`stripe-client.ts:104`) — "Add promotion code" really appears at Stripe checkout. Held (Stripe mode).
- **Pricing formula:** 4900 + 1000·n → $99/$109/$149/$649 for 5/6/10/60 (matches brief); the "$49 platform" decomposition is NOT in the go-live pitch. The formula is internally correct — its only defect is being disconnected from the charge (finding #1). Held.
- **Integer input clamp:** onChange clamps [5,60], blank/NaN→5; integer values always in range. Held (decimals = finding #5).
- **Stale-copy guard:** real, not tautological — would fail on the old "not active yet" copy; signup label change is consistent. Held.
- **Mobile layout (390px):** banner ("Sandbox mode — sends are simulated" + "Go live") fits one row; Go-live section and checklist stack cleanly; no crowding/overflow. Screenshots `*-mobile.png`. Held.
- **Battery:** typecheck 0 errors (5 workspaces); tests 819/819 platform + 123/123 dashboard + engine 95(+3 skip) + shared/root green.

## UNVERIFIABLE (needs environment/creds)
- **Live Stripe arming state:** cannot read the prod `STRIPE_SECRET_KEY` secret from here. If it is UNSET, "Go live" redirects to `/checkout/simulate` — an unauthenticated GET returning raw JSON that flips the tenant to `managed`/`active` for free (`routes/checkout.ts:53-67`, `billing.ts:158-181`) — a broken human experience. If test/live keys are set, it's a proper Stripe checkout. **Confirm arming before deploy.**
- **Finding #3 exact duplicate-charge outcome:** whether a second active-tenant checkout produces a truly duplicate live subscription needs a live-Stripe smoke.

## NEW (out-of-scope) observations
- `site/index.html` still says new accounts "activate through a short concierge step" + offers a "Request real-sending activation" waitlist form — stale vs the now-self-serve Go-live flow. Marketing surface; the dashboard stale-copy guard only sweeps `apps/dashboard/src`. Founder ruling: is concierge activation still offered alongside self-serve?

## Screenshots
`/Users/yaakovscher/dev/coldstart/pw-shots/golive-review-2026-07-27/` — `{billing,setup}-{sandbox,active}-{desktop,mobile}.png` (8 files), captured against the worktree vite dev server with `/account`+`/infrastructure-status` intercepted.

---

# ROUND 2 (2026-07-28) — re-check after builder's 5 fixes

Same worktree, HEAD `a0249705` unchanged (fixes uncommitted). Battery re-run: dashboard 139/139, engine 95+3 skipped, platform suite ran, `npm test` exit 0; typecheck 0 errors. Fresh screenshots in `pw-shots/golive-review-2026-07-27/round2/` (billing sandbox/active/canceled + setup sandbox/active/pending_provisioning, desktop+mobile), examined.

## ROUND-2 VERDICT: SHIP-AFTER-FIX — 1 NEW BLOCKING survives; 4 of 5 round-1 findings CLEANLY CLOSED.

### Round-1 findings — status
- **BLOCKING #1 (selector inert / price ≠ charge): CLOSED for the traced values, but a NEW adjacent BLOCKING opened (see below).** The free-form selector is gone; the quote is now `monthlyRevenueCents(account.data.mailboxes)` and the billed count `billableMailboxes(account.data.mailboxes)` — the identical **uncapped** `max(5,n)` formula the server bills (`billing.ts:89-94`, `stripe-client.ts:103`). Traced both sides for provisioned 0/5/12/72: display == charge = $99/$99/$169/$769 (billed 5/5/12/72). The deliberate choice of `billableMailboxes`/`monthlyRevenueCents` over the 60-clamped `quoteProvisionedMailboxes` is CORRECT — a 72-provisioned tenant quotes $769, matching the uncapped server charge (`checkoutMailboxQuantity` has no upper cap). Seed-clamp-to-60 is SAFE, not a 400 trap: `checkoutSeedMailboxes = max(5,min(60,provisioned))` is always in `CheckoutInput`'s 5..60 range, and the server ignores it anyway (re-reads the live count). Test covers 0/5/12/72. ✓
- **BLOCKING #2 (false "real sending is live"): CLOSED.** `goLiveStatus()` gives each `ActivationSurfaceState` its own honest line; `done:true` reserved for `active` only. `pending_provisioning` (the current unarmed-deploy post-checkout state) now renders NOT-done + "real sending is still being provisioned; sends shown are still simulated." Verified in `round2/setup-pending_provisioning-desktop.png`. Copy-asserting tests added. ✓
- **NB #3 (ungated re-checkout → duplicate subscription): CLOSED.** Client renders the section only for `sandbox/canceled/suspended` (`GO_LIVE_VISIBLE_STATES`); server `startCheckout` 400s when `billing_state === "active"` (`billing.ts`, `readLifecycleState`). Check (b) resolved: `active`/`pending_provisioning`/`capacity_pending` all branch off `billing_state === "active"` in `deriveActivationState`, so the one check covers all three; `screening_hold` with active billing is guarded, and `screening_hold` without it has no live subscription to duplicate — so a screening_hold tenant cannot double-subscribe through the gap. Guard test is genuine RED/GREEN (activates the tenant, asserts 400 `/already.*active/i`; separately asserts canceled reactivation still 201). `active` tenant now shows NO Go-live section (`round2/billing-active-desktop.png`). ✓
- **NB #4 (preview copy contradicts paid state): CLOSED.** Header chip is state-derived (`HEADER_CHIP` map); Payment method / Renewal rows dynamic on `billingState`; ceiling copy honest ("preview only — isn't persisted or enforced yet"). Verified in `round2/billing-{sandbox,active}-desktop.png`. ✓
- **NB #5 (decimal input → 400): CLOSED.** The number input is eliminated entirely. ✓

### NEW — BLOCKING (round-2 re-attack, lens 7 regression ring): the go-live quote re-opens display ≠ charge for any Go-live-visible tenant with RELEASED mailboxes
- **Root:** the display derives from `account.data.mailboxes` = `getAccount`'s `count("mailboxes")` = `SELECT COUNT(*) ... WHERE tenant_id = ?` — **no `released_at` filter** (`reporting.ts:173-174`). The charge derives from `checkoutMailboxQuantity` = `COUNT(*) WHERE tenant_id = ? AND released_at IS NULL` (`billing.ts:91`). Releases are SOFT — rows persist with `released_at` set — via three core flows: `removeMailboxes` (`billing.ts:685`), deliverability auto-replacement (`deliverability-actions.ts:136`), and teardown/cancel releasing ALL (`lifecycle.ts:225`). So the two counts diverge whenever any mailbox has been released.
- **Failure scenario (highest magnitude — the flow the builder ENABLED):** a **canceled** tenant (in `GO_LIVE_VISIBLE_STATES`, with "reactivate from Billing" copy) had its mailboxes soft-released by teardown → `account.data.mailboxes` still counts them. The Go-live section shows "you have 12 provisioned now" and "**$169 /mo for 12 mailboxes**", but at reactivation `checkoutMailboxQuantity = 0 → max(5,0)=5 → $99`. Both the price AND "12 provisioned now" are confidently wrong. Visible in `round2/billing-canceled-desktop.png`. A 72-mailbox canceled tenant would be quoted **$769** and charged **$99**. Sandbox tenants that hit auto-replacement see a smaller inflated quote.
- **Verification:** code trace (count queries + soft-release grep, no `DELETE FROM mailboxes` anywhere) + live render. **Direction is over-quote** (shown ≥ charged), so no customer is overcharged beyond what they saw, and a FRESH tenant's first go-live (no releases) is correct — the pilot's typical path passes. But the copy makes a false factual assertion on the money surface for a reachable, builder-enabled flow.
- **Test blind spot (lens 5):** `billingPage.test.tsx` sets `account.mailboxes` directly and treats it as both display and (implicitly) charge — it cannot model `released_at`, so green ≠ correct here.
- **Fix:** drive the go-live quote (and ideally "Provisioned now") from the billing meter's count (`released_at IS NULL`), not `getAccount`'s count-all — e.g. expose a billable-count field from `/account`, or have the server return the authoritative quote.

### RULING on builder-flagged deviation (c) — SetupPage header chip: NON-BLOCKING (ledgered follow-up)
`SetupPage.tsx:106` still hardcodes `<span>Sandbox · no real sends</span>` (NOT state-derived, unlike the BillingPage header chip just fixed). It is FALSE only for `active`; for `sandbox` and `pending_provisioning` "no real sends" is TRUE. `active` is UNREACHABLE in the current unarmed deploy (`realSendPathLive` needs engine+InboxKit armed), so this is a **latent** contradiction, not live today. NON-BLOCKING, but trivially fixable now — the `HEADER_CHIP` state-derivation helper already exists on BillingPage; apply it to the SetupPage chip in the same cut. Must be fixed before arming makes `active` reachable.

### Round-2 attacks that HELD
Uncapped formula for >60 (72→$769); seed-clamp-to-60 no 400 trap; server guard exactly gates the double-subscription precondition (`billing_state==="active"`) and preserves canceled/past_due/none reactivation; per-state SetupPage copy honest; state-derived BillingPage chip/aside/ceiling; input removed; CSRF still pinned (201-with / 403-without). Mobile 390px clean.

### UNVERIFIABLE (unchanged)
Prod `STRIPE_SECRET_KEY` arming — confirm before deploy (simulated-mode "Go live" → raw-JSON `/checkout/simulate`).

---

# ROUND 3 (2026-07-28) — final check after single-source refactor

Same worktree, HEAD `a0249705`. Battery re-run: **dashboard 143/143, platform 821/821, engine 95+3 skipped, cli passing, `npm test` exit 0**; typecheck 0 errors. Screenshots in `pw-shots/golive-review-2026-07-27/round3/`.

## FINAL VERDICT: SHIP. All findings across rounds 1–3 closed; no BLOCKING survives. Deploy gate CLEARED from the adversary side.

### Round-2 BLOCKING (count-source divergence) — CLOSED, verified end-to-end
- **Single-sourced:** new `billableMailboxCount(ctx)` = `COUNT(*) ... WHERE released_at IS NULL` (`lifecycle.ts:117-121`) is now the ONE query behind BOTH the charge (`checkoutMailboxQuantity` → `billing.ts:94`) AND the dashboard quote (`AccountSummary.billableMailboxes` → `reporting.ts:217`). BillingPage reads `account.data.billableMailboxes` for the quote and the renamed **"Active mailboxes"** row; the count-all `mailboxes` field is retained for compat and documented non-billing (`types.ts:200-206`).
- **(a) round-2 scenario end-to-end:** canceled tenant, 12 provisioned then teardown-released all → `billableMailboxes=0`. Display: "you have 0 provisioned now", "**$99 /mo for 5 mailboxes**", "Active mailboxes: 0". Charge: `checkoutMailboxQuantity = max(5,0)=5 = $99`. **Both $99/5 — match.** Verified in `round3/billing-canceled-desktop.png`. Fresh sandbox (billable==count-all==12) correctly shows $169/12 (`round3/billing-sandbox-desktop.png`).
- **Tests genuine:** dashboard `billingPage.test.tsx` sets `DECOY_COUNT_ALL=999` on `mailboxes` and asserts the quote reads `billableMailboxes` + `not.toHaveTextContent("999")`, plus a canceled `mailboxes:12/billableMailboxes:0 → $99/5, not $169` case; platform `lifecycle-cancel.test.ts` proves the server side (`mailboxes===4, billableMailboxes===0` after provision-4→cancel-immediate; RED — old `/account` has no `billableMailboxes`).

### (b) Single-source claim — verified with one nuance
The two sides that MUST agree (charge + dashboard quote) both route through `billableMailboxCount` — the divergence class is structurally closed. Grep note: 5 other inline `released_at IS NULL` mailbox counts remain (`provisioning.ts:226`, `ops-summary.ts:129`, `quota.ts:61`, `byo-mailbox-composition.ts:45`, `billing.ts:523`) — but all use the identical WHERE clause, compute the same non-released value for unrelated purposes (slots/quota/ops/byo/stripe-sync), and none feeds the display-vs-charge comparison. No divergence; a DRY cleanup opportunity only (they could call `billableMailboxCount`).

### (c) count-all `mailboxes` consumers — no money-charge context remains
Every user-facing MONEY-CHARGE surface (the Go-live quote) now reads `billableMailboxes`. Two non-charge count-all consumers remain, both pre-existing and NON-BLOCKING: `SetupPage.tsx:111` "Infrastructure configured" readiness boolean (`mailboxes > 0` — a torn-down tenant would stay checked), and `QuotaUsage.tsx:33` usage bar (`used={account.mailboxes}` — slightly over-states usage vs the `released_at`-aware server quota at `quota.ts:61`). Neither is a charge; recommend a fast-follow to point both at the billable count.

### Round-2 ruling (SetupPage header chip) — CLOSED
`SetupPage.tsx` chip is now state-derived via a page-specific `HEADER_CHIP` map (per-state copy: sandbox "Sandbox · no real sends", pending_provisioning "Billing active · no real sends yet", etc.) with per-state tests. No longer a latent contradiction.

### Deploy gate
STRIPE arming confirmed set (team-lead: secret list + live Price lookups earlier today), so the prior UNVERIFIABLE (simulated-mode raw-JSON `/checkout/simulate`) does not apply — "Go live" hits real Stripe checkout. **Adversary deploy gate CLEARED.**

### NEW (out-of-scope, no verdict weight)
- `QuotaUsage.tsx:33` over-states mailbox usage vs the released_at-aware server quota (pre-existing, cosmetic).
- `SetupPage.tsx:111` "Infrastructure configured" uses count-all (stays checked for a torn-down tenant; cosmetic).
- 5 DRY-duplicate `released_at IS NULL` count queries (CLAUDE.md rule c) — no divergence.
- `site/index.html` "activate through a short concierge step" still stale vs self-serve (from round 1; marketing surface, founder ruling).
