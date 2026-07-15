// POST /api/waitlist — the public marketing-site waitlist form (C6 in
// ROADMAP.md; site/assets/waitlist.js posts here). Unauthenticated by
// design (no bearer token exists yet for someone who hasn't signed up).
// Emails are persisted DURABLY in the D1 `waitlist` table (no expiry —
// adversarial panel-03 finding #9: the old KV store expired leads after 90
// days and nothing read them back). Only the per-IP RATE-LIMIT counters stay
// in KV (short TTL, correctly ephemeral). Never touches a TenantDO.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env.js";
import { RealClock } from "../clock.js";
import { insertWaitlistEmail } from "../db.js";
import { parseJsonBody } from "../validate.js";

const WaitlistInput = z.object({ email: z.string().email() });

// The site origins allowed to call this endpoint from a browser. `coldrig.dev`
// is the live custom domain (the canonical host — all of site/'s self-refs
// point there); the `pages.dev` origin is kept for the pre-cutover Pages URL /
// preview deploys. Echo-validate: the request Origin is reflected back ONLY
// when it's an exact allowlist member (never `*`, never an unvalidated echo),
// so a browser on either host is allowed and every other origin gets no ACAO
// header at all. (Before the coldrig.dev cutover this was a single hardcoded
// pages.dev origin — a coldrig.dev browser was CORS-blocked on the form.)
const ALLOWED_ORIGINS = new Set(["https://coldrig.dev", "https://agent-cold-email.pages.dev"]);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 5;
const RATE_LIMIT_KV_TTL_SECONDS = 120; // > the window, so a bucket always outlives its own window

function corsHeaders(requestOrigin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    // The ACAO varies by request Origin (allowlist echo), so any cache MUST key
    // on Origin or it could serve one origin's allow header to another.
    Vary: "Origin",
  };
  if (requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  return headers;
}

function json(body: unknown, status: number, requestOrigin: string | null | undefined): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(requestOrigin) },
  });
}

export const waitlistRoute = new Hono<{ Bindings: Env }>()
  .options("/api/waitlist", (c) => new Response(null, { status: 204, headers: corsHeaders(c.req.header("Origin")) }))
  .post("/api/waitlist", async (c) => {
    const origin = c.req.header("Origin");
    const parsed = await parseJsonBody(c, WaitlistInput);
    if (!parsed.ok) return json(await parsed.response.json(), parsed.response.status, origin);

    const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "unknown";
    const windowBucket = Math.floor(new RealClock().now() / RATE_LIMIT_WINDOW_MS);
    const rateLimitKey = `rl:${ip}:${windowBucket}`;

    // NOTE: this KV read-modify-write is NOT atomic (a concurrent burst can all
    // read the same count and bypass the cap). It is tolerated here only
    // because the blast radius is the waitlist store — no cost/sends. The
    // higher-value /signup limiter uses the atomic RateLimiterDO instead
    // (rate-limiter-do.ts); migrating this endpoint to that DO is the intended
    // follow-up (adversarial panel-02).
    const currentCountRaw = await c.env.WAITLIST.get(rateLimitKey);
    const currentCount = currentCountRaw ? Number.parseInt(currentCountRaw, 10) : 0;
    if (currentCount >= RATE_LIMIT_MAX_PER_WINDOW) {
      return json({ error: "rate limited — try again shortly" }, 429, origin);
    }
    await c.env.WAITLIST.put(rateLimitKey, String(currentCount + 1), { expirationTtl: RATE_LIMIT_KV_TTL_SECONDS });

    const email = parsed.data.email.trim().toLowerCase();
    // Durable D1 store, no expiry. INSERT OR IGNORE dedupes by email (PK) —
    // a repeat submission is a silent no-op, still `ok: true`.
    await insertWaitlistEmail(c.env, email, new RealClock().now());

    return json({ ok: true }, 200, origin);
  });
