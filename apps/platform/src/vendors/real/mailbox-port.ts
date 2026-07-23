import { VendorError } from "@coldstart/shared";
import type { MailboxHealth, MailboxPort, ProvisionedMailbox, ReleaseResult } from "@coldstart/shared";
import { InboxKitClient, type InboxKitClientConfig } from "./inboxkit-client.js";

/**
 * Real MailboxPort — InboxKit (ACTIVATION.md Gate 0, founder ruling
 * 2026-07-20: "go inboxkit"; SPEC.md §11/§12 "primary = Inboxkit"). A genuine
 * HTTP client against `https://api.inboxkit.com/v1/api`, activation-gated
 * exactly like `real/email-port.ts`'s `RealEmailPort`: stays dark
 * (`NotActivatedError`, via `InboxKitClient`) until BOTH `apiKey` and
 * `workspaceId` are configured — with no config, the deployed default cannot
 * reach a live vendor. Even configured, the adapter factory only ever hands
 * this to a paid, activated tenant (factory.ts).
 *
 * Endpoint coverage (verified live/doc-captured 2026-07-20,
 * https://docs.inboxkit.com/):
 *  - provision   -> POST /mailboxes/buy
 *  - getHealth   -> POST /mailboxes/list (resolve email->uid) then
 *                   GET /email-insights/mailbox/{uid}/health
 *  - startWarmup -> POST /mailboxes/list (resolve uid) then POST /warmup/add
 *  - release     -> POST /mailboxes/list (resolve uid) then POST /mailboxes/cancel
 *
 * PROVISION IDEMPOTENCY (gate (c), adversary finding 3): InboxKit's
 * `/mailboxes/buy` has no idempotency-key parameter, so a redelivered
 * `setup_infrastructure` could double-charge a paid mailbox. The retry-safety
 * now lives at the CALLER (engine/provisioning.ts), which wraps this call in
 * the repo's own `withRequestIdempotency` (the same primitive that guards
 * launch_campaign/setup_infrastructure) keyed by the deterministic per-mailbox
 * `provision:mbx:...` key — so a re-run returns the recorded ProvisionedMailbox
 * WITHOUT a second vendor buy. This REPLACES the previous fragile
 * `/already exists/i` message-substring detection (a vendor wording change
 * would have silently broken it); provision() no longer inspects error text.
 *
 * KNOWN APPROXIMATION: `getHealth`'s `MailboxHealth` has fields InboxKit's
 * per-mailbox health endpoint does not expose directly (`complaintRate`,
 * `placementRate` — InboxKit only returns `bounce_rate`/`reply_rate`/send-
 * volume counters). See the method for the exact derivation and its caveats.
 */
export class RealMailboxPort implements MailboxPort {
  private readonly client: InboxKitClient;

  constructor(config?: InboxKitClientConfig) {
    this.client = new InboxKitClient(config);
  }

  async provision(domain: string, localPart: string, _idempotencyKey: string): Promise<ProvisionedMailbox> {
    const email = `${localPart}@${domain}`;
    const { firstName, lastName } = nameFromLocalPart(localPart);
    // Retry-safety is the CALLER's withRequestIdempotency wrap (gate (c), see the
    // class doc) — provision() no longer inspects vendor error text for
    // "already exists". A genuine vendor failure surfaces as a VendorError.
    const body = await this.client.request<BuyMailboxesResponse>("provision", "POST", "/mailboxes/buy", {
      body: {
        use_wallet_balance: true,
        mailboxes: [{ first_name: firstName, last_name: lastName, username: localPart, platform: "GOOGLE", domain_name: domain }],
      },
    });
    if (body.error || !Array.isArray(body.mailboxes) || body.mailboxes.length === 0) {
      throw new VendorError(`inboxkit mailboxes/buy did not return a mailbox for ${email}: ${body.message ?? "no message"}`, false);
    }
    return { email, provider: "google", provisionedAt: Date.now() };
  }

  async getHealth(email: string): Promise<MailboxHealth> {
    const uid = await this.resolveMailboxUid(email);
    const body = await this.client.request<MailboxHealthResponse>("getHealth", "GET", `/email-insights/mailbox/${uid}/health`);
    if (!body.success || !body.data) {
      throw new VendorError(`inboxkit mailbox health for ${email} returned no data`, false);
    }
    const { bounce_rate, health_status } = body.data;
    return {
      email,
      // InboxKit's `bounce_rate` is a percentage (docs examples show 1.8,
      // 22.3) — this port's contract is a 0-1 fraction.
      bounceRate: clamp01(bounce_rate / 100),
      // APPROXIMATION: InboxKit's health endpoint has no 0-100 reputation
      // score; derived from its coarse `health_status` enum instead.
      reputationScore: reputationScoreFromHealthStatus(health_status),
      // NOT EXPOSED by InboxKit's per-mailbox health payload (no complaint/
      // FBL signal in this endpoint) — see class doc comment.
      complaintRate: 0,
      // APPROXIMATION: no inbox-placement signal in this endpoint either;
      // proxied as the bounce-rate complement, pending a real placement-test
      // integration (InboxKit's separate `inbox-placement` product).
      placementRate: clamp01(1 - bounce_rate / 100),
    };
  }

  async startWarmup(email: string, _idempotencyKey: string): Promise<{ started: boolean; startedAt: number }> {
    const uid = await this.resolveMailboxUid(email);
    const body = await this.client.request<AddWarmupResponse>("startWarmup", "POST", "/warmup/add", {
      body: { mailbox_uids: [uid], activate_immediately: true },
    });
    const subscription = body.subscriptions?.[0];
    if (body.error || !subscription) {
      throw new VendorError(`inboxkit warmup/add did not create a subscription for ${email}: ${body.message ?? "no message"}`, false);
    }
    const startedAt = subscription.started_at ?? subscription.createdAt;
    return { started: true, startedAt: Date.parse(startedAt) };
  }

  async release(email: string, _idempotencyKey: string): Promise<ReleaseResult> {
    const uid = await this.resolveMailboxUid(email);
    const body = await this.client.request<CancelMailboxesResponse>("release", "POST", "/mailboxes/cancel", {
      body: { uids: [uid] },
    });
    if (body.error) {
      throw new VendorError(`inboxkit mailboxes/cancel failed for ${email}: ${body.message ?? "no message"}`, false);
    }
    return { released: true, releasedAt: Date.now() };
  }

  /**
   * Fetches a provisioned mailbox's IMAP (+ optional SMTP) credentials for the
   * self-serve I3 credential push (ROADMAP 2026-07-20 "GET show-mailbox-
   * credentials (full smtp+imap creds)"). The engine needs the IMAP endpoint to
   * read replies; the gmail_api SEND transport's OAuth grant comes separately
   * from the OAuth-mint seam (oauth-mint.ts), not from here.
   *
   * ⚠️ UNVERIFIED (no live calls in this build): the endpoint path + response
   * field names are a DOCUMENTED-SHAPE GUESS to confirm at the first live
   * mailbox. Dark until the InboxKitClient is configured (NotActivatedError).
   */
  async showMailboxCredentials(email: string): Promise<InboxKitMailboxCredentials> {
    const uid = await this.resolveMailboxUid(email);
    const body = await this.client.request<ShowCredentialsResponse>("showMailboxCredentials", "GET", `/mailboxes/${uid}/credentials`);
    const imap = body.imap ?? body.data?.imap;
    if (!imap || !imap.host || !imap.port || !imap.username || !imap.password) {
      throw new VendorError(`inboxkit show-mailbox-credentials for ${email} returned no usable IMAP credentials (UNVERIFIED response shape): ${body.message ?? "no message"}`, false);
    }
    const smtp = body.smtp ?? body.data?.smtp;
    return {
      imap: { host: imap.host, port: imap.port, secure: imap.secure ?? true, user: imap.username, pass: imap.password },
      smtp: smtp && smtp.host && smtp.port && smtp.username && smtp.password
        ? { host: smtp.host, port: smtp.port, secure: smtp.secure ?? true, user: smtp.username, pass: smtp.password }
        : undefined,
    };
  }

  /**
   * Resolves a mailbox's InboxKit `uid` from its email (POST /mailboxes/list?
   * keyword=).
   *
   * Gate (b) — EXACT-EMAIL assertion (adversary inboxkit-adapters-2026-07-20
   * finding 2): `/mailboxes/list?keyword=` is a keyword search whose exact-vs-
   * fuzzy semantics are UNVERIFIED, so trusting `mailboxes[0]` blind risks
   * resolving the WRONG mailbox — catastrophic for `release()`, which then
   * cancels a DIFFERENT paid mailbox (and wrong for getHealth/startWarmup/
   * showMailboxCredentials too). We reconstruct the matched mailbox's own
   * `username@domain_name` and require it to equal the requested email
   * (case-insensitive) before returning its uid; a fuzzy near-match fails LOUD
   * (permanent) rather than acting on the wrong mailbox. Enforced HERE (not just
   * before cancel) so every uid consumer is exact by construction.
   */
  private async resolveMailboxUid(email: string): Promise<string> {
    const body = await this.client.request<ListMailboxesResponse>("resolveMailboxUid", "POST", "/mailboxes/list", {
      body: { keyword: email, limit: 1 },
    });
    const match = body.mailboxes?.[0];
    if (!match?.uid) {
      throw new VendorError(`inboxkit has no mailbox matching ${email}`, false);
    }
    const resolvedEmail = `${match.username}@${match.domain_name}`;
    if (resolvedEmail.toLowerCase() !== email.toLowerCase()) {
      throw new VendorError(
        `inboxkit keyword search for ${email} returned a NON-EXACT match (${resolvedEmail}) — refusing to act on the wrong mailbox`,
        false,
      );
    }
    return match.uid;
  }
}

/** An SMTP/IMAP endpoint in the engine's per-mailbox credential shape (apps/engine config.ts). */
export interface MailboxEndpoint {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** What showMailboxCredentials returns — the IMAP endpoint (always) + SMTP (when the vendor exposes it). */
export interface InboxKitMailboxCredentials {
  imap: MailboxEndpoint;
  smtp?: MailboxEndpoint;
}

// UNVERIFIED response shape (see showMailboxCredentials). Both a top-level and
// a `data`-nested envelope are tolerated since InboxKit uses both across its API.
interface RawEndpoint {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
}
interface ShowCredentialsResponse {
  message?: string;
  imap?: RawEndpoint;
  smtp?: RawEndpoint;
  data?: { imap?: RawEndpoint; smtp?: RawEndpoint };
}

interface BuyMailboxesResponse {
  error: boolean;
  message?: string;
  mailboxes?: Array<{ uid: string; domain_name: string; username: string; status: string }>;
}

interface ListMailboxesResponse {
  error: boolean;
  message?: string;
  mailboxes?: Array<{ uid: string; domain_name: string; username: string; status: string }>;
}

interface MailboxHealthResponse {
  success: boolean;
  data?: {
    health_status: string;
    bounce_rate: number;
    reply_rate: number;
    sent_7d: number;
    received_7d: number;
    last_event_at: string;
  };
}

interface AddWarmupResponse {
  error: boolean;
  message?: string;
  subscriptions?: Array<{ uid: string; status: string; mailbox_email: string; started_at: string | null; createdAt: string }>;
}

interface CancelMailboxesResponse {
  error: boolean;
  message?: string;
}

/**
 * Derives InboxKit's required `first_name`/`last_name` mailbox-buy fields
 * from a localPart like "john.doe" — InboxKit's `MailboxPort.provision`
 * signature (domain, localPart) carries no separate name fields. Splits on
 * `.`/`_`/`-`; first token -> first name, remaining tokens joined -> last
 * name; falls back to "Mailbox"/"User" when the localPart has no separator.
 */
function nameFromLocalPart(localPart: string): { firstName: string; lastName: string } {
  const tokens = localPart.split(/[._-]+/).filter(Boolean);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const firstName = tokens[0] ? capitalize(tokens[0]) : "Mailbox";
  const lastName = tokens.length > 1 ? capitalize(tokens.slice(1).join(" ")) : "User";
  return { firstName, lastName };
}

function reputationScoreFromHealthStatus(status: string): number {
  switch (status) {
    case "healthy":
      return 90;
    case "warning":
      return 60;
    case "critical":
      return 30;
    default:
      return 50;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
