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
