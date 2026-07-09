# src/billing

Stripe REST client + webhook transport concerns for the B1 money path.
Distinct from `src/vendors/` (the `VendorPort` sandbox/real adapter pairs):
this directory is Worker-level Stripe plumbing used directly by
`src/engine/billing.ts`, not a per-tenant vendor adapter.

- `stripe-client.ts` — outbound REST calls to `api.stripe.com`: real
  TEST-mode Checkout Session creation, metered usage-record reporting. Only
  ever invoked when `env.STRIPE_SECRET_KEY` is set (never true in this
  build — CLAUDE.md rule g, no real vendor secret in the repo; wiring a real
  Stripe TEST key is an `ACTIVATION.md` step). Coded fully against Stripe's
  documented REST shape so the swap is a provable no-op at activation.
- `stripe-webhook.ts` — inbound: the (loose) event zod schema, HMAC-SHA256
  `Stripe-Signature` verification, and tenant-id resolution from an event
  (`client_reference_id` / `metadata.tenantId`). No business logic — what an
  event DOES to a tenant lives in `../engine/billing.ts`.

## How to run

Part of `apps/platform`; exercised by `apps/platform/test/checkout.test.ts`
and `apps/platform/test/webhook.test.ts` via `npm test`. The real-Stripe
code path in `stripe-client.ts` is coded but UNVERIFIED against a live
Stripe test account — no key exists in any test environment here; it stays
inert until `STRIPE_SECRET_KEY` is wired at activation.

## Depended on by

`src/engine/billing.ts` (checkout + webhook business logic, called from
`src/tenant-do.ts`) and `src/routes/checkout.ts` / `src/routes/webhooks.ts`
(HTTP transport).
