import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendEmailInput } from "@coldstart/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CredentialsMap } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import type { ImapFetcher, RawMessage } from "../src/imap.js";
import type { SmtpSender } from "../src/smtp.js";
import { EngineStore } from "../src/store.js";

// T2 for IN-7 of the head-of-line-blocking class sweep (2026-08-17).
//
// The per-message loop in `EmailEngine.poll` had no per-item guard, and the
// cursor is CONSUMER-owned and deliberately left un-advanced on a failed poll
// (apps/platform/src/engine/reply-processor.ts). So a single message whose
// classification threw meant the same UID range was re-fetched and re-thrown on
// every cycle, forever: that mailbox's replies, bounces and complaints were
// never processed again — stop-on-reply never fired, so the platform kept
// mailing prospects who had already answered.
//
// HONEST NOTE ON THE TRIGGER. The sweep named `simpleParser` (mailparser) on a
// malformed MIME message as the throw source. That did NOT reproduce: probed
// directly, simpleParser accepted every malformed STRING tried against it
// (3000-deep nested multipart, an invalid charset with non-base64 payload under
// a base64 CTE, binary garbage, header-only, empty) and threw only on non-string
// input, which `imapflow` cannot produce (`msg.source.toString("utf8")`). The
// LOOP defect is real and structural; its named trigger is not currently
// reachable. The throw is therefore injected at the one real per-message seam
// the engine actually exposes — the thread resolver classifyMessage is handed —
// which drives the genuine poll -> classifyMessage -> resolveOriginal path.

const SENDER = "sender@coldstart.test";
const creds: CredentialsMap = {
  [SENDER]: {
    smtp: { host: "smtp", port: 465, secure: true, user: SENDER, pass: "p" },
    imap: { host: "imap", port: 993, secure: true, user: SENDER, pass: "p" },
  },
};

class FakeSmtp implements SmtpSender {
  async send(): Promise<void> {}
}

class FakeImap implements ImapFetcher {
  constructor(private readonly messages: RawMessage[]) {}
  async currentUidNext(): Promise<number> {
    return this.messages.reduce((m, msg) => Math.max(m, msg.uid), 0) + 1;
  }
  async fetchRange(_creds: unknown, sinceUid: number, throughUid: number): Promise<RawMessage[]> {
    return this.messages.filter((m) => m.uid > sinceUid && m.uid <= throughUid);
  }
}

function baseInput(threadId: string): SendEmailInput {
  return {
    fromEmail: SENDER,
    toEmail: "lead@example.com",
    subject: "hi",
    body: "hello",
    threadId,
    inReplyToMessageId: null,
  };
}

function replyTo(messageId: string, ownId: string): string {
  const CRLF = String.fromCharCode(13, 10);
  return [`Message-ID: <${ownId}@lead.test>`, `In-Reply-To: ${messageId}`, "From: Lead <lead@example.com>", "", "thanks!"].join(CRLF);
}

/** A store whose thread resolution throws for ONE message id — the poison item. */
function storeWithPoisonedResolve(store: EngineStore, poisonFor: string): EngineStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop !== "resolveThread") return Reflect.get(target, prop, receiver);
      return (messageId: string): string | undefined => {
        if (messageId === poisonFor) throw new Error("simulated per-message classification failure");
        return target.resolveThread(messageId);
      };
    },
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-poll-iso-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("IN-7 — one unclassifiable message must not wedge a mailbox's inbound processing forever", () => {
  it("skips the poison message, still returns the healthy events, and advances the cursor past it", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();

    // Prime the mailbox (first contact) and record two outbound sends so both
    // replies below are attributable to known threads.
    const seedEngine = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap([]) });
    const poison = await seedEngine.send(baseInput("thr_poison"), "seed-poison");
    const healthy = await seedEngine.send(baseInput("thr_healthy"), "seed-healthy");
    const primed = await seedEngine.poll(SENDER, -1);
    expect(primed.cursor).toBe(0);

    const imap = new FakeImap([
      { uid: 1, source: replyTo(poison.messageId, "r1") }, // the HEAD item — poison
      { uid: 2, source: replyTo(healthy.messageId, "r2") },
    ]);
    const engine = new EmailEngine({
      credentials: creds,
      store: storeWithPoisonedResolve(store, poison.messageId),
      smtp,
      imap,
    });

    // Pre-fix: this REJECTS, so the consumer's catch leaves poll_cursor at 0 and
    // the identical batch is re-fetched and re-thrown on every cycle, forever.
    const result = await engine.poll(SENDER, primed.cursor);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "reply", threadId: "thr_healthy" });
    // THE DURABLE HALF: the cursor advances past the poison UID, so the
    // consumer persists it and the mailbox never sees that message again.
    expect(result.cursor).toBe(2);
    // The skip is a genuinely lost reply, so it is REPORTED rather than
    // swallowed — the consumer records it where an operator reads it.
    expect(result.unreadable).toBe(1);
  });

  it("a healthy poll reports zero unreadable (the counter is not fired by ordinary traffic)", async () => {
    const store = new EngineStore(dir);
    const smtp = new FakeSmtp();
    const seedEngine = new EmailEngine({ credentials: creds, store, smtp, imap: new FakeImap([]) });
    const sent = await seedEngine.send(baseInput("thr_ok"), "seed-ok");
    const primed = await seedEngine.poll(SENDER, -1);

    const engine = new EmailEngine({
      credentials: creds,
      store,
      smtp,
      imap: new FakeImap([{ uid: 1, source: replyTo(sent.messageId, "r1") }]),
    });
    const result = await engine.poll(SENDER, primed.cursor);

    expect(result.events).toHaveLength(1);
    expect(result.unreadable).toBe(0);
  });
});
