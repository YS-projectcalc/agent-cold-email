import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError } from "@coldstart/shared";
import { EngineMailboxClient, type EnginePushCredentials } from "../src/engine/engine-mailbox-client.js";

// Authed client for the engine's I3 POST/DELETE /v1/mailboxes boundary. Mirrors
// RealEmailPort's dark-until-configured + https-required + transient-vs-permanent
// grading. fetch stubbed — no live call.

const CONFIG = { baseUrl: "https://engine.example.internal", authSecret: "engine-secret" };
const CREDS: EnginePushCredentials = {
  imap: { host: "imap.gmail.com", port: 993, secure: true, user: "a@b.com", pass: "p" },
  send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "r", user: "a@b.com" },
  messageIdDomain: "b.com",
};

function stubFetch(res: { status: number; body: unknown } | Error) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (res instanceof Error) throw res;
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => vi.restoreAllMocks());

describe("EngineMailboxClient — dark until configured", () => {
  it("throws NotActivatedError with no config (deployed default)", async () => {
    await expect(new EngineMailboxClient().pushMailbox("a@b.com", CREDS, "k")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(new EngineMailboxClient().removeMailbox("a@b.com", "k")).rejects.toBeInstanceOf(NotActivatedError);
    expect(new EngineMailboxClient().isConfigured).toBe(false);
    expect(new EngineMailboxClient(CONFIG).isConfigured).toBe(true);
  });

  it("refuses a cleartext (non-https, non-localhost) ENGINE_BASE_URL — the bearer secret must not cross plaintext", async () => {
    const client = new EngineMailboxClient({ baseUrl: "http://engine.example.internal", authSecret: "s" });
    const err = await client.pushMailbox("a@b.com", CREDS, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });
});

describe("EngineMailboxClient — configured", () => {
  it("POSTs /v1/mailboxes with the bearer secret and returns the upsert outcome", async () => {
    const spy = stubFetch({ status: 200, body: { email: "a@b.com", outcome: "created", contentHash: "abc" } });
    const result = await new EngineMailboxClient(CONFIG).pushMailbox("a@b.com", CREDS, "k1");

    expect(result).toEqual({ email: "a@b.com", outcome: "created", contentHash: "abc" });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://engine.example.internal/v1/mailboxes");
    expect((init as RequestInit).method).toBe("POST");
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe("Bearer engine-secret");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: "a@b.com", credentials: CREDS, idempotencyKey: "k1" });
  });

  it("DELETEs /v1/mailboxes and reports removed", async () => {
    const spy = stubFetch({ status: 200, body: { email: "a@b.com", removed: true } });
    const result = await new EngineMailboxClient(CONFIG).removeMailbox("a@b.com", "k1");
    expect(result).toEqual({ email: "a@b.com", removed: true });
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("grades a network failure as RETRYABLE (the reconcile loop retries)", async () => {
    stubFetch(new Error("ECONNRESET"));
    const err = await new EngineMailboxClient(CONFIG).pushMailbox("a@b.com", CREDS, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("grades a 5xx as retryable and a 4xx as permanent", async () => {
    stubFetch({ status: 503, body: { error: "down" } });
    const t = await new EngineMailboxClient(CONFIG).pushMailbox("a@b.com", CREDS, "k").catch((e) => e);
    expect((t as VendorError).retryable).toBe(true);

    stubFetch({ status: 400, body: { error: "bad creds" } });
    const p = await new EngineMailboxClient(CONFIG).pushMailbox("a@b.com", CREDS, "k").catch((e) => e);
    expect((p as VendorError).retryable).toBe(false);
  });
});
