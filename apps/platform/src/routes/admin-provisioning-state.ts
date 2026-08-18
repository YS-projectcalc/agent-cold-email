import { Hono } from "hono";
import { getTenantIndexById } from "../admin/db.js";
import type { Env } from "../env.js";

// UNVERIFIABLE-1/2/3 (docs/adversarial/agent-channel-product-audit-2026-08-17.md)
// — the operator's read-only view of one tenant's provisioning state: which
// domains it holds and their real DNS standing, which ordinal each occupies,
// and whether a `setup_infrastructure` idempotency key already replays a
// stale response. Same auth pattern as GET /admin/tenants/:id/messages
// (admin.use("/admin/*", requireAdminAuth) in index.ts covers this path
// automatically) and the same getTenantIndexById 404 check, then a single
// TenantDO RPC (engine/provisioning-state.ts's getProvisioningStateForOperator
// — PURE SELECT, delivers regardless of lifecycle state; there is nothing to
// gate on a read).
export const adminProvisioningStateRoute = new Hono<{ Bindings: Env }>().get(
  "/admin/tenants/:id/provisioning-state",
  async (c) => {
    const tenantId = c.req.param("id");
    const tenant = await getTenantIndexById(c.env, tenantId);
    if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
    const state = await stub.getProvisioningStateForOperator();

    return c.json({ tenantId, ...state });
  },
);
