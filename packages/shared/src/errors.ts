// Shared error types. Kept tiny and dependency-free so both the platform
// worker and (later) the CLI/MCP surface can catch/branch on these classes.

export class ValidationError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * A vendor-side failure carrying its own transient-vs-permanent grade. Real
 * signals are graded (SMTP 4xx/5xx, an activation-gated stub, a rate-limit vs
 * a bad-credentials error); a handler must branch on that grade instead of
 * attaching one unconditional consequence (A5 spike CLASS A). `retryable`
 * true = transient (safe to re-attempt with backoff/cap); false = permanent
 * (re-attempting can never succeed — fail fast). The engine tick's per-send
 * billing path (engine/tick.ts) reads this: retryable retries under an attempt
 * cap, non-retryable fails immediately, so no infinite-retry path survives.
 */
export class VendorError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VendorError";
  }
}

/**
 * Thrown by every `real/` VendorPort implementation. ARCHITECTURE.md #6 and
 * #8: real vendor adapters are typed stubs coded against public docs but
 * never actually called — they exist so the swap sandbox->real is a
 * provable no-op later, and so a demo/free tenant is structurally unable to
 * reach a live vendor (the adapter factory only ever hands them `sandbox`).
 * A VendorError with `retryable: false` — an unactivated adapter can never
 * become activated by retrying, so a handler must fail fast, never loop.
 */
export class NotActivatedError extends VendorError {
  constructor(vendor: string, op: string) {
    super(
      `${vendor}.${op} is not activated — real vendor adapters are coded stubs only until ACTIVATION.md is executed by the owner.`,
      false,
    );
    this.name = "NotActivatedError";
  }
}

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Thrown when a per-tenant/per-IP rate limit or lifetime cap is exceeded.
 * The Worker's onError maps this to HTTP 429. Used by the demo-run throttle
 * (TenantDO.demoRun); the /signup per-IP limiter returns 429 directly at the
 * HTTP layer without throwing (see routes/signup.ts).
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a mutating intent is retried with the same Idempotency-Key while
 * the FIRST call for that key is still executing — a 'pending' claim row exists
 * (engine/idempotency.ts's claim-then-execute). RETRYABLE by design: the client
 * should retry once the first call records its response (or clears the claim on
 * failure). The Worker maps it to HTTP 409 Conflict.
 */
export class RequestInProgressError extends Error {
  constructor(message = "a request with this idempotency key is already in progress — retry shortly") {
    super(message);
    this.name = "RequestInProgressError";
  }
}
