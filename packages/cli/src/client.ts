// Thin HTTP client for the agent-cold-email API — every command file below
// calls `request()` instead of touching `fetch` directly, so retry/error/
// base-URL handling lives in exactly one place.

export const DEFAULT_API_BASE = "https://agent-cold-email-api.yaakovscher.workers.dev";

export function apiBase(): string {
  const fromEnv = process.env.AGENT_COLD_EMAIL_API;
  return fromEnv ? fromEnv.replace(/\/$/, "") : DEFAULT_API_BASE;
}

export function resolveToken(flagToken?: string): string {
  const token = flagToken || process.env.AGENT_COLD_EMAIL_TOKEN;
  if (!token) {
    console.error("Missing bearer token. Pass --token <token> or set AGENT_COLD_EMAIL_TOKEN.");
    process.exit(1);
  }
  return token;
}

export interface RequestOptions {
  method?: string;
  token?: string;
  body?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = `${apiBase()}${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `request failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }

  return body as T;
}

export interface PollOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Exponential-backoff poll: calls `fn` until `isDone(result)` or attempts run out. */
export async function pollUntil<T>(fn: () => Promise<T>, isDone: (result: T) => boolean, opts: PollOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 4000;

  let result = await fn();
  for (let attempt = 0; attempt < maxAttempts && !isDone(result); attempt++) {
    const delayMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await fn();
  }
  return result;
}
