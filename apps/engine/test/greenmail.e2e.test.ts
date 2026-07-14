import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type { PolledEvent } from "@coldstart/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CredentialsMap } from "../src/config.js";
import { EmailEngine } from "../src/engine.js";
import { imapflowFetcher } from "../src/imap.js";
import { nodemailerSender } from "../src/smtp.js";
import { EngineStore } from "../src/store.js";

// Opt-in: needs the GreenMail container from apps/engine/README.md. Default
// `npm test` self-skips this whole file (no Docker required for CI).
const RUN = process.env.ENGINE_E2E === "1";

const HOST = "127.0.0.1";
const SMTP_PORT = 3025;
const IMAP_PORT = 3143;
const DOMAIN = "coldstart.test";
const SENDER = `sender@${DOMAIN}`;
const LEAD = `lead@${DOMAIN}`;

function endpoint(user: string) {
  return {
    smtp: { host: HOST, port: SMTP_PORT, secure: false, user, pass: "x" },
    imap: { host: HOST, port: IMAP_PORT, secure: false, user, pass: "x" },
  };
}
const creds: CredentialsMap = { [SENDER]: endpoint(SENDER), [LEAD]: endpoint(LEAD) };

// Raw injector (nodemailer straight at GreenMail) to simulate the lead replying
// and MAILER-DAEMON bouncing — the inbound side the engine then polls.
const rawTransport = nodemailer.createTransport({ host: HOST, port: SMTP_PORT, secure: false, ignoreTLS: true });

// The engine is cursor-stateless, so the consumer (here, the test) tracks the
// per-mailbox cursor and advances it between polls.
async function pollUntil(
  engine: EmailEngine,
  mailbox: string,
  want: number,
  sinceCursor: number,
): Promise<{ events: PolledEvent[]; cursor: number }> {
  for (let i = 0; i < 30; i++) {
    const result = await engine.poll(mailbox, sinceCursor);
    if (result.events.length >= want) return result;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${want} event(s) in ${mailbox}`);
}

describe.skipIf(!RUN)("GreenMail end-to-end (real SMTP+IMAP)", () => {
  let dir: string;
  let engine: EmailEngine;
  let originalMessageId: string;
  let senderCursor = 0; // consumer-owned poll cursor, advanced between polls

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-e2e-"));
    engine = new EmailEngine({ credentials: creds, store: new EngineStore(dir), smtp: nodemailerSender, imap: imapflowFetcher });
  });
  afterAll(() => {
    rawTransport.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends a real email and mints a readable Message-ID", async () => {
    const result = await engine.send(
      {
        fromEmail: SENDER,
        toEmail: LEAD,
        subject: "Quick question about your outreach",
        body: "Hi — are you the right person? Reply STOP to opt out.",
        threadId: "thr_e2e",
        inReplyToMessageId: null,
        listUnsubscribe: `<mailto:unsub@${DOMAIN}>, <https://${DOMAIN}/u/abc>`,
        listUnsubscribePost: "List-Unsubscribe=One-Click",
      },
      "send:e2e:1",
    );
    expect(result.messageId).toMatch(new RegExp(`@${DOMAIN}>$`));
    originalMessageId = result.messageId;
  });

  it("polls a real reply over IMAP and reconstructs the threadId", async () => {
    await rawTransport.sendMail({
      from: LEAD,
      to: SENDER,
      subject: "Re: Quick question about your outreach",
      text: "Yes, I'm the right person.",
      messageId: `<reply-${Date.now()}@${DOMAIN}>`,
      inReplyTo: originalMessageId,
      references: originalMessageId,
    });
    const { events, cursor } = await pollUntil(engine, SENDER, 1, senderCursor);
    senderCursor = cursor;
    const reply = events.find((e) => e.kind === "reply");
    expect(reply).toMatchObject({ kind: "reply", threadId: "thr_e2e", fromEmail: LEAD });
  });

  it("polls a real RFC 3464 DSN and classifies it as a HARD bounce", async () => {
    const boundary = "=_e2e_dsn";
    const rawDsn = [
      `From: MAILER-DAEMON@${DOMAIN}`,
      `To: ${SENDER}`,
      `Subject: Delivery Status Notification (Failure)`,
      `Message-ID: <dsn-${Date.now()}@${DOMAIN}>`,
      `In-Reply-To: ${originalMessageId}`,
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
      `MIME-Version: 1.0`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      `Delivery failed.`,
      ``,
      `--${boundary}`,
      `Content-Type: message/delivery-status`,
      ``,
      `Final-Recipient: rfc822; ${LEAD}`,
      `Action: failed`,
      `Status: 5.1.1`,
      ``,
      `--${boundary}`,
      `Content-Type: text/rfc822-headers`,
      ``,
      `Message-ID: ${originalMessageId}`,
      ``,
      `--${boundary}--`,
      ``,
    ].join("\r\n");
    await rawTransport.sendMail({ envelope: { from: `MAILER-DAEMON@${DOMAIN}`, to: SENDER }, raw: rawDsn });

    const { events, cursor } = await pollUntil(engine, SENDER, 1, senderCursor);
    senderCursor = cursor;
    const bounce = events.find((e) => e.kind === "bounce");
    expect(bounce).toMatchObject({ kind: "bounce", severity: "hard", threadId: "thr_e2e" });
  });
});
