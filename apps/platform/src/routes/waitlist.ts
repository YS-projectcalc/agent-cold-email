// POST /api/waitlist — the public marketing-site waitlist form (C6 in
// ROADMAP.md; site/assets/waitlist.js posts here). Unauthenticated by
// design (no bearer token exists yet for someone who hasn't signed up), so
// this is a KV-backed store + a basic per-IP rate limit rather than a
// tenant-scoped facade intent — it never touches TenantDO.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env.js";
import { RealClock } from "../clock.js";
import { parseJsonBody } from "../validate.js";

const WaitlistInput = z.object({ email: z.string().email() });

// The live site's Pages origin (site/_headers CSP `connect-src`, server-card.json).
const ALLOWED_ORIGIN = "https://agent-cold-email.pages.dev";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 5;
const RATE_LIMIT_KV_TTL_SECONDS = 120; // > the window, so a bucket always outlives its own window

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}

export const waitlistRoute = new Hono<{ Bindings: Env }>()
  .options("/api/waitlist", () => new Response(null, { status: 204, headers: corsHeaders() }))
  .post("/api/waitlist", async (c) => {
    const parsed = await parseJsonBody(c, WaitlistInput);
    if (!parsed.ok) return json(await parsed.response.json(), parsed.response.status);

    const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("x-forwarded-for") ?? "unknown";
    const windowBucket = Math.floor(new RealClock().now() / RATE_LIMIT_WINDOW_MS);
    const rateLimitKey = `rl:${ip}:${windowBucket}`;

    const currentCountRaw = await c.env.WAITLIST.get(rateLimitKey);
    const currentCount = currentCountRaw ? Number.parseInt(currentCountRaw, 10) : 0;
    if (currentCount >= RATE_LIMIT_MAX_PER_WINDOW) {
      return json({ error: "rate limited — try again shortly" }, 429);
    }
    await c.env.WAITLIST.put(rateLimitKey, String(currentCount + 1), { expirationTtl: RATE_LIMIT_KV_TTL_SECONDS });

    const email = parsed.data.email.trim().toLowerCase();
    const emailKey = `email:${email}`;
    const existing = await c.env.WAITLIST.get(emailKey);
    if (!existing) {
      await c.env.WAITLIST.put(emailKey, JSON.stringify({ email, createdAt: new RealClock().now() }));
    }
    // existing !== null: already on the list — dedupe silently, still `ok: true`.

    return json({ ok: true }, 200);
  });
