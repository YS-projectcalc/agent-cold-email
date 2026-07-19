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
  constructor(
    private readonly byMailbox: Record<string, RawMessage[]>,
    // Explicit per-mailbox UIDNEXT override. Defaults to (max fixture UID + 1)
    // -- a realistic mailbox where UIDNEXT is one past the last existing
    // message -- so most tests don't need to compute it by hand.
    private readonly uidNextByMailbox: Record<string, number> = {},
  ) {}
  fetched: { sinceUid: number; throughUid: number }[] = [];

  async currentUidNext(credsArg: { user: string }): Promise<number> {
    const override = this.uidNextByMailbox[credsArg.user];
    if (override !== undefined) return override;
    const maxUid = (this.byMailbox[credsArg.user] ?? []).reduce((m, msg) => Math.max(m, msg.uid), 0);
    return maxUid + 1;
  }

  async fetchRange(credsArg: { user: string }, sinceUid: number, throughUid: number): Promise<RawMessage[]> {
    this.fetched.push({ sinceUid, throughUid });
    return (this.byMailbox[credsArg.user] ?? []).filter((m) => m.uid > sinceUid && m.uid <= throughUid);
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

// A Gmail sender that models the wire-rewrite: it is called with the MINTED id,
// but reports back the WIRE id Gmail actually stamped (or undefined when the
// read-back failed) — exactly what the real gmail.ts returns after messages.get.
class WireRewritingGmail {
  calls: { input: SendEmailInput; messageId: string }[] = [];
  constructor(private readonly wireId: string | undefined) {}
  async send(_t: unknown, input: SendEmailInput, messageId: string): Promise<string | undefined> {
    this.calls.push({ input, messageId });
    return this.wireId;
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
  it("does NOT fetch mailbox history on first contact (sinceCursor=-1), even on a mailbox with a large pre-existing UID space — the unbounded-first-fetch defect — and initializes the cursor at the mailbox's current high-water", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    // A real pre-existing mailbox (the Gate-1 smoke found one with UID >147k):
    // hundreds of historical messages already sitting in INBOX before the
    // platform ever polls it.
    const historical: RawMessage[] = [];
    for (let uid = 1; uid <= 500; uid++) {
      historical.push({ uid, source: `From: x@y.test\r\nMessage-ID: <h${uid}@x.test>\r\nContent-Type: text/plain\r\n\r\nbody` });
    }
    const imap = new FakeImap({ [SENDER]: historical });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    const { events, cursor } = await engine.poll(SENDER, -1);
    expect(imap.fetched).toHaveLength(0); // no IMAP fetch at all on first contact
    expect(events).toHaveLength(0);
    // Cursor lands exactly at the mailbox's current high-water (the fixture's
    // max UID), not at 0 and not at some partial/capped value — the very next
    // poll starts strictly above all 500 historical messages.
    expect(cursor).toBe(500);
  });

  it("ROUND-2 REGRESSION (adversary poll-bounded-fetch-2026-07-16 finding 1): an empty mailbox's first-ever inbound is NOT silently lost -- sinceCursor -1 (never polled) is distinct from a legitimate 0 (incremental from UID 1)", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    const engine0 = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap({}) });
    const sent = await engine0.send(baseInput({ threadId: "thr_empty" }), "seed-empty");

    // Tick 1: the mailbox is genuinely empty when first polled. sinceCursor=-1
    // is the "never polled" sentinel -- initializes at the current (empty)
    // high-water, which is legitimately 0 for an empty mailbox.
    const emptyImap = new FakeImap({}, { [SENDER]: 1 }); // UIDNEXT=1 -- nothing exists yet
    const primingEngine = new EmailEngine({ credentials: creds, store, smtp, imap: emptyImap });
    const primed = await primingEngine.poll(SENDER, -1);
    expect(emptyImap.fetched).toHaveLength(0);
    expect(primed.cursor).toBe(0);

    // A real reply now arrives at UID 1 -- the mailbox's very first message
    // ever.
    const imap = new FakeImap({ [SENDER]: [{ uid: 1, source: replyFrom(sent.messageId) }] }, { [SENDER]: 2 });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    // Tick 2: the consumer polls again with the PERSISTED cursor (0). Under the
    // old (round-1) sentinel where 0 meant "never polled", this would re-enter
    // first-contact and skip UID 1 forever -- the exact defect the adversary
    // demonstrated live. 0 must now be an ordinary incremental cursor.
    const { events, cursor } = await engine.poll(SENDER, primed.cursor);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "reply", threadId: "thr_empty" });
    expect(cursor).toBe(1);
  });

  it("classifies messages on a normal incremental poll (after first contact already initialized the cursor) and returns the new cursor", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    const engine0 = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap({}) });
    const sent = await engine0.send(baseInput({ threadId: "thr_9" }), "seed");

    // Realistic ordering: the mailbox already has some history (uid 1-5) the
    // FIRST time the platform connects and polls it. First contact initializes
    // the cursor at that high-water without fetching anything.
    const preExisting: RawMessage[] = [1, 2, 3, 4, 5].map((uid) => ({
      uid,
      source: `Message-ID: <old-${uid}@x.test>\r\n\r\nold`,
    }));
    const primingImap = new FakeImap({ [SENDER]: preExisting });
    const primingEngine = new EmailEngine({ credentials: creds, store, smtp, imap: primingImap });
    const primed = await primingEngine.poll(SENDER, -1);
    expect(primingImap.fetched).toHaveLength(0);
    expect(primed.cursor).toBe(5);

    // A genuine reply now lands at uid 7, after the primed high-water. A
    // normal incremental poll from the primed cursor must classify it.
    const imap = new FakeImap({ [SENDER]: [...preExisting, { uid: 7, source: replyFrom(sent.messageId) }] });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    const { events, cursor } = await engine.poll(SENDER, primed.cursor);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "reply", threadId: "thr_9", messageId: "<reply-1@example.com>" });
    expect(cursor).toBe(7);
    expect(imap.fetched).toEqual([{ sinceUid: 5, throughUid: 7 }]);

    // The consumer persists cursor=7 and polls again with it — fully caught up,
    // so no fetch call happens at all this time.
    const next = await engine.poll(SENDER, cursor);
    expect(next.events).toHaveLength(0);
    expect(imap.fetched).toHaveLength(1); // still just the one fetch from above
  });

  it("caps a single incremental poll's fetch range to POLL_BATCH_CAP UIDs and pages across polls (batch-cap defense-in-depth)", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    // 800 messages beyond an already-initialized cursor -- a backlog bigger
    // than one poll's cap (300).
    const historical: RawMessage[] = [];
    for (let uid = 1; uid <= 800; uid++) {
      historical.push({ uid, source: `Message-ID: <h${uid}@x.test>\r\n\r\nbody` });
    }
    const imap = new FakeImap({ [SENDER]: historical }, { [SENDER]: 801 });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    // sinceCursor=1 (already initialized, non-zero) exercises the incremental
    // path, not first contact.
    const page1 = await engine.poll(SENDER, 1);
    expect(page1.cursor).toBe(301); // capped short of the true high-water (800)
    expect(imap.fetched).toEqual([{ sinceUid: 1, throughUid: 301 }]);

    const page2 = await engine.poll(SENDER, page1.cursor);
    expect(page2.cursor).toBe(601);

    const page3 = await engine.poll(SENDER, page2.cursor);
    expect(page3.cursor).toBe(800); // now caught up to the mailbox's true high-water

    const page4 = await engine.poll(SENDER, page3.cursor);
    expect(page4.cursor).toBe(800); // fully caught up -- no further fetch calls
    expect(imap.fetched).toHaveLength(3);
  });

  it("advances the cursor to the FULL scanned range even when the top-of-range UID doesn't exist (expunged/deleted) -- the anti-stall property", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    // Messages exist through uid 305, but nothing at 306-310 (expunged/gap).
    // From cursor 10, the batch-cap range is (10, 310] -- the last message
    // ACTUALLY present in that range is 305, not 310.
    const historical: RawMessage[] = [];
    for (let uid = 11; uid <= 305; uid++) historical.push({ uid, source: `Message-ID: <h${uid}@x.test>\r\n\r\nbody` });
    const imap = new FakeImap({ [SENDER]: historical }, { [SENDER]: 500 }); // highWater=499, well above 310
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    const { cursor } = await engine.poll(SENDER, 10);
    // If cursor tracked the max RETURNED uid instead of the full scanned range,
    // this would be 305 and the next poll would re-scan the dead 306-310 gap
    // forever. It must be 310 -- proving the anti-stall design is real.
    expect(cursor).toBe(310);
  });

  it("REDELIVERS the same events on a lost response (consumer did not advance) — the cursor-loss fix", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    const engine0 = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap({}) });
    const sent = await engine0.send(baseInput({ threadId: "thr_9" }), "seed");

    const imap = new FakeImap({ [SENDER]: [{ uid: 7, source: replyFrom(sent.messageId) }] });
    const engine = new EmailEngine({ credentials: creds, store, smtp, imap });

    // Start from an already-initialized cursor (5) below the reply at uid 7 --
    // first contact already happened on a prior poll; this exercises a normal
    // incremental poll, not the first-contact path.
    const first = await engine.poll(SENDER, 5);
    expect(first.events).toHaveLength(1);

    // Response "lost": the consumer never persisted the advanced cursor, so it
    // retries from the SAME sinceCursor.
    const retry = await engine.poll(SENDER, 5);
    // Same event redelivered (no engine-side cursor advanced past it). Its
    // Message-ID is stable, so the Worker's events unique index dedupes it.
    expect(retry.events).toHaveLength(1);
    expect((retry.events[0] as { messageId: string }).messageId).toBe(
      (first.events[0] as { messageId: string }).messageId,
    );
  });
});

const GMAIL_ONLY: CredentialsMap = {
  [GMAIL_BOX]: {
    imap: { host: "imap", port: 993, secure: true, user: GMAIL_BOX, pass: "p" },
    send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "rt" },
  },
};

function gmailEngine(store: EngineStore, imap: FakeImap, gmail: WireRewritingGmail, now?: () => number): EmailEngine {
  return new EmailEngine({
    credentials: GMAIL_ONLY,
    store,
    smtp: new FakeSmtp(),
    imap,
    gmail: gmail as unknown as GmailSender,
    graph: new FakeApiSender() as unknown as GraphSender,
    now,
  });
}

describe("EmailEngine.send — wire Message-ID reconciliation (gmail_api)", () => {
  // The confirmed production bug (2026-07-19): Gmail's messages.send REWRITES the
  // Message-ID, so a recipient's reply carries the WIRE id, which is not the id the
  // engine minted. Pre-fix the engine recorded only the minted id, so the reply's
  // In-Reply-To resolved to NOTHING and every reply/bounce to a gmail_api send was
  // silently dropped. This models the real over-time flow: send -> reply arrives.
  it("threads an inbound reply carrying Gmail's REWRITTEN wire Message-ID (this reply is LOST on the pre-fix engine)", async () => {
    const store = new EngineStore(dir);
    const wireId = "<CAMc35PQ9axcPb86Sr9hnWHhJDUTEa7CdKiAuqffNeZ06=vc3fw@mail.gmail.com>";
    const gmail = new WireRewritingGmail(wireId);

    const sent = await gmailEngine(store, new FakeImap({}), gmail).send(
      baseInput({ fromEmail: GMAIL_BOX, threadId: "thr_g" }),
      "k-gmail",
    );

    // The canonical id returned from /v1/send is the WIRE id — the id a reply carries.
    expect(sent.messageId).toBe(wireId);
    // Dual-record: the wire id AND the minted id both resolve to the thread.
    const mintedId = gmail.calls[0]!.messageId;
    expect(mintedId).not.toBe(wireId);
    expect(store.resolveThread(wireId)).toBe("thr_g");
    expect(store.resolveThread(mintedId)).toBe("thr_g");

    // A recipient replies; the client sets In-Reply-To to the WIRE id (the only
    // Message-ID that was ever on the delivered message).
    const imap = new FakeImap({ [GMAIL_BOX]: [{ uid: 7, source: replyFrom(wireId) }] });
    const { events } = await gmailEngine(store, imap, gmail).poll(GMAIL_BOX, 5);

    // PRE-FIX: resolveThread(wireId) was undefined (only the minted id was stored),
    // so events.length was 0 — the reply vanished. FIXED: threaded to thr_g.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "reply", threadId: "thr_g" });
  });

  it("keeps the minted id matchable when the wire-id read-back fails (send still succeeds, reply still threads)", async () => {
    const store = new EngineStore(dir);
    // Gmail accepted the send (200) but the metadata read-back failed → the
    // transport reports undefined; the engine keeps the minted id as canonical.
    const gmail = new WireRewritingGmail(undefined);

    const sent = await gmailEngine(store, new FakeImap({}), gmail, () => 9).send(
      baseInput({ fromEmail: GMAIL_BOX, threadId: "thr_fb" }),
      "k-fb",
    );

    // The send is NOT failed: it returns a result at the send timestamp, and the
    // minted id is canonical and recorded.
    expect(sent.sentAt).toBe(9);
    expect(sent.messageId).toBe(gmail.calls[0]!.messageId);
    expect(store.resolveThread(sent.messageId)).toBe("thr_fb");

    // A reply carrying that id threads (the fallback stays matchable).
    const imap = new FakeImap({ [GMAIL_BOX]: [{ uid: 7, source: replyFrom(sent.messageId) }] });
    const { events } = await gmailEngine(store, imap, gmail).poll(GMAIL_BOX, 5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "reply", threadId: "thr_fb" });
  });
});
