import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendEmailInput } from "@coldstart/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialsMap } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import { SendInProgressError, UnknownMailboxError } from "../src/errors.js";
import type { GmailSender } from "../src/gmail.js";
import type { GraphSender } from "../src/graph.js";
import type { ImapFetcher, RawMessage } from "../src/imap.js";
import type { SmtpSender } from "../src/smtp.js";
import { EngineStore } from "../src/store.js";

const SENDER = "sender@coldstart.test";
const creds: CredentialsMap = {
  [SENDER]: {
    smtp: { host: "smtp", port: 465, secure: true, user: SENDER, pass: "p" },
    imap: { host: "imap", port: 993, secure: true, user: SENDER, pass: "p" },
  },
};

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    fromEmail: SENDER,
    toEmail: "lead@example.com",
    subject: "hi",
    body: "hello",
    threadId: "thr_1",
    inReplyToMessageId: null,
    ...overrides,
  };
}

class FakeSmtp implements SmtpSender {
  calls: { messageId: string; input: SendEmailInput }[] = [];
  async send(_creds: unknown, input: SendEmailInput, messageId: string): Promise<void> {
    this.calls.push({ messageId, input });
  }
}

// A send that STALLS (socket hung) until released — models the double-send
// window: the row's send is still on the wire when a retry for the same key
// arrives (the consumer's stuck-'sending' TTL reclaim re-sending it).
class StallableSmtp implements SmtpSender {
  calls: { messageId: string; input: SendEmailInput }[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  async send(_creds: unknown, input: SendEmailInput, messageId: string): Promise<void> {
    this.calls.push({ messageId, input });
    await this.gate;
  }
  releaseAll(): void {
    this.release();
  }
}

class FakeImap implements ImapFetcher {
  constructor(private readonly byMailbox: Record<string, RawMessage[]>) {}
  fetched: { sinceUid: number }[] = [];
  async fetchSince(credsArg: { user: string }, sinceUid: number): Promise<RawMessage[]> {
    this.fetched.push({ sinceUid });
    return (this.byMailbox[credsArg.user] ?? []).filter((m) => m.uid > sinceUid);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-core-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("EmailEngine.send", () => {
  it("mints a real RFC 5322 Message-ID and records the thread mapping", async () => {
    const smtp = new FakeSmtp();
    const store = new EngineStore(dir);
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap({}), now: () => 42 });

    const result = await engine.send(baseInput(), "send:t1:r1");
    expect(result.sentAt).toBe(42);
    expect(result.messageId).toMatch(/^<[0-9a-f-]+@coldstart\.test>$/);
    expect(smtp.calls).toHaveLength(1);
    expect(store.resolveThread(result.messageId)).toBe("thr_1");
  });

  it("is idempotent on the key — a replay returns the same id WITHOUT a second SMTP send", async () => {
    const smtp = new FakeSmtp();
    const engine = new EmailEngine({ credentials: creds, store: new EngineStore(dir), smtp, imap: new FakeImap({}) });

    const first = await engine.send(baseInput(), "send:t1:r1");
    const second = await engine.send(baseInput(), "send:t1:r1");
    expect(second).toEqual(first);
    expect(smtp.calls).toHaveLength(1); // NOT re-sent
  });

  it("does not open a second SMTP transaction when a send races an in-flight send with the same key", async () => {
    // The blocking defect (engine-host-review-2026-07-14): send() was bare
    // check-then-act with no in-flight claim, so a stuck-'sending' TTL reclaim
    // re-sending a row whose first send merely STALLED (not failed) opened a
    // second SMTP transaction → the lead was mailed twice.
    const smtp = new StallableSmtp();
    const engine = new EmailEngine({
      credentials: creds,
      store: new EngineStore(dir),
      smtp,
      imap: new FakeImap({}),
      now: () => 7,
    });

    // First send claims the key and stalls inside smtp.send.
    const first = engine.send(baseInput(), "send:t1:r1");
    // A concurrent retry with the SAME key arrives while the first is still on
    // the wire. It must be rejected as in-flight, NOT start a second send.
    const second = engine.send(baseInput(), "send:t1:r1").catch((e) => e);

    smtp.releaseAll(); // let the stalled first send complete
    const firstResult = await first;
    const secondResult = await second;

    // Old code: 2 (the retry opened a second SMTP transaction). Fixed: 1.
    expect(smtp.calls).toHaveLength(1);
    // Old code: a duplicate SendEmailResult. Fixed: a retryable SendInProgressError.
    expect(secondResult).toBeInstanceOf(SendInProgressError);

    // And a retry AFTER completion hits the cache — same id, still one send.
    const retry = await engine.send(baseInput(), "send:t1:r1");
    expect(retry).toEqual(firstResult);
    expect(smtp.calls).toHaveLength(1);
  });

  it("throws a permanent UnknownMailboxError for an unconfigured sender", async () => {
    const engine = new EmailEngine({
      credentials: creds,
      store: new EngineStore(dir),
      smtp: new FakeSmtp(),
      imap: new FakeImap({}),
    });
    await expect(engine.send(baseInput({ fromEmail: "nobody@x.test" }), "k")).rejects.toBeInstanceOf(
      UnknownMailboxError,
    );
  });
});

class FakeApiSender<T> {
  calls: { transport: T; input: SendEmailInput; messageId: string }[] = [];
  async send(transport: T, input: SendEmailInput, messageId: string): Promise<void> {
    this.calls.push({ transport, input, messageId });
  }
}

const GMAIL_BOX = "gmail@coldstart.test";
const GRAPH_BOX = "graph@coldstart.test";
const apiCreds: CredentialsMap = {
  [GMAIL_BOX]: {
    imap: { host: "imap", port: 993, secure: true, user: GMAIL_BOX, pass: "p" },
    send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "rt" },
  },
  [GRAPH_BOX]: {
    imap: { host: "imap", port: 993, secure: true, user: GRAPH_BOX, pass: "p" },
    send: { kind: "ms_graph", mode: "delegated", tenantId: "t", clientId: "c", clientSecret: "s", refreshToken: "rt" },
  },
};

describe("EmailEngine.send — transport routing", () => {
  it("routes a gmail_api mailbox to the Gmail sender, not SMTP", async () => {
    const smtp = new FakeSmtp();
    const gmail = new FakeApiSender();
    const engine = new EmailEngine({
      credentials: apiCreds,
      store: new EngineStore(dir),
      smtp,
      imap: new FakeImap({}),
      gmail: gmail as unknown as GmailSender,
      graph: new FakeApiSender() as unknown as GraphSender,
    });

    const res = await engine.send(baseInput({ fromEmail: GMAIL_BOX }), "k-gmail");
    expect(gmail.calls).toHaveLength(1);
    expect(smtp.calls).toHaveLength(0);
    expect(gmail.calls[0]!.messageId).toBe(res.messageId);
  });

  it("routes an ms_graph mailbox to the Graph sender, not SMTP", async () => {
    const smtp = new FakeSmtp();
    const graph = new FakeApiSender();
    const engine = new EmailEngine({
      credentials: apiCreds,
      store: new EngineStore(dir),
      smtp,
      imap: new FakeImap({}),
      gmail: new FakeApiSender() as unknown as GmailSender,
      graph: graph as unknown as GraphSender,
    });

    await engine.send(baseInput({ fromEmail: GRAPH_BOX }), "k-graph");
    expect(graph.calls).toHaveLength(1);
    expect(smtp.calls).toHaveLength(0);
  });

  it("fails (never silently wrong-wire sends) when the needed API transport is not wired", async () => {
    const engine = new EmailEngine({
      credentials: apiCreds,
      store: new EngineStore(dir),
      smtp: new FakeSmtp(),
      imap: new FakeImap({}),
      // gmail/graph intentionally omitted
    });
    await expect(engine.send(baseInput({ fromEmail: GMAIL_BOX }), "k")).rejects.toThrow(/not wired/);
  });
});

function replyFrom(messageId: string): string {
  return [
    `From: lead@example.com`,
    `To: ${SENDER}`,
    `Message-ID: <reply-1@example.com>`,
    `In-Reply-To: ${messageId}`,
    `Content-Type: text/plain`,
    ``,
    `interested`,
    ``,
  ].join("\r\n");
}

describe("EmailEngine.poll", () => {
  it("is cursor-stateless: classifies messages above sinceCursor and returns the new cursor (consumer advances)", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    const engine0 = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap({}) });
    const sent = await engine0.send(baseInput({ threadId: "thr_9" }), "seed");

    const imap = new FakeImap({ [SENDER]: [{ uid: 7, source: replyFrom(sent.messageId) }] });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    const { events, cursor } = await engine.poll(SENDER, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "reply", threadId: "thr_9", messageId: "<reply-1@example.com>" });
    expect(cursor).toBe(7);

    // The consumer persists cursor=7 and polls again with it — fetches only
    // above 7, nothing new. Engine stored no cursor of its own.
    const next = await engine.poll(SENDER, cursor);
    expect(next.events).toHaveLength(0);
    expect(imap.fetched.at(-1)?.sinceUid).toBe(7);
  });

  it("REDELIVERS the same events on a lost response (consumer did not advance) — the cursor-loss fix", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    const engine0 = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap({}) });
    const sent = await engine0.send(baseInput({ threadId: "thr_9" }), "seed");

    const imap = new FakeImap({ [SENDER]: [{ uid: 7, source: replyFrom(sent.messageId) }] });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    // First poll returns the event + cursor=7 — but the response is "lost": the
    // consumer never persists cursor, so it retries from the SAME sinceCursor.
    const first = await engine.poll(SENDER, 0);
    expect(first.events).toHaveLength(1);

    const retry = await engine.poll(SENDER, 0);
    // Same event redelivered (no engine-side cursor advanced past it). Its
    // Message-ID is stable, so the Worker's events unique index dedupes it.
    expect(retry.events).toHaveLength(1);
    expect((retry.events[0] as { messageId: string }).messageId).toBe(
      (first.events[0] as { messageId: string }).messageId,
    );
  });
});
