import { randomUUID } from "node:crypto";

/**
 * Mint a real RFC 5322 Message-ID (`<uuid@domain>`) for an outbound send. The
 * SendEmailResult contract (packages/shared/src/vendor-ports.ts) requires a REAL
 * Message-ID — the IMAP poll path reconstructs a reply/bounce's threadId by
 * matching the inbound In-Reply-To/References back to this exact id, so it must
 * be a genuine, domain-scoped Message-ID the receiving server will echo.
 */
export function mintMessageId(fromEmail: string, overrideDomain?: string): string {
  const domain = overrideDomain ?? fromEmail.split("@")[1] ?? "localhost";
  return `<${randomUUID()}@${domain}>`;
}
