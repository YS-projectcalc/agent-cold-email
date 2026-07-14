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
// (the tick reverts the row and retries under its cap). MUST stay below the
// stuck-'sending' reclaim TTL (SEND_CLAIM_TTL_MS = 5 min, engine/tick.ts): the
// send's row must resolve or abort BEFORE it is eligible for reclaim, so a
// reclaim can never race a still-live fetch. Also above the engine's worst-case
// SMTP time (~100s, apps/engine/src/smtp.ts) so a merely-slow send isn't aborted.
const ENGINE_REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

// 4xx statuses the tick should RETRY rather than terminally fail:
//   409 — a send with this idempotency key is already in flight on the engine
//         (its in-flight claim). A retry lands after that send records its
//         result and returns the SAME Message-ID from cache — never a 2nd send.
//   422 — unknown mailbox: the operator adds the mailbox to the engine creds
//         file, after which a retry succeeds. Terminal-failing here would burn
//         the whole due queue (no requeue path) on a fixable misconfiguration.
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
    return { events: body.events as PollResult["events"], cursor: body.cursor };
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

/** https required, except a localhost/loopback bootstrap (see call()). */
function isSecureEngineUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}
