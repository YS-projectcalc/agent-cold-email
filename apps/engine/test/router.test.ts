import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialsMap } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import type { ImapFetcher } from "../src/imap.js";
import { route, type EngineRequest } from "../src/router.js";
import type { SmtpSender } from "../src/smtp.js";
import { EngineStore } from "../src/store.js";

const SECRET = "engine-boundary-shared-secret";
const SENDER = "sender@coldstart.test";
const creds: CredentialsMap = {
  [SENDER]: {
    smtp: { host: "smtp", port: 465, secure: true, user: SENDER, pass: "p" },
    imap: { host: "imap", port: 993, secure: true, user: SENDER, pass: "p" },
  },
};

const noopSmtp: SmtpSender = { async send() {} };
const emptyImap: ImapFetcher = {
  async currentUidNext() {
    return 1; // an empty mailbox: no messages exist yet
  },
  async fetchRange() {
    return [];
  },
};

function req(over: Partial<EngineRequest>): EngineRequest {
  return { method: "GET", path: "/health", authHeader: undefined, rawBody: "", ...over };
}

let dir: string;
let store: EngineStore;
let engine: EmailEngine;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-router-"));
  store = new EngineStore(dir);
  engine = new EmailEngine({ credentials: creds, store, smtp: noopSmtp, imap: emptyImap });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const auth = `Bearer ${SECRET}`;
const sendBody = (from = SENDER) =>
  JSON.stringify({
    input: {
      fromEmail: from,
      toEmail: "lead@example.com",
      subject: "s",
      body: "b",
      threadId: "thr_1",
      inReplyToMessageId: null,
    },
    idempotencyKey: "k1",
  });

describe("route", () => {
  it("serves /health with no auth, carrying the parked-intent count for the prober", async () => {
    const res = await route(engine, SECRET, req({ method: "GET", path: "/health" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", parked: 0 });
  });

  it("401s an unauthenticated /v1/send", async () => {
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/send", rawBody: sendBody() }));
    expect(res.status).toBe(401);
  });

  it("200s an authed send and returns a SendEmailResult", async () => {
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/send", authHeader: auth, rawBody: sendBody() }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ messageId: expect.stringMatching(/@coldstart\.test>$/), sentAt: expect.any(Number) });
  });

  it("400s a malformed body", async () => {
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/send", authHeader: auth, rawBody: "{not json" }));
    expect(res.status).toBe(400);
  });

  it("400s a body that fails schema validation (missing idempotencyKey)", async () => {
    const bad = JSON.stringify({ input: { fromEmail: SENDER } });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/send", authHeader: auth, rawBody: bad }));
    expect(res.status).toBe(400);
  });

  it("422s a send from an unconfigured mailbox (permanent — Worker fails fast)", async () => {
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/send", authHeader: auth, rawBody: sendBody("nobody@x.test") }));
    expect(res.status).toBe(422);
  });

  it("200s an authed poll (ordinary incremental, sinceCursor=0) and returns { events, cursor }", async () => {
    const body = JSON.stringify({ mailboxEmail: SENDER, sinceCursor: 0 });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/poll", authHeader: auth, rawBody: body }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], cursor: 0 });
  });

  it("200s an authed poll with sinceCursor=-1 (first-contact sentinel) through the full wire boundary", async () => {
    const body = JSON.stringify({ mailboxEmail: SENDER, sinceCursor: -1 });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/poll", authHeader: auth, rawBody: body }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], cursor: 0 }); // emptyImap: uidNext=1 -> high-water 0
  });

  it("400s a poll missing sinceCursor (schema validation)", async () => {
    const body = JSON.stringify({ mailboxEmail: SENDER });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/poll", authHeader: auth, rawBody: body }));
    expect(res.status).toBe(400);
  });

  it("400s a poll with sinceCursor below the -1 floor (schema validation)", async () => {
    const body = JSON.stringify({ mailboxEmail: SENDER, sinceCursor: -2 });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/poll", authHeader: auth, rawBody: body }));
    expect(res.status).toBe(400);
  });

  it("404s an unknown route", async () => {
    const res = await route(engine, SECRET, req({ method: "GET", path: "/nope" }));
    expect(res.status).toBe(404);
  });

  it("401s an unauthenticated GET /v1/intents", async () => {
    const res = await route(engine, SECRET, req({ method: "GET", path: "/v1/intents" }));
    expect(res.status).toBe(401);
  });

  it("200s an authed GET /v1/intents and returns the parked list", async () => {
    store.appendIntent("pk", { transport: "smtp", from: SENDER, to: "x@y.test", mintedId: "<m@x>", threadId: "thr" });
    store.park("pk", "smtp has no server-side sent record — parked");
    const res = await route(engine, SECRET, req({ method: "GET", path: "/v1/intents", authHeader: auth }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parked: [expect.objectContaining({ key: "pk", reason: expect.stringMatching(/parked/), to: "x@y.test" })] });
  });

  it("404s POST /v1/intents/resolve for a key that is neither parked nor dangling", async () => {
    const body = JSON.stringify({ key: "nope", outcome: "resendable" });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/intents/resolve", authHeader: auth, rawBody: body }));
    expect(res.status).toBe(404);
  });

  it("resolves a parked key as 'sent' (200) and removes it from the parked list", async () => {
    store.appendIntent("pk", { transport: "smtp", from: SENDER, to: "x@y.test", mintedId: "<m@x>", threadId: "thr" });
    store.park("pk", "parked");
    const body = JSON.stringify({ key: "pk", outcome: "sent", by: "ops-runbook" });
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/intents/resolve", authHeader: auth, rawBody: body }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: "pk", outcome: "sent", resolved: true });
    // No longer parked; a send for that key now hits the cache (recorded as sent).
    const list = await route(engine, SECRET, req({ method: "GET", path: "/v1/intents", authHeader: auth }));
    expect(list.body).toEqual({ parked: [] });
    expect(store.getSend("pk")).toMatchObject({ messageId: "<m@x>" });
  });

  it("refuses a new send with 503 while draining (accepting:false), so the Worker retries the restarted engine", async () => {
    const res = await route(engine, SECRET, req({ method: "POST", path: "/v1/send", authHeader: auth, rawBody: sendBody() }), { accepting: false });
    expect(res.status).toBe(503);
  });

  it("still serves /health while draining (only sends are refused)", async () => {
    const res = await route(engine, SECRET, req({ method: "GET", path: "/health" }), { accepting: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", parked: 0 });
  });
});
