import { Hono } from "hono";
import { ContactOperatorInput, ListMessagesQueryInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

// msgchannel increment 3 (2026-08-06) — REST facade for the SAME TenantDO
// methods the MCP tools list_messages/ack_message call (parity law, matching
// leads.ts/webhook-subscriptions.ts/byo-domains.ts). `GET /messages` mirrors
// list_messages exactly (cursor-paginated, unacked-first). `POST
// /messages/:id/ack` is id-in-URL (not body-keyed — a message id, unlike an
// email, has no reason to live in the body) mirroring
// `POST /threads/:id/mark`.
export const messagesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/messages", async (c) => {
    const rawLimit = c.req.query("limit");
    const parsed = ListMessagesQueryInput.safeParse({
      limit: rawLimit !== undefined ? Number(rawLimit) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
    }
    const result = await c.get("tenantStub").listMessages(parsed.data);
    return c.json(result);
  })
  .post("/messages/:id/ack", async (c) => {
    const id = c.req.param("id");
    const result = await c.get("tenantStub").ackMessage(id);
    return c.json(result);
  })
  // msgchannel Inc5 (founder-ratified 2026-08-11) — REST parity for the MCP
  // `contact_operator` tool (mcp/tools.ts), the SAME TenantDO RPC (parity
  // law). Body-keyed (mirrors leads.ts's suppress/disposition routes) — there
  // is no id to put in the URL, this call MINTS a new ticket id.
  .post("/messages/contact-operator", async (c) => {
    const parsed = await parseJsonBody(c, ContactOperatorInput);
    if (!parsed.ok) return parsed.response;
    const result = await c.get("tenantStub").contactOperator(parsed.data);
    return c.json(result, 201);
  });
