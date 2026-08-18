import { Hono } from "hono";
import { getTenantIndexById } from "../admin/db.js";
import type { Env } from "../env.js";
import { parseIntQueryParam } from "../validate.js";

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
//
// Item 3 / D minimal (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md):
// `?limit=` bounds every list in the response (D9-safe: parseIntQueryParam
// treats an empty value the same as absent); `?idempotencyPrefix=` narrows
// `requestIdempotency` back to one prefix — the DEFAULT is now every prefix
// (see the engine module's doc for why the old hardcoded narrowing was a gap).
export const adminProvisioningStateRoute = new Hono<{ Bindings: Env }>().get(
  "/admin/tenants/:id/provisioning-state",
  async (c) => {
    const tenantId = c.req.param("id");
    const tenant = await getTenantIndexById(c.env, tenantId);
    if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

    const limit = parseIntQueryParam(c.req.query("limit"));
    const idempotencyPrefix = c.req.query("idempotencyPrefix") || undefined;

    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
    const state = await stub.getProvisioningStateForOperator({ limit, idempotencyPrefix });

    return c.json({ tenantId, ...state });
  },
);
