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

// --- C6 waitlist (migrations/0004_waitlist.sql) — durable lead store for the
// public marketing-site form (adversarial panel-03 finding #9). Emails persist
// with NO expiry (unlike the prior 90-day KV TTL). ---

/** Persists one waitlist email durably. Idempotent (email is the PK): a repeat
 * signup is a silent no-op, preserving the original createdAt. Returns true iff
 * this call inserted a NEW lead. */
export async function insertWaitlistEmail(env: Env, email: string, createdAt: number): Promise<boolean> {
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)`)
    .bind(email, createdAt)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Total waitlist leads — surfaced in the owner digest (buildOpsDigest). */
export async function countWaitlistEmails(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM waitlist`).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface WaitlistEntry {
  email: string;
  createdAt: number;
}

/** Ordered waitlist export (newest first) for the owner — GET /admin/ops/waitlist. */
export async function listWaitlistEmails(env: Env, limit = 1000): Promise<WaitlistEntry[]> {
  const result = await env.DB.prepare(
    `SELECT email, created_at FROM waitlist ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ email: string; created_at: number }>();
  return result.results.map((r) => ({ email: r.email, createdAt: r.created_at }));
}
