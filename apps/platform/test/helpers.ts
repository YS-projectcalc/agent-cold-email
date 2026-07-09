import { env, SELF } from "cloudflare:test";
import type { TenantPlan } from "@coldstart/shared";
import { generateApiToken, hashApiToken } from "../src/auth.js";
import { insertTenantIndex } from "../src/db.js";
import { newId } from "../src/schema.js";
import type { TenantDO } from "../src/tenant-do.js";

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  path: string,
  init: (RequestInit & { token?: string }) | undefined = {},
): Promise<ApiResult<T>> {
  const { token, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = { "content-type": "application/json", ...(headers as Record<string, string> | undefined) };
  if (token) finalHeaders.authorization = `Bearer ${token}`;

  const res = await SELF.fetch(`https://example.com${path}`, { ...rest, headers: finalHeaders });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

export function tenantStub(tenantId: string): DurableObjectStub<TenantDO> {
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}

export async function signup(brand: string, contactEmail: string): Promise<{ tenantId: string; token: string }> {
  // Each signup uses a unique synthetic source IP so it lands in its own
  // per-IP RateLimiterDO bucket instead of self-throttling the suite under the
  // /signup rate limit (routes/signup.ts). Real clients present distinct IPs.
  const res = await api<{ tenantId: string; token: string }>("/signup", {
    method: "POST",
    headers: { "CF-Connecting-IP": `test-ip-${crypto.randomUUID()}` },
    body: JSON.stringify({ brand, contactEmail }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res)}`);
  return res.body;
}

/**
 * Mints a tenant on an arbitrary plan, bypassing `POST /signup` (which
 * always mints `demo` — see routes/signup.ts). Test-only: the real product
 * has no paid-signup path yet (B1); this exists solely to prove the B5
 * `/demo/run` guard actually rejects a non-demo/free plan (there is no
 * other way to construct one in this build).
 */
export async function mintTenant(brand: string, plan: TenantPlan): Promise<{ tenantId: string; token: string }> {
  const tenantId = newId("ten");
  const token = generateApiToken();
  const tokenHash = await hashApiToken(token, env.TOKEN_HASH_PEPPER);
  await insertTenantIndex(env, { id: tenantId, apiTokenHash: tokenHash, brand, plan, createdAt: Date.now() });
  const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
  await stub.initTenant({ tenantId, brand, plan });
  return { tenantId, token };
}
