/**
 * The ONE vendor lifecycle-token vocabulary, shared by every real InboxKit
 * adapter that has to answer "is this resource dead, working on it, or live?"
 * (`RealInboxKitDomainPort.setDns`, `RealMailboxPort.provisioningState`).
 *
 * It exists as one module because the vendor-verdict class
 * (docs/adversarial/vendor-verdict-class-sweep-2026-08-14.md) has a domain half
 * and a mailbox half with the SAME defect: each mapped every non-'active' status
 * onto its own benign in-progress value, so an expired domain and a suspended
 * mailbox both read as "still coming up". Two copies of this table would drift,
 * and the drift is exactly the bug.
 *
 * ⚠ THE LIVE VOCABULARY IS NOT FULLY VERIFIED. The only tokens observed live are
 * 'active' (domain `status`, and mailbox `status` on a working mailbox),
 * 'pending' (the domain propagation fields) and 'scheduled' (a just-accepted
 * mailbox buy) — see the contract captures in inboxkit-domain-port.ts and
 * mailbox-port.ts. Everything else below is a CONSERVATIVE reading, and the
 * conservatism runs in one specific direction:
 *
 *   AN UNRECOGNIZED TOKEN IS 'unknown', NEVER 'terminal'.
 *
 * Terminal is a hard, customer-visible stop. Guessing it for a healthy domain
 * whose status the vendor renamed would brick a working account, while guessing
 * 'unknown' costs only what a not-yet costs (the caller grades both identically
 * and the age bound still terminates them). So the terminal set is an ALLOWLIST
 * of tokens whose meaning is unambiguous in ANY vendor's vocabulary — a
 * registration/mailbox that is gone, cancelled, expired, or explicitly failed —
 * and it is deliberately short. Extending it needs a live observation, not a
 * plausible-sounding synonym.
 */

/**
 * States that mean "this resource is DEAD and will not become usable".
 *
 * Justification, token by token — each is terminal in the plain-English sense
 * that no amount of waiting turns it back into a working registration/mailbox:
 *  - 'expired'          — the registration lapsed.
 *  - 'suspended'        — the vendor/registrar took it out of service.
 *  - 'cancelled'/'canceled' — the order was cancelled (both spellings are the
 *    SAME token; including the US spelling is not an extension of meaning, and
 *    omitting it would make correctness depend on which speller wrote the API).
 *  - 'failed'           — the vendor's own verdict that the operation did not
 *    succeed. Distinct from "not finished".
 *  - 'pending_deletion' — scheduled for removal. "Pending" here qualifies the
 *    DELETION, not the provisioning; nothing about it heals.
 *  - 'deleted'          — gone.
 */
const TERMINAL_TOKENS = new Set([
  "expired",
  "suspended",
  "cancelled",
  "canceled",
  "failed",
  "pending_deletion",
  "deleted",
]);

/**
 * States that mean "the vendor is still working on it" — a genuine benign wait.
 *
 * 'pending' and 'scheduled' are live-observed. The rest are the async-in-flight
 * synonyms a provisioning API plausibly uses; classifying one of them as
 * 'pending' rather than 'unknown' changes NO decision in the engine (both flow
 * through the same bounded-benign branch) except that the mailbox acquisition
 * path treats a pending mailbox as one the vendor holds — which is the
 * no-second-purchase direction, so a wrong guess here cannot spend money.
 */
const PENDING_TOKENS = new Set([
  "pending",
  "scheduled",
  "processing",
  "provisioning",
  "creating",
  "queued",
  "in_progress",
  "registering",
]);

/** The single live/positive token. Anything else is graded by the sets above. */
const LIVE_TOKEN = "active";

export type VendorLifecycle = "live" | "terminal" | "pending" | "unknown";

/**
 * Grades a raw vendor status token. An absent/blank status is 'unknown' (the
 * vendor told us nothing), never 'live' — the readiness asymmetry means a
 * missing status must not read as working.
 */
export function classifyVendorLifecycle(raw: string | undefined | null): VendorLifecycle {
  const token = (raw ?? "").trim().toLowerCase();
  if (token === "") return "unknown";
  if (token === LIVE_TOKEN) return "live";
  if (TERMINAL_TOKENS.has(token)) return "terminal";
  if (PENDING_TOKENS.has(token)) return "pending";
  return "unknown";
}

/** The raw token, normalized for logs/verdicts — never shown to a customer. */
export function normalizeLifecycleToken(raw: string | undefined | null): string {
  return (raw ?? "").trim().toLowerCase() || "unknown";
}
