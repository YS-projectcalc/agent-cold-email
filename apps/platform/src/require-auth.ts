import type { Context, Next } from "hono";
import type { TenantDO } from "./tenant-do.js";
import { extractBearerToken, hashApiToken } from "./auth.js";
import { lookupTenantByTokenHash } from "./db.js";
import type { Env } from "./env.js";

// CLAUDE.md rule h: every tenant-scoped route must resolve to exactly one
// tenant's DO stub, and every downstream engine query is additionally
// scoped by tenant_id inside that DO — belt and suspenders isolation.
export interface AuthedVariables {
  tenantId: string;
  tenantStub: DurableObjectStub<TenantDO>;
}

export async function requireAuth(c: Context<{ Bindings: Env; Variables: AuthedVariables }>, next: Next) {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "missing bearer token" }, 401);

  const tokenHash = await hashApiToken(token, c.env.TOKEN_HASH_PEPPER);
  const tenant = await lookupTenantByTokenHash(c.env, tokenHash);
  if (!tenant || tenant.status !== "active") return c.json({ error: "invalid or inactive token" }, 401);

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenant.id));
  c.set("tenantId", tenant.id);
  c.set("tenantStub", stub);
  await next();
}
