import type { SendEmailInput } from "@coldstart/shared";
import { describe, expect, it, vi } from "vitest";
import type { GmailTransport } from "../src/config.js";
import { UpstreamTransientError } from "../src/errors.js";
import { createGmailSender } from "../src/gmail.js";

// Gmail HTTPS/443 send. The HTTP layer is mocked (no live net): assert transport
// behavior — a base64url raw message that carries the compliance headers, token
// caching, refresh-on-401, backoff-on-429, and error mapping to the same
// UpstreamTransientError shape the SMTP path produces.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const transport: GmailTransport = { kind: "gmail_api", clientId: "cid", clientSecret: "sec", refreshToken: "rt" };

function input(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    fromEmail: "sender@coldstart.test",
    toEmail: "lead@example.com",
    subject: "hi",
    body: "hello",
    threadId: "thr_1",
    inReplyToMessageId: null,
    listUnsubscribe: "<https://coldstart.test/u/abc>",
    listUnsubscribePost: "List-Unsubscribe=One-Click",
    ...overrides,
  };
}

/** A mock fetch routing token vs send URLs; `sendResponses` is drained per send POST. */
function mockFetch(sendResponses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === TOKEN_URL) {
      return new Response(JSON.stringify({ access_token: `tok${tokenN++}`, expires_in: 3600 }), { status: 200 });
    }
    const next = sendResponses.shift();
    if (!next) throw new Error(`unexpected send call to ${u}`);
    return next;
  });
  let tokenN = 1;
  return { fn: fn as unknown as typeof fetch, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe("createGmailSender", () => {
  it("POSTs the raw base64url RFC822 with a Bearer token, carrying the List-Unsubscribe headers", async () => {
    const { fn, calls } = mockFetch([new Response("{}", { status: 200 })]);
    const sender = createGmailSender(fn, noSleep);

    await sender.send(transport, input(), "<m1@coldstart.test>");

    const tokenCalls = calls.filter((c) => c.url === TOKEN_URL);
    const sendCalls = calls.filter((c) => c.url === SEND_URL);
    expect(tokenCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);

    const init = sendCalls[0]!.init!;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok1");
    expect(headers["content-type"]).toBe("application/json");

    const { raw } = JSON.parse(init.body as string) as { raw: string };
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("List-Unsubscribe: <https://coldstart.test/u/abc>");
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(mime).toContain("Message-ID: <m1@coldstart.test>");
  });

  it("caches the access token across sends (one token mint for two messages)", async () => {
    const { fn, calls } = mockFetch([new Response("{}", { status: 200 }), new Response("{}", { status: 200 })]);
    const sender = createGmailSender(fn, noSleep);

    await sender.send(transport, input(), "<m1@coldstart.test>");
    await sender.send(transport, input(), "<m2@coldstart.test>");

    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
    expect(calls.filter((c) => c.url === SEND_URL)).toHaveLength(2);
  });

  it("refreshes the token once on a 401 then retries the send", async () => {
    const { fn, calls } = mockFetch([new Response("expired", { status: 401 }), new Response("{}", { status: 200 })]);
    const sender = createGmailSender(fn, noSleep);

    await sender.send(transport, input(), "<m1@coldstart.test>");

    // Initial mint + one forced refresh after the 401.
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
    expect(calls.filter((c) => c.url === SEND_URL)).toHaveLength(2);
  });

  it("backs off and retries on a 429 then succeeds", async () => {
    const { fn } = mockFetch([
      new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      new Response("{}", { status: 200 }),
    ]);
    const sleep = vi.fn(async () => undefined);
    const sender = createGmailSender(fn, sleep);

    await sender.send(transport, input(), "<m1@coldstart.test>");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("maps a persistent 5xx to UpstreamTransientError (the SMTP-path shape)", async () => {
    const { fn } = mockFetch([
      new Response("err", { status: 500 }),
      new Response("err", { status: 500 }),
      new Response("err", { status: 500 }),
    ]);
    const sender = createGmailSender(fn, noSleep);

    await expect(sender.send(transport, input(), "<m1@coldstart.test>")).rejects.toBeInstanceOf(UpstreamTransientError);
  });

  it("maps a 400 to UpstreamTransientError without wasting backoff retries", async () => {
    const { fn, calls } = mockFetch([new Response("bad request", { status: 400 })]);
    const sender = createGmailSender(fn, noSleep);

    await expect(sender.send(transport, input(), "<m1@coldstart.test>")).rejects.toBeInstanceOf(UpstreamTransientError);
    expect(calls.filter((c) => c.url === SEND_URL)).toHaveLength(1);
  });
});
