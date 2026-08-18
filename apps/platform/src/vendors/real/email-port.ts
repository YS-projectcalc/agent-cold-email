import { NotActivatedError, VendorError } from "@coldstart/shared";
import type { EmailPort, PollResult, SendEmailInput, SendEmailResult } from "@coldstart/shared";

/**
 * Address of the external engine (apps/engine) — the off-Worker Go/Node SMTP/IMAP
 * daemon (ARCHITECTURE.md #6). Injected from env at activation; absent in the
 * deployed build, which keeps this adapter dark.
 */
export interface EngineClientConfig {
  baseUrl: string;
  authSecret: string;
}

/**
 * Real EmailPort — an HTTP client to the external engine (apps/engine),
 * activation-gated. It stays a coded-but-inert stub until BOTH `ENGINE_BASE_URL`
 * and `ENGINE_AUTH_SECRET` are set (see env.ts / factory.ts): with no config it
 * throws NotActivatedError exactly like every other real/ adapter, so the
 * deployed default cannot reach a live mail server. Even when configured, the
 * adapter factory only ever hands it to a paid, activated tenant — a demo/free
 * tenant is structurally forced to sandbox first (factory.ts).
 *
 * Errors are re-graded from the engine's HTTP status into a VendorError the
 * engine tick (apps/platform/src/engine/tick.ts) branches on: a 5xx / network
 * failure is TRANSIENT (retryable — the tick retries under its attempt cap); a
 * 4xx is PERMANENT (retryable:false — fail fast, never loop) EXCEPT the
 * operator-fixable / in-flight statuses in RETRYABLE_ENGINE_STATUSES. This
 * mirrors the engine-side taxonomy (apps/engine/src/errors.ts).
 */

// A request to the engine is bounded so a stalled engine/SMTP socket can't hang
// the tick indefinitely — an aborted fetch surfaces as a RETRYABLE VendorError
// (the tick reverts the row and retries under its cap).
//
// THE ORDERING LADDER. Five rungs, every one of them load-bearing; changing any
// constant means re-deriving all of them (adversary round-2 R5 found the ladder
// silently violated the moment the wave-2 cron leg added a per-tenant budget):
//
//   ~100s   engine worst-case SMTP transaction (20s connect + 20s greeting +
//           60s socket, apps/engine/src/smtp.ts)
//     <  ENGINE_REQUEST_TIMEOUT_MS (120s)   — a merely-slow send must not be
//           aborted mid-flight by us
//     <  SEND_PIPELINE_TENANT_BUDGET_MS (135s, admin/ops-sweep.ts) — R5's rung:
//           a tenant's cron budget must fit at least ONE complete engine
//           request, or it is abandoned having done zero work on every cycle
//     <= SEND_PIPELINE_LEG_DEADLINE_MS (150s) — the leg must be able to spend
//           one whole tenant budget
//     +  one budget (285s total worst case) < the 300s cron period — the leg
//           checks its deadline BETWEEN tenants, so its true worst case is
//           deadline + one budget; keeping that under the period is what stops
//           a wedged engine making every sweep overlap the next one
//     <  SEND_CLAIM_TTL_MS (5 min, engine/tick.ts) — the original rung: a
//           send's row must resolve or abort BEFORE it is reclaim-eligible, so
//           a reclaim can never race a still-live fetch
//
// This value came DOWN from 180s to satisfy rung 3 while leaving rung 1 intact.
// The adversary's suggested ~45s would have broken rung 1 (it sits below the
// engine's own worst-case SMTP transaction), which would abort genuinely slow
// but succeeding sends; 120s is the largest reduction that satisfies every rung
// at once. test/send-pipeline-budget.test.ts's "R5" describe asserts the whole
// ladder so the next constant change cannot quietly re-open R5's incoherence.
export const ENGINE_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

// 4xx statuses the tick should RETRY rather than terminally fail:
//   409 — a send with this idempotency key is already in flight on the engine
//         (its in-flight claim). A retry lands after that send records its
//         result and returns the SAME Message-ID from cache — never a 2nd send.
//   422 — unknown mailbox: the operator adds the mailbox to the engine creds
//         file, after which a retry succeeds. Terminal-failing here would burn
//         the whole due queue (no requeue path) on a fixable misconfiguration.
// DELIBERATELY NOT here: 424 SendUnverifiedError (engine pre-send intent log,
// apps/engine/src/errors.ts) — a key whose prior dispatch is durably dangling or
// parked (a crash after the transport accepted but before recordSend). It grades
// PERMANENT so the row lands terminal 'failed' + an ops event: the governing rule
// is DROP one send rather than ever duplicate one, and a retry could double-send.
// Operator recovery is campaign-level (a new row/key), not a tick requeue.
const RETRYABLE_ENGINE_STATUSES = new Set([409, 422]);

export class RealEmailPort implements EmailPort {
  constructor(private readonly config?: EngineClientConfig) {}

  async send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult> {
    const body = await this.call("/v1/send", { input, idempotencyKey });
    if (typeof body?.messageId !== "string" || typeof body?.sentAt !== "number") {
      throw new VendorError("engine /v1/send returned a malformed SendEmailResult", false);
    }
    return { messageId: body.messageId, sentAt: body.sentAt };
  }

  async poll(mailboxEmail: string, sinceCursor: number): Promise<PollResult> {
    const body = await this.call("/v1/poll", { mailboxEmail, sinceCursor });
    if (!Array.isArray(body?.events) || typeof body?.cursor !== "number") {
      throw new VendorError("engine /v1/poll returned a malformed PollResult", false);
    }
    // `unreadable` is carried across the boundary, never dropped: it is the
    // engine's report that it permanently skipped a message to un-block this
    // mailbox (IN-7), and the consumer is what records that loss.
    return {
      events: body.events as PollResult["events"],
      cursor: body.cursor,
      unreadable: typeof body.unreadable === "number" ? body.unreadable : 0,
    };
  }

  /**
   * One authed POST to the engine. `fn`-level network failures and 5xx are
   * retryable VendorErrors; 4xx are permanent. Never reached unless `config` is
   * present — an absent config throws NotActivatedError (the dark default).
   */
  private async call(path: string, payload: unknown): Promise<{ [k: string]: unknown }> {
    if (!this.config?.baseUrl || !this.config?.authSecret) {
      throw new NotActivatedError("cold-engine", path === "/v1/send" ? "send" : "poll");
    }
    // Defense in depth (ACTIVATION.md mandates HTTPS before real tenant traffic):
    // the bearer secret must never cross a cleartext link. Permanent failure —
    // a misconfigured plaintext URL can't be fixed by retrying. localhost is
    // exempt so a same-host / tunnel-terminated bootstrap can use http.
    if (!isSecureEngineUrl(this.config.baseUrl)) {
      throw new VendorError(`ENGINE_BASE_URL must be https (or localhost): ${this.config.baseUrl}`, false);
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.authSecret}`,
        },
        body: JSON.stringify(payload),
        // Bound the wait so a stalled engine/socket aborts (transient) rather
        // than hanging the tick past the reclaim TTL — see ENGINE_REQUEST_TIMEOUT_MS.
        signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure or a timeout abort (DNS, connection reset, the
      // AbortSignal firing) — transient; the tick retries under its cap.
      throw new VendorError(`engine unreachable at ${path}: ${err instanceof Error ? err.message : String(err)}`, true, {
        cause: err,
      });
    }

    if (res.ok) {
      return (await res.json()) as { [k: string]: unknown };
    }

    const detail = await res.text().catch(() => "");
    // 5xx = transient (retry under the tick's cap); 4xx = permanent (fail fast)
    // EXCEPT the operator-fixable / in-flight statuses graded retryable above.
    const retryable = res.status >= 500 || RETRYABLE_ENGINE_STATUSES.has(res.status);
    throw new VendorError(`engine ${path} -> HTTP ${res.status}: ${detail}`, retryable);
  }
}

/** https required, except a localhost/loopback bootstrap (see call()). Shared with the I3 credential-push client. */
export function isSecureEngineUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}
