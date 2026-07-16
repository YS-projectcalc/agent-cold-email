import { Hono } from "hono";
import { AcknowledgeByoConsentInput, ConnectByoMailboxInput, RegisterByoDomainInput, RequestManagedByoMailboxesInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

// SPEC.md §20 — BYO domains & mailboxes. Mounted behind requireAuth + the
// global CSRF guard (index.ts), bearer OR dashboard cookie, like every other
// tenant-facing route. Every mutating intent is validated against the shared
// zod schema at the boundary (CLAUDE.md rule h) BEFORE it ever reaches the
// tenant's own DO.
export const byoDomainsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/byo-domains", async (c) => {
    return c.json(await c.get("tenantStub").byoDomains());
  })
  .get("/byo-domains/:id", async (c) => {
    // Unknown/cross-tenant id throws NotFoundError -> 404 (index.ts onError).
    return c.json(await c.get("tenantStub").byoDomain(c.req.param("id")));
  })
  .post("/byo-domains", async (c) => {
    const parsed = await parseJsonBody(c, RegisterByoDomainInput);
    if (!parsed.ok) return parsed.response;
    return c.json(await c.get("tenantStub").registerByoDomain(parsed.data), 201);
  })
  .post("/byo-domains/:id/poll-dns", async (c) => {
    return c.json(await c.get("tenantStub").pollByoDomainDns(c.req.param("id")));
  })
  .post("/byo-domains/:id/consent", async (c) => {
    const parsed = await parseJsonBody(c, AcknowledgeByoConsentInput);
    if (!parsed.ok) return parsed.response;
    return c.json(await c.get("tenantStub").acknowledgeByoConsent(c.req.param("id"), parsed.data));
  })
  .post("/byo-domains/:id/managed-mailboxes", async (c) => {
    const parsed = await parseJsonBody(c, RequestManagedByoMailboxesInput);
    if (!parsed.ok) return parsed.response;
    return c.json(await c.get("tenantStub").requestManagedByoMailboxes(c.req.param("id"), parsed.data), 201);
  })
  .post("/byo-domains/:id/connect-mailbox", async (c) => {
    const parsed = await parseJsonBody(c, ConnectByoMailboxInput);
    if (!parsed.ok) return parsed.response;
    return c.json(await c.get("tenantStub").connectByoMailbox(c.req.param("id"), parsed.data), 201);
  });
