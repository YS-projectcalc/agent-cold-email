import { describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError } from "../src/api/client";
import { onUnauthorized } from "../src/api/unauthorizedBus";

// Backend gaps brief item 4 / SPEC.md §19.1 — every 401 body now carries a
// machine-readable `code` (apps/platform/src/require-auth.ts's
// AuthFailureCode). The client must forward THAT code to the unauthorized
// bus, not a hardcoded generic reason — TokenGate's per-code copy is only as
// honest as this plumbing.
describe("apiRequest — 401 code plumbing", () => {
  it("emits the response body's own `code` on a 401", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "this account has been suspended", code: "account_suspended" }), { status: 401 })) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onUnauthorized((reason) => received.push(reason));
    try {
      await expect(apiRequest("/account")).rejects.toThrow(ApiError);
      expect(received).toEqual(["account_suspended"]);
    } finally {
      unsubscribe();
    }
  });

  it("falls back to invalid_token if the body is missing/malformed (never silently drops the redirect)", async () => {
    global.fetch = vi.fn(async () => new Response("not json", { status: 401 })) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onUnauthorized((reason) => received.push(reason));
    try {
      await expect(apiRequest("/account")).rejects.toThrow(ApiError);
      expect(received).toEqual(["invalid_token"]);
    } finally {
      unsubscribe();
    }
  });

  it("does not emit at all when suppressUnauthorizedRedirect is set (the token-gate's own login POST)", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "invalid or inactive token", code: "invalid_token" }), { status: 401 })) as unknown as typeof fetch;

    const received: string[] = [];
    const unsubscribe = onUnauthorized((reason) => received.push(reason));
    try {
      await expect(apiRequest("/account", { suppressUnauthorizedRedirect: true })).rejects.toThrow(ApiError);
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
