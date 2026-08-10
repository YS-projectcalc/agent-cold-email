import { Hono } from "hono";
import { ListMessagesQueryInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";

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
  });
