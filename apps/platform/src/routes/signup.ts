import { Hono } from "hono";
import { SignupInput } from "@coldstart/shared";
import { generateApiToken, hashApiToken } from "../auth.js";
import { RealClock } from "../clock.js";
import { insertTenantIndex } from "../db.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { parseJsonBody } from "../validate.js";

// POST /signup — the one bootstrap intent outside the ~12 tenant-scoped
// facade intents (SPEC.md §6). Always mints a `demo` plan tenant in this
// build: there is no paid/Stripe path yet (B1), and demo is what forces the
// vendor adapter factory to sandbox-only (see vendors/factory.ts).
export const signupRoute = new Hono<{ Bindings: Env }>().post("/signup", async (c) => {
  const parsed = await parseJsonBody(c, SignupInput);
  if (!parsed.ok) return parsed.response;

  const tenantId = newId("ten");
  const token = generateApiToken();
  const tokenHash = await hashApiToken(token, c.env.TOKEN_HASH_PEPPER);

  await insertTenantIndex(c.env, {
    id: tenantId,
    apiTokenHash: tokenHash,
    brand: parsed.data.brand,
    plan: "demo",
    createdAt: new RealClock().now(),
  });

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
  await stub.initTenant({ tenantId, brand: parsed.data.brand, plan: "demo" });

  return c.json({ tenantId, token }, 201);
});
