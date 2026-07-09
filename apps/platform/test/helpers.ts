import { env, SELF } from "cloudflare:test";
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
  const res = await api<{ tenantId: string; token: string }>("/signup", {
    method: "POST",
    body: JSON.stringify({ brand, contactEmail }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res)}`);
  return res.body;
}
