import { VendorError } from "@coldstart/shared";

/**
 * InboxKit error-envelope mapping. TWO distinct shapes were observed live
 * (verified 2026-07-20 against `https://api.inboxkit.com/v1/api`):
 *
 *  - Gateway/auth-layer errors (bad/malformed JWT, unknown route) — a bare
 *    `{code, message}`, e.g. `401 {"code":401,"message":"jwt malformed"}` or
 *    `404 {"code":404,"message":"Not found"}`. These never reach the app's own
 *    business logic (no `error` field at all).
 *  - App-level business errors on a known, authenticated route —
 *    `{error: true, message}`, e.g.
 *    `409 {"error":true,"message":"Mailbox john.doe@example.com already exists"}`
 *    (per docs.inboxkit.com's per-endpoint response examples).
 *
 * Both shapes carry a plain `message` string, so extraction doesn't need to
 * branch on which envelope it is — only the HTTP status matters for the
 * transient-vs-permanent grade: 5xx or 429 (InboxKit's documented bulk-
 * provisioning rate limit, ACTIVATION.md) are TRANSIENT/retryable; every
 * other 4xx is PERMANENT (fail fast — matches the RealEmailPort convention
 * in real/email-port.ts).
 */
export function mapInboxKitError(status: number, body: unknown, context: string): VendorError {
  const retryable = status >= 500 || status === 429;
  const message = extractMessage(body) ?? `HTTP ${status} with no parseable error body`;
  return new VendorError(`inboxkit ${context} -> HTTP ${status}: ${message}`, retryable);
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : undefined;
}
