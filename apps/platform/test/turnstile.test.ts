import { describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../src/turnstile.js";

// Turnstile (design docs/research/human-signup-magic-link-design-2026-07-22.
// md §2.3) — verifyTurnstile takes its secret/fetcher as plain arguments
// (dependency injection, mirroring the OpsMailer house style), so every case
// here is a real behavioral proof with NO live network call.

describe("verifyTurnstile — dark by default", () => {
  it("passes with no fetch call at all when no secret is configured", async () => {
    const fetcher = vi.fn();
    const ok = await verifyTurnstile(undefined, "some-token", "203.0.113.1", fetcher as unknown as typeof fetch);
    expect(ok).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes for an empty-string secret too (treated as unconfigured)", async () => {
    const fetcher = vi.fn();
    const ok = await verifyTurnstile("", "some-token", "203.0.113.1", fetcher as unknown as typeof fetch);
    expect(ok).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("verifyTurnstile — configured", () => {
  it("fails closed with NO fetch call when a challenge token is missing", async () => {
    const fetcher = vi.fn();
    const ok = await verifyTurnstile("test-secret", undefined, "203.0.113.1", fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POSTs secret+response+remoteip to the real Cloudflare siteverify URL", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const ok = await verifyTurnstile("test-secret", "solved-token", "203.0.113.9", fetcher as unknown as typeof fetch);
    expect(ok).toBe(true);

    const call = fetcher.mock.calls[0];
    if (!call) throw new Error("fetcher was never called");
    const [url, init] = call as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const sent = new URLSearchParams(init.body as URLSearchParams);
    expect(sent.get("secret")).toBe("test-secret");
    expect(sent.get("response")).toBe("solved-token");
    expect(sent.get("remoteip")).toBe("203.0.113.9");
  });

  it("rejects when Cloudflare reports success:false", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    const ok = await verifyTurnstile("test-secret", "bad-token", "203.0.113.9", fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
  });

  it("fails closed on a non-2xx response from siteverify", async () => {
    const fetcher = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const ok = await verifyTurnstile("test-secret", "any-token", "203.0.113.9", fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
  });

  it("fails closed when the siteverify request itself throws", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    });
    const ok = await verifyTurnstile("test-secret", "any-token", "203.0.113.9", fetcher as unknown as typeof fetch);
    expect(ok).toBe(false);
  });
});
