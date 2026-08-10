// Wire A's `retry_setup` message body (msgchannel increment 1) — split out of
// tenant-messages.ts (CLAUDE.md rule b, god-file line cap) since this is a
// pure string-composition helper for ONE emit call site (provisioning.ts),
// not part of the tenant_messages table's CRUD surface tenant-messages.ts owns.

/**
 * The `retry_setup` body — STEP-AWARE (gate
 * docs/adversarial/wave-integration-gate-2026-08-05.md finding #2). Wire A
 * fires on any retryable VendorError escaping runSetupInfrastructure, and
 * more than one leg can throw one (setDnsWithRetry, awaitMailboxReady, …).
 * The prior hard-coded DNS sentence disagreed with the REST error body's
 * `step` field whenever the failing leg was NOT DNS — the two customer
 * surfaces must always name the SAME step. `step` is the abstract label
 * `vendor-failure.ts`'s `customerSafeVendorFailure` already derives (the
 * SAME function error-response.ts uses for the REST body), so this is never
 * a second, divergent classification — vendor-blind by construction (never
 * `err.message`, GUARDRAIL B).
 */
export function retrySetupMessageBody(domain: string | undefined, step: string | undefined): string {
  if (!domain) {
    return "Your last setup_infrastructure call has not finished yet. Nothing was lost; retry it with the same idempotency key to finish it.";
  }
  const progress = step ? ` — its ${step} is still completing at the vendor` : "";
  return `Setup for ${domain} has not finished yet${progress}. Nothing was lost; retry setup_infrastructure with the same idempotency key to finish it.`;
}
