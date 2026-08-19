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
 * `step` carries an ABSTRACT operation label (vendor-failure.ts) derived from
 * what the adapters put in their messages, so a caller learns WHERE in the saga
 * it failed without us shipping internal detail — or the provider's identity.
 */

import { NOT_NOTIFIED, operatorNotifiedClause } from "@coldstart/shared";
import { customerSafeVendorFailure } from "./vendor-failure.js";

export interface ErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Errors carrying extra structured fields worth forwarding. */
interface StructuredError extends Error {
  retryable?: boolean;
  /** VendorError's third value — see the VendorError branch below. Read as a FIELD, not via instanceof: an error crossing the DO->Worker RPC boundary arrives with no prototype. */
  operatorActionable?: boolean;
  missingFields?: string[];
  currentRev?: number;
  currentLayout?: unknown;
  existingCampaignId?: string;
  reason?: string;
  step?: string;
  retryAfter?: number;
}

/**
 * The vendor operation as an ABSTRACT label, ONLY when we can name it safely.
 *
 * This used to be a passthrough allowlist of the vendor's LITERAL endpoint
 * paths ("domains/register", "mailboxes/buy", …) shipped to the customer as
 * `step` — the guard file's own leak (sweep-vendor-leak-2026-08-05): those
 * tokens are the vendor's routes, so `step` identified the provider as surely
 * as its name would. `customerSafeVendorFailure` maps them to prose labels
 * instead, keeping the actionable signal and dropping the fingerprint.
 *
 * Anything unrecognized still returns undefined: a caller learns nothing from a
 * leaked internal token, and a wrong or noisy `step` is worse than no step.
 */
function vendorStep(err: StructuredError): string | undefined {
  return customerSafeVendorFailure(err).step;
}

export function toErrorResponse(err: unknown): ErrorResponse {
  const error = err instanceof Error ? (err as StructuredError) : null;
  const name = error?.name ?? "";
  const message = error?.message ?? "";

  if (name === "ValidationError") return { status: 400, body: { error: message } };
  if (name === "NotFoundError") return { status: 404, body: { error: message } };
  if (name === "TenantIsolationError") return { status: 403, body: { error: message } };
  // msgchannel Inc5 — retryAfter (seconds) is present only when the throw
  // site supplied one (contact_operator's storm guard); every other
  // RateLimitError site (demo-run) omits it and keeps its plain body.
  if (name === "RateLimitError") {
    const retryAfter = error?.retryAfter;
    return { status: 429, body: { error: message, ...(retryAfter !== undefined ? { retryAfter } : {}) } };
  }
  if (name === "RequestInProgressError") return { status: 409, body: { error: message } };
  // The refusal has to carry the campaign that already exists, or the caller
  // cannot tell a duplicate-submit refusal from a real failure to launch.
  if (name === "DuplicateCampaignError") {
    return {
      status: 409,
      body: { error: message, code: "duplicate_campaign", existingCampaignId: error?.existingCampaignId },
    };
  }

  // G5 gate (a) — customer body stays GENERIC (N-G5-1): err.message names
  // internal env vars + arming docs, which belong in the founder ops alert
  // (registrar-alert.ts), never in a tenant response.
  // The notification claim is NOT made here (docs/adversarial/
  // class-sweep-signal-inversion-2026-08-17.md guard A1). alertRegistrarUnarmed
  // is wired at exactly three catches, early-returns when OPS_ALERT_EMAIL is
  // unset and swallows send failure — and this mapper, which runs for EVERY
  // producer of the error including the ones with no catch at all (teardown's
  // domain.release out of POST /cancel), holds no notification result to cite.
  // A customer told a human is already on it stops escalating.
  if (name === "RegistrarUnarmedError") {
    // TWO LEGS, TWO ANSWERS (design §7.8, gate L2). Read as a FIELD, never via
    // instanceof: an error crossing the DO->Worker RPC boundary arrives with
    // its own properties and NO prototype.
    //
    // The OPT-IN leg is the caller's own request, and its own next call fixes
    // it — so it is a 400 that names the field, modelled on
    // IncompleteRegistrantError's naming precedent, and carries NO notification
    // clause at all: nobody needs to be told, and an agent told a human is
    // involved stops trying. Wording follows the customer's own retraction —
    // "'registerDomains was not set on this request' would self-correct"
    // (sup_9d2c9a3a). The ENV leg keeps today's 503 verbatim.
    if (error?.reason === "opt_in") {
      return {
        status: 400,
        body: {
          error:
            "Domain registration was not authorized for this request: it did not set `registerDomains: true`. " +
            "No purchase was attempted and nothing about your account changed. Resend the same call with " +
            "`registerDomains: true` to authorize it.",
          code: "registrar_optin_missing",
        },
      };
    }
    return {
      status: 503,
      body: {
        error: `Domain registration is not yet enabled for this account. No purchase was made. ${operatorNotifiedClause(NOT_NOTIFIED)}`,
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
  // Same rule, and this one is starker: NOTHING ANYWHERE NOTIFIES FOR THIS
  // ERROR. All twelve throw sites (vendors/real/*-port.ts, inboxkit-client.ts,
  // engine-mailbox-client.ts) are unwrapped by any alert function and no
  // watchtower check covers "a vendor seam is dark" — so the old sentence was
  // false by construction, on the one error whose only fix is an operator
  // arming something.
  if (name === "NotActivatedError") {
    return {
      status: 503,
      body: {
        error: `This capability is not enabled for this account yet. Nothing was charged. ${operatorNotifiedClause(NOT_NOTIFIED)}`,
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
    // THE THIRD BRANCH (class A, docs/adversarial/
    // class-sweep-vendor-truth-2026-08-18.md). Two branches could not express
    // an operator-clearable refusal, so it took the "rejected" one and every
    // such failure reached the customer's agent as "Retrying as-is will not
    // help — check your inputs". For an empty provider wallet both halves were
    // false: there was nothing wrong with the inputs, and the identical retry
    // succeeded the moment a human topped up. The agent believed us and
    // disabled its retry loop, which is precisely the behaviour that sentence
    // asks for.
    //
    // Wording follows the CapacityPendingError template — the honest
    // back-pressure message this codebase already had: held, not failed;
    // nothing charged; someone else acts; then the SAME retry completes.
    if (!retryable && error?.operatorActionable === true) {
      return {
        status: 502,
        body: {
          error:
            "This request is on hold: an upstream provider refused it for a reason only an operator can clear. " +
            "Nothing was charged for the failed step. Do NOT change your inputs — once the operator clears it, " +
            "retrying this same request (same idempotency key) completes it. Call contact_operator to reach a human.",
          code: "vendor_operator_blocked",
          ...(step ? { step } : {}),
          retryable,
          operatorActionable: true,
        },
      };
    }
    return {
      status: 502,
      body: {
        error: retryable
          ? "An upstream provider failed while handling this request. Nothing was charged for the failed step. Retry shortly."
          : "An upstream provider rejected this request. Nothing was charged for the failed step. Retrying as-is will not help — check your inputs, or call contact_operator to reach a human.",
        code: "vendor_error",
        ...(step ? { step } : {}),
        retryable,
      },
    };
  }

  return { status: 500, body: { error: "internal error", code: "internal" } };
}
