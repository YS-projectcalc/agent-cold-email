import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function postWaitlist(email: unknown, ip?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return SELF.fetch("https://example.com/api/waitlist", { method: "POST", headers, body: JSON.stringify({ email }) });
}

describe("POST /api/waitlist — public waitlist form", () => {
  it("stores a valid email and returns { ok: true }", async () => {
    const email = `store-${crypto.randomUUID()}@waitlist-test.example`;
    const res = await postWaitlist(email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const stored = await env.WAITLIST.get(`email:${email.toLowerCase()}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toMatchObject({ email: email.toLowerCase() });
  });

  it("dedupes by email — a second submission does not create a second record or change the stored createdAt", async () => {
    const email = `dedupe-${crypto.randomUUID()}@waitlist-test.example`;
    const first = await postWaitlist(email);
    expect(first.status).toBe(200);
    const firstStored = await env.WAITLIST.get(`email:${email.toLowerCase()}`);

    const second = await postWaitlist(email.toUpperCase()); // also proves case-insensitive dedupe
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    const secondStored = await env.WAITLIST.get(`email:${email.toLowerCase()}`);
    expect(secondStored).toBe(firstStored); // untouched — the second call didn't overwrite it

    const listed = await env.WAITLIST.list({ prefix: `email:${email.toLowerCase()}` });
    expect(listed.keys).toHaveLength(1);
  });

  it("rejects a malformed email with 400", async () => {
    const res = await postWaitlist("not-an-email");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("rate-limits repeated submissions from the same IP", async () => {
    // A dedicated synthetic IP for this test only, so its rate-limit bucket
    // is never shared with (or polluted by) the other tests in this file —
    // each of those uses no CF-Connecting-IP header and lands in the
    // "unknown" bucket instead. State (KV) persists across `it()`s within a
    // file in this test pool, so bucket isolation has to be explicit.
    const ip = "203.0.113.77"; // TEST-NET-3 (RFC 5737), never a real client
    const results: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await postWaitlist(`rl-${i}-${crypto.randomUUID()}@waitlist-test.example`, ip);
      results.push(res.status);
    }
    expect(results.filter((s) => s === 200).length).toBe(5);
    expect(results.filter((s) => s === 429).length).toBe(2);
  });

  it("OPTIONS preflight returns CORS headers for the site origin", async () => {
    const res = await SELF.fetch("https://example.com/api/waitlist", {
      method: "OPTIONS",
      headers: { origin: "https://agent-cold-email.pages.dev" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://agent-cold-email.pages.dev");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("POST responses also carry the CORS header (not just preflight)", async () => {
    const res = await postWaitlist(`cors-${crypto.randomUUID()}@waitlist-test.example`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://agent-cold-email.pages.dev");
  });
});
