// Engine-side error taxonomy. Each error carries an HTTP status the server maps
// it to; the Worker's RealEmailPort then re-derives a transient-vs-permanent
// VendorError grade from that status (retryable 5xx vs permanent 4xx), so the
// engine tick's per-send retry logic (apps/platform/src/engine/tick.ts) branches
// correctly. This mirrors @coldstart/shared's VendorError contract across the
// process boundary without the engine runtime-depending on the Worker package.

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "invalid or missing engine auth token") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class BadRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/**
 * The requested mailbox has no credentials configured on this engine. PERMANENT
 * (422): retrying can never succeed until the mailbox is provisioned into the
 * engine's config, so the Worker must fail fast, not loop.
 */
export class UnknownMailboxError extends Error {
  readonly status = 422;
  constructor(email: string) {
    super(`no credentials configured for mailbox ${email}`);
    this.name = "UnknownMailboxError";
  }
}

/**
 * An SMTP/IMAP round trip failed transiently (connection reset, 4xx greeting,
 * timeout). TRANSIENT (503): safe for the Worker to retry with backoff under its
 * attempt cap.
 */
export class UpstreamTransientError extends Error {
  readonly status = 503;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamTransientError";
  }
}

/**
 * A second send() for an idempotency key whose first send is still executing
 * (in-flight claim held). CONFLICT (409): the Worker must RETRY, not fail — the
 * retry lands after the first send records its result and returns the SAME
 * Message-ID from cache, so no second SMTP transaction is ever opened. Graded
 * retryable on the Worker side (email-port.ts RETRYABLE_ENGINE_STATUSES).
 */
export class SendInProgressError extends Error {
  readonly status = 409;
  constructor(idempotencyKey: string) {
    super(`a send for idempotency key ${idempotencyKey} is already in flight`);
    this.name = "SendInProgressError";
  }
}

export function statusFor(err: unknown): number {
  if (err instanceof UnauthorizedError) return err.status;
  if (err instanceof BadRequestError) return err.status;
  if (err instanceof UnknownMailboxError) return err.status;
  if (err instanceof SendInProgressError) return err.status;
  if (err instanceof UpstreamTransientError) return err.status;
  // Unknown failures are treated as transient (503) so a mis-classified bug
  // surfaces as a retry, not a permanent drop of a real send.
  return 503;
}
