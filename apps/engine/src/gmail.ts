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
//
// WIRE Message-ID RECONCILIATION (the reply-loop bug): Gmail's users.messages.send
// REWRITES the Message-ID header — the id we minted and put in the MIME is NOT the
// one Gmail stamps on the delivered message (proven live 2026-07-19). A recipient's
// reply carries In-Reply-To = the WIRE id, so the engine must record THAT id (not
// the minted one) to reconstruct the thread. After a successful send we therefore
// read the created message's headers back (messages.get?format=metadata) and return
// the wire Message-ID as the send's canonical id. If that read-back fails the send
// still succeeded (it is on the wire), so we never fail it — we return undefined and
// the engine falls back to the minted id (still recorded, via the dual-record net in
// store.ts). NOTE: messages.get needs a READ scope; the mint helper requests
// `gmail.metadata` alongside `gmail.send` for exactly this (scripts/mint-gmail-token.mjs).

const GMAIL_MESSAGES_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_SEND_URL = `${GMAIL_MESSAGES_BASE}/send`;
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Bound the post-send read-back: the message is ALREADY sent, so a hung lookup
// must not hold the engine's in-flight send claim (delaying recordSend toward the
// Worker's request timeout / reclaim TTL). On abort we simply fall back to the
// minted id — well under the 180s Worker timeout.
const WIRE_ID_READBACK_TIMEOUT_MS = 15_000;

export interface GmailSender {
  /**
   * Sends `input` and returns the WIRE Message-ID Gmail stamped on the delivered
   * message (read back via messages.get) so the engine records the id a reply
   * will actually carry. Returns undefined if the read-back fails after a
   * successful send — the send is NOT failed (it is delivered); the engine then
   * falls back to the minted id.
   */
  send(transport: GmailTransport, input: SendEmailInput, messageId: string): Promise<string | undefined>;
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
      const tokens = tokensFor(transport);
      const label = `gmail:${input.fromEmail}`;
      const sendBody = await apiSend(
        fetchImpl,
        tokens,
        {
          url: GMAIL_SEND_URL,
          contentType: "application/json",
          body: JSON.stringify({ raw: raw.toString("base64url") }),
          okStatus: 200,
          label,
        },
        sleep,
      );
      const gmailId = parseGmailMessageId(sendBody);
      if (!gmailId) return undefined; // no id to read back → engine keeps the minted id
      return fetchWireMessageId(fetchImpl, tokens, gmailId);
    },
  };
}

/** The internal Gmail message `id` from a messages.send 200 body, or undefined. */
function parseGmailMessageId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the wire `Message-ID` header off a just-sent message. Best-effort: the send
 * already succeeded, so ANY failure here (403 missing read scope, 404, network,
 * malformed body) returns undefined rather than throwing — losing the wire id
 * degrades reply-matching for that one send (engine falls back to the minted id),
 * it must never fail a message that already went out. One refresh-on-401, no
 * backoff loop (this is a post-send lookup, not the send itself).
 */
async function fetchWireMessageId(
  fetchImpl: FetchLike,
  tokens: TokenCache,
  gmailId: string,
): Promise<string | undefined> {
  const url = `${GMAIL_MESSAGES_BASE}/${encodeURIComponent(gmailId)}?format=metadata&metadataHeaders=Message-ID`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIRE_ID_READBACK_TIMEOUT_MS);
  try {
    const get = (token: string): Promise<Response> =>
      fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    let res = await get(await tokens.get());
    if (res.status === 401) res = await get(await tokens.get(true));
    if (res.status !== 200) return undefined;
    const body = (await res.json()) as { payload?: { headers?: Array<{ name?: string; value?: string }> } };
    const header = body.payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id");
    const value = header?.value?.trim();
    return value || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
