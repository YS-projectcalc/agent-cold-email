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

export interface ResolvedTenant {
  tenantId: string;
  tenantStub: DurableObjectStub<TenantDO>;
}

/**
 * The single token->tenant resolver. Used by the Hono `requireAuth`
 * middleware below AND by `src/mcp/handler.ts` (the hosted MCP endpoint
 * resolves the tenant fresh from the Authorization header on every JSON-RPC
 * call — no caching across requests, so two different tokens on the same
 * `/mcp` route never cross-contaminate).
 */
export async function resolveTenantFromToken(env: Env, token: string | null): Promise<ResolvedTenant | null> {
  if (!token) return null;
  const tokenHash = await hashApiToken(token, env.TOKEN_HASH_PEPPER);
  const tenant = await lookupTenantByTokenHash(env, tokenHash);
  if (!tenant || tenant.status !== "active") return null;
  const stub = env.TENANT.get(env.TENANT.idFromName(tenant.id));
  return { tenantId: tenant.id, tenantStub: stub };
}

export async function requireAuth(c: Context<{ Bindings: Env; Variables: AuthedVariables }>, next: Next) {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "missing bearer token" }, 401);

  const resolved = await resolveTenantFromToken(c.env, token);
  if (!resolved) return c.json({ error: "invalid or inactive token" }, 401);

  c.set("tenantId", resolved.tenantId);
  c.set("tenantStub", resolved.tenantStub);
  await next();
}
