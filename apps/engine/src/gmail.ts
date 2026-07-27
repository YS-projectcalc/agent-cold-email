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

/**
 * Boot-reconciliation lookup of a dangling gmail send by its provider id:
 *  - `found`     — messages.get 200 with the wire Message-ID (finalize with it + minted alias)
 *  - `sent`      — 404 (created then purged) or 200 without a Message-ID header: the 200 on
 *                  the ORIGINAL send proved creation, so the message WAS sent (finalize with the minted id)
 *  - `uncertain` — 403 / 5xx / network / timeout: cannot confirm ⇒ PARK (drop, never re-send)
 */
export type GmailLookup = { kind: "found"; wireId: string } | { kind: "sent" } | { kind: "uncertain" };

export interface GmailSender {
  /**
   * Submit `input` via messages.send and return Gmail's internal message `id`
   * (undefined if the 200 body carried none). The message IS sent once this
   * resolves (Gmail's send is synchronous create+send). Split from `wireId` so
   * the engine can durably append `submitted{id}` BETWEEN the POST return and the
   * read-back: a crash in the read-back window then leaves a dangling that boot
   * reconciliation can finalize via messages.get instead of parking.
   */
  submit(transport: GmailTransport, input: SendEmailInput, messageId: string): Promise<string | undefined>;
  /**
   * Read back the WIRE Message-ID Gmail stamped on a just-submitted message (by
   * its internal `id`) so the engine records the id a reply will actually carry.
   * Best-effort: returns undefined on ANY failure — the message is already sent,
   * so the engine falls back to the minted id, never failing a delivered send.
   */
  wireId(transport: GmailTransport, gmailId: string): Promise<string | undefined>;
  /**
   * Boot reconciliation of a dangling gmail send that has a `submitted{id}` line
   * (see GmailLookup). A 404 is treated as SENT (the original 200 proved
   * creation); only a genuinely inconclusive status parks.
   */
  lookup(transport: GmailTransport, gmailId: string): Promise<GmailLookup>;
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
    async submit(transport, input, messageId) {
      const raw = await buildRawMessage(input, messageId);
      const tokens = tokensFor(transport);
      const sendBody = await apiSend(
        fetchImpl,
        tokens,
        {
          url: GMAIL_SEND_URL,
          contentType: "application/json",
          body: JSON.stringify({ raw: raw.toString("base64url") }),
          okStatus: 200,
          label: `gmail:${input.fromEmail}`,
        },
        sleep,
      );
      return parseGmailMessageId(sendBody); // undefined ⇒ no id to read back
    },
    async wireId(transport, gmailId) {
      const result = await getMessageIdHeader(fetchImpl, tokensFor(transport), gmailId);
      return result.kind === "found" ? result.wireId : undefined;
    },
    async lookup(transport, gmailId) {
      return getMessageIdHeader(fetchImpl, tokensFor(transport), gmailId);
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
 * messages.get?format=metadata for the wire `Message-ID`, graded for both the
 * alive read-back (wireId, which cares only found-vs-not) AND boot reconciliation
 * (lookup, which must distinguish 404-⇒-sent from an inconclusive failure). One
 * refresh-on-401, no backoff loop (a post-send lookup, not the send itself),
 * bounded by the read-back timeout so a hung lookup never delays the caller.
 */
async function getMessageIdHeader(
  fetchImpl: FetchLike,
  tokens: TokenCache,
  gmailId: string,
): Promise<GmailLookup> {
  const url = `${GMAIL_MESSAGES_BASE}/${encodeURIComponent(gmailId)}?format=metadata&metadataHeaders=Message-ID`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIRE_ID_READBACK_TIMEOUT_MS);
  try {
    const get = (token: string): Promise<Response> =>
      fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    let res = await get(await tokens.get());
    if (res.status === 401) res = await get(await tokens.get(true));
    // 404 ⇒ the message was created (the original send's 200 proved it) then
    // deleted/purged ⇒ it WAS sent (finalize with the minted id, never re-send).
    if (res.status === 404) return { kind: "sent" };
    if (res.status !== 200) return { kind: "uncertain" };
    const body = (await res.json()) as { payload?: { headers?: Array<{ name?: string; value?: string }> } };
    const header = body.payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id");
    const value = header?.value?.trim();
    // 200 with the header ⇒ the wire id; 200 without ⇒ the message exists (sent),
    // but we cannot read the wire id, so finalize with the minted id.
    return value ? { kind: "found", wireId: value } : { kind: "sent" };
  } catch {
    return { kind: "uncertain" };
  } finally {
    clearTimeout(timer);
  }
}
