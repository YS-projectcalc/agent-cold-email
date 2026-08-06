/**
 * The ONE translation from an internal vendor failure to something a CUSTOMER
 * or their agent may see.
 *
 * FOUNDER RULE: customer- and agent-facing surfaces never reveal which upstream
 * provider we use. Vendor identity stays in internal logs
 * (docs/adversarial/sweep-vendor-leak-2026-08-05.md).
 *
 * The leak this closes is narrower than "vendor strings in an error body" — the
 * throw->response boundary (error-response.ts) already genericizes. The live
 * class was a VendorError CAUGHT and written into a value a customer read-surface
 * later returns (`deliverability_actions.detail_json`, `vendorHealthError`, the
 * tick's failed-send event), plus the guard file's own allowlist of RAW ENDPOINT
 * PATHS shipped to the customer as `step` — `step:"domains/register"` is a
 * fingerprint you can curl the vendor with.
 *
 * So the allowlist became a MAP: internal op token -> abstract label. A caller
 * still learns WHICH step failed and whether to retry (the actionable part
 * Mordy asked for), and the emitted vocabulary is a closed set of prose labels
 * that name no vendor and no endpoint.
 */

/**
 * A vendor failure as seen by a caller, WITHOUT `instanceof`.
 *
 * An error thrown inside the Durable Object and rethrown by the Worker has
 * crossed an RPC boundary: it arrives as a structurally-equivalent object with
 * its own properties intact but its PROTOTYPE gone, so `err instanceof
 * VendorError` is false at exactly the surface that matters most (the HTTP
 * response). error-response.ts has always branched on `err.name` for this
 * reason; this module has to use the same discipline, or a genuinely retryable
 * failure would reach the customer graded "do not retry".
 */
interface VendorFailureShape {
  name?: unknown;
  message?: unknown;
  retryable?: unknown;
  step?: unknown;
}

/**
 * The abstract labels, named so a throw site that already knows its own step can
 * attach one WITHOUT restating the string. A restated label that drifts from the
 * map below is silently DROPPED by `customerSafeVendorFailure` (it only emits
 * what the map contains), which is the quiet way to lose the actionable signal.
 *
 * None of these contains '/' — the tripwire test asserts exactly that, so a
 * future entry cannot reintroduce the endpoint-path fingerprint.
 */
export const VENDOR_STEP = {
  domainRegistration: "domain registration",
  domainAvailability: "domain availability check",
  domainLookup: "domain lookup",
  domainDns: "domain DNS setup",
  domainRelease: "domain release",
  mailboxPurchase: "mailbox purchase",
  mailboxLookup: "mailbox lookup",
  mailboxHealth: "mailbox health check",
  mailboxRelease: "mailbox release",
  warmupEnrollment: "warmup enrollment",
  warmupCancellation: "warmup cancellation",
  warmupLookup: "warmup lookup",
  emailDelivery: "email delivery",
  mailboxSync: "mailbox sync",
} as const;

/**
 * Internal op token (as it appears in an adapter's own message, or in the
 * client's `METHOD /path`) -> the abstract label we are willing to say out loud.
 * Keys are matched LONGEST-FIRST so a nested path
 * ("domains/nameservers/check-propagation") never resolves via its own prefix.
 */
const ABSTRACT_STEP_BY_OP: Record<string, string> = {
  "domains/register": VENDOR_STEP.domainRegistration,
  "domains/available": VENDOR_STEP.domainAvailability,
  "domains/list": VENDOR_STEP.domainLookup,
  "domains/nameservers/check-propagation": VENDOR_STEP.domainDns,
  "domains/nameservers": VENDOR_STEP.domainDns,
  "domains/remove": VENDOR_STEP.domainRelease,
  "mailboxes/buy": VENDOR_STEP.mailboxPurchase,
  "mailboxes/list": VENDOR_STEP.mailboxLookup,
  "email-insights/mailbox": VENDOR_STEP.mailboxHealth,
  "mailboxes/cancel": VENDOR_STEP.mailboxRelease,
  "warmup/add": VENDOR_STEP.warmupEnrollment,
  "warmup/cancel": VENDOR_STEP.warmupCancellation,
  "warmup/list": VENDOR_STEP.warmupLookup,
  "email/send": VENDOR_STEP.emailDelivery,
  "email/poll": VENDOR_STEP.mailboxSync,
};

const OPS_LONGEST_FIRST = Object.keys(ABSTRACT_STEP_BY_OP).sort((a, b) => b.length - a.length);

/** Every label this module may emit — the closed vocabulary the tripwire pins. */
export const ABSTRACT_VENDOR_STEPS: ReadonlySet<string> = new Set(Object.values(ABSTRACT_STEP_BY_OP));

export interface CustomerSafeVendorFailure {
  /** Abstract operation label, or undefined when we cannot name the step safely. */
  step?: string;
  /** The adapter's own transient-vs-permanent grade — honest, never laundered. */
  retryable: boolean;
}

/**
 * What a customer surface is allowed to record or return about a vendor failure.
 *
 * Resolution order: an explicitly attached ABSTRACT `step` (a throw site that
 * knew its own step and wrote a vendor-blind message), then a longest-match scan
 * of the message for a known op token. Anything unrecognized yields NO step
 * rather than a guess — the previous best-effort regex emitted whatever token
 * sat in position 2 ("unreachable", "manually-minted"), and a wrong step is
 * worse than none.
 *
 * `retryable` defaults to FALSE for a non-VendorError: an unclassified failure
 * is not evidence that retrying helps, and "retry forever" is the exact shape
 * that turned one wrong vendor operation into a 24-hour customer loop.
 */
export function customerSafeVendorFailure(err: unknown): CustomerSafeVendorFailure {
  const failure = (typeof err === "object" && err !== null ? err : {}) as VendorFailureShape;
  const retryable = failure.retryable === true;
  const explicit = typeof failure.step === "string" ? failure.step : undefined;
  if (explicit && ABSTRACT_VENDOR_STEPS.has(explicit)) return { step: explicit, retryable };

  const message = typeof failure.message === "string" ? failure.message : String(err);
  for (const op of OPS_LONGEST_FIRST) {
    if (message.includes(op)) return { step: ABSTRACT_STEP_BY_OP[op], retryable };
  }
  return { retryable };
}

/**
 * The customer-facing detail for an ACTIVITY row / status field: the abstract
 * step + retryability + a human sentence the surface itself supplies. The raw
 * operator text is deliberately NOT included — it goes to the Worker log, which
 * is internal, so the vendor detail an operator needs survives without being
 * stored in a row the customer can read back.
 */
export function customerSafeVendorDetail(
  err: unknown,
  reason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return customerSafeDetail(customerSafeVendorFailure(err), reason, extra);
}

/** Same, for a caller that has already graded the failure itself. */
export function customerSafeDetail(
  failure: CustomerSafeVendorFailure,
  reason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { reason, ...(failure.step ? { step: failure.step } : {}), retryable: failure.retryable, ...extra };
}

/**
 * Logs the RAW vendor failure where only operators can see it (Worker logs),
 * so genericizing a customer surface never destroys the diagnostic. Paired with
 * `customerSafeVendorDetail` at every catch site that records something readable.
 */
export function logVendorFailure(context: string, err: unknown): void {
  console.error(`vendor failure [${context}]`, err instanceof Error ? err.message : String(err));
}
