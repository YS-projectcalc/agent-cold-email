import { Hono } from "hono";
import { ActivityQueryInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";

// GET /activity (§19.4) — NEW DO method merging events + deliverability_actions.
export const activityRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().get("/activity", async (c) => {
  const rawLimit = c.req.query("limit");
  const parsed = ActivityQueryInput.safeParse({
    limit: rawLimit !== undefined ? Number(rawLimit) : undefined,
    cursor: c.req.query("cursor"),
    kind: c.req.query("kind"),
  });
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
  }
  const result = await c.get("tenantStub").activity(parsed.data);
  return c.json(result);
});
