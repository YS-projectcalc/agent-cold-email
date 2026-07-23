import { Hono } from "hono";
import { LoginConsumeInput, LoginRequestInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import { generateDashboardSessionId, hashApiToken } from "../auth.js";
import { DEFAULT_PUBLIC_BASE_URL } from "../engine/tick.js";
import { consumeLoginLink, insertLoginLink, lookupActiveTenantsByContactEmail, lookupLoginLinkByHash } from "../db.js";
import { sendLoginLinkEmail } from "../ops-mail/auth-mailer.js";
import { createOpsMailer } from "../ops-mail/ops-mailer.js";
import { verifyTurnstile } from "../turnstile.js";
import { parseJsonBody } from "../validate.js";
import { mintDashboardSession } from "./dashboard-session.js";

// Magic-link login (design docs/research/human-signup-magic-link-design-
// 2026-07-22.md §1). Mounted UNAUTHENTICATED alongside POST /dashboard/session
// (index.ts) — both routes resolve their own credential from the request
// body, not a header.

const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;

// §1.6 — reuse SIGNUP_LIMITER (the atomic per-key RateLimiterDO), distinct key
// namespaces so login limits never cross-contaminate /signup's own limits.
const LOGIN_EMAIL_PER_MINUTE = 3;
const LOGIN_EMAIL_PER_DAY = 10;
const LOGIN_IP_PER_MINUTE = 5;
const LOGIN_IP_PER_DAY = 30;
// Mirrors signup.ts's own global ceiling (routes/signup.ts:22-23).
const LOGIN_GLOBAL_PER_MINUTE = 200;
const LOGIN_GLOBAL_PER_DAY = 5000;

const ENUMERATION_SAFE_BODY = { ok: true as const, message: "If an account exists for that email, we've sent a sign-in link." };

export const loginRoute = new Hono<{ Bindings: Env }>()
  .post("/login", async (c) => {
    const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "unknown";

    // §1.6 — rate-limit BEFORE any lookup. IP + global are cheap (no body
    // parse needed yet), so they gate first, mirroring signup.ts's own order.
    const perIp = c.env.SIGNUP_LIMITER.get(c.env.SIGNUP_LIMITER.idFromName(`login:ip:${ip}`));
    const ipDecision = await perIp.hit(LOGIN_IP_PER_MINUTE, LOGIN_IP_PER_DAY);
    if (!ipDecision.allowed) {
      return c.json({ error: "rate limited — too many sign-in requests from this IP, try again shortly" }, 429);
    }
    const global = c.env.SIGNUP_LIMITER.get(c.env.SIGNUP_LIMITER.idFromName("login:__global__"));
    const globalDecision = await global.hit(LOGIN_GLOBAL_PER_MINUTE, LOGIN_GLOBAL_PER_DAY);
    if (!globalDecision.allowed) {
      return c.json({ error: "sign-in temporarily unavailable — global capacity reached, try again later" }, 429);
    }

    const parsed = await parseJsonBody(c, LoginRequestInput);
    if (!parsed.ok) return parsed.response;

    // Normalize BEFORE both the rate-limit key and the DB lookup (adversary
    // r1 NB4) — a mixed-case retry must hit the SAME per-email bucket as the
    // lowercase original, and must match the normalize-on-write DB column.
    const email = parsed.data.email.toLowerCase();

    // Per-email limiter — the primary email-bomb defense (§1.8). Hash the
    // email so PII never lands in a DO id; reuses the existing pepper+SHA-256
    // path rather than adding a second hash function (CLAUDE.md rule c).
    const emailHash = await hashApiToken(email, c.env.TOKEN_HASH_PEPPER);
    const perEmail = c.env.SIGNUP_LIMITER.get(c.env.SIGNUP_LIMITER.idFromName(`login:email:${emailHash}`));
    const emailDecision = await perEmail.hit(LOGIN_EMAIL_PER_MINUTE, LOGIN_EMAIL_PER_DAY);
    if (!emailDecision.allowed) {
      return c.json({ error: "rate limited — too many sign-in requests for this address, try again shortly" }, 429);
    }

    // §2.3 — Turnstile, `/login` ONLY. Dark no-op (always passes) while
    // TURNSTILE_SECRET is unconfigured; this failure is gated BEFORE the
    // tenant lookup, so it never becomes an enumeration signal either way.
    const turnstileOk = await verifyTurnstile(c.env.TURNSTILE_SECRET, parsed.data.turnstileToken, ip);
    if (!turnstileOk) return c.json({ error: "turnstile verification failed" }, 400);

    // §1.3 steps 3-6 — enumeration-safe: identical response regardless of
    // whether the email matches an active tenant. The send (if any) is fired
    // via ctx.waitUntil (adversary r1 NB2) so the exists/not-exists branches
    // return on the exact same path — awaiting it here would make the
    // exists-branch measurably slower, a timing oracle.
    const tenants = await lookupActiveTenantsByContactEmail(c.env, email);
    if (tenants.length > 0) {
      const linkId = generateDashboardSessionId(); // reuses the opaque-id generator — see auth.ts doc comment
      const tokenHash = await hashApiToken(linkId, c.env.TOKEN_HASH_PEPPER);
      const now = Date.now();
      await insertLoginLink(c.env, { tokenHash, contactEmail: email, createdAt: now, expiresAt: now + LOGIN_LINK_TTL_MS });

      const baseUrl = c.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL;
      const url = `${baseUrl}/app/login?token=${encodeURIComponent(linkId)}`;
      const mailer = createOpsMailer(c.env);
      const userAgent = c.req.header("User-Agent") ?? "unknown";
      c.executionCtx.waitUntil(
        sendLoginLinkEmail(mailer, { to: email, url, requestIp: ip, requestUserAgent: userAgent }).catch((err) => {
          // Dark-safe degrade (§1.7): an unsendable link must never surface
          // to the requester (that would be an enumeration oracle) — log and
          // move on, exactly like every other OpsMailer caller in this repo.
          console.error("login link email send failed", err);
        }),
      );
    }

    return c.json(ENUMERATION_SAFE_BODY, 200);
  })
  .post("/login/consume", async (c) => {
    // Adversary r1 NB3 — login-CSRF: `c.req.json()` ignores Content-Type, so
    // a cross-site simple POST could otherwise log a victim into the
    // attacker's own tenant (the attacker requests their own link, then
    // tricks the victim's browser into submitting it here). This route is
    // unauthenticated (no cookie yet), so the global csrfGuard middleware
    // (which reads authVia off an ALREADY-authed context) never runs for it —
    // require the same same-origin header explicitly, right here.
    if (c.req.header("X-Coldstart-Client") !== "dashboard") {
      return c.json({ error: "missing required X-Coldstart-Client header" }, 403);
    }

    const parsed = await parseJsonBody(c, LoginConsumeInput);
    if (!parsed.ok) return parsed.response;

    const tokenHash = await hashApiToken(parsed.data.token, c.env.TOKEN_HASH_PEPPER);
    const link = await lookupLoginLinkByHash(c.env, tokenHash);
    if (!link || link.consumed_at !== null || link.expires_at <= Date.now()) {
      return c.json({ error: "invalid or expired sign-in link" }, 401);
    }

    const tenants = await lookupActiveTenantsByContactEmail(c.env, link.contact_email);
    if (tenants.length === 0) {
      // No active tenant left for this email (e.g. terminated between the
      // request and the click) — do NOT consume; the link simply can't
      // complete, and a mid-window state change might still resolve before
      // the 15-min expiry.
      return c.json({ error: "no active account for this email" }, 401);
    }

    if (parsed.data.tenantId !== undefined) {
      // §1.5 picker's second call — assert the picked tenant is actually one
      // of this email's OWN active tenants before consuming (never trust a
      // client-supplied tenantId on its own).
      const picked = tenants.find((t) => t.id === parsed.data.tenantId);
      if (!picked) return c.json({ error: "that account is not associated with this sign-in link" }, 403);
      const consumed = await consumeLoginLink(c.env, tokenHash, Date.now());
      if (!consumed) return c.json({ error: "this sign-in link was already used" }, 401);
      const result = await mintDashboardSession(c, c.env, picked.id);
      return c.json(result, 200);
    }

    if (tenants.length > 1) {
      // §1.5 — multiple tenants, no pick made yet: return the picker list
      // WITHOUT consuming. Consumption happens exactly once, on the final
      // pick (the branch above).
      return c.json({ tenants: tenants.map((t) => ({ tenantId: t.id, brand: t.brand })) }, 200);
    }

    // Exactly one tenant — the common case auto-completes in one round trip.
    const only = tenants[0];
    if (!only) return c.json({ error: "no active account for this email" }, 401);
    const consumed = await consumeLoginLink(c.env, tokenHash, Date.now());
    if (!consumed) return c.json({ error: "this sign-in link was already used" }, 401);
    const result = await mintDashboardSession(c, c.env, only.id);
    return c.json(result, 200);
  });
