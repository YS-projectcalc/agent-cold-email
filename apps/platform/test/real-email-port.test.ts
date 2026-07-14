import { afterEach, describe, expect, it, vi } from "vitest";
import { NotActivatedError, VendorError, type SendEmailInput } from "@coldstart/shared";
import { RealEmailPort } from "../src/vendors/real/email-port.js";

// Contract test for the Worker-side engine client. `fetch` is stubbed so no real
// network call is made; the assertions pin the request shape the engine
// (apps/engine) must receive and the transient-vs-permanent grading the engine
// tick relies on. The suite default (no engine config) proves the adapter stays
// dark exactly like every other real/ stub.

const CONFIG = { baseUrl: "https://engine.example.internal", authSecret: "shared-secret-xyz" };

const input: SendEmailInput = {
  fromEmail: "sender@coldstart.test",
  toEmail: "lead@example.com",
  subject: "hi",
  body: "hello",
  threadId: "thr_1",
  inReplyToMessageId: null,
  listUnsubscribe: "<mailto:unsub@coldstart.test>",
};

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

describe("RealEmailPort — dark until configured", () => {
  it("throws NotActivatedError on send with no engine config (deployed default)", async () => {
    await expect(new RealEmailPort().send(input, "k1")).rejects.toBeInstanceOf(NotActivatedError);
  });
  it("throws NotActivatedError on poll with no engine config", async () => {
    await expect(new RealEmailPort().poll("m@x.test", 0)).rejects.toBeInstanceOf(NotActivatedError);
  });
  it("throws NotActivatedError when only one of the two env vars is set (needs BOTH)", async () => {
    const partial = new RealEmailPort({ baseUrl: CONFIG.baseUrl, authSecret: "" });
    await expect(partial.send(input, "k1")).rejects.toBeInstanceOf(NotActivatedError);
  });
});

describe("RealEmailPort — configured HTTP client", () => {
  it("POSTs the send contract shape with bearer auth and returns the parsed result", async () => {
    const spy = stubFetch({ status: 200, body: { messageId: "<m1@coldstart.test>", sentAt: 123 } });
    const result = await new RealEmailPort(CONFIG).send(input, "send:t1:r1");

    expect(result).toEqual({ messageId: "<m1@coldstart.test>", sentAt: 123 });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://engine.example.internal/v1/send");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer shared-secret-xyz" });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ input, idempotencyKey: "send:t1:r1" });
  });

  it("POSTs the poll contract shape (mailboxEmail + sinceCursor) and returns { events, cursor }", async () => {
    const events = [{ kind: "reply", mailboxEmail: "m@x.test", threadId: "t", messageId: "<r@x>", fromEmail: "l@x", body: "hi", receivedAt: 1 }];
    const spy = stubFetch({ status: 200, body: { events, cursor: 42 } });
    const out = await new RealEmailPort(CONFIG).poll("m@x.test", 41);
    expect(out).toEqual({ events, cursor: 42 });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://engine.example.internal/v1/poll");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ mailboxEmail: "m@x.test", sinceCursor: 41 });
  });

  it("rejects a malformed poll response (missing cursor) as a permanent VendorError", async () => {
    stubFetch({ status: 200, body: { events: [] } });
    const err = await new RealEmailPort(CONFIG).poll("m@x.test", 0).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });

  it("refuses a non-https ENGINE_BASE_URL (permanent — secret must not cross cleartext)", async () => {
    const spy = stubFetch({ status: 200, body: { messageId: "<m@x>", sentAt: 1 } });
    const err = await new RealEmailPort({ baseUrl: "http://engine.public.example", authSecret: "s" }).send(input, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // never even reached fetch
  });

  it("allows http for a localhost/tunnel-terminated bootstrap", async () => {
    stubFetch({ status: 200, body: { messageId: "<m@localhost>", sentAt: 7 } });
    const out = await new RealEmailPort({ baseUrl: "http://localhost:8080", authSecret: "s" }).send(input, "k");
    expect(out).toEqual({ messageId: "<m@localhost>", sentAt: 7 });
  });

  it("grades a 5xx as a RETRYABLE VendorError (tick retries under its cap)", async () => {
    stubFetch({ status: 503, body: { error: "SMTP transient" } });
    const err = await new RealEmailPort(CONFIG).send(input, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("grades a 422 (unknown mailbox) as RETRYABLE — operator adds the mailbox to the creds file, then a retry succeeds", async () => {
    // Was graded PERMANENT (terminal 'failed', no requeue) — burning the whole
    // due queue on a fixable misconfig (engine-host-review-2026-07-14). Now
    // retryable so the tick re-attempts under its cap while the operator fixes it.
    stubFetch({ status: 422, body: { error: "no credentials for mailbox" } });
    const err = await new RealEmailPort(CONFIG).send(input, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("grades a 409 (send already in flight on the engine) as RETRYABLE (retry hits the cache — no 2nd send)", async () => {
    stubFetch({ status: 409, body: { error: "a send for idempotency key k is already in flight" } });
    const err = await new RealEmailPort(CONFIG).send(input, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("still grades an unlisted 4xx (400) as a PERMANENT VendorError (fail fast)", async () => {
    stubFetch({ status: 400, body: { error: "malformed request" } });
    const err = await new RealEmailPort(CONFIG).send(input, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });

  it("bounds the request with an AbortSignal timeout so a stalled engine can't hang the tick", async () => {
    const spy = stubFetch({ status: 200, body: { messageId: "<m@x>", sentAt: 1 } });
    await new RealEmailPort(CONFIG).send(input, "send:t1:r1");
    const [, init] = spy.mock.calls[0]!;
    // A missing signal is the pre-fix state (fetch could hang past the reclaim
    // TTL → a reclaim races a still-live send). The signal makes it abortable.
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("grades a network failure as a RETRYABLE VendorError", async () => {
    stubFetch(new Error("ECONNRESET"));
    const err = await new RealEmailPort(CONFIG).poll("m@x.test", 0).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(true);
  });

  it("rejects a malformed 200 body (missing messageId) as a permanent VendorError", async () => {
    stubFetch({ status: 200, body: { sentAt: 1 } });
    const err = await new RealEmailPort(CONFIG).send(input, "k").catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });
});
