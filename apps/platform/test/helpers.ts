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

// D1/D2/D6 admin-surface tests (test/admin-*.test.ts) all present this same
// fixed bearer — see test/setup.ts, which sets `env.ADMIN_TOKEN` to this
// exact value once before every test file's DB migrations run.
export const TEST_ADMIN_TOKEN = "test-admin-token-for-vitest";

export async function adminApi<T = unknown>(
  path: string,
  init: (RequestInit & { adminToken?: string }) | undefined = {},
): Promise<ApiResult<T>> {
  const { adminToken, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = { "content-type": "application/json", ...(headers as Record<string, string> | undefined) };
  finalHeaders.authorization = `Bearer ${adminToken ?? TEST_ADMIN_TOKEN}`;
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

/**
 * Drives a tenant's billing_state to 'past_due' via the SAME
 * `invoice.payment_failed` Stripe webhook path B1 exercises
 * (test/webhook.test.ts) — each call is one more recorded failure (the
 * dunning "cycle", src/admin/dunning.ts), matching how a real Stripe account
 * would redeliver a fresh event id per failed invoice attempt.
 */
export async function failPayment(tenantId: string): Promise<void> {
  const event = {
    id: `evt_${crypto.randomUUID()}`,
    type: "invoice.payment_failed",
    data: { object: { metadata: { tenantId } } },
  };
  const res = await api("/webhooks/stripe", { method: "POST", body: JSON.stringify(event) });
  if (res.status !== 200) throw new Error(`failPayment webhook failed: ${JSON.stringify(res)}`);
}

/**
 * Drives a tenant to an active paid plan via the SAME
 * `checkout.session.completed` Stripe webhook path B1 exercises
 * (test/webhook.test.ts) — the real path a Stripe checkout success uses to
 * set `plan` + `billing_state = 'active'` together, which is what
 * MRR (src/engine/ops-summary.ts) requires.
 */
export async function activatePaidPlan(tenantId: string, plan: TenantPlan): Promise<void> {
  const event = {
    id: `evt_${crypto.randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_test_admin",
        subscription: "sub_test_admin",
        client_reference_id: tenantId,
        metadata: { tenantId, plan },
      },
    },
  };
  const res = await api("/webhooks/stripe", { method: "POST", body: JSON.stringify(event) });
  if (res.status !== 200) throw new Error(`activatePaidPlan webhook failed: ${JSON.stringify(res)}`);
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
