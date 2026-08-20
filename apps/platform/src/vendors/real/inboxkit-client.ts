import { NotActivatedError, VendorError } from "@coldstart/shared";
import type { ZodType } from "zod";
import { mapInboxKitError } from "./inboxkit-errors.js";

/**
 * InboxKit workspace credentials (ACTIVATION.md Gate 0, founder ruling
 * 2026-07-20: "go inboxkit"). Injected from env at activation; absent in the
 * deployed build today, which keeps every InboxKit-backed adapter dark
 * (mirrors EngineClientConfig / real/email-port.ts).
 *
 * Auth (verified live 2026-07-20 against https://api.inboxkit.com/v1/api):
 * `Authorization: Bearer <apiKey>` — a raw JWT, no double "Bearer" prefixing
 * — plus `X-Workspace-Id: <workspaceId>` (a UUID, `GET /workspaces/list`) on
 * every call. Some endpoints (e.g. `GET /domains/available`) don't strictly
 * require the workspace header, but we send it unconditionally since most do
 * and there's no harm in the extra header on the ones that don't.
 */
export interface InboxKitClientConfig {
  apiKey: string;
  workspaceId: string;
  /** Override for tests; defaults to the real InboxKit API. */
  baseUrl?: string;
  /**
   * Injected in tests so the 429 backoff can be ASSERTED without a test ever
   * waiting (mirrors SendLogIo in apps/engine). Production never passes this.
   */
  sleep?: (ms: number) => Promise<void>;
}

export const INBOXKIT_DEFAULT_BASE_URL = "https://api.inboxkit.com/v1/api";
export const INBOXKIT_VENDOR = "inboxkit";

// InboxKit is a plain JSON REST API (unlike the SMTP-bound engine client),
// so a much shorter bound than ENGINE_REQUEST_TIMEOUT_MS is appropriate — a
// stalled HTTP call should abort well before any caller-side retry/backoff
// budget is exhausted.
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * S3 (docs/adversarial/scale-readiness-audit-2026-08-17.md) — RATE-LIMIT
 * COMPLIANCE. `ACTIVATION.md` records InboxKit's bulk limit as 10 req/min, which
 * is a 6-second window per request; one tenant provisioning 3 domains x 3
 * mailboxes is ~25-30 calls, and the audit measured contention at just TWO
 * concurrent checkouts. `mapInboxKitError` already graded 429 retryable — but
 * NOTHING retried, and `Retry-After` was read nowhere in the vendors tree, so
 * the 429 propagated straight out and failed the saga.
 *
 * WE BACK OFF ON THE VENDOR'S SIGNAL, NOT ON A LOCAL PACER. A fixed 6s-per-call
 * token bucket would make a normal checkout take three minutes, and it would
 * bake in a number the audit itself lists as UNVERIFIABLE ("InboxKit's current
 * live rate limit ... not re-verified against the vendor today"). Honoring the
 * 429 + Retry-After the vendor actually sends is correct whatever the real limit
 * is, and costs nothing when we are under it.
 *
 * WHAT THIS DOES NOT CLOSE: the audit's full fix is a shared serialized
 * provisioning queue in a single DO. The serialization below is per CLIENT
 * INSTANCE, so it bounds one request's burst; two tenants checking out in
 * different isolates still reach the vendor independently and rely on the 429
 * handling above to sort it out.
 */
export const INBOXKIT_MAX_ATTEMPTS = 3;

// Full-jitter base for the first retry when the vendor sends no Retry-After
// (doubling per attempt). Jittered because the concurrent checkouts that CAUSE
// the 429 would otherwise retry in lockstep and collide again.
const RETRY_BASE_DELAY_MS = 2_000;

// The longest we will hold a caller waiting for one retry. A vendor answering
// `Retry-After: 3600` is telling us to come back in an hour — waiting that out
// inside a checkout wedges the saga far worse than handing the caller a
// RETRYABLE refusal and letting its own layer decide.
const MAX_RETRY_WAIT_MS = 10_000;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before re-attempting, or `undefined` for "longer than we are
 * willing to hold the caller — give up now".
 *
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110); both are
 * seen in the wild, so both are read. An unparseable or past value falls back to
 * our own jittered backoff rather than to zero.
 */
function retryDelayMs(retryAfter: string | null, attempt: number, nowMs: number): number | undefined {
  const vendorMs = parseRetryAfterMs(retryAfter, nowMs);
  if (vendorMs !== undefined) return vendorMs > MAX_RETRY_WAIT_MS ? undefined : vendorMs;
  const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_WAIT_MS);
  return 1 + Math.floor(Math.random() * base); // full jitter, never 0
}

function parseRetryAfterMs(retryAfter: string | null, nowMs: number): number | undefined {
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter.trim());
  if (Number.isFinite(seconds)) return seconds <= 0 ? undefined : seconds * 1000;
  const at = Date.parse(retryAfter);
  if (Number.isNaN(at)) return undefined;
  const delta = at - nowMs;
  return delta <= 0 ? undefined : delta;
}

export interface InboxKitRequestOptions<T = unknown> {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /**
   * The RESPONSE contract, enforced (class F, docs/adversarial/
   * class-sweep-vendor-truth-2026-08-18.md). Without it `request<T>` ends in
   * `return body as T` — a compile-time model of the vendor's payload that
   * nothing checks at runtime, at every call site. That is not a theoretical
   * hole: `getHealth` destructured `bounce_rate`/`health_status`, which the live
   * response does not carry, and shipped `NaN` into a 0-1 rate and a fabricated
   * reputation score into a customer-facing field, with a green test pinning the
   * fiction.
   *
   * Supply one for every READ whose fields we act on. A parse failure is a
   * LOUD, graded `VendorError` naming the op, the path and the offending fields
   * — never a silent `undefined` propagating into arithmetic.
   *
   * WRITE the schema the way the adapter READS: require only the fields this
   * codebase both consumes AND has live-confirmed, leave everything else
   * optional. An over-strict schema turns a working vendor into an outage,
   * which is a worse failure than the one it is guarding against.
   */
  schema?: ZodType<T>;
}

/**
 * Thin authed JSON HTTP client for the InboxKit API. One instance per
 * adapter (RealMailboxPort / RealInboxKitDomainPort), both activation-gated
 * on the SAME `InboxKitClientConfig` (one vendor account, ACTIVATION.md Gate
 * 0). Stays dark (`NotActivatedError`) until both `apiKey` and `workspaceId`
 * are present — never reachable from the deployed default (factory.ts never
 * supplies a config today).
 */
export class InboxKitClient {
  constructor(private readonly config?: InboxKitClientConfig) {}

  /**
   * One request at a time per client instance (S3's concurrency bound). The
   * whole attempt sequence holds the slot INCLUDING its backoff waits — a call
   * that has just been told to slow down must not let the next one burst past
   * it into the same limit.
   *
   * The chain is re-armed RESOLVED after every task, so one rejection cannot
   * wedge every later call behind it.
   */
  private queue: Promise<unknown> = Promise.resolve();

  get isConfigured(): boolean {
    return Boolean(this.config?.apiKey && this.config?.workspaceId);
  }

  async request<T>(op: string, method: "GET" | "POST", path: string, opts: InboxKitRequestOptions<T> = {}): Promise<T> {
    if (!this.config?.apiKey || !this.config?.workspaceId) {
      throw new NotActivatedError(INBOXKIT_VENDOR, op);
    }

    const url = new URL(`${this.config.baseUrl ?? INBOXKIT_DEFAULT_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const run = () => this.attempt<T>(op, method, path, url, opts);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async attempt<T>(
    op: string,
    method: "GET" | "POST",
    path: string,
    url: URL,
    opts: InboxKitRequestOptions<T>,
  ): Promise<T> {
    const sleep = this.config?.sleep ?? realSleep;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config!.apiKey}`,
            "x-workspace-id": this.config!.workspaceId,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          // Bounds the wait so a stalled InboxKit call aborts (transient)
          // rather than hanging the caller indefinitely.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // DELIBERATELY NOT RETRIED — see the money rule below. A thrown fetch is
        // ambiguous: the request may have reached the vendor and been acted on.
        throw new VendorError(`inboxkit ${method} ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`, true, {
          cause: err,
        });
      }

      const body: unknown = await res.json().catch(() => undefined);
      if (!res.ok) {
        const error = mapInboxKitError(res.status, body, `${method} ${path}`);
        // THE MONEY RULE (S3). ONLY a 429 is re-sent. A 429 is an explicit
        // REFUSAL — the vendor did no work, so re-sending it cannot double-buy.
        // Every other failure is ambiguous in the one direction that costs real
        // money: a 502 or a dropped socket on `POST /mailboxes/buy` may well
        // have bought the mailbox, and InboxKit's buy endpoint carries no
        // idempotency key to collapse a duplicate. Those stay exactly as they
        // were — graded and thrown once, for the caller's own layer to decide.
        if (res.status !== 429 || attempt >= INBOXKIT_MAX_ATTEMPTS) throw error;
        const wait = retryDelayMs(res.headers.get("retry-after"), attempt, Date.now());
        // Longer than we will hold a caller: hand back the SAME graded error
        // (retryable, never permanent — the grading contract is untouched by
        // whether we happened to retry).
        if (wait === undefined) throw error;
        await sleep(wait);
        continue;
      }
      // A 200 whose body is empty, truncated or non-JSON — a CDN/proxy
      // interstitial — leaves `body` undefined, and every call site then evaluates
      // `body.error` / `body.subscriptions` on it. That threw a **TypeError**,
      // which is not a VendorError: error-response.ts fell through to a bare 500,
      // setup-terminality never saw it and vendor-failure.ts could not derive the
      // step. Graded here, once, for all fifteen call sites (canon finding 8).
      if (body === undefined) {
        throw shapeDriftError(op, method, path, "the response carried no parseable JSON body");
      }
      if (!opts.schema) return body as T;
      const parsed = opts.schema.safeParse(body);
      if (!parsed.success) {
        throw shapeDriftError(op, method, path, describeIssues(parsed.error));
      }
      return parsed.data;
    }
  }
}

/**
 * The vendor's response no longer matches the contract this adapter is coded
 * against.
 *
 * NOT retryable — the next call returns the same shape — and
 * OPERATOR-ACTIONABLE: a drifted vendor contract is cleared by someone updating
 * the adapter, after which the caller's same retry completes. Telling a
 * customer's agent to "check your inputs" for it would be false, and telling it
 * "retrying will never help" would be false the moment the adapter ships.
 *
 * The message names the op, the path and the offending fields because it is
 * read by an operator in the Worker log; the customer surface shows the
 * abstract step only (error-response.ts).
 */
function shapeDriftError(op: string, method: string, path: string, detail: string): VendorError {
  return new VendorError(`inboxkit ${op} (${method} ${path}) returned an unexpected response shape: ${detail}`, false, {
    operatorActionable: true,
  });
}

/** Zod issues as one operator-readable `path: message` list, bounded so a wildly-off payload can't flood the log. */
function describeIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const described = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const dropped = error.issues.length - MAX_REPORTED_ISSUES;
  return dropped > 0 ? `${described}; +${dropped} more` : described;
}

const MAX_REPORTED_ISSUES = 5;
