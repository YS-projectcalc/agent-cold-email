import { Hono } from "hono";
import { SetupInfrastructureInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

export const infrastructureRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .post("/setup-infrastructure", async (c) => {
    const parsed = await parseJsonBody(c, SetupInfrastructureInput);
    if (!parsed.ok) return parsed.response;
    // B2: an Idempotency-Key header makes a retried setup return the first
    // job instead of re-provisioning duplicate domains/mailboxes.
    const result = await c.get("tenantStub").setupInfrastructure(parsed.data, c.req.header("Idempotency-Key"));
    return c.json(result, 202);
  })
  .get("/infrastructure-status", async (c) => {
    const result = await c.get("tenantStub").infrastructureStatus();
    return c.json(result);
  });
