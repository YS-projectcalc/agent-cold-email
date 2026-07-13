import { Hono } from "hono";
import { InboxQueryInput, MarkInput, ReplyInput, ThreadLabelInput, type Provenance } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseBoolQueryParam, parseJsonBody } from "../validate.js";

export const inboxRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/inbox", async (c) => {
    // §19.4 — v2: cursor pagination + filters, backward-compatible defaults
    // (a bare GET /inbox parses to the same "everything, page 1" shape v1
    // always returned). Raw query strings are parsed here, NOT via zod
    // coercion (see parseBoolQueryParam's doc — z.coerce.boolean() would
    // treat "?read=false" as true).
    const rawLimit = c.req.query("limit");
    const parsed = InboxQueryInput.safeParse({
      limit: rawLimit !== undefined ? Number(rawLimit) : undefined,
      cursor: c.req.query("cursor"),
      mailbox: c.req.query("mailbox"),
      campaign: c.req.query("campaign"),
      label: c.req.query("label"),
      read: parseBoolQueryParam(c.req.query("read")),
      includeNonreply: parseBoolQueryParam(c.req.query("include_nonreply")),
      archived: c.req.query("archived"),
    });
    if (!parsed.success) {
      return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
    }
    const result = await c.get("tenantStub").inbox(parsed.data);
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
  })
  .post("/threads/:id/label", async (c) => {
    const parsed = await parseJsonBody(c, ThreadLabelInput);
    if (!parsed.ok) return parsed.response;
    // Provenance server-derived from transport (§19.4) — never a client claim.
    const source: Provenance = c.get("authVia") === "cookie" ? "dashboard" : "api";
    const result = await c.get("tenantStub").labelThread(c.req.param("id"), parsed.data.label, source);
    return c.json(result, 200);
  });
