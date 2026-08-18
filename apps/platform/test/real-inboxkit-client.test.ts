import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { InboxKitClient } from "../src/vendors/real/inboxkit-client.js";
import { inboxKitAppError, mapInboxKitError } from "../src/vendors/real/inboxkit-errors.js";
import { IK_API_KEY, IK_APP_ERROR_UNAUTHORIZED, IK_GATEWAY_ERROR_401, IK_GATEWAY_ERROR_404, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// Unit contract for the shared InboxKit HTTP client: auth-header
// construction (Bearer + X-Workspace-Id, raw JWT — no double "Bearer"
// confusion) and the dark-until-configured guard every real/ adapter shares.
// `fetch` is stubbed so no real network call is made.

function stubFetch(res: { status: number; body: unknown } | Error) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (res instanceof Error) throw res;
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("InboxKitClient — dark until configured", () => {
  it("throws NotActivatedError with no config at all", async () => {
    await expect(new InboxKitClient().request("op", "GET", "/domains/available")).rejects.toBeInstanceOf(NotActivatedError);
  });

  it("throws NotActivatedError when apiKey is present but workspaceId is missing", async () => {
    const client = new InboxKitClient({ apiKey: IK_API_KEY, workspaceId: "" });
    await expect(client.request("op", "GET", "/domains/available")).rejects.toBeInstanceOf(NotActivatedError);
  });

  it("throws NotActivatedError when workspaceId is present but apiKey is missing", async () => {
    const client = new InboxKitClient({ apiKey: "", workspaceId: IK_WORKSPACE_ID });
    await expect(client.request("op", "GET", "/domains/available")).rejects.toBeInstanceOf(NotActivatedError);
  });

  it("isConfigured reflects whether both credentials are present", () => {
    expect(new InboxKitClient().isConfigured).toBe(false);
    expect(new InboxKitClient({ apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID }).isConfigured).toBe(true);
  });
});

describe("InboxKitClient — configured HTTP client", () => {
  const CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };

  it("sends a raw-JWT Bearer Authorization header (no double 'Bearer' prefixing) and X-Workspace-Id", async () => {
    const spy = stubFetch({ status: 200, body: { error: false } });
    await new InboxKitClient(CONFIG).request("op", "GET", "/account");

    const [, init] = spy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${IK_API_KEY}`);
    expect(headers.authorization?.startsWith("Bearer Bearer")).toBe(false);
    expect(headers["x-workspace-id"]).toBe(IK_WORKSPACE_ID);
  });

  it("builds the request URL from baseUrl + path + query params", async () => {
    const spy = stubFetch({ status: 200, body: { error: false, available: true } });
    await new InboxKitClient(CONFIG).request("op", "GET", "/domains/available", { query: { domain: "example.com" } });
    const [url] = spy.mock.calls[0]!;
    expect(url).toBe("https://ik.example.internal/v1/api/domains/available?domain=example.com");
  });

  it("sends a JSON body on POST requests", async () => {
    const spy = stubFetch({ status: 200, body: { error: false } });
    await new InboxKitClient(CONFIG).request("op", "POST", "/mailboxes/list", { body: { keyword: "a@b.com", limit: 1 } });
    const [, init] = spy.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ keyword: "a@b.com", limit: 1 });
  });

  it("bounds the request with an AbortSignal timeout", async () => {
    const spy = stubFetch({ status: 200, body: { error: false } });
    await new InboxKitClient(CONFIG).request("op", "GET", "/account");
    const [, init] = spy.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("grades a network failure as a RETRYABLE VendorError", async () => {
    stubFetch(new Error("ECONNRESET"));
    const err = await new InboxKitClient(CONFIG).request("op", "GET", "/account").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("returns the parsed JSON body on a 200", async () => {
    stubFetch({ status: 200, body: { error: false, available: true } });
    const body = await new InboxKitClient(CONFIG).request<{ available: boolean }>("op", "GET", "/domains/available");
    expect(body).toEqual({ error: false, available: true });
  });

  it("maps a non-2xx response through mapInboxKitError (gateway {code,message} shape)", async () => {
    stubFetch({ status: 401, body: IK_GATEWAY_ERROR_401 });
    const err = await new InboxKitClient(CONFIG).request("op", "GET", "/account").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect((err as VendorError).message).toContain("jwt malformed");
  });
});

describe("mapInboxKitError — the two live-verified InboxKit error envelopes", () => {
  it("extracts message from the gateway/auth-layer {code,message} 404 shape", () => {
    const err = mapInboxKitError(404, IK_GATEWAY_ERROR_404, "GET /this-route-does-not-exist");
    expect(err).toBeInstanceOf(VendorError);
    expect(err.message).toContain("Not found");
    expect(err.retryable).toBe(false);
    // A route the vendor does not serve is OURS to fix (the state
    // showMailboxCredentials is in), never the caller's inputs.
    expect(err.operatorActionable).toBe(true);
  });

  it("extracts message from the gateway/auth-layer {code,message} 401 shape", () => {
    const err = mapInboxKitError(401, IK_GATEWAY_ERROR_401, "GET /account");
    expect(err.message).toContain("jwt malformed");
    expect(err.retryable).toBe(false);
    expect(err.operatorActionable).toBe(true);
  });

  it("extracts message from the app-level {error:true,message} envelope", () => {
    const err = mapInboxKitError(401, IK_APP_ERROR_UNAUTHORIZED, "POST /mailboxes/buy");
    expect(err.message).toContain("Unauthorized");
    expect(err.retryable).toBe(false);
    expect(err.operatorActionable).toBe(true);
  });

  it("grades 5xx as retryable regardless of envelope shape", () => {
    expect(mapInboxKitError(500, { error: true, message: "Internal server error" }, "ctx").retryable).toBe(true);
    expect(mapInboxKitError(503, { code: 503, message: "unavailable" }, "ctx").retryable).toBe(true);
  });

  it("grades 429 (InboxKit's documented bulk-provisioning rate limit) as retryable", () => {
    expect(mapInboxKitError(429, { code: 429, message: "rate limited" }, "ctx").retryable).toBe(true);
  });

  // REWRITTEN (class A). It asserted `retryable === false` and called that
  // "permanent", which is the conflation the class is named after: the grade is
  // now a STATUS-and-REASON pair, and "this caller cannot retry it" says nothing
  // about whether anyone can clear it. An ordinary 400 is genuinely the
  // caller's — nobody else can fix it — so both halves are asserted here.
  it("grades an unlisted 4xx as permanent AND nobody-else's-to-fix", () => {
    const err = mapInboxKitError(400, { error: true, message: "bad request" }, "ctx");
    expect(err.retryable).toBe(false);
    expect(err.operatorActionable).toBe(false);
  });

  it("grades 402 Payment Required — and any funding-worded refusal — as operator-actionable", () => {
    const paymentRequired = mapInboxKitError(402, { error: true, message: "Insufficient wallet balance to purchase mailboxes" }, "POST /mailboxes/buy");
    expect(paymentRequired.retryable).toBe(false);
    expect(paymentRequired.operatorActionable).toBe(true);

    // 403 — a suspended/delinquent workspace. Account-wide, so grading it
    // "check your inputs" mis-addresses EVERY tenant at once.
    expect(mapInboxKitError(403, { code: 403, message: "Forbidden" }, "ctx").operatorActionable).toBe(true);

    // The wire shape of a funds refusal is UNVERIFIED (canon Part 6 #1), so the
    // body path has to work on a status the status path does not catch.
    const wordedOnly = mapInboxKitError(409, { error: true, message: "Not enough credits to add warmup" }, "POST /warmup/add");
    expect(wordedOnly.operatorActionable).toBe(true);
  });

  it("a RETRYABLE failure is never also operator-actionable — a transient failure needs nobody", () => {
    expect(mapInboxKitError(500, { error: true, message: "Insufficient balance" }, "ctx").operatorActionable).toBe(false);
    expect(mapInboxKitError(429, { code: 429, message: "rate limited" }, "ctx").operatorActionable).toBe(false);
  });

  it("grades the 200-{error:true} envelope the HTTP layer never sees — same three-valued answer", () => {
    // THE INCIDENT SHAPE if the vendor answers a funds refusal with a 200:
    // `mapInboxKitError` is never reached, so the app-envelope constructor has
    // to grade it or the whole fix has a hole the size of the incident.
    const funding = inboxKitAppError("inboxkit warmup/add did not create a subscription for a@b.com: Insufficient wallet balance", {
      error: true,
      message: "Insufficient wallet balance",
    });
    expect(funding.retryable).toBe(false);
    expect(funding.operatorActionable).toBe(true);

    const ordinary = inboxKitAppError("inboxkit mailboxes/buy did not return a mailbox for a@b.com: local part rejected", {
      error: true,
      message: "local part rejected",
    });
    expect(ordinary.operatorActionable).toBe(false);
  });

  it("falls back to a generic message when the body has neither shape", () => {
    const err = mapInboxKitError(500, { unexpected: "shape" }, "ctx");
    expect(err.message).toContain("HTTP 500");
  });

  it("falls back to a generic message when the body is not parseable JSON at all", () => {
    const err = mapInboxKitError(500, undefined, "ctx");
    expect(err.message).toContain("HTTP 500");
  });
});
