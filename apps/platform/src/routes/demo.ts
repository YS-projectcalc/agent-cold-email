import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";

// POST /demo/run (B5 brief) — authed, but the demo/free-plan guard is
// enforced INSIDE TenantDO.demoRun() (a structural type-level check, not an
// HTTP-layer policy — ARCHITECTURE.md #8), which throws TenantIsolationError
// for any other plan. index.ts's onError maps that to 403. Nothing in this
// file decides who is allowed to run it.
export const demoRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().post("/demo/run", async (c) => {
  const result = await c.get("tenantStub").demoRun();
  return c.json(result, 200);
});
