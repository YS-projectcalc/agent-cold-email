import type { SendEmailInput } from "@coldstart/shared";
import { apiSend } from "./api-send.js";
import type { GmailTransport } from "./config.js";
import { type FetchLike } from "./http.js";
import { buildRawMessage } from "./message.js";
import { TokenCache } from "./oauth.js";

// Gmail send over HTTPS/443 — the SMTP-wall workaround for a BYO Google mailbox.
// OAuth2 refresh-token grant per mailbox; POST the raw base64url RFC822 message
// (built by the shared message.ts builder, so the compliance headers are
// byte-identical to the SMTP path) to gmail.googleapis.com. Cold-email payloads
// are tiny, so the standard messages.send endpoint (base64url `{raw}` JSON, ≤5MB)
// is used rather than the resumable /upload/ endpoint (that one is for large
// media and takes raw `message/rfc822`, not base64url — see README note).

const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailSender {
  send(transport: GmailTransport, input: SendEmailInput, messageId: string): Promise<void>;
}

/**
 * Build the Gmail sender. `fetchImpl`/`sleep` are injectable so tests mock the
 * HTTP layer and run backoff instantly; production uses the built-in fetch and a
 * real timer (no googleapis SDK). Token caches are held per grant so a send
 * burst mints one access token.
 */
export function createGmailSender(fetchImpl: FetchLike = fetch, sleep?: (ms: number) => Promise<void>): GmailSender {
  const caches = new Map<string, TokenCache>();
  function tokensFor(t: GmailTransport): TokenCache {
    const key = `${t.clientId}:${t.refreshToken}`;
    let cache = caches.get(key);
    if (!cache) {
      cache = new TokenCache(fetchImpl, GMAIL_TOKEN_URL, {
        client_id: t.clientId,
        client_secret: t.clientSecret,
        refresh_token: t.refreshToken,
        grant_type: "refresh_token",
      });
      caches.set(key, cache);
    }
    return cache;
  }

  return {
    async send(transport, input, messageId) {
      const raw = await buildRawMessage(input, messageId);
      await apiSend(
        fetchImpl,
        tokensFor(transport),
        {
          url: GMAIL_SEND_URL,
          contentType: "application/json",
          body: JSON.stringify({ raw: raw.toString("base64url") }),
          okStatus: 200,
          label: `gmail:${input.fromEmail}`,
        },
        sleep,
      );
    },
  };
}
