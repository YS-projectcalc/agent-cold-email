import { NotActivatedError, VendorError } from "@coldstart/shared";
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

export interface InboxKitRequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
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

  async request<T>(op: string, method: "GET" | "POST", path: string, opts: InboxKitRequestOptions = {}): Promise<T> {
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
    return body as T;
  }
}
