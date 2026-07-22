import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialsMap } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import type { ImapFetcher } from "../src/imap.js";
import { MailboxCredentialStore } from "../src/mailbox-store.js";
import { route, type EngineRequest } from "../src/router.js";
import type { SmtpSender } from "../src/smtp.js";
import { EngineStore } from "../src/store.js";

// I3 credential-push boundary + resolve-union, over the full wire (router ->
// engine -> MailboxCredentialStore). Mirrors router.test.ts's fakes.

const SECRET = "engine-boundary-shared-secret";
const auth = `Bearer ${SECRET}`;
const STATIC_SENDER = "static@coldstart.test";
const PUSHED_SENDER = "pushed@coldstart.test";

const staticCreds: CredentialsMap = {
  [STATIC_SENDER]: {
    smtp: { host: "static-smtp", port: 465, secure: true, user: STATIC_SENDER, pass: "p" },
    imap: { host: "static-imap", port: 993, secure: true, user: STATIC_SENDER, pass: "p" },
  },
};

// A pushed SMTP mailbox resolves through the noop smtp sender (no live vendor).
const pushedSmtpCreds = {
  smtp: { host: "pushed-smtp", port: 465, secure: true, user: PUSHED_SENDER, pass: "p" },
  imap: { host: "pushed-imap", port: 993, secure: true, user: PUSHED_SENDER, pass: "p" },
};

const noopSmtp: SmtpSender = { async send() {} };
const emptyImap: ImapFetcher = {
  async currentUidNext() {
    return 1;
  },
  async fetchRange() {
    return [];
  },
};

let dir: string;
let engine: EmailEngine;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-router-mbx-"));
  engine = new EmailEngine({
    credentials: staticCreds,
    store: new EngineStore(dir),
    credentialStore: new MailboxCredentialStore(dir),
    smtp: noopSmtp,
    imap: emptyImap,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function req(over: Partial<EngineRequest>): EngineRequest {
  return { method: "GET", path: "/health", authHeader: undefined, rawBody: "", ...over };
}

function writeMailbox(email: string, credentials: unknown, idempotencyKey?: string): EngineRequest {
  return req({
    method: "POST",
    path: "/v1/mailboxes",
    authHeader: auth,
    rawBody: JSON.stringify({ email, credentials, idempotencyKey }),
  });
}

function sendReq(from: string): EngineRequest {
  return req({
    method: "POST",
    path: "/v1/send",
    authHeader: auth,
    rawBody: JSON.stringify({
      input: { fromEmail: from, toEmail: "lead@example.com", subject: "s", body: "b", threadId: "thr_1", inReplyToMessageId: null },
      idempotencyKey: `send:${from}`,
    }),
  });
}

describe("POST/DELETE /v1/mailboxes", () => {
  it("401s an unauthenticated push", async () => {
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/mailboxes", rawBody: JSON.stringify({ email: PUSHED_SENDER, credentials: pushedSmtpCreds }) }));
    expect(res.status).toBe(401);
  });

  it("200s an authed push and returns the created outcome", async () => {
    const res = await route(engine, SECRET, writeMailbox(PUSHED_SENDER, pushedSmtpCreds));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: PUSHED_SENDER, outcome: "created" });
  });

  it("400s an invalid credential push (schema)", async () => {
    const res = await route(engine, SECRET, writeMailbox(PUSHED_SENDER, { imap: pushedSmtpCreds.imap, send: { kind: "smtp" } }));
    expect(res.status).toBe(400);
  });

  it("a replayed push under the same key returns replayed (idempotent)", async () => {
    await route(engine, SECRET, writeMailbox(PUSHED_SENDER, pushedSmtpCreds, "k-1"));
    const res = await route(engine, SECRET, writeMailbox(PUSHED_SENDER, pushedSmtpCreds, "k-1"));
    expect(res.body).toMatchObject({ outcome: "replayed" });
  });

  it("DELETE revokes a pushed mailbox (idempotent second delete)", async () => {
    await route(engine, SECRET, writeMailbox(PUSHED_SENDER, pushedSmtpCreds));
    const del = () => route(engine, SECRET, req({ method: "DELETE", path: "/v1/mailboxes", authHeader: auth, rawBody: JSON.stringify({ email: PUSHED_SENDER }) }));
    expect((await del()).body).toMatchObject({ removed: true });
    expect((await del()).body).toMatchObject({ removed: false });
  });
});

describe("resolve-union (static config precedence)", () => {
  it("a send from an UNKNOWN mailbox is 422 until it is pushed, then 200 (pushed creds resolve)", async () => {
    expect((await route(engine, SECRET, sendReq(PUSHED_SENDER))).status).toBe(422);
    await route(engine, SECRET, writeMailbox(PUSHED_SENDER, pushedSmtpCreds));
    expect((await route(engine, SECRET, sendReq(PUSHED_SENDER))).status).toBe(200);
  });

  it("a DELETE'd pushed mailbox stops resolving (send returns to 422)", async () => {
    await route(engine, SECRET, writeMailbox(PUSHED_SENDER, pushedSmtpCreds));
    await route(engine, SECRET, req({ method: "DELETE", path: "/v1/mailboxes", authHeader: auth, rawBody: JSON.stringify({ email: PUSHED_SENDER }) }));
    expect((await route(engine, SECRET, sendReq(PUSHED_SENDER))).status).toBe(422);
  });

  it("STATIC config WINS: pushing gmail_api creds over a static SMTP mailbox does NOT override it (send still uses the static smtp path, 200)", async () => {
    // If the pushed gmail_api creds won, the send would route to the (un-wired)
    // gmail transport and fail internally; a 200 with the static messageIdDomain
    // proves the static smtp entry took precedence.
    const gmail = {
      imap: { host: "imap.gmail.com", port: 993, secure: true, user: STATIC_SENDER, pass: "x" },
      send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "r" },
    };
    const push = await route(engine, SECRET, writeMailbox(STATIC_SENDER, gmail));
    expect(push.status).toBe(200); // the push itself is accepted+stored
    const send = await route(engine, SECRET, sendReq(STATIC_SENDER));
    expect(send.status).toBe(200);
    expect(send.body).toMatchObject({ messageId: expect.stringMatching(/@coldstart\.test>$/) });
  });
});
