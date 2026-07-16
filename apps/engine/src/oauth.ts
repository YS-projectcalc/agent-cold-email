import { UpstreamTransientError } from "./errors.js";
import { type FetchLike, truncate } from "./http.js";

// OAuth2 access-token cache for the HTTPS/443 send transports. One instance per
// mailbox grant (Gmail refresh-token, MS Graph delegated refresh-token, or MS
// Graph app-only client-credentials); the caller keys and reuses them so a burst
// of sends mints one token, not one per message. Any token-endpoint failure is a
// transient send failure (the Worker retries under its cap) — the same shape the
// SMTP path surfaces, so upstream retry accounting is unchanged.

// Refresh this far BEFORE the real expiry so an in-flight send never races the
// token going stale on the wire.
const EXPIRY_SKEW_MS = 60_000;
// Absent `expires_in`, assume the OAuth2 default (Google/Microsoft both ~1h).
const DEFAULT_TTL_SEC = 3600;

export class TokenCache {
  private cached?: { token: string; expiresAtMs: number };

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly tokenUrl: string,
    private readonly form: Record<string, string>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A valid access token, minting/refreshing on demand. `forceRefresh` bypasses
   * the cache — the caller uses it after a 401 (the cached token was rejected).
   */
  async get(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAtMs > this.now()) {
      return this.cached.token;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(this.form).toString(),
      });
    } catch (err) {
      throw new UpstreamTransientError(`oauth token request to ${this.tokenUrl} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new UpstreamTransientError(`oauth token request to ${this.tokenUrl} -> HTTP ${res.status}: ${truncate(text)}`);
    }
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new UpstreamTransientError(`oauth token response was not JSON: ${truncate(text)}`);
    }
    if (typeof parsed.access_token !== "string" || !parsed.access_token) {
      throw new UpstreamTransientError(`oauth token response missing access_token: ${truncate(text)}`);
    }
    const ttlSec = typeof parsed.expires_in === "number" ? parsed.expires_in : DEFAULT_TTL_SEC;
    this.cached = { token: parsed.access_token, expiresAtMs: this.now() + ttlSec * 1000 - EXPIRY_SKEW_MS };
    return parsed.access_token;
  }
}
