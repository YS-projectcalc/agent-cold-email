// Tiny shared HTTP primitives for the HTTPS/443 send transports (gmail.ts,
// graph.ts, oauth.ts, api-send.ts). Kept in one place so the fetch type, the
// backoff sleep, and error-detail truncation are defined ONCE (CLAUDE.md rule c:
// no duplicated logic).

/** The global `fetch`, injectable so tests mock the HTTP layer (no live net). */
export type FetchLike = typeof fetch;

/** Real timer sleep for bounded backoff; tests inject a no-op to stay instant. */
export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bound an untrusted upstream error body before it lands in a thrown message. */
export function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
