import { Hono } from "hono";
import { WebhookCreateInput, WebhookUpdateInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody, SMALL_BODY_MAX_BYTES } from "../validate.js";

// Per-tenant OUTBOUND webhook subscription CRUD (ROADMAP.md WIN-THE-COMPARISON
// (d) / forensics §5 (c)). Base path is `/webhook-subscriptions`, deliberately
// DISTINCT from the unauthenticated inbound `/webhooks/stripe` receiver
// (routes/webhooks.ts) — a `/webhooks/*` auth pattern would have swept the
// Stripe endpoint into requireAuth and 401'd it. Mounted behind requireAuth +
// the global CSRF guard (index.ts), bearer OR dashboard cookie, like every
// other tenant-facing route. Boundary URL security (https-only, SSRF private-IP
// rejection) is enforced in the DO facade via assertSafeWebhookUrl, surfaced
// here as the platform's usual 400 (ValidationError -> index.ts onError).
export const webhookSubscriptionsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/webhook-subscriptions", async (c) => {
    return c.json(await c.get("tenantStub").webhooks());
  })
  .get("/webhook-subscriptions/:id", async (c) => {
    // Unknown id throws NotFoundError -> 404 (index.ts onError).
    return c.json(await c.get("tenantStub").webhook(c.req.param("id")));
  })
  .post("/webhook-subscriptions", async (c) => {
    const parsed = await parseJsonBody(c, WebhookCreateInput, SMALL_BODY_MAX_BYTES);
    if (!parsed.ok) return parsed.response;
    // The response carries the signing secret — the one time it is exposed on
    // a create; reads never return it (rotate via PUT with a new secret).
    return c.json(await c.get("tenantStub").createWebhook(parsed.data), 201);
  })
  .put("/webhook-subscriptions/:id", async (c) => {
    const parsed = await parseJsonBody(c, WebhookUpdateInput, SMALL_BODY_MAX_BYTES);
    if (!parsed.ok) return parsed.response;
    return c.json(await c.get("tenantStub").updateWebhook(c.req.param("id"), parsed.data), 200);
  })
  .delete("/webhook-subscriptions/:id", async (c) => {
    return c.json(await c.get("tenantStub").deleteWebhook(c.req.param("id")), 200);
  });
