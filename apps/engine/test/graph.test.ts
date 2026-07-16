import type { SendEmailInput } from "@coldstart/shared";
import { describe, expect, it, vi } from "vitest";
import type { GraphTransport } from "../src/config.js";
import { UpstreamTransientError } from "../src/errors.js";
import { createGraphSender } from "../src/graph.js";

// MS Graph HTTPS/443 send. HTTP mocked (no live net). Assert: the raw MIME is
// sent base64 as a text/plain body (so headers survive) to the correct endpoint
// for the auth mode, with the right token grant, 202 = success, and errors map
// to the SMTP-path UpstreamTransientError shape.

const TENANT = "tenant-guid";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const ME_SEND = "https://graph.microsoft.com/v1.0/me/sendMail";
const USER_SEND = "https://graph.microsoft.com/v1.0/users/box%40x.test/sendMail";

const delegated: GraphTransport = {
  kind: "ms_graph",
  mode: "delegated",
  tenantId: TENANT,
  clientId: "cid",
  clientSecret: "sec",
  refreshToken: "rt",
};
const appOnly: GraphTransport = {
  kind: "ms_graph",
  mode: "app_only",
  tenantId: TENANT,
  clientId: "cid",
  clientSecret: "sec",
  user: "box@x.test",
};

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

function mockFetch(sendResponses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let tokenN = 1;
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
  return { fn: fn as unknown as typeof fetch, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe("createGraphSender", () => {
  it("delegated: POSTs base64 MIME as text/plain to /me/sendMail via a refresh-token grant", async () => {
    const { fn, calls } = mockFetch([new Response("", { status: 202 })]);
    const sender = createGraphSender(fn, noSleep);

    await sender.send(delegated, input(), "<m1@coldstart.test>");

    const tokenInit = calls.find((c) => c.url === TOKEN_URL)!.init!;
    const form = new URLSearchParams(tokenInit.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("rt");
    expect(form.get("scope")).toContain("Mail.Send");

    const sendCall = calls.find((c) => c.url === ME_SEND)!;
    const headers = sendCall.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok1");
    expect(headers["content-type"]).toBe("text/plain");
    const mime = Buffer.from(sendCall.init!.body as string, "base64").toString("utf8");
    expect(mime).toContain("List-Unsubscribe: <https://coldstart.test/u/abc>");
    expect(mime).toContain("Message-ID: <m1@coldstart.test>");
  });

  it("app_only: POSTs to /users/{user}/sendMail via a client-credentials grant", async () => {
    const { fn, calls } = mockFetch([new Response("", { status: 202 })]);
    const sender = createGraphSender(fn, noSleep);

    await sender.send(appOnly, input(), "<m1@coldstart.test>");

    const form = new URLSearchParams(calls.find((c) => c.url === TOKEN_URL)!.init!.body as string);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(calls.some((c) => c.url === USER_SEND)).toBe(true);
  });

  it("refreshes once on a 401 then retries", async () => {
    const { fn, calls } = mockFetch([new Response("expired", { status: 401 }), new Response("", { status: 202 })]);
    const sender = createGraphSender(fn, noSleep);

    await sender.send(delegated, input(), "<m1@coldstart.test>");
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
    expect(calls.filter((c) => c.url === ME_SEND)).toHaveLength(2);
  });

  it("maps a permission failure (403) to UpstreamTransientError", async () => {
    const { fn } = mockFetch([new Response("forbidden", { status: 403 })]);
    const sender = createGraphSender(fn, noSleep);

    await expect(sender.send(delegated, input(), "<m1@coldstart.test>")).rejects.toBeInstanceOf(UpstreamTransientError);
  });
});
