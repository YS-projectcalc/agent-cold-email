import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { TenantDO } from "./tenant-do.js";
import { extractBearerToken, hashApiToken } from "./auth.js";
import { lookupDashboardSession, lookupTenantById, lookupTenantByTokenHash } from "./db.js";
import type { Env } from "./env.js";

// SPEC.md §19.1 (M1) — the dashboard's httpOnly session cookie name. Shared
// between require-auth.ts (reads it) and routes/dashboard-session.ts (sets/
// clears it) — the single source of truth for the cookie's name.
export const DASHBOARD_SESSION_COOKIE = "cs_dashboard_session";

// CLAUDE.md rule h: every tenant-scoped route must resolve to exactly one
// tenant's DO stub, and every downstream engine query is additionally
// scoped by tenant_id inside that DO — belt and suspenders isolation.
export interface AuthedVariables {
  tenantId: string;
  tenantStub: DurableObjectStub<TenantDO>;
  // SPEC.md §19.1 [NEW-5] — WHICH credential authenticated this request:
  // 'bearer' (Authorization header) or 'cookie' (dashboard session). Routes
  // map this to the provenance `source` param they pass into TenantDO methods
  // ('api' for bearer, 'dashboard' for cookie); the CSRF guard (csrf-guard.ts)
  // reads it too — only a cookie-authed mutation needs the CSRF header.
  authVia: "bearer" | "cookie";
}

export interface ResolvedTenant {
  tenantId: string;
  tenantStub: DurableObjectStub<TenantDO>;
}

// Item 4 (backend gaps brief) / SPEC.md §19.6 — a stable, machine-readable
// reason a request failed auth, alongside the existing human `error` string.
// Sourced HONESTLY from what actually gates login: `tenants_index.status`
// (D1) only ever leaves 'active' via the abuse-terminate lane (routes/
// admin-ops.ts's setTenantIndexStatus) — a dunning/billing-frozen tenant's
// `tenant_profile.status`/`billing_state` (DO-local, engine/billing-state.ts)
// deliberately does NOT block login (it freezes spend-incurring intents
// instead, so the tenant can still authenticate and see why it's frozen /
// reactivate via checkout) — so `account_suspended` here reports EXACTLY
// what actually locked the credential out, never a DO-local state that
// didn't.
export type AuthFailureCode = "invalid_token" | "expired_session" | "account_suspended";

export type TokenResolution =
  | { ok: true; tenant: ResolvedTenant }
  | { ok: false; code: AuthFailureCode; message: string };

function stubFor(env: Env, tenantId: string): DurableObjectStub<TenantDO> {
  return env.TENANT.get(env.TENANT.idFromName(tenantId));
}

/**
 * The single token->tenant resolver. Used by the Hono `requireAuth`
 * middleware below AND by `src/mcp/handler.ts` (the hosted MCP endpoint
 * resolves the tenant fresh from the Authorization header on every JSON-RPC
 * call — no caching across requests, so two different tokens on the same
 * `/mcp` route never cross-contaminate).
 */
export async function resolveTenantFromToken(env: Env, token: string | null): Promise<TokenResolution> {
  if (!token) return { ok: false, code: "invalid_token", message: "missing bearer token" };
  const tokenHash = await hashApiToken(token, env.TOKEN_HASH_PEPPER);
  const tenant = await lookupTenantByTokenHash(env, tokenHash);
  if (!tenant) return { ok: false, code: "invalid_token", message: "invalid or inactive token" };
  if (tenant.status !== "active") {
    return { ok: false, code: "account_suspended", message: "this account has been suspended" };
  }
  return { ok: true, tenant: { tenantId: tenant.id, tenantStub: stubFor(env, tenant.id) } };
}

/**
 * SPEC.md §19.1 (M1) — the dashboard cookie->tenant resolver. Re-validates
 * BOTH the session's own TTL (`expires_at`, real wall-clock) AND the tenant's
 * current control-plane status on every call — a session survives no longer
 * than the tenant it was minted for staying active, so a mid-session
 * suspend/terminate 401s the dashboard exactly like it already 401s a bearer
 * token (the tenant-facing security guarantee is identical either way).
 */
export async function resolveTenantFromDashboardSession(env: Env, sessionId: string | null): Promise<TokenResolution> {
  if (!sessionId) return { ok: false, code: "invalid_token", message: "missing dashboard session" };
  const sessionHash = await hashApiToken(sessionId, env.TOKEN_HASH_PEPPER);
  const session = await lookupDashboardSession(env, sessionHash);
  if (!session) return { ok: false, code: "invalid_token", message: "invalid or expired dashboard session" };
  if (session.expires_at <= Date.now()) {
    return { ok: false, code: "expired_session", message: "dashboard session expired — please sign in again" };
  }
  const tenant = await lookupTenantById(env, session.tenant_id);
  if (!tenant) return { ok: false, code: "invalid_token", message: "invalid or expired dashboard session" };
  if (tenant.status !== "active") {
    return { ok: false, code: "account_suspended", message: "this account has been suspended" };
  }
  return { ok: true, tenant: { tenantId: tenant.id, tenantStub: stubFor(env, tenant.id) } };
}

export async function requireAuth(c: Context<{ Bindings: Env; Variables: AuthedVariables }>, next: Next) {
  const token = extractBearerToken(c.req.header("Authorization"));
  if (token) {
    const resolved = await resolveTenantFromToken(c.env, token);
    if (!resolved.ok) return c.json({ error: resolved.message, code: resolved.code }, 401);
    c.set("tenantId", resolved.tenant.tenantId);
    c.set("tenantStub", resolved.tenant.tenantStub);
    c.set("authVia", "bearer");
    return next();
  }

  // Cookie fallback (§19.1 [NEW-1]) — only consulted when no Authorization
  // header was presented at all, so a bearer-token caller's behavior is
  // completely unchanged (an invalid bearer token still 401s immediately
  // above, it never silently falls back to a cookie).
  const sessionId = getCookie(c, DASHBOARD_SESSION_COOKIE) ?? null;
  if (sessionId) {
    const resolved = await resolveTenantFromDashboardSession(c.env, sessionId);
    if (resolved.ok) {
      c.set("tenantId", resolved.tenant.tenantId);
      c.set("tenantStub", resolved.tenant.tenantStub);
      c.set("authVia", "cookie");
      return next();
    }
    // §19.6 — 401 mid-session (suspended/expired/invalid) drops the SPA back
    // to the token-gate screen; `code` lets it render a distinct explanatory
    // state per SPEC.md §19.6 instead of parsing the human `error` string.
    return c.json({ error: resolved.message, code: resolved.code }, 401);
  }

  return c.json({ error: "missing bearer token", code: "invalid_token" satisfies AuthFailureCode }, 401);
}
