import { Hono } from "hono";
import { CheckoutInput, CheckoutSimulateQuery } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

// POST /checkout — authed, tenant-scoped (B1 money path). Mounted behind
// requireAuth in index.ts.
export const checkoutRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().post("/checkout", async (c) => {
  const parsed = await parseJsonBody(c, CheckoutInput);
  if (!parsed.ok) return parsed.response;
  const origin = new URL(c.req.url).origin;
  const result = await c.get("tenantStub").checkout(parsed.data, origin);
  return c.json(result, 201);
});

// GET /checkout/simulate — UNAUTHENTICATED, mirroring the fact that Stripe's
// own hosted checkout return page isn't bearer-token-gated either: the
// session id is itself the (unguessable, single-use) credential, re-validated
// tenant-scoped inside the target TenantDO (`WHERE id = ? AND tenant_id = ?`
// — see engine/billing.ts). Test-mode simulation ONLY.
//
// F1 (adversarial 2026-07-21, BLOCKING — docs/adversarial/
// selfserve-activation-design-review-2026-07-21.md): startCheckout() only
// takes the simulated branch when STRIPE_SECRET_KEY is unset at CHECKOUT
// time (engine/billing.ts), but a PENDING simulated session created before a
// live key was ever wired (e.g. a pre-arming test tenant) persists in
// `checkout_sessions` regardless — this route would otherwise complete it
// unconditionally. Under I1's product-driven activation gate that write
// (plan + billing_state='active') is directly activation-relevant, so this
// route must be UNREACHABLE for real activation the moment this environment
// CAN do real vendor spend — fail closed at the route boundary (never
// reaches the DO) whenever a live key is configured, regardless of arming
// order elsewhere. `completeSimulatedCheckout` (engine/billing.ts) repeats
// this guard as defense in depth.
export const checkoutSimulateRoute = new Hono<{ Bindings: Env }>().get("/checkout/simulate", async (c) => {
  if (c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "simulated checkout is disabled once live Stripe keys are configured" }, 404);
  }

  const query = CheckoutSimulateQuery.safeParse({
    tenant: c.req.query("tenant"),
    session: c.req.query("session"),
  });
  if (!query.success) return c.json({ error: "missing/invalid tenant or session query param" }, 400);

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(query.data.tenant));
  const result = await stub.completeCheckoutSimulated(query.data.session);
  return c.json(result, 200);
});
