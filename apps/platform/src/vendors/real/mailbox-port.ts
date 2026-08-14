import { VendorError } from "@coldstart/shared";
import type {
  CancelWarmupResult,
  MailboxHealth,
  MailboxPort,
  MailboxReadiness,
  ProvisionedMailbox,
  ReleaseResult,
} from "@coldstart/shared";
import { InboxKitClient, type InboxKitClientConfig } from "./inboxkit-client.js";
import { classifyVendorLifecycle, normalizeLifecycleToken } from "./vendor-lifecycle.js";

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
 *  - provisioningState -> POST /mailboxes/list (is the async buy done yet?)
 *  - getHealth   -> POST /mailboxes/list (resolve email->uid) then
 *                   GET /email-insights/mailbox/{uid}/health
 *  - startWarmup -> POST /mailboxes/list (resolve uid) then POST /warmup/add
 *  - cancelWarmup-> POST /mailboxes/list (resolve uid) then POST /warmup/cancel
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

  /**
   * Vendor-side progress of the ASYNC buy (INCIDENT 2026-08-05, L2). /mailboxes/buy
   * answers "Mailbox scheduled to be assigned to domains successfully" with
   * `status: "scheduled"` — the order is ACCEPTED, the mailbox does not exist
   * yet — and every other method here starts with `resolveMailboxUid`, which
   * throws PERMANENTLY while the mailbox is unlistable. Provisioning used to run
   * startWarmup on the next line, so a vendor that hadn't caught up wedged the
   * whole saga.
   *
   * STATUS TOKENS (vendor-lifecycle.ts holds the one vocabulary): 'active' is
   * the only value read as ready. Same asymmetry as the domain readiness
   * allowlist: guessing "not ready" costs a retry, guessing "ready" enrolls a
   * paid warmup subscription for a mailbox that may never exist.
   *
   * ⚠ THE MAILBOX HALF OF THE VENDOR-VERDICT CLASS (docs/adversarial/
   * vendor-verdict-class-sweep-2026-08-14.md). This used to map EVERY non-active
   * token onto 'pending', so a suspended / cancelled / failed mailbox reported
   * "still being created" and engine/mailbox-provisioning.ts's awaitMailboxReady
   * threw a RETRYABLE "the provider is still working on it" for it forever. A
   * terminal token now gets its own verdict, and the engine turns that into a
   * non-retryable, actionable failure instead of an endless wait.
   */
  async provisioningState(email: string): Promise<MailboxReadiness> {
    const found = await this.findExactMailbox(email);
    if (found.kind !== "found") return found;
    switch (classifyVendorLifecycle(found.mailbox.status)) {
      case "live":
        return { kind: "ready" };
      case "terminal":
        return { kind: "terminal", vendorState: normalizeLifecycleToken(found.mailbox.status) };
      case "pending":
        return { kind: "not_yet" };
      case "unknown":
        // Unrecognized token: NOT terminal (the live vocabulary is unverified —
        // hard-failing a healthy mailbox on a token we have not seen is the one
        // mistake worse than waiting). Every caller grades this exactly like
        // 'not_yet', and neither one ever authorizes a second purchase.
        return {
          kind: "inconclusive",
          reason: `unrecognized provider mailbox status "${normalizeLifecycleToken(found.mailbox.status)}"`,
        };
    }
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
    // FAIL LOUD ON A NON-FINITE PARSE (adversary N2). `Date.parse` returns NaN
    // for a missing/unrecognized value, and this number is written straight
    // into `mailboxes.warmup_started_at` — the ramp's only anchor. A NaN or
    // absent anchor makes the ramp math read "fully warmed" (cap 40/day, and
    // send-ready, which also makes the warmup-cancel sweep cancel the paid
    // subscription immediately) for a mailbox that has never sent anything.
    // A retryable VendorError here costs one retry; guessing costs the
    // mailbox's reputation on its first day.
    //
    // NON-retryable, matching the malformed-response throw in provision() above:
    // the subscription has ALREADY been created and billed by the time we parse
    // this, and a vendor whose date format we cannot read answers the retry the
    // same way — so a retryable grade would enrol (and charge for) a fresh
    // subscription on every attempt. Loud and once is the right shape here.
    const startedAtMs = Date.parse(startedAt);
    if (!Number.isFinite(startedAtMs)) {
      throw new VendorError(
        `inboxkit warmup/add returned an unparseable start time for ${email}: ${JSON.stringify(startedAt)}`,
        false,
      );
    }
    return { started: true, startedAt: startedAtMs };
  }

  /**
   * Cancels the mailbox's warmup-pool subscription at ramp completion (founder
   * ruling 2026-08-02, ROADMAP.md:25) — POST /warmup/cancel, documented at
   * docs.inboxkit.com/cancel-warmup-for-mailboxes-28170231e0 (contract captured
   * 2026-08-02): body `{mailbox_uids: [...]}` (1-100), and "active warmups will
   * be stopped before cancellation" so no separate pause call is needed. The
   * sibling pause/resume/list endpoints are deliberately NOT wired — this
   * platform only ever cancels.
   *
   * PARTIAL FAILURE: the endpoint answers 200 for a BATCH and reports per-
   * mailbox outcomes ("Processed N mailbox(es): N cancelled, N failed"), so a
   * 200 alone does not mean OUR mailbox was cancelled. We send exactly one uid
   * and require it back in `results.success`.
   *
   * IDEMPOTENCY (adversary N-d, 2026-08-02). Absence from `results.success` is
   * AMBIGUOUS: it covers both "the cancel failed" and "there was nothing left
   * to cancel because a previous attempt already succeeded". Treating it as
   * failure broke this method's own port contract ("safe to invoke more than
   * once") and mis-graded the crash-between-vendor-200-and-marker-write retry —
   * the engine would burn its whole attempt budget and file a FALSE
   * "may still be billing" give-up for an already-cancelled subscription.
   * Disambiguated by ASKING the vendor (`hasActiveWarmupSubscription` below)
   * rather than by matching error text — this adapter already deleted one
   * `/already exists/i` substring match for being fragile. No active
   * subscription for this mailbox means the goal state holds, whoever achieved
   * it, so we report success. Only a still-ACTIVE subscription (or an
   * inconclusive lookup) throws, and RETRYABLE — a batch-level failure is far
   * more likely transient than permanent, and the engine's sweep re-attempts on
   * the next cron pass without blocking sends.
   */
  async cancelWarmup(email: string, _idempotencyKey: string): Promise<CancelWarmupResult> {
    const uid = await this.resolveMailboxUid(email);
    const body = await this.client.request<CancelWarmupResponse>("cancelWarmup", "POST", "/warmup/cancel", {
      body: { mailbox_uids: [uid] },
    });
    if (!body.error && (body.results?.success?.some((r) => r.mailbox_uid === uid) ?? false)) {
      return { cancelled: true, cancelledAt: Date.now() };
    }

    const state = await this.warmupSubscriptionState(uid, email);
    if (state === "absent") return { cancelled: true, cancelledAt: Date.now() };
    throw new VendorError(
      `inboxkit warmup/cancel did not cancel ${email} (uid ${uid}), and its subscription is still ${state}: ${body.message ?? "no message"}`,
      true,
    );
  }

  /**
   * Whether this mailbox still has an ACTIVE warmup subscription — the
   * disambiguator for `cancelWarmup` above. POST /v1/api/warmup/list, contract
   * captured from docs.inboxkit.com/list-warmup-subscriptions-28170226e0
   * (2026-08-02): body `{page, limit, status, include_cancelled}`, response
   * `{error, message, subscriptions[], total, pages, current_page, limit}`,
   * each subscription carrying `mailbox_email` and a nested `mailbox.uid`.
   *
   * The documented body params expose no per-mailbox filter, so this pages
   * through the workspace's ACTIVE subscriptions and matches on either
   * identifier. `"inconclusive"` (a vendor error, or more pages than
   * MAX_SUBSCRIPTION_PAGES) is deliberately NOT folded into `"absent"`: an
   * unfinished search proves nothing, and reporting a cancel that never
   * happened would silently leak a recurring charge — the one outcome worth
   * failing loudly for. Caller retries on anything but a definite `"absent"`.
   */
  private async warmupSubscriptionState(uid: string, email: string): Promise<"active" | "absent" | "inconclusive"> {
    for (let page = 1; page <= MAX_SUBSCRIPTION_PAGES; page++) {
      let body: ListWarmupSubscriptionsResponse;
      try {
        body = await this.client.request<ListWarmupSubscriptionsResponse>("warmupSubscriptionState", "POST", "/warmup/list", {
          body: { page, limit: SUBSCRIPTION_PAGE_SIZE, status: "active", include_cancelled: false },
        });
      } catch {
        return "inconclusive"; // the lookup itself failed — prove nothing
      }
      if (body.error) return "inconclusive";

      const subscriptions = body.subscriptions ?? [];
      const match = subscriptions.some(
        (s) => s.mailbox?.uid === uid || (s.mailbox_email ?? "").toLowerCase() === email.toLowerCase(),
      );
      if (match) return "active";
      // Last page reached (or the vendor returned a short/empty page): the
      // active set has been fully walked without a match.
      if (subscriptions.length === 0 || page >= (body.pages ?? 1)) return "absent";
    }
    return "inconclusive"; // more pages than we are willing to walk
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
    const found = await this.findExactMailbox(email);
    if (found.kind === "absent") {
      throw new VendorError(`inboxkit has no mailbox matching ${email}`, false);
    }
    if (found.kind === "inconclusive") {
      // The lookup did not answer, which is not the same as "no such mailbox".
      // RETRYABLE, unlike the definite absence above: a permanent grade here
      // would abandon a mailbox that exists because one list call had a bad day.
      // The op token stays in the message so vendor-failure.ts derives the
      // abstract step exactly as it does for every other throw in this adapter.
      throw new VendorError(`inboxkit mailboxes/list could not resolve ${email}: ${found.reason}`, true);
    }
    return found.mailbox.uid;
  }

  /**
   * The single keyword lookup + exactness check behind `resolveMailboxUid` and
   * `provisioningState`. The caller decides what each outcome means — a uid
   * consumer treats 'absent' as a hard error, the provisioning poll treats it as
   * "the vendor holds nothing". A NON-EXACT hit still throws from HERE, for both
   * callers: acting on a near-match is catastrophic (release() would cancel a
   * DIFFERENT paid mailbox) and reading one as "provisioned" would confirm a
   * mailbox we never bought.
   *
   * ⚠ THE ERRORED-BODY HOLE (found during the vendor-verdict class fix,
   * 2026-08-14; same class, mailbox half). InboxKitClient only rejects on a
   * non-2xx HTTP status, and this endpoint answers 200 with `{error: true,
   * message: ...}` for a workspace-level failure — which left `body.mailboxes`
   * undefined and made this function return "the vendor lists nothing". 'absent'
   * is the ONE verdict that feeds the automatic re-buy authorization
   * (engine/mailbox-acquisition.ts), so a bad list response could buy a second
   * paid mailbox for an address the vendor already held. A failed lookup proves
   * nothing and is now 'inconclusive'. (`/domains/list` already checked
   * `body.error` — this is the sibling that did not.)
   */
  private async findExactMailbox(email: string): Promise<FoundMailbox> {
    const body = await this.client.request<ListMailboxesResponse>("resolveMailboxUid", "POST", "/mailboxes/list", {
      body: { keyword: email, limit: 1 },
    });
    if (body.error) {
      return { kind: "inconclusive", reason: `provider mailbox lookup failed: ${body.message ?? "no message"}` };
    }
    const match = body.mailboxes?.[0];
    if (!match?.uid) return { kind: "absent" };
    const resolvedEmail = `${match.username}@${match.domain_name}`;
    if (resolvedEmail.toLowerCase() !== email.toLowerCase()) {
      throw new VendorError(
        `inboxkit keyword search for ${email} returned a NON-EXACT match (${resolvedEmail}) — refusing to act on the wrong mailbox`,
        false,
      );
    }
    return { kind: "found", mailbox: { uid: match.uid, status: match.status } };
  }
}

/**
 * `findExactMailbox`'s three outcomes. 'absent' and 'inconclusive' are the SAME
 * two arms `MailboxReadiness` carries, deliberately: they are the pair whose
 * conflation is the class defect, and keeping them apart at the innermost
 * lookup is what stops either caller from re-collapsing them.
 */
type FoundMailbox =
  | { kind: "found"; mailbox: { uid: string; status?: string } }
  | { kind: "absent" }
  | { kind: "inconclusive"; reason: string };

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

// POST /warmup/cancel (contract captured from docs.inboxkit.com 2026-08-02).
// `message` is a human summary ("Processed 1 mailbox(es): 1 cancelled, 0
// failed"); the machine-readable per-mailbox outcome is `results.success[]`,
// which is what cancelWarmup actually branches on — never the message text
// (this adapter already removed one message-substring match, see the class doc).
interface CancelWarmupResponse {
  error: boolean;
  message?: string;
  results?: { success?: Array<{ mailbox_uid: string; subscription_uid: string; action: string }> };
}

// POST /warmup/list (contract captured from docs.inboxkit.com 2026-08-02) —
// the already-cancelled disambiguator for cancelWarmup. Paginated; each entry
// carries the subscription's own `uid` plus the owning mailbox's email and uid.
interface ListWarmupSubscriptionsResponse {
  error: boolean;
  message?: string;
  subscriptions?: Array<{ uid: string; status: string; mailbox_email?: string; mailbox?: { uid?: string } }>;
  total?: number;
  pages?: number;
  current_page?: number;
}

// Page size + walk ceiling for warmupSubscriptionState. The ceiling exists so a
// very large workspace can never turn one cancel into an unbounded crawl; at
// 100/page it covers 1,000 active subscriptions, far beyond the InboxKit plan
// sizes this platform provisions against (INBOXKIT_PLAN_SLOTS).
const SUBSCRIPTION_PAGE_SIZE = 100;
const MAX_SUBSCRIPTION_PAGES = 10;

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
