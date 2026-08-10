import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

// panel-02 abuse-cost-dos: /signup was unauthenticated with ZERO rate limit
// (20 parallel signups all 201) — the root DoS enabler. It now has an atomic
// per-IP limiter (RateLimiterDO) BEFORE any tenant creation.
describe("POST /signup — per-IP rate limit (atomic, no CAPTCHA)", () => {
  it("returns 429 once a single IP bursts past the per-minute cap", async () => {
    const ip = "192.0.2.55"; // TEST-NET-1 (RFC 5737), fixed so all calls share one bucket
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await api<{ tenantId?: string; token?: string; error?: string }>("/signup", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: JSON.stringify({ brand: `Burst ${i}`, contactEmail: `burst-${i}@ratelimit-test.example` }),
      });
      statuses.push(res.status);
    }
    // Cap is 5/min: first 5 create a tenant (201), the rest are throttled (429).
    expect(statuses.filter((s) => s === 201).length).toBe(5);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });

  it("does not throttle distinct IPs against each other", async () => {
    const a = await api("/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.101" },
      body: JSON.stringify({ brand: "IP A", contactEmail: "a@distinct-ip.example" }),
    });
    const b = await api("/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.102" },
      body: JSON.stringify({ brand: "IP B", contactEmail: "b@distinct-ip.example" }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });
});

// panel-02 abuse-cost-dos: c.req.json() materialized+parsed the ENTIRE body
// before any zod bound was checked. Oversized bodies are now rejected 413
// BEFORE the parse, on unauthenticated endpoints.
describe("body-size cap before JSON.parse (413)", () => {
  it("rejects an oversized /signup body with 413 before parsing", async () => {
    const bigBody = JSON.stringify({ brand: "x".repeat(9000), contactEmail: "big@body-test.example" });
    const res = await api<{ error: string }>("/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.200" },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized /api/waitlist body with 413", async () => {
    const bigBody = JSON.stringify({ email: `${"x".repeat(9000)}@waitlist-test.example` });
    const res = await api("/api/waitlist", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.201" },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized /mcp body with 413", async () => {
    const bigBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
    const res = await api("/mcp", { method: "POST", body: bigBody });
    expect(res.status).toBe(413);
  });

  // audit-stripe-webhook-2026-08-06.md finding 7, swept off the webhook onto the
  // rest of the class. Every cap above read the DECLARED content-length, which a
  // chunked request simply does not send — so the three 413s above were the only
  // shape that was ever blocked, and the same request delivered as a stream sailed
  // through into the parse. These deliver the identical bytes with no
  // content-length; `api()` cannot express that, so they drive SELF.fetch directly.
  function streamed(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
        controller.close();
      },
    });
  }

  it("rejects an oversized /signup body delivered CHUNKED, with no content-length", async () => {
    const bigBody = JSON.stringify({ brand: "x".repeat(9000), contactEmail: "chunked@body-test.example" });
    const res = await SELF.fetch("https://example.com/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.202" },
      body: streamed(bigBody),
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized /mcp body delivered CHUNKED, keeping the JSON-RPC error envelope", async () => {
    const bigBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamed(bigBody),
    });
    expect(res.status).toBe(413);
    // /mcp answers in JSON-RPC, not the platform's `{error}` shape — the shared
    // reader returns null rather than a ready-made Response for exactly this.
    const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32600);
  });

  it("rejects an oversized /demo/run body delivered CHUNKED (the route that had NO cap at all)", async () => {
    const { token } = await signup("Demo Cap Co", "demo-cap@body-test.example");
    const res = await SELF.fetch("https://example.com/demo/run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: streamed(JSON.stringify({ leads: 3, pad: "x".repeat(9000) })),
    });
    expect(res.status).toBe(413);
  });

  it("still accepts a normal /mcp request delivered chunked and under the cap (control)", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamed(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; result?: { tools: unknown[] } };
    expect(body.id).toBe(7);
    expect(body.result?.tools.length).toBeGreaterThan(0);
  });

  it("still accepts a normal small /signup body (control)", async () => {
    const res = await api("/signup", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.210" },
      body: JSON.stringify({ brand: "Normal Co", contactEmail: "normal@body-test.example" }),
    });
    expect(res.status).toBe(201);
  });
});

// The platform is now LIVE (real billing, real Stripe keys flipped —
// ROADMAP.md 2026-07-23), so a fresh token is brand-correct AND mode-honest:
// `cr_live_`. This supersedes the pre-live-cutover invariant this test used
// to assert (demo tenants never carrying a `_live_`-shaped token, panel-02
// distribution-honesty) — that concern doesn't apply once "live" is true for
// every tenant, not just activated real-sending ones.
describe("token prefix — every fresh signup mints a brand-correct, mode-honest token", () => {
  it("mints a cr_live_ token for a demo-plan signup", async () => {
    const { token } = await signup("Prefix Co", "prefix@token-test.example");
    expect(token.startsWith("cr_live_")).toBe(true);
  });
});
