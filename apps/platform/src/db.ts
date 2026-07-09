// D1 control-plane index helpers (ARCHITECTURE.md: "D1 = control-plane
// index"). The only thing D1 stores in B0 is the token->tenant lookup;
// everything else lives in the tenant's own TenantDO SQLite storage.

import type { Env } from "./env.js";

export interface TenantIndexRow {
  id: string;
  brand: string;
  plan: string;
  status: string;
}

export async function insertTenantIndex(
  env: Env,
  params: { id: string; apiTokenHash: string; brand: string; plan: string; createdAt: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenants_index (id, api_token_hash, brand, plan, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(params.id, params.apiTokenHash, params.brand, params.plan, params.createdAt)
    .run();
}

export async function lookupTenantByTokenHash(env: Env, tokenHash: string): Promise<TenantIndexRow | null> {
  const row = await env.DB.prepare(`SELECT id, brand, plan, status FROM tenants_index WHERE api_token_hash = ?`)
    .bind(tokenHash)
    .first<TenantIndexRow>();
  return row ?? null;
}
