import { Hono } from "hono";
import { AdminOperatorMessageInput } from "../admin/schemas.js";
import { getTenantIndexById } from "../admin/db.js";
import type { Env } from "../env.js";
import { parseJsonBody } from "../validate.js";

// msgchannel increment 2 (2026-08-06) — the operator route: an admin-authed
// endpoint that drops a STRUCTURED message into one tenant's own message
// store (engine/tenant-messages.ts's emitOperatorMessage), reachable via
// infrastructure_status/list_messages exactly like a system-emitted message
// (increment 1) — same auth pattern as POST /admin/tenants/:id/terminate and
// /admin/tenants/:id/screening (getTenantIndexById 404 check, then a single
// TenantDO RPC). DELIVERS REGARDLESS OF LIFECYCLE STATE (gate fix,
// msgchannel-inc23-gate-2026-08-06 F2) — see emitOperatorMessage's doc for
// why: a human operator reaching a suspended/canceling/canceled tenant is
// this channel's canonical use case, not a case to block.
export const adminMessagesRoute = new Hono<{ Bindings: Env }>().post("/admin/tenants/:id/messages", async (c) => {
  const tenantId = c.req.param("id");
  const tenant = await getTenantIndexById(c.env, tenantId);
  if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

  const parsed = await parseJsonBody(c, AdminOperatorMessageInput);
  if (!parsed.ok) return parsed.response;

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
  await stub.emitOperatorMessage(parsed.data);

  return c.json({ tenantId, emitted: true }, 201);
});
