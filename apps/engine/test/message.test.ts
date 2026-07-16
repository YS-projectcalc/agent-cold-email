import type { SendEmailInput } from "@coldstart/shared";
import { describe, expect, it } from "vitest";
import { buildMailOptions, buildRawMessage } from "../src/message.js";

// The compliance INVARIANT: the single message builder that every transport
// (SMTP + the HTTPS/443 API transports) shares must carry the RFC 8058 headers,
// the CAN-SPAM footer / opt-out link (which ride verbatim in `input.body`), the
// real Message-ID, and the sequence In-Reply-To/References onto the wire message.
// If this builder ever drops one, EVERY transport silently ships a non-compliant
// message — so this is the test that must fail the instant the invariant breaks.

const MID = "<abc-123@coldstart.test>";

function compliantInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    fromEmail: "sender@coldstart.test",
    toEmail: "lead@example.com",
    subject: "quick question",
    body: "Hi there.\n\nBest, S\n\n--\nUnsubscribe: https://coldstart.test/u/abc\nColdStart, 123 Main St, City ST 00000",
    threadId: "thr_1",
    inReplyToMessageId: null,
    listUnsubscribe: "<mailto:unsub@coldstart.test>, <https://coldstart.test/u/abc>",
    listUnsubscribePost: "List-Unsubscribe=One-Click",
    ...overrides,
  };
}

describe("buildMailOptions", () => {
  it("carries the RFC 8058 headers when present and the Message-ID / addressing", () => {
    const opts = buildMailOptions(compliantInput(), MID);
    expect(opts.messageId).toBe(MID);
    expect(opts.from).toBe("sender@coldstart.test");
    expect(opts.to).toBe("lead@example.com");
    const headers = opts.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe("<mailto:unsub@coldstart.test>, <https://coldstart.test/u/abc>");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("threads a sequence follow-up via In-Reply-To and References", () => {
    const opts = buildMailOptions(compliantInput({ inReplyToMessageId: "<prev@coldstart.test>" }), MID);
    expect(opts.inReplyTo).toBe("<prev@coldstart.test>");
    expect(opts.references).toBe("<prev@coldstart.test>");
  });

  it("omits the List-Unsubscribe headers when the input carries none (internal send)", () => {
    const opts = buildMailOptions(compliantInput({ listUnsubscribe: undefined, listUnsubscribePost: undefined }), MID);
    const headers = opts.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBeUndefined();
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
  });
});

describe("buildRawMessage", () => {
  it("emits a raw RFC822 message with the compliance headers, footer body, and Message-ID", async () => {
    const raw = (await buildRawMessage(compliantInput(), MID)).toString("utf8");
    // The long List-Unsubscribe value is RFC 5322 header-folded across lines
    // (semantically transparent) — assert the header + both opt-out forms survive
    // rather than a brittle single-line match.
    expect(raw).toContain("List-Unsubscribe:");
    expect(raw).toContain("<mailto:unsub@coldstart.test>");
    expect(raw).toContain("<https://coldstart.test/u/abc>");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(raw).toContain(`Message-ID: ${MID}`);
    expect(raw).toContain("Subject: quick question");
    // The CAN-SPAM footer + opt-out link ride in the body verbatim — they must
    // survive into the raw message (the engine never mutates the composed body).
    expect(raw).toContain("Unsubscribe: https://coldstart.test/u/abc");
    expect(raw).toContain("123 Main St");
  });
});
