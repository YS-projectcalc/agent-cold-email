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
}

export const INBOXKIT_DEFAULT_BASE_URL = "https://api.inboxkit.com/v1/api";
export const INBOXKIT_VENDOR = "inboxkit";

// InboxKit is a plain JSON REST API (unlike the SMTP-bound engine client),
// so a much shorter bound than ENGINE_REQUEST_TIMEOUT_MS is appropriate — a
// stalled HTTP call should abort well before any caller-side retry/backoff
// budget is exhausted.
const REQUEST_TIMEOUT_MS = 30_000;

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

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          "x-workspace-id": this.config.workspaceId,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        // Bounds the wait so a stalled InboxKit call aborts (transient)
        // rather than hanging the caller indefinitely.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new VendorError(`inboxkit ${method} ${path} unreachable: ${err instanceof Error ? err.message : String(err)}`, true, {
        cause: err,
      });
    }

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw mapInboxKitError(res.status, body, `${method} ${path}`);
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
