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
 * KNOWN GAP (flag for adversary/founder review before arming): InboxKit's
 * `/mailboxes/buy` has no idempotency-key parameter — the vendor API gives us
 * no at-least-once-safe primitive. `provision` mitigates the common retry
 * case (a redelivered `setup_infrastructure` call after a transient network
 * failure) by treating the vendor's own "already exists" business error as an
 * idempotent success, since the resulting email is fully deterministic from
 * (domain, localPart) regardless of vendor-side state. That does NOT cover
 * every failure window (e.g. the buy succeeded vendor-side but the response
 * never reached us before a hard timeout, or the response format changes) —
 * a true idempotency story here needs a persisted local record (out of scope
 * for this coded-but-dark adapter pass).
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
    try {
      const body = await this.client.request<BuyMailboxesResponse>("provision", "POST", "/mailboxes/buy", {
        body: {
          use_wallet_balance: true,
          mailboxes: [{ first_name: firstName, last_name: lastName, username: localPart, platform: "GOOGLE", domain_name: domain }],
        },
      });
      if (body.error || !Array.isArray(body.mailboxes) || body.mailboxes.length === 0) {
        throw new VendorError(`inboxkit mailboxes/buy did not return a mailbox for ${email}: ${body.message ?? "no message"}`, false);
      }
    } catch (err) {
      // See the KNOWN GAP doc comment above — an "already exists" business
      // error for THIS exact (domain, localPart) is treated as an idempotent
      // success, not a failure, since the resulting mailbox is the same one
      // this call would otherwise have created.
      if (err instanceof VendorError && /already exists/i.test(err.message)) {
        return { email, provider: "google", provisionedAt: Date.now() };
      }
      throw err;
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

  /** Resolves a mailbox's InboxKit `uid` from its email (POST /mailboxes/list?keyword=). */
  private async resolveMailboxUid(email: string): Promise<string> {
    const body = await this.client.request<ListMailboxesResponse>("resolveMailboxUid", "POST", "/mailboxes/list", {
      body: { keyword: email, limit: 1 },
    });
    const uid = body.mailboxes?.[0]?.uid;
    if (!uid) {
      throw new VendorError(`inboxkit has no mailbox matching ${email}`, false);
    }
    return uid;
  }
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
