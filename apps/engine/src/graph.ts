import type { SendEmailInput } from "@coldstart/shared";
import { apiSend } from "./api-send.js";
import type { GraphTransport } from "./config.js";
import { type FetchLike } from "./http.js";
import { buildRawMessage } from "./message.js";
import { TokenCache } from "./oauth.js";

// MS Graph send over HTTPS/443 — the SMTP-wall workaround for a BYO Microsoft
// 365 mailbox. Sends the raw MIME (base64) to the Graph sendMail endpoint, which
// accepts a base64-encoded RFC822 message as a `text/plain` body and preserves
// every header (so the shared builder's compliance headers survive). Two auth
// modes: `delegated` (user refresh-token grant, endpoint /me/sendMail) and
// `app_only` (client-credentials grant, endpoint /users/{user}/sendMail — Graph
// app-only has no `me`). Success is 202 Accepted. No @azure SDK — built-in fetch.

const GRAPH_SEND_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_ACCEPTED = 202;

export interface GraphSender {
  send(transport: GraphTransport, input: SendEmailInput, messageId: string): Promise<void>;
}

function tokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

function tokenForm(t: GraphTransport): Record<string, string> {
  if (t.mode === "app_only") {
    return {
      client_id: t.clientId,
      client_secret: t.clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    };
  }
  // delegated: refreshToken presence is enforced by config.superRefine.
  return {
    client_id: t.clientId,
    client_secret: t.clientSecret,
    grant_type: "refresh_token",
    refresh_token: t.refreshToken ?? "",
    scope: "https://graph.microsoft.com/Mail.Send offline_access",
  };
}

/**
 * The sending mailbox is the token's own for `delegated` (/me/sendMail) and the
 * explicit `user` for `app_only` (required by config; /users/{user}/sendMail).
 */
function sendUrl(t: GraphTransport, fromEmail: string): string {
  if (t.mode === "app_only") {
    const user = t.user ?? fromEmail;
    return `${GRAPH_SEND_BASE}/users/${encodeURIComponent(user)}/sendMail`;
  }
  return `${GRAPH_SEND_BASE}/me/sendMail`;
}

export function createGraphSender(fetchImpl: FetchLike = fetch, sleep?: (ms: number) => Promise<void>): GraphSender {
  const caches = new Map<string, TokenCache>();
  function tokensFor(t: GraphTransport): TokenCache {
    const key = `${t.mode}:${t.tenantId}:${t.clientId}:${t.refreshToken ?? ""}`;
    let cache = caches.get(key);
    if (!cache) {
      cache = new TokenCache(fetchImpl, tokenUrl(t.tenantId), tokenForm(t));
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
          url: sendUrl(transport, input.fromEmail),
          contentType: "text/plain",
          body: raw.toString("base64"),
          okStatus: GRAPH_ACCEPTED,
          label: `graph:${input.fromEmail}`,
        },
        sleep,
      );
    },
  };
}
