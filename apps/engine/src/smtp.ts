import nodemailer from "nodemailer";
import type { SendEmailInput } from "@coldstart/shared";
import type { Endpoint } from "./config.js";
import { UpstreamTransientError } from "./errors.js";
import { buildMailOptions } from "./message.js";

export interface SmtpSender {
  send(creds: Endpoint, input: SendEmailInput, messageId: string): Promise<void>;
}

// Bound one SMTP transaction WELL under the consumer's stuck-'sending' reclaim
// TTL (SEND_CLAIM_TTL_MS = 5 min, apps/platform/src/engine/tick.ts). nodemailer's
// defaults are dangerous here: SOCKET_TIMEOUT defaults to 10 min — DOUBLE the
// reclaim TTL — so a stalled socket would let the consumer reclaim and re-send a
// row whose first send is still on the wire (the double-send race,
// engine-host-review-2026-07-14). Explicit, small timeouts make a genuine stall
// surface as an UpstreamTransientError long before the row is reclaim-eligible.
// Note these are per-phase INACTIVITY timeouts, not a total-transaction bound —
// a dribbling server can exceed connect + greeting + socket ≈ 100s; the in-flight
// claim (store.claimSend), not these constants, is the double-send guarantee.
// Keep the sum below the Worker's fetch abort (ENGINE_REQUEST_TIMEOUT_MS,
// email-port.ts), which is below the reclaim TTL.
const CONNECTION_TIMEOUT_MS = 20_000;
const GREETING_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 60_000;

/**
 * Real SMTP send via nodemailer (the A5-validated library). Sets the minted RFC
 * 5322 Message-ID, the In-Reply-To for a sequence follow-up, and the RFC 8058
 * List-Unsubscribe / List-Unsubscribe-Post headers carried on SendEmailInput
 * (finding F1). Any transport failure is surfaced as an UpstreamTransientError
 * so the Worker retries under its cap rather than dropping the send.
 */
export const nodemailerSender: SmtpSender = {
  async send(creds, input, messageId) {
    const transport = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      auth: { user: creds.user, pass: creds.pass },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
    try {
      await transport.sendMail(buildMailOptions(input, messageId));
    } catch (err) {
      throw new UpstreamTransientError(`SMTP send failed for ${input.fromEmail}: ${(err as Error).message}`, {
        cause: err,
      });
    } finally {
      transport.close();
    }
  },
};
