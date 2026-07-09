import { Hono } from "hono";
import { SignupInput } from "@coldstart/shared";
import { generateApiToken, hashApiToken } from "../auth.js";
import { RealClock } from "../clock.js";
import { insertTenantIndex } from "../db.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { parseJsonBody } from "../validate.js";

// POST /signup — the one bootstrap intent outside the ~12 tenant-scoped
// facade intents (SPEC.md §6). Always mints a `demo` plan tenant in this
// build: there is no paid/Stripe path yet (B1), and demo is what forces the
// vendor adapter factory to sandbox-only (see vendors/factory.ts).
//
// Unauthenticated, so it is rate-limited BEFORE any tenant creation
// (adversarial panel-02: unbounded /signup is the root DoS enabler). Uses the
// atomic per-IP RateLimiterDO — NOT the racy waitlist KV limiter. No
// Turnstile/CAPTCHA on purpose: this signup must stay agent-drivable.
const SIGNUP_PER_MINUTE = 5;
const SIGNUP_PER_DAY = 50;
// Global defense-in-depth ceiling on demo-tenant creation across ALL IPs.
const SIGNUP_GLOBAL_PER_MINUTE = 200;
const SIGNUP_GLOBAL_PER_DAY = 5000;

export const signupRoute = new Hono<{ Bindings: Env }>().post("/signup", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "unknown";
  const perIp = c.env.SIGNUP_LIMITER.get(c.env.SIGNUP_LIMITER.idFromName(`signup:${ip}`));
  const ipDecision = await perIp.hit(SIGNUP_PER_MINUTE, SIGNUP_PER_DAY);
  if (!ipDecision.allowed) {
    return c.json({ error: "rate limited — too many signups from this IP, try again shortly" }, 429);
  }
  const global = c.env.SIGNUP_LIMITER.get(c.env.SIGNUP_LIMITER.idFromName("signup:__global__"));
  const globalDecision = await global.hit(SIGNUP_GLOBAL_PER_MINUTE, SIGNUP_GLOBAL_PER_DAY);
  if (!globalDecision.allowed) {
    return c.json({ error: "signup temporarily unavailable — global demo capacity reached, try again later" }, 429);
  }

  const parsed = await parseJsonBody(c, SignupInput);
  if (!parsed.ok) return parsed.response;

  const tenantId = newId("ten");
  const token = generateApiToken();
  const tokenHash = await hashApiToken(token, c.env.TOKEN_HASH_PEPPER);

  await insertTenantIndex(c.env, {
    id: tenantId,
    apiTokenHash: tokenHash,
    brand: parsed.data.brand,
    plan: "demo",
    createdAt: new RealClock().now(),
  });

  const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
  await stub.initTenant({ tenantId, brand: parsed.data.brand, plan: "demo" });

  return c.json({ tenantId, token }, 201);
});
