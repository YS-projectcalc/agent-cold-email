# billing-gate — Tier-2 Stripe TEST-MODE verification

What it is: the REQUIRED build-time gate from the quantity-billing design
(`docs/research/quantity-billing-design-2026-07-23.md` §10). It verifies the
hardest-to-reverse money behaviors against **real Stripe test mode** — the
things a self-authored sandbox cannot prove — before the lane closes. Separate
from the hermetic vitest suite (which fetch-stubs Stripe).

How to run:

```
apps/platform/tools/billing-gate/run.sh
```

`run.sh` reads the TEST-mode `STRIPE_SECRET_KEY` from
`apps/platform/.dev.vars` (a `sk_test_` key that cannot charge real money),
verifies it is test-mode, and runs `gate.mjs`. It never prints, commits, or
touches the live Keychain. Exit code 0 = all 5 scenarios passed.

Scenarios (design §10):
- (a) a subscription-level 60%-off coupon rides a FUTURE quantity-bump's proration line
- (b) a mailbox-quantity increase prorates (positive proration on the upcoming invoice)
- (c) a decrease does NOT credit (`proration_behavior: "none"` — founder ruling 2)
- (d) two concurrent `ensureStripePrices` converge on one Price per `lookup_key` (N3 race)
- (e) a 60%-off checkout still collects a card (invoice > $0) and the first invoice succeeds

`gate.mjs`'s request shapes mirror `apps/platform/src/billing/stripe-client.ts`.
It creates uniquely-named test objects per run (Product/Prices/Coupon/Customer/
Subscription) and cleans them all up in a `finally` (prices/products are
deactivated since Stripe forbids deleting them; the rest are deleted).

What depends on it: the arm-time durable-Price bootstrap (`ACTIVATION.md`) — the
gate proves the same `ensureStripePrices` + `setSubscriptionItemQuantity` +
two-item checkout economics the production path (`engine/billing.ts`
`syncMailboxQuantity`, `startCheckout`) relies on.
