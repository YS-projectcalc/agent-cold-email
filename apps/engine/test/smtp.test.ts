import type { SendEmailInput } from "@coldstart/shared";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Endpoint } from "../src/config.js";
import { nodemailerSender } from "../src/smtp.js";

// Mirrors apps/platform/src/engine/tick.ts SEND_CLAIM_TTL_MS — the reclaim TTL a
// single SMTP transaction MUST finish well under, or a reclaim can re-send a
// still-live send (the double-send race, engine-host-review-2026-07-14).
const SEND_CLAIM_TTL_MS = 5 * 60 * 1000;

const creds: Endpoint = { host: "smtp.test", port: 465, secure: true, user: "u", pass: "p" };
const input: SendEmailInput = {
  fromEmail: "sender@coldstart.test",
  toEmail: "lead@example.com",
  subject: "hi",
  body: "hello",
  threadId: "thr_1",
  inReplyToMessageId: null,
};

afterEach(() => vi.restoreAllMocks());

describe("nodemailerSender — bounded timeouts (double-send guard)", () => {
  it("constructs the transport with connection/greeting/socket timeouts well under the reclaim TTL", async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const spy = vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail, close } as never);

    await nodemailerSender.send(creds, input, "<m1@coldstart.test>");

    const opts = spy.mock.calls[0]![0] as {
      connectionTimeout?: number;
      greetingTimeout?: number;
      socketTimeout?: number;
    };
    // Pre-fix: all three undefined — nodemailer's SOCKET_TIMEOUT defaults to
    // 10 min, DOUBLE the reclaim TTL, which was the root of the race.
    expect(opts.connectionTimeout).toBeGreaterThan(0);
    expect(opts.greetingTimeout).toBeGreaterThan(0);
    expect(opts.socketTimeout).toBeGreaterThan(0);
    // Worst-case in-flight time must sit WELL under the reclaim TTL so a genuine
    // stall surfaces (and retries) long before the row is eligible for reclaim.
    const worstCase = opts.connectionTimeout! + opts.greetingTimeout! + opts.socketTimeout!;
    expect(worstCase).toBeLessThan(SEND_CLAIM_TTL_MS);

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1); // transport always closed (finally)
  });
});
