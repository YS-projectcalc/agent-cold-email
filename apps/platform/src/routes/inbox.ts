import { Hono } from "hono";
import { MarkInput, ReplyInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

export const inboxRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/inbox", async (c) => {
    const result = await c.get("tenantStub").inbox();
    return c.json(result);
  })
  .get("/threads/:id", async (c) => {
    const result = await c.get("tenantStub").thread(c.req.param("id"));
    return c.json(result);
  })
  .post("/threads/:id/reply", async (c) => {
    const parsed = await parseJsonBody(c, ReplyInput);
    if (!parsed.ok) return parsed.response;
    // B2/B3: an Idempotency-Key header makes a retried reply return the first
    // send instead of dispatching a second identical email.
    const result = await c.get("tenantStub").reply(c.req.param("id"), parsed.data.body, c.req.header("Idempotency-Key"));
    return c.json(result, 201);
  })
  .post("/threads/:id/mark", async (c) => {
    const parsed = await parseJsonBody(c, MarkInput);
    if (!parsed.ok) return parsed.response;
    await c.get("tenantStub").mark(c.req.param("id"), parsed.data.status);
    return c.json({ marked: true });
  });
