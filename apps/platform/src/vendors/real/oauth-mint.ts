import { VendorError } from "@coldstart/shared";
import type { InboxKitClient } from "./inboxkit-client.js";

/**
 * gmail_api send-transport grant for one mailbox — the per-mailbox OAuth2
 * refresh-token credential the engine needs to send over 443 (apps/engine
 * config.ts's gmailTransportSchema). This is the SECRET the push-to-droplet
 * architecture keeps off the internet-facing Worker: minted here, pushed to
 * the engine, never durably stored Worker-side.
 */
export interface GmailGrant {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface MailboxRef {
  email: string;
  domain: string;
}

/**
 * The OAuth-mint seam (self-serve activation I3c). A provisioned InboxKit
 * mailbox needs a gmail_api refresh token before the engine can send as it;
 * there are two ways to get one, behind ONE interface so the provisioning flow
 * doesn't care which is wired:
 *   - MANUAL — an operator mints the refresh token once (the proven 2026-07-19
 *     pilot path) and supplies it; used for the first pilot where one manual
 *     mint per mailbox is fine.
 *   - PROGRAMMATIC — InboxKit's client-id-request flow registers our Google
 *     OAuth client on the provisioned Workspace domain and grants consent,
 *     yielding a refresh token at fleet scale. DARK + UNVERIFIED until a live
 *     mailbox exists (ROADMAP 2026-07-20 Mordy-pilot entry).
 */
export interface OAuthMinter {
  readonly kind: "manual" | "inboxkit";
  mintGmailGrant(mailbox: MailboxRef): Promise<GmailGrant>;
}

/**
 * Operator-supplied grants (the proven manual path). Grants are keyed by
 * mailbox email and injected at arming (an operator runs Google's consent flow
 * once per mailbox and hands over the refresh token) — never defaulted, never
 * in code/git. A request for a mailbox with no supplied grant fails LOUD
 * (permanent) so a missing manual mint surfaces at provisioning, not as a
 * silent no-send later.
 */
export class ManualOAuthMinter implements OAuthMinter {
  readonly kind = "manual" as const;
  constructor(private readonly grants: Readonly<Record<string, GmailGrant>>) {}

  async mintGmailGrant(mailbox: MailboxRef): Promise<GmailGrant> {
    const grant = this.grants[mailbox.email];
    if (!grant) {
      throw new VendorError(`no manually-minted gmail_api grant supplied for ${mailbox.email} — mint its refresh token and supply it at arming`, false);
    }
    return grant;
  }
}

// InboxKit's programmatic OAuth endpoints (ROADMAP 2026-07-20). These register
// OUR existing Google OAuth client onto the mailbox's provisioned Workspace
// domain, then grant consent to yield a refresh token. ⚠️ UNVERIFIED — the
// exact request/response field names are a DOCUMENTED-SHAPE GUESS captured from
// the endpoint names only; verify empirically at the first live mailbox (no
// live calls are permitted in this build). The seam + call sequence is real;
// the field mapping is what the first live mailbox confirms.
const CLIENT_ID_REQUEST_INITIATE = "/mailboxes/client-id-request/initiate";
const CONSENT_REQUEST_INITIATE = "/mailboxes/client-id-request/initiate-consent-request";

interface ConsentResponse {
  error?: boolean;
  message?: string;
  refresh_token?: string;
  refreshToken?: string;
  client_secret?: string;
  clientSecret?: string;
}

/**
 * Programmatic InboxKit refresh-token minting (the fleet path). DARK: reachable
 * only when the InboxKitClient is configured (arming), which it never is in the
 * deployed build. UNVERIFIED — see the endpoint-constant comment. `oauthClientId`
 * is OUR Google OAuth client id, registered onto the mailbox's Workspace domain.
 */
export class InboxKitOAuthMinter implements OAuthMinter {
  readonly kind = "inboxkit" as const;
  constructor(
    private readonly client: InboxKitClient,
    private readonly oauthClientId: string,
    private readonly oauthClientSecret: string,
  ) {}

  async mintGmailGrant(mailbox: MailboxRef): Promise<GmailGrant> {
    // 1. Register our OAuth client id onto the mailbox's Workspace domain.
    await this.client.request("mintGmailGrant.clientIdRequest", "POST", CLIENT_ID_REQUEST_INITIATE, {
      body: { client_id: this.oauthClientId, domain_name: mailbox.domain, mailbox_email: mailbox.email },
    });
    // 2. Grant consent -> refresh token.
    const consent = await this.client.request<ConsentResponse>("mintGmailGrant.consentRequest", "POST", CONSENT_REQUEST_INITIATE, {
      body: { client_id: this.oauthClientId, domain_name: mailbox.domain, mailbox_email: mailbox.email },
    });
    const refreshToken = consent.refresh_token ?? consent.refreshToken;
    if (!refreshToken) {
      // Fail LOUD rather than push a mailbox that can never send — the response
      // shape differed from the documented guess (verify at first live mailbox).
      throw new VendorError(`inboxkit consent for ${mailbox.email} returned no refresh token (UNVERIFIED response shape): ${consent.message ?? "no message"}`, false);
    }
    return {
      clientId: this.oauthClientId,
      clientSecret: consent.client_secret ?? consent.clientSecret ?? this.oauthClientSecret,
      refreshToken,
    };
  }
}
