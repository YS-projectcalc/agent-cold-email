import { Hono } from "hono";
import { AdminOperatorMessageInput } from "../admin/schemas.js";
import { getTenantIndexById } from "../admin/db.js";
import type { Env } from "../env.js";
import { parseIntQueryParam, parseJsonBody } from "../validate.js";

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
export const adminMessagesRoute = new Hono<{ Bindings: Env }>()
  .post("/admin/tenants/:id/messages", async (c) => {
    const tenantId = c.req.param("id");
    const tenant = await getTenantIndexById(c.env, tenantId);
    if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

    const parsed = await parseJsonBody(c, AdminOperatorMessageInput);
    if (!parsed.ok) return parsed.response;

    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
    await stub.emitOperatorMessage(parsed.data);

    return c.json({ tenantId, emitted: true }, 201);
  })
  // The read twin of the POST above — lets the operator see a tenant's
  // WHOLE message store (engine/tenant-messages.ts's listMessagesForOperator).
  // Item 6 (founder-ordered, docs/adversarial/class-sweep-vendor-truth-2026-08-18.md
  // addendum): each message's serialized `ackedAt` (renamed from the old,
  // MISLEADING `readAt` — set only by the tenant agent's explicit ack tool,
  // engine/tenant-messages.ts's ackMessage, the ONLY writer of the underlying
  // `read_at` column) answers "has the customer's agent ACKED this?", never
  // "has it been seen" — THIS call itself lists messages regardless of ack
  // state, so a null `ackedAt` here does not mean the agent never read it.
  // Same auth (admin.use("/admin/*", requireAdminAuth) in index.ts covers
  // this path automatically — no per-route auth call needed, matching the
  // POST above) and same getTenantIndexById 404 check. `?unreadOnly=1`
  // mirrors the boolean query-flag convention admin-ops.ts's
  // GET /admin/ops/checks already uses (`?unhealthy=1`). DELIVERS REGARDLESS
  // OF LIFECYCLE STATE — same rationale as the POST (admin-messages.ts:13-16):
  // a pure read has nothing to gate.
  .get("/admin/tenants/:id/messages", async (c) => {
    const tenantId = c.req.param("id");
    const tenant = await getTenantIndexById(c.env, tenantId);
    if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

    // D9 fix (docs/adversarial/class-sweep-vendor-truth-2026-08-18.md) — a
    // literal `?limit=` is present-but-empty, not absent; parseIntQueryParam
    // treats both the same, so this can no longer silently clamp to 1.
    const limit = parseIntQueryParam(c.req.query("limit"));
    const unreadOnly = c.req.query("unreadOnly") === "1";

    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
    const result = await stub.listMessagesForOperator({ limit, unreadOnly });

    return c.json({ tenantId, messages: result.messages, total: result.total });
  });
