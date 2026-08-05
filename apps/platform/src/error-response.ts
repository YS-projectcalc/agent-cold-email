/**
 * The ONE place an internal error becomes a customer-facing response.
 *
 * INCIDENT 2026-08-05 (H6): a `VendorError` thrown mid-provision fell through
 * every mapped class and became an opaque `500 {"error":"internal error"}`.
 * The customer's agent could not tell "retry this" from "stop, something is
 * broken", and the founder could not tell from the response whether money had
 * moved. Worse, the MCP transport did the opposite and returned `err.message`
 * verbatim — leaking internal env-var names and ACTIVATION.md runbook text to
 * a tenant.
 *
 * Both surfaces now translate here, so a class can never be mapped on one
 * transport and unmapped on the other. Adding a class means adding ONE case.
 *
 * `step` carries the vendor operation name adapters already put in their
 * messages, so a caller learns WHERE in the saga it failed without us shipping
 * internal detail.
 */

export interface ErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Errors carrying extra structured fields worth forwarding. */
interface StructuredError extends Error {
  retryable?: boolean;
  missingFields?: string[];
  currentRev?: number;
  currentLayout?: unknown;
  reason?: string;
  step?: string;
}

/**
 * The vendor operations we are willing to name to a customer. An ALLOWLIST, not
 * a parse (N2, gate 2026-08-05): the previous best-effort regex over the error
 * message emitted whatever token happened to sit in position 2, producing junk
 * steps like "unreachable" and "manually-minted" — and, far worse, it sat next
 * to a `error: err.message` that shipped the raw adapter text to the customer.
 * Proven leaks included the operator's InboxKit Stripe checkout URL,
 * ENGINE_BASE_URL (an internal 10.x address), ECONNREFUSED internal IPs, and
 * OAuth runbook wording.
 */
const CUSTOMER_SAFE_STEPS = new Set([
  "domains/register",
  "domains/available",
  "domains/list",
  "domains/nameservers",
  "domains/remove",
  "mailboxes/buy",
  "mailboxes/list",
  "mailboxes/cancel",
  "warmup/add",
  "warmup/cancel",
  "warmup/list",
  "email/send",
  "email/poll",
]);

/**
 * The vendor operation, ONLY when it is one we have decided is safe to name.
 * Anything else returns undefined: a caller learns nothing from a leaked
 * internal token, and a wrong or noisy `step` is worse than no step.
 */
function vendorStep(err: StructuredError): string | undefined {
  const explicit = typeof err.step === "string" ? err.step : undefined;
  const parsed = /^[a-z0-9-]+ ([a-z0-9/_:-]+)/i.exec(err.message ?? "")?.[1];
  const candidate = explicit ?? parsed;
  return candidate && CUSTOMER_SAFE_STEPS.has(candidate) ? candidate : undefined;
}

export function toErrorResponse(err: unknown): ErrorResponse {
  const error = err instanceof Error ? (err as StructuredError) : null;
  const name = error?.name ?? "";
  const message = error?.message ?? "";

  if (name === "ValidationError") return { status: 400, body: { error: message } };
  if (name === "NotFoundError") return { status: 404, body: { error: message } };
  if (name === "TenantIsolationError") return { status: 403, body: { error: message } };
  if (name === "RateLimitError") return { status: 429, body: { error: message } };
  if (name === "RequestInProgressError") return { status: 409, body: { error: message } };

  // G5 gate (a) — customer body stays GENERIC (N-G5-1): err.message names
  // internal env vars + arming docs, which belong in the founder ops alert
  // (registrar-alert.ts), never in a tenant response.
  if (name === "RegistrarUnarmedError") {
    return {
      status: 503,
      body: {
        error: "Domain registration is not yet enabled for this account. No purchase was made. The operator has been notified.",
        code: "registrar_unarmed",
      },
    };
  }

  // Tenant-fixable data gap — names the missing fields so the agent can resubmit.
  if (name === "IncompleteRegistrantError") {
    return { status: 400, body: { error: message, missingFields: error?.missingFields ?? [], code: "incomplete_registrant" } };
  }

  // SPEC.md §19.4 [F5] — a stale dashboard-view rev is a STRUCTURED 409: the
  // agent needs currentRev + currentLayout to rebase its edit.
  if (name === "RevConflictError") {
    return { status: 409, body: { error: message, currentRev: error?.currentRev, currentLayout: error?.currentLayout } };
  }

  // Warm-lead Q3 — a send refused by the guarded single-send primitive.
  if (name === "SendBlockedError") {
    const retryable = error?.retryable === true;
    return {
      status: retryable ? 429 : 409,
      body: { error: message, code: "send_blocked", reason: error?.reason, retryable },
    };
  }

  // G2/G4 back-pressure — the reserve was released; a retry after the founder
  // raises the ceiling starts clean.
  if (name === "CapacityPendingError") {
    return { status: 409, body: { error: message, code: "capacity_pending", reason: error?.reason } };
  }

  // H6 — a vendor seam that is not armed. GENERIC message on purpose: the raw
  // one names ACTIVATION.md and env vars.
  if (name === "NotActivatedError") {
    return {
      status: 503,
      body: {
        error: "This capability is not enabled for this account yet. Nothing was charged. The operator has been notified.",
        code: "not_activated",
        step: vendorStep(error as StructuredError),
      },
    };
  }

  // H6 — the base vendor failure. 502: an upstream we depend on failed, which
  // is materially different from a bug in this service. `retryable` is the
  // adapter's own grade, so an agent can back off instead of guessing.
  //
  // N2 — the message is GENERIC. Adapter messages are written for operators and
  // embed whatever the vendor returned: checkout URLs, internal hostnames and
  // IPs, runbook text. `retryable` + `step` carry everything a caller can act
  // on; the operator detail belongs in the log line index.ts emits, never in a
  // tenant response. Same discipline RegistrarUnarmedError already followed.
  if (name === "VendorError") {
    const retryable = error?.retryable === true;
    const step = vendorStep(error as StructuredError);
    return {
      status: 502,
      body: {
        error: retryable
          ? "An upstream provider failed while handling this request. Nothing was charged for the failed step. Retry shortly."
          : "An upstream provider rejected this request. Nothing was charged for the failed step. Retrying as-is will not help — check your inputs or contact support.",
        code: "vendor_error",
        ...(step ? { step } : {}),
        retryable,
      },
    };
  }

  return { status: 500, body: { error: "internal error", code: "internal" } };
}
