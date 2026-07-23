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
  params: { id: string; apiTokenHash: string; brand: string; plan: string; createdAt: number; contactEmail?: string | null },
): Promise<void> {
  // Adversary r1 NB4 (2026-07-23) — normalize-on-write: lowercase at the ONE
  // write site so magic-link login (routes/login.ts) can match a mixed-case
  // signup email with a plain (non-LOWER()) index (migrations/0009). The
  // 0009 migration backfills every pre-existing row the same way.
  const contactEmail = params.contactEmail ? params.contactEmail.toLowerCase() : (params.contactEmail ?? null);
  await env.DB.prepare(
    `INSERT INTO tenants_index (id, api_token_hash, brand, plan, status, created_at, contact_email) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(params.id, params.apiTokenHash, params.brand, params.plan, params.createdAt, contactEmail)
    .run();
}

/** Dunning notices (D2) — the tenant's contact email captured at signup, or
 * `null` for tenants that predate the column / the test-only `mintTenant`
 * path. The suspend path flags a null address rather than inventing one. */
export async function lookupTenantContactEmail(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT contact_email FROM tenants_index WHERE id = ?`)
    .bind(id)
    .first<{ contact_email: string | null }>();
  return row?.contact_email ?? null;
}

export async function lookupTenantByTokenHash(env: Env, tokenHash: string): Promise<TenantIndexRow | null> {
  const row = await env.DB.prepare(`SELECT id, brand, plan, status FROM tenants_index WHERE api_token_hash = ?`)
    .bind(tokenHash)
    .first<TenantIndexRow>();
  return row ?? null;
}

/** Looked up by id (not token hash) — the only thing a resolved dashboard
 * cookie session carries is a tenant id (see dashboard-session helpers below),
 * so the suspended/inactive check needs its own by-id lookup. */
export async function lookupTenantById(env: Env, id: string): Promise<TenantIndexRow | null> {
  const row = await env.DB.prepare(`SELECT id, brand, plan, status FROM tenants_index WHERE id = ?`)
    .bind(id)
    .first<TenantIndexRow>();
  return row ?? null;
}

// --- SPEC.md §19.1 (M1) — dashboard cookie sessions (migrations/0006). The
// opaque session id itself lives ONLY in the httpOnly cookie; only its
// SHA-256(+pepper) hash (src/auth.ts) is ever persisted here — the same
// never-store-the-plaintext-credential discipline as tenants_index's bearer
// token hash (CLAUDE.md rule g). ---

export async function insertDashboardSession(
  env: Env,
  params: { sessionHash: string; tenantId: string; createdAt: number; expiresAt: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dashboard_sessions (session_hash, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(params.sessionHash, params.tenantId, params.createdAt, params.expiresAt)
    .run();
}

export interface DashboardSessionRow {
  tenant_id: string;
  expires_at: number;
}

export async function lookupDashboardSession(env: Env, sessionHash: string): Promise<DashboardSessionRow | null> {
  const row = await env.DB.prepare(`SELECT tenant_id, expires_at FROM dashboard_sessions WHERE session_hash = ?`)
    .bind(sessionHash)
    .first<DashboardSessionRow>();
  return row ?? null;
}

/** POST /dashboard/logout — deletes the session row so the cookie (once the
 * client also clears it) can never be replayed. Idempotent: deleting an
 * already-gone/never-existed hash is a silent no-op. */
export async function deleteDashboardSession(env: Env, sessionHash: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM dashboard_sessions WHERE session_hash = ?`).bind(sessionHash).run();
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

/** Active tenants (id, brand) owned by a contact email — the magic-link
 * lookup (routes/login.ts). `email` MUST already be lowercased by the caller
 * (insertTenantIndex normalizes on write, migrations/0009 backfills existing
 * rows) — this function does not re-normalize, so a caller that forgets to
 * lowercase gets a silent zero-row miss, matching the enumeration-safe "do
 * nothing" branch rather than a crash. Suspended/terminated tenants are
 * excluded (`status = 'active'`), same posture as bearer-token resolution. */
export async function lookupActiveTenantsByContactEmail(
  env: Env,
  email: string,
): Promise<Array<{ id: string; brand: string }>> {
  const result = await env.DB.prepare(`SELECT id, brand FROM tenants_index WHERE contact_email = ? AND status = 'active'`)
    .bind(email)
    .all<{ id: string; brand: string }>();
  return result.results;
}

// --- Magic-link login (migrations/0009_login_links.sql) — email-possession
// login (design docs/research/human-signup-magic-link-design-2026-07-22.md
// §1.2). `token_hash` mirrors dashboard_sessions.session_hash exactly (same
// SHA-256(+pepper) discipline); the row is bound to `contact_email`, not a
// tenant, because one email can own several tenants (§1.5 picker). ---

export interface LoginLinkRow {
  contact_email: string;
  expires_at: number;
  consumed_at: number | null;
}

export async function insertLoginLink(
  env: Env,
  params: { tokenHash: string; contactEmail: string; createdAt: number; expiresAt: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO login_links (token_hash, contact_email, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, NULL)`,
  )
    .bind(params.tokenHash, params.contactEmail, params.createdAt, params.expiresAt)
    .run();
}

export async function lookupLoginLinkByHash(env: Env, tokenHash: string): Promise<LoginLinkRow | null> {
  const row = await env.DB.prepare(`SELECT contact_email, expires_at, consumed_at FROM login_links WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<LoginLinkRow>();
  return row ?? null;
}

/** Atomic single-use consume (adversary-held attack: `changes()===1`) — the
 * conditional UPDATE closes the double-submit/replay race at the DB layer,
 * not in app logic. Returns `true` iff THIS call was the one that consumed
 * it; a concurrent second call (or a replay of an already-consumed token)
 * gets `false` and must NOT mint a session. */
export async function consumeLoginLink(env: Env, tokenHash: string, consumedAt: number): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE login_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`)
    .bind(consumedAt, tokenHash)
    .run();
  return (result.meta.changes ?? 0) === 1;
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
