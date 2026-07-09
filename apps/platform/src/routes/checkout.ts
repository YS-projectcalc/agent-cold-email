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
// — see engine/billing.ts). Test-mode simulation ONLY: this route has no
// effect once a real STRIPE_SECRET_KEY is wired (checkout() then returns a
// real Stripe-hosted url instead of one pointing back here).
export const checkoutSimulateRoute = new Hono<{ Bindings: Env }>().get("/checkout/simulate", async (c) => {
  const query = CheckoutSimulateQuery.safeParse({
    tenant: c.req.query("tenant"),
    session: c.req.query("session"),
  });
  if (!query.success) return c.json({ error: "missing/invalid tenant or session query param" }, 400);

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(query.data.tenant));
  const result = await stub.completeCheckoutSimulated(query.data.session);
  return c.json(result, 200);
});
