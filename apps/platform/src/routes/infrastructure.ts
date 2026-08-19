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
    // A quoteOnly preview provisions nothing -> 200; a real provision is async -> 202.
    return c.json(result, "quoteOnly" in result ? 200 : 202);
  })
  .get("/infrastructure-status", async (c) => {
    const stub = c.get("tenantStub");
    const result = await stub.infrastructureStatus();
    // §7.10.2 — a SEPARATE RPC call, deliberately outside infrastructureStatus
    // itself (which is readOnlyHint:true and must stay genuinely write-free —
    // see recordAgentActivity's doc comment). Bearer = the agent; a cookie is
    // a human in the dashboard and must never stamp.
    //
    // BEST-EFFORT (in-class with mcp/handler.ts's stamp): the read has already
    // succeeded, and a failure to record liveness must not turn an answered
    // status call into a 500. Bookkeeping never fails the call it observes.
    if (c.get("authVia") === "bearer") {
      try {
        await stub.recordAgentActivity();
      } catch (err) {
        console.error(`infrastructure-status: liveness stamp failed for tenant ${c.get("tenantId")} (non-fatal)`, err);
      }
    }
    return c.json(result);
  });
