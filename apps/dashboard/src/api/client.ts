import { emitUnauthorized, type UnauthorizedReason } from "./unauthorizedBus";

const KNOWN_UNAUTHORIZED_REASONS: readonly UnauthorizedReason[] = ["invalid_token", "expired_session", "account_suspended"];

/** Backend gaps brief item 4 — every 401 body carries a machine-readable
 * `code` (apps/platform/src/require-auth.ts's AuthFailureCode) now. Falls
 * back to `invalid_token` for a missing/unrecognized code (a malformed or
 * unexpectedly-shaped response) rather than silently skipping the redirect —
 * the token-gate still needs to fire, just with the most neutral of the
 * three explanations. */
function parseUnauthorizedReason(body: unknown): UnauthorizedReason {
  const code = (body as { code?: unknown } | null)?.code;
  return KNOWN_UNAUTHORIZED_REASONS.includes(code as UnauthorizedReason) ? (code as UnauthorizedReason) : "invalid_token";
}

// SPEC.md §19.1 — every mutation carries X-Coldstart-Client: dashboard (the
// global CSRF guard requires it for any cookie-authed non-GET call); the
// dashboard never stores the bearer token or session id in JS-readable
// storage, it only relies on the httpOnly cookie the browser attaches via
// `credentials: "include"`. Same-origin (the SPA is served by the same
// Worker under /app/*), so no base URL is needed.
const MUTATING_HEADER = { "X-Coldstart-Client": "dashboard" } as const;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : `request failed (${status})`);
    this.name = "ApiError";
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** The token-gate's own login POST must NOT trigger the global
   * unauthorized-redirect on a 401 — that 401 IS the login form's own error
   * state, not a session drop. */
  suppressUnauthorizedRedirect?: boolean;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") Object.assign(headers, MUTATING_HEADER);

  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 401) {
    const data = await safeJson(res);
    if (!opts.suppressUnauthorizedRedirect) emitUnauthorized(parseUnauthorizedReason(data));
    throw new ApiError(401, data);
  }
  if (res.status === 409) {
    const data = await safeJson(res);
    throw new ApiError(409, data);
  }
  if (!res.ok) {
    const data = await safeJson(res);
    throw new ApiError(res.status, data);
  }
  if (res.status === 204) return undefined as T;
  return (await safeJson(res)) as T;
}
