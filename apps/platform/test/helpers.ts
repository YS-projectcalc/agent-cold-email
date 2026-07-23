import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { TenantPlan } from "@coldstart/shared";
import { generateApiToken, hashApiToken } from "../src/auth.js";
import { VirtualClock } from "../src/clock.js";
import { insertTenantIndex } from "../src/db.js";
import { readActivationState } from "../src/engine/activation.js";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";
import { swapInSdnList } from "../src/ofac/sdn-list.js";
import { newId } from "../src/schema.js";
import type { TenantContext } from "../src/tenant-context.js";
import type { TenantDO } from "../src/tenant-do.js";
import { createVendorAdapters } from "../src/vendors/factory.js";

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

/**
 * Builds a REAL `TenantContext` against the DO's own live SqlStorage/clock
 * inside a `runInDurableObject` callback, and runs `fn` against it — for
 * tests that need to call an `engine/*.ts` function DIRECTLY (bypassing the
 * facade) with an injected dependency the RPC surface doesn't accept (e.g.
 * `runDeliverabilitySweep`'s injectable OpsMailer — see
 * deliverability-actions.ts). Mirrors the exact tenant_profile read every
 * other runInDurableObject test in this suite already does for clock_base/
 * clock_offset (e.g. tick-correctness.test.ts's send-window test).
 */
export async function withTenantContext<T>(tenantId: string, fn: (ctx: TenantContext) => Promise<T> | T): Promise<T> {
  return runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
    const sql = state.storage.sql;
    const profile = sql
      .exec<{ plan: TenantPlan; clock_base: number; clock_offset: number; clock_multiplier: number }>(
        `SELECT plan, clock_base, clock_offset, clock_multiplier FROM tenant_profile WHERE id = ?`,
        tenantId,
      )
      .one();
    const clock = new VirtualClock(profile.clock_base, profile.clock_offset, profile.clock_multiplier);
    // Mirrors tenant-do.ts's buildAdapters(): the I1 activation gate is a
    // FRESH SQL read, never a cached decision (adversarial finding F3).
    const { activated } = readActivationState(sql, tenantId);
    const ctx: TenantContext = {
      sql,
      tenantId,
      plan: profile.plan,
      clock,
      adapters: createVendorAdapters(profile.plan, clock, activated),
      env,
    };
    return fn(ctx);
  });
}

// The test webhook secret — MUST match vitest.config.ts's miniflare binding.
// The route fails CLOSED without a secret (adversarial panel-03 finding #1), so
// every webhook fixture is signed exactly as a real Stripe delivery would be.
export const TEST_STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_vitest";

/** Computes a valid `Stripe-Signature` header (`t=<ts>,v1=<hex-hmac>`) over the
 * raw payload — the same HMAC-SHA256 scheme src/billing/stripe-webhook.ts
 * verifies. */
export async function signStripeEvent(payload: string, secret: string = TEST_STRIPE_WEBHOOK_SECRET): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

/** POSTs a Stripe webhook event through the real HTTP surface with a valid
 * signature — the standard way tests drive billing state now that the webhook
 * verifies signatures (finding #1). */
export async function postWebhook<T = unknown>(event: unknown): Promise<ApiResult<T>> {
  const body = JSON.stringify(event);
  return api<T>("/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": await signStripeEvent(body) },
    body,
  });
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
  const res = await postWebhook(event);
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
  const res = await postWebhook(event);
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

/**
 * G1 OFAC screening (N-OF-1 fix, adversary OFAC build review 2026-07-23) — a
 * checkout now genuinely fail-CLOSES (`screening_status='review'`) when NO
 * SDN list is loaded (src/ofac/screening.ts). Any test that drives a tenant
 * through checkout/activatePaidPlan and expects the tenant to end up genuinely
 * activated (not held for screening review) needs a real list loaded first so
 * the real screen completes 'clear' — matching what a real deployment looks
 * like once the SDN list has loaded at least once. Seeds a small list whose
 * one entry doesn't match any brand these tests use.
 */
export async function seedBenignSdnList(nowMs: number = Date.now()): Promise<void> {
  const name = normalizeName("Totally Unrelated Sanctioned Entity");
  await swapInSdnList(env, {
    listVersion: `benign-${nowMs}`,
    entries: [{ uid: "0", nameNormalized: name, tokens: tokenize(name), entityType: null, program: "TEST" }],
    publishedDate: "2026-07-23",
    fetchedAt: nowMs,
  });
}

// --- SPEC.md §19.1 (M1 dashboard+inbox) — dashboard cookie-session test
// helpers. `SELF.fetch` here is the test harness's fetch (not a browser
// fetch), so `Set-Cookie` on the response is plainly readable — no browser
// cookie-jar/security filtering to work around. ---

export interface DashboardSession {
  /** A ready-to-send `Cookie:` header value, e.g. "cs_dashboard_session=<id>". */
  cookie: string;
  tenantId: string;
}

/** Exchanges a bearer token for a dashboard cookie session via POST
 * /dashboard/session, mirroring the real token-gate-screen flow. */
export async function createDashboardSession(token: string): Promise<DashboardSession> {
  const res = await SELF.fetch("https://example.com/dashboard/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.status !== 200) throw new Error(`dashboard session create failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("no Set-Cookie header returned from POST /dashboard/session");
  const match = /^cs_dashboard_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`could not parse session cookie from Set-Cookie: ${setCookie}`);
  const body = (await res.json()) as { tenantId: string };
  return { cookie: `cs_dashboard_session=${match[1]}`, tenantId: body.tenantId };
}

/** Like `api()`, but cookie-authed instead of bearer-authed. `csrf: true`
 * attaches the `X-Coldstart-Client: dashboard` header the global CSRF guard
 * requires on a cookie-authed non-GET/HEAD request (csrf-guard.ts). */
export async function cookieApi<T = unknown>(
  path: string,
  session: DashboardSession,
  init: (RequestInit & { csrf?: boolean }) | undefined = {},
): Promise<ApiResult<T>> {
  const { csrf, headers, ...rest } = init;
  const finalHeaders: Record<string, string> = {
    "content-type": "application/json",
    cookie: session.cookie,
    ...(headers as Record<string, string> | undefined),
  };
  if (csrf) finalHeaders["X-Coldstart-Client"] = "dashboard";
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
