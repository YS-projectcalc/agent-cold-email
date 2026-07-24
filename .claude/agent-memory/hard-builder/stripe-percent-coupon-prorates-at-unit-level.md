# Stripe: a percent-off coupon discounts PRORATION at the unit level, RECURRING at the invoice level

A subscription-level `percent_off` coupon rides BOTH recurring and mid-cycle quantity-bump proration lines — but Stripe renders the discount DIFFERENTLY on each, which will burn a gate/assertion cycle if you assume "invoice total == subtotal × (1 − pct)":

- **Recurring line**: discount appears as a populated `discount_amounts` entry (e.g. an $80 mailbox line shows `discount_amounts=[{amount: 48}]` for 60% off). The line `amount` is GROSS.
- **Proration line** (from `setSubscriptionItemQuantity` with `create_prorations`): the discount is BAKED INTO the line `amount` (already net-of-discount), `discount_amounts=[{amount: 0}]`, and the description literally reads `"Remaining time on N × … (with 60.0% off) …"`.

So the upcoming-invoice `subtotal` MIXES net-of-discount proration lines with gross recurring lines, and `total_discount_amounts` only reflects the recurring discount. `total = subtotal − total_discount_amounts` still holds, but `total ≠ subtotal × 0.4`. To assert "coupon rode the bump": check the bumped RECURRING line's `discount_amounts == round(amount × pct)` AND that a proration line's description matches `/%\s*off/i` — do NOT compute against subtotal.

Also: an INCREASE proration (qty 5→8, create_prorations) emits TWO lines — a negative "Unused time on 5 ×" credit + a positive "Remaining time on 8 ×" charge (net positive). Testing "a DECREASE creates no credit (proration_behavior none)" must run on a FRESH subscription (no prior increase proration), then assert ZERO proration lines — else you catch the increase's credit component. See `apps/platform/tools/billing-gate/gate.mjs` (quantity-billing Tier-2 gate). The APP was correct throughout; these were assertion bugs the gate surfaced.
