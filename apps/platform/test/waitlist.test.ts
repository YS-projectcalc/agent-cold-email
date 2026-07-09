import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminApi } from "./helpers.js";

async function postWaitlist(email: unknown, ip?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return SELF.fetch("https://example.com/api/waitlist", { method: "POST", headers, body: JSON.stringify({ email }) });
}

async function waitlistRow(email: string): Promise<{ email: string; created_at: number } | null> {
  return env.DB.prepare(`SELECT email, created_at FROM waitlist WHERE email = ?`)
    .bind(email.toLowerCase())
    .first<{ email: string; created_at: number }>();
}

describe("POST /api/waitlist — public waitlist form", () => {
  it("persists a valid email durably in D1 and returns { ok: true }", async () => {
    const email = `store-${crypto.randomUUID()}@waitlist-test.example`;
    const res = await postWaitlist(email);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await waitlistRow(email);
    expect(row).not.toBeNull();
    expect(row!.email).toBe(email.toLowerCase());
    expect(typeof row!.created_at).toBe("number");
  });

  // Adversarial panel-03 finding #9: emails were stored in KV with a 90-day
  // TTL and nothing read them back — the funnel silently emptied. They now live
  // in D1 with NO expiry, and NO `email:` KV key is written. This FAILS on the
  // old code (old code wrote a TTL'd KV `email:` key and no D1 row).
  it("stores the email in D1 with no expiry and writes no TTL'd KV email key (finding #9)", async () => {
    const email = `durable-${crypto.randomUUID()}@waitlist-test.example`;
    const res = await postWaitlist(email);
    expect(res.status).toBe(200);

    // Durable D1 row exists (D1 has no TTL — it never expires).
    const row = await waitlistRow(email);
    expect(row).not.toBeNull();

    // The old TTL'd KV email store is gone — no `email:` key is written.
    const legacyKv = await env.WAITLIST.get(`email:${email.toLowerCase()}`);
    expect(legacyKv).toBeNull();
  });

  it("dedupes by email — a second submission keeps the original createdAt (case-insensitive)", async () => {
    const email = `dedupe-${crypto.randomUUID()}@waitlist-test.example`;
    const first = await postWaitlist(email);
    expect(first.status).toBe(200);
    const firstRow = await waitlistRow(email);
    expect(firstRow).not.toBeNull();

    const second = await postWaitlist(email.toUpperCase()); // also proves case-insensitive dedupe
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });

    const secondRow = await waitlistRow(email);
    expect(secondRow!.created_at).toBe(firstRow!.created_at); // untouched — INSERT OR IGNORE

    // Exactly one row for this email.
    const count = await env.DB.prepare(`SELECT COUNT(*) as n FROM waitlist WHERE email = ?`)
      .bind(email.toLowerCase())
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  // Adversarial panel-03 finding #9 — owner visibility: the funnel had no
  // owner-retrieval path. The digest + admin export now surface durable
  // waitlist leads. Asserted as a DELTA so it holds regardless of rows other
  // tests in this file leave in the shared D1.
  it("owner visibility: the ops digest reports the waitlist count (finding #9)", async () => {
    const before = await adminApi<{ waitlist: { count: number } }>("/admin/ops/digest");
    const baseline = before.body.waitlist.count;

    // Dedicated IP bucket so these two posts aren't throttled by the shared
    // "unknown" per-IP rate-limit bucket other tests in this file fill.
    const ip = "203.0.113.99"; // TEST-NET-3 (RFC 5737)
    const emailA = `digest-a-${crypto.randomUUID()}@waitlist-test.example`;
    const emailB = `digest-b-${crypto.randomUUID()}@waitlist-test.example`;
    const resA = await postWaitlist(emailA, ip);
    const resB = await postWaitlist(emailB, ip);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const digest = await adminApi<{ waitlist: { count: number } }>("/admin/ops/digest");
    expect(digest.status).toBe(200);
    // Two signups -> the digest count is exactly two higher.
    expect(digest.body.waitlist.count).toBe(baseline + 2);

    // And the ADMIN_TOKEN-gated export lists both leads (newest first).
    const list = await adminApi<{ count: number; entries: { email: string }[] }>("/admin/ops/waitlist");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(digest.body.waitlist.count);
    const emails = list.body.entries.map((e) => e.email);
    expect(emails).toContain(emailA.toLowerCase());
    expect(emails).toContain(emailB.toLowerCase());
  });

  it("rejects a malformed email with 400", async () => {
    const res = await postWaitlist("not-an-email");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("rate-limits repeated submissions from the same IP", async () => {
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
