import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeWebhookUrl,
  hmacSha256Hex,
  realWebhookDeliverer,
  WEBHOOK_SNIPPET_MAX,
} from "../src/engine/webhook-security.js";

// OUTBOUND webhook delivery SECURITY (distinct from the inbound Stripe receiver
// in webhook-security.test.ts). The adversary attacks the SSRF boundary — these
// are unit tests of the pure URL validator + the real fetch deliverer with
// global fetch stubbed (NO live network), driven directly in the test isolate.

describe("assertSafeWebhookUrl — SSRF / scheme / port rejection table", () => {
  const REJECTED: [string, string][] = [
    ["http (not https)", "http://example.com/hook"],
    ["embedded credentials", "https://user:pass@example.com/hook"],
    ["non-443 port", "https://example.com:8080/hook"],
    ["loopback IPv4", "https://127.0.0.1/hook"],
    ["private 10/8", "https://10.0.0.5/hook"],
    ["private 172.16/12", "https://172.16.0.1/hook"],
    ["private 192.168/16", "https://192.168.1.1/hook"],
    ["link-local / metadata 169.254", "https://169.254.169.254/latest/meta-data"],
    ["CGNAT 100.64/10", "https://100.64.0.1/hook"],
    ["0.0.0.0", "https://0.0.0.0/hook"],
    ["IPv4 as hex (normalizes to 127.0.0.1)", "https://0x7f000001/hook"],
    ["IPv4 as decimal (normalizes to 127.0.0.1)", "https://2130706433/hook"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["IPv6 link-local", "https://[fe80::1]/hook"],
    ["IPv6 unique-local", "https://[fc00::1]/hook"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/hook"],
    // Adversary webhooks-lane-2026-07-16: IPv4-embedded IPv6 forms beyond
    // ::ffff:/96 that carry a private/link-local/loopback v4 in the low 32 bits.
    ["NAT64 64:ff9b::/96 metadata (169.254.169.254)", "https://[64:ff9b::a9fe:a9fe]/hook"],
    ["NAT64 64:ff9b::/96 loopback (127.0.0.1)", "https://[64:ff9b::7f00:1]/hook"],
    ["NAT64 64:ff9b::/96 private (10.0.0.1)", "https://[64:ff9b::a00:1]/hook"],
    ["IPv4-compatible ::/96 loopback (hex tail)", "https://[::7f00:1]/hook"],
    ["IPv4-compatible ::/96 loopback (dotted input)", "https://[::127.0.0.1]/hook"],
    ["IPv4-compatible ::/96 metadata (169.254.169.254)", "https://[::a9fe:a9fe]/hook"],
    // 6to4 2002::/16 embeds the v4 in bytes 2-5 (prefix, not low 32).
    ["6to4 2002::/16 loopback (127.0.0.1)", "https://[2002:7f00:1::]/hook"],
    ["6to4 2002::/16 metadata (169.254.169.254)", "https://[2002:a9fe:a9fe::]/hook"],
    // Trailing-dot FQDN normalization (localhost. == localhost); ALL trailing
    // dots stripped, so a double trailing dot doesn't slip either.
    ["trailing-dot localhost", "https://localhost./hook"],
    ["trailing-dot *.localhost", "https://api.localhost./hook"],
    ["double trailing-dot localhost", "https://localhost../hook"],
    ["localhost", "https://localhost/hook"],
    ["*.localhost", "https://api.localhost/hook"],
    ["*.internal", "https://vault.internal/hook"],
    ["*.local", "https://db.local/hook"],
    ["single-label host", "https://internalbox/hook"],
  ];

  it.each(REJECTED)("rejects %s", (_label, url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow();
  });

  const ALLOWED = [
    "https://example.com/hook",
    "https://hooks.acme.co/webhooks/coldrig",
    "https://api.example.com:443/path",
    "https://1.1.1.1/hook", // a public IP literal is legitimate
    "https://[2606:4700:4700::1111]/hook", // a public IPv6 literal is legitimate (no over-rejection)
    "https://api.example.com./hook", // a single-trailing-dot public FQDN is legitimate (not over-stripped into breakage)
  ];

  it.each(ALLOWED)("allows %s", (url) => {
    expect(() => assertSafeWebhookUrl(url)).not.toThrow();
  });
});

describe("realWebhookDeliverer — signing, redirects, timeout, snippet (fetch stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const target = { url: "https://hooks.example.com/coldrig", secret: "whsec_test_secret_1234567890" };
  const body = JSON.stringify({ id: "evt_1", type: "reply", data: { x: 1 } });

  it("POSTs with an X-Coldrig-Signature that is HMAC-SHA256(secret, raw body)", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        captured = init;
        return new Response("ok", { status: 200 });
      }),
    );

    const outcome = await realWebhookDeliverer(target, body, { "X-Coldrig-Event": "reply" });
    expect(outcome.ok).toBe(true);
    expect(outcome.statusCode).toBe(200);

    expect(captured?.method).toBe("POST");
    expect(captured?.redirect).toBe("manual");
    expect(captured?.body).toBe(body);
    const headers = captured?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["X-Coldrig-Event"]).toBe("reply");
    const expected = await hmacSha256Hex(target.secret, body);
    expect(headers["X-Coldrig-Signature"]).toBe(`sha256=${expected}`);
  });

  it("treats a 3xx as a refused redirect, never follows it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } })));
    const outcome = await realWebhookDeliverer(target, body, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(302);
    expect(outcome.error).toBe("redirect_not_followed");
  });

  it("grades a 5xx as a retryable failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    const outcome = await realWebhookDeliverer(target, body, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBe(503);
    expect(outcome.error).toBe("http_503");
  });

  it("tags a timeout/abort by its error name and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }));
    const outcome = await realWebhookDeliverer(target, body, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.statusCode).toBeNull();
    expect(outcome.error).toBe("TimeoutError");
  });

  it("stores at most a truncated response snippet", async () => {
    const big = "x".repeat(WEBHOOK_SNIPPET_MAX * 4);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big, { status: 200 })));
    const outcome = await realWebhookDeliverer(target, body, {});
    expect(outcome.ok).toBe(true);
    expect(outcome.snippet.length).toBeLessThanOrEqual(WEBHOOK_SNIPPET_MAX);
  });

  it("refuses to deliver to a URL that fails re-validation at delivery time (DNS-rebinding posture)", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const outcome = await realWebhookDeliverer({ url: "http://127.0.0.1/hook", secret: "s".repeat(16) }, body, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.startsWith("url_rejected")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
