import { describe, expect, it } from "vitest";
import { classifyMessage, type ThreadResolver } from "../src/classify.js";

const DOMAIN = "coldstart.test";
const ORIGINAL_ID = "<a-123@coldstart.test>";
const THREAD_ID = "thr_abc";

// resolveThread that only knows the one original send above.
const resolve: ThreadResolver = (id) => (id === ORIGINAL_ID ? THREAD_ID : undefined);

function dsn(status: string): string {
  const boundary = "=_dsn_9137";
  return [
    `From: Mail Delivery Subsystem <MAILER-DAEMON@${DOMAIN}>`,
    `To: sender@${DOMAIN}`,
    `Subject: Delivery Status Notification (Failure)`,
    `Message-ID: <dsn-999@${DOMAIN}>`,
    `In-Reply-To: ${ORIGINAL_ID}`,
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    `MIME-Version: 1.0`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Delivery failed.`,
    ``,
    `--${boundary}`,
    `Content-Type: message/delivery-status`,
    ``,
    `Reporting-MTA: dns; mail.${DOMAIN}`,
    ``,
    `Final-Recipient: rfc822; nosuchuser@example.com`,
    `Action: failed`,
    `Status: ${status}`,
    `Diagnostic-Code: smtp; 550 5.1.1 No such user here`,
    ``,
    `--${boundary}`,
    `Content-Type: text/rfc822-headers`,
    ``,
    `Message-ID: ${ORIGINAL_ID}`,
    `From: sender@${DOMAIN}`,
    `To: nosuchuser@example.com`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

function reply(): string {
  return [
    `From: Lead Person <lead@example.com>`,
    `To: sender@${DOMAIN}`,
    `Subject: Re: Quick question`,
    `Message-ID: <b-456@example.com>`,
    `In-Reply-To: ${ORIGINAL_ID}`,
    `References: ${ORIGINAL_ID}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Yes, I'm the right person. Tell me more.`,
    ``,
  ].join("\r\n");
}

function arfComplaint(): string {
  const boundary = "=_arf_555";
  return [
    `From: complaints@feedback.example.com`,
    `To: sender@${DOMAIN}`,
    `Subject: complaint`,
    `Message-ID: <arf-777@feedback.example.com>`,
    `Content-Type: multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    `MIME-Version: 1.0`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain`,
    ``,
    `This is an email abuse report.`,
    ``,
    `--${boundary}`,
    `Content-Type: message/feedback-report`,
    ``,
    `Feedback-Type: abuse`,
    `Original-Rcpt-To: lead@example.com`,
    ``,
    `--${boundary}`,
    `Content-Type: message/rfc822`,
    ``,
    `Message-ID: ${ORIGINAL_ID}`,
    `From: sender@${DOMAIN}`,
    `To: lead@example.com`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

describe("classifyMessage", () => {
  it("classifies a 5.x.x DSN as a HARD bounce with the reconstructed thread", async () => {
    const ev = await classifyMessage(dsn("5.1.1"), `sender@${DOMAIN}`, resolve, 1000);
    expect(ev).toMatchObject({
      kind: "bounce",
      severity: "hard",
      threadId: THREAD_ID,
      originalMessageId: ORIGINAL_ID,
      mailboxEmail: `sender@${DOMAIN}`,
      receivedAt: 1000,
    });
    expect((ev as { toEmail: string }).toEmail).toBe("nosuchuser@example.com");
  });

  it("classifies a 4.x.x DSN as a SOFT bounce (never permanent-suppressed on one)", async () => {
    const ev = await classifyMessage(dsn("4.2.2"), `sender@${DOMAIN}`, resolve, 1000);
    expect(ev).toMatchObject({ kind: "bounce", severity: "soft", threadId: THREAD_ID });
  });

  it("defaults a DSN with no parseable enhanced status to SOFT (fail-safe, not hard)", async () => {
    const noStatus = dsn("5.1.1").replace(/^Status: .*$/im, "Action: failed");
    const ev = await classifyMessage(noStatus, `sender@${DOMAIN}`, resolve, 1000);
    expect(ev).toMatchObject({ kind: "bounce", severity: "soft" });
  });

  it("reconstructs a reply's threadId from In-Reply-To -> known send", async () => {
    const ev = await classifyMessage(reply(), `sender@${DOMAIN}`, resolve, 2000);
    expect(ev).toMatchObject({
      kind: "reply",
      threadId: THREAD_ID,
      messageId: "<b-456@example.com>",
      fromEmail: "lead@example.com",
      receivedAt: 2000,
    });
    expect((ev as { body: string }).body).toContain("right person");
  });

  it("classifies an RFC 5965 ARF report as a complaint", async () => {
    const ev = await classifyMessage(arfComplaint(), `sender@${DOMAIN}`, resolve, 3000);
    expect(ev).toMatchObject({
      kind: "complaint",
      threadId: THREAD_ID,
      originalMessageId: ORIGINAL_ID,
      toEmail: "lead@example.com",
    });
  });

  it("returns null for a bounce/reply that resolves to no known thread (unattributable -> dropped)", async () => {
    const unknown = reply().replaceAll(ORIGINAL_ID, "<unknown@nowhere.test>");
    expect(await classifyMessage(unknown, `sender@${DOMAIN}`, resolve, 4000)).toBeNull();
  });

  // IN-22/IN-23, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md.
  // RFC 5322 makes Message-ID a SHOULD, not a MUST, so a real prospect's client
  // may omit it. `classifyReply` used to return null for exactly that message —
  // AFTER resolveOriginal had already attributed it to a known thread — and the
  // poll loop drops a null with no counter while the cursor still advances, so
  // the reply was destroyed: no event, no inbox thread, no stop-on-reply.
  const replyWithoutMessageId = () => reply().replace(/^Message-ID: .*\r?\n/im, "");

  it("emits an ATTRIBUTABLE reply whose client omitted Message-ID (never destroys it)", async () => {
    const ev = await classifyMessage(replyWithoutMessageId(), `sender@${DOMAIN}`, resolve, 2000);
    expect(ev).toMatchObject({
      kind: "reply",
      threadId: THREAD_ID,
      fromEmail: "lead@example.com",
      receivedAt: 2000,
    });
    expect((ev as { messageId: string }).messageId).toBeTruthy();
  });

  // The synthesized key is a DEDUP anchor, so it must be a function of the
  // message bytes ALONE. `receivedAt` is the engine's POLL time (engine.ts
  // passes `this.now()`), not the message's date, and the poll contract is that
  // a lost response redelivers the same batch — so keying on it would make every
  // re-poll a NEW key and file a duplicate reply.
  it("synthesizes a key that is STABLE across re-polls (receivedAt must not feed it)", async () => {
    const source = replyWithoutMessageId();
    const first = await classifyMessage(source, `sender@${DOMAIN}`, resolve, 2000);
    const second = await classifyMessage(source, `sender@${DOMAIN}`, resolve, 987654);
    expect((first as { messageId: string }).messageId).toBe((second as { messageId: string }).messageId);
  });

  it("synthesizes DISTINCT keys for two different no-Message-ID replies", async () => {
    const a = replyWithoutMessageId();
    const b = replyWithoutMessageId().replace("Tell me more.", "Not interested, thanks.");
    const evA = await classifyMessage(a, `sender@${DOMAIN}`, resolve, 2000);
    const evB = await classifyMessage(b, `sender@${DOMAIN}`, resolve, 2000);
    expect((evA as { messageId: string }).messageId).not.toBe((evB as { messageId: string }).messageId);
  });

  // A synthesized key must never be mistaken for a wire Message-ID: the Worker
  // dedups `(tenant_id, type, message_id)` across BOTH, and resolveOriginal
  // matches candidates against real ids.
  it("marks the synthesized key so it cannot collide with a real RFC 5322 Message-ID", async () => {
    const ev = await classifyMessage(replyWithoutMessageId(), `sender@${DOMAIN}`, resolve, 2000);
    const messageId = (ev as { messageId: string }).messageId;
    expect(messageId.startsWith("synthetic:")).toBe(true);
    expect(messageId).not.toMatch(/^</);
  });

  it("returns null for an ordinary inbound with no thread linkage (the common silence case)", async () => {
    const cold = [
      `From: random@stranger.test`,
      `To: sender@${DOMAIN}`,
      `Subject: hello`,
      `Message-ID: <x@stranger.test>`,
      `Content-Type: text/plain`,
      ``,
      `unrelated`,
      ``,
    ].join("\r\n");
    expect(await classifyMessage(cold, `sender@${DOMAIN}`, resolve, 5000)).toBeNull();
  });
});
