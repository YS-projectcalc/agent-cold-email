import { Hono } from "hono";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";

export const accountRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>().get("/account", async (c) => {
  const result = await c.get("tenantStub").account();
  return c.json(result);
});
