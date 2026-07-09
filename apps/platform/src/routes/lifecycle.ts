import { Hono } from "hono";
import { CancelInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";

// POST /cancel — authed, tenant-scoped (D5 voluntary cancellation + infra
// teardown/reclaim). Mounted behind requireAuth in index.ts. Tolerant of an
// empty body: `{ immediate }` defaults to false (end-of-billing-period), so a
// bare `POST /cancel` schedules an end-of-period cancellation. Idempotent —
// re-cancel returns the existing teardown summary (see engine/lifecycle.ts).
export const lifecycleRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().post("/cancel", async (c) => {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
  }
  const parsed = CancelInput.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
  }

  const result = await c.get("tenantStub").cancel(parsed.data);
  return c.json(result, 200);
});
