-- Quantity-billing migration (quantity-billing-design-2026-07-23.md §3) — the
-- durable Stripe Price cache. The migration replaces checkout's inline
-- `price_data` (un-couponable, un-durable) with two durable Prices resolved by
-- a stable `lookup_key`: `coldrig_platform_monthly_v1` ($49 flat, qty 1) and
-- `coldrig_mailbox_monthly_v1` ($10/mailbox, qty = max(5, provisioned)), plus
-- their yearly twins. `ensureStripePrices` (billing/stripe-client.ts) resolves
-- each lookup_key against Stripe once and caches the resolved id here so
-- checkout builds its line items without a per-request round trip, and so the
-- test-vs-live price map is auditable.
--
-- WHY D1 (not per-tenant DO SQLite): Stripe Prices are an ACCOUNT-wide object,
-- not per-tenant — every tenant's checkout references the same two Price ids
-- for a given mode. A per-tenant DO cannot see another tenant's cache, so this
-- account-level map lives in D1 alongside the vendor-spend ledger (0011), the
-- same control-plane store the DO spend path already writes (design §0).
--
-- `mode` ('test' | 'live') keys the row because the SAME lookup_key resolves to
-- a DIFFERENT Price id in each Stripe mode — the secret key decides which. A
-- test-mode bootstrap and a later live-mode bootstrap coexist as distinct rows,
-- so swapping sk_test_ -> sk_live_ never reads a stale test-mode Price id.
CREATE TABLE IF NOT EXISTS stripe_prices (
  lookup_key TEXT NOT NULL,
  mode       TEXT NOT NULL,
  price_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lookup_key, mode)
);
