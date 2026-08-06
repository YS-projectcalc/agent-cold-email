-- Stripe customer -> tenant routing index (audit-stripe-webhook-2026-08-06.md
-- finding 1). POST /webhooks/stripe used to resolve its target tenant from
-- `data.object.metadata.tenantId` alone — a field only `checkout.session.completed`
-- and `customer.subscription.*` actually carry, because those are the only two
-- objects we ourselves decorate at checkout-creation time (billing/stripe-client.ts).
-- A real `invoice.payment_failed` carries `metadata: {}` and a real Dispute is
-- minted by Stripe with `metadata: {}` too, so the dunning lane and the D5
-- chargeback-freeze lane resolved NOTHING in production and silently answered
-- `200 {"applied":false}` on every delivery.
--
-- WHY D1 (not the tenant's own DO SQLite): this is a ROUTING table — the Worker
-- has to know which TenantDO to open BEFORE it can touch any per-tenant storage,
-- so a per-DO `tenant_profile.stripe_customer_id` (which does exist) is
-- unreachable at the moment the decision is made. Same reasoning as
-- `tenants_index` itself and the account-wide `stripe_prices` cache (0015).
--
-- WHY A TABLE, not a column on tenants_index: the mapping is MANY customers to
-- ONE tenant over time. Checkout Sessions are created without a `customer`
-- param, so Stripe mints a NEW customer for every checkout — a tenant that
-- cancels and re-subscribes owns two customer ids, and a dispute or a final
-- invoice can still arrive against the OLD one long after. A single column would
-- hold only the latest and silently drop those; the append-only mapping keeps
-- every customer routable to the tenant it belonged to.
CREATE TABLE IF NOT EXISTS stripe_customer_index (
  -- Stripe's `cus_...` id, as it appears on the event's `data.object.customer`.
  stripe_customer_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stripe_customer_index_tenant ON stripe_customer_index(tenant_id);
