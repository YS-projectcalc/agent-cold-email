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

/**
 * Flips a tenant's control-plane index status (D5 abuse offboarding). Setting
 * it to anything but 'active' makes `resolveTenantFromToken` reject the
 * tenant's bearer token on EVERY authed route — so a terminated tenant cannot
 * re-provision or re-launch and undo the infra reclaim. Voluntary /cancel does
 * NOT call this (a canceled tenant keeps read access so account() can reflect
 * its canceled state).
 */
export async function setTenantIndexStatus(env: Env, id: string, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE tenants_index SET status = ? WHERE id = ?`).bind(status, id).run();
}
