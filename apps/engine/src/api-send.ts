import { UpstreamTransientError } from "./errors.js";
import { type FetchLike, defaultSleep, truncate } from "./http.js";
import type { TokenCache } from "./oauth.js";

// One bearer-authed POST of a pre-serialized message to a provider send endpoint,
// shared by the Gmail and MS Graph adapters. Encapsulates the three cross-cutting
// behaviors the transports need identically:
//   - refresh-on-401: the cached access token was rejected → force one refresh
//     and retry once. A second 401 means the grant itself is bad (revoked/
//     misconfigured) — surfaced transient so the Worker retries under its cap
//     while the operator re-mints, matching the SMTP path's all-transient shape.
//   - bounded backoff on 429/5xx (honoring Retry-After), so a throttled provider
//     is retried a few times in-adapter before bubbling up.
//   - error mapping: EVERY unrecovered failure becomes UpstreamTransientError
//     (HTTP 503) — the exact shape nodemailerSender produces — so the engine
//     tick's retry/bounce accounting is unchanged across transports.
// The whole loop is bounded (one refresh + MAX_BACKOFF_RETRIES) and stays well
// under the Worker's engine-request timeout, itself under the reclaim TTL.

const MAX_BACKOFF_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;

export interface ApiSendSpec {
  /** Provider send endpoint. */
  url: string;
  /** Body media type: Gmail `application/json`, Graph `text/plain`. */
  contentType: string;
  /** Pre-serialized body (Gmail `{raw}` JSON, Graph base64 MIME). */
  body: string;
  /** Provider success status: Gmail 200, Graph 202. */
  okStatus: number;
  /** Prefix for thrown error messages, e.g. `gmail:sender@x`. */
  label: string;
}

export async function apiSend(
  fetchImpl: FetchLike,
  tokens: TokenCache,
  spec: ApiSendSpec,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  let refreshed = false;
  let backoffAttempt = 0;
  for (;;) {
    const token = await tokens.get();
    let res: Response;
    try {
      res = await fetchImpl(spec.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": spec.contentType },
        body: spec.body,
      });
    } catch (err) {
      throw new UpstreamTransientError(`${spec.label} send failed (network): ${(err as Error).message}`, { cause: err });
    }

    if (res.status === spec.okStatus) return;

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await tokens.get(true);
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && backoffAttempt < MAX_BACKOFF_RETRIES) {
      const wait = backoffFor(res, backoffAttempt);
      backoffAttempt++;
      await sleep(wait);
      continue;
    }

    const detail = await res.text().catch(() => "");
    throw new UpstreamTransientError(`${spec.label} send -> HTTP ${res.status}: ${truncate(detail)}`);
  }
}

function backoffFor(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}
