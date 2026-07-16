import type { SendEmailInput } from "@coldstart/shared";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

// THE single outbound-message builder. Every transport — SMTP (smtp.ts) and the
// HTTPS/443 API transports (gmail.ts, graph.ts) — builds its message from
// `buildMailOptions` so the compliance surface (RFC 8058 List-Unsubscribe /
// List-Unsubscribe-Post headers, the in-body opt-out link + CAN-SPAM footer that
// arrive verbatim in `input.body`, the RFC 5322 Message-ID, sequence
// In-Reply-To/References) is byte-identical no matter which wire the send takes.
// The engine is a faithful transmitter: it never mutates the composed body, so
// whatever compliance machinery the Worker put on the message flows through
// unchanged.

/** The nodemailer mail-options shape both the SMTP send and MailComposer accept. */
export type MailOptions = ConstructorParameters<typeof MailComposer>[0];

/**
 * Map a frozen SendEmailInput + minted Message-ID onto nodemailer mail options.
 * The SMTP path hands this straight to `transport.sendMail`; the API paths hand
 * it to `MailComposer` (below) to get the same raw RFC822 bytes SMTP would send.
 */
export function buildMailOptions(input: SendEmailInput, messageId: string): MailOptions {
  const headers: Record<string, string> = {};
  if (input.listUnsubscribe) headers["List-Unsubscribe"] = input.listUnsubscribe;
  if (input.listUnsubscribePost) headers["List-Unsubscribe-Post"] = input.listUnsubscribePost;
  return {
    from: input.fromEmail,
    to: input.toEmail,
    subject: input.subject,
    text: input.body,
    messageId,
    inReplyTo: input.inReplyToMessageId ?? undefined,
    references: input.inReplyToMessageId ?? undefined,
    headers,
  };
}

/**
 * Compile the exact raw RFC822 message the SMTP path would send, as a Buffer, so
 * the Gmail (base64url) and MS Graph (base64) API bodies carry the identical
 * headers + body. Uses nodemailer's own MailComposer — the same MIME builder
 * `transport.sendMail` uses internally — so there is no second, divergent
 * serializer to keep in sync.
 */
export async function buildRawMessage(input: SendEmailInput, messageId: string): Promise<Buffer> {
  const node = new MailComposer(buildMailOptions(input, messageId)).compile();
  return await new Promise<Buffer>((resolve, reject) => {
    node.build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}
