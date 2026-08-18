// Wire A's setup message bodies (msgchannel increment 1) — split out of
// tenant-messages.ts (CLAUDE.md rule b, god-file line cap) since these are
// pure string-composition helpers for ONE emit call site (provisioning.ts),
// not part of the tenant_messages table's CRUD surface tenant-messages.ts owns.
// Two bodies, one per outcome the setup saga can hand an agent that is not a
// plain success: "not finished, retry" and "finished failing, escalate".

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
  // TRUTHFULNESS (F1, docs/adversarial/
  // agent-channel-product-audit-2026-08-17.md): the prior wording promised that
  // a same-key retry finishes the setup, which was false for as long as the
  // recorded outcome replayed — this exact sentence is what turned the replay
  // trap into a live customer incident. It is true without qualification now:
  // an outcome that still owes work is not recorded at all (idempotency.ts's
  // Settled contract), so the key is reclaimable the moment this message is
  // written. Any caveat added back here has to be a caveat the CODE enforces.
  const sameKeyIsSafe =
    "Nothing was lost; retry setup_infrastructure to finish it — reusing the same idempotency key is safe and will re-run the setup.";
  if (!domain) {
    return `Your last setup_infrastructure call has not finished yet. ${sameKeyIsSafe}`;
  }
  const progress = step ? ` — its ${step} is still completing at the vendor` : "";
  return `Setup for ${domain} has not finished yet${progress}. ${sameKeyIsSafe}`;
}

/**
 * The `setup_failed` body — the TERMINAL counterpart (F3). Reached only from a
 * non-retryable VendorError escaping runSetupInfrastructure, i.e. the platform
 * has stopped trying. Its job is to name the ONE recovery that exists today:
 * `contact_operator`. There is deliberately no self-serve replacement action to
 * point at — `REPLACE_DOMAIN` is reachable only from the deliverability control
 * loop's burn thresholds, which need sends, which a zero-mailbox domain can
 * never produce — so naming a tool the agent cannot use would be a second lie
 * on top of the one this message exists to delete.
 *
 * Same vendor-blind composition rule as retrySetupMessageBody: `step` comes
 * from `customerSafeVendorFailure`, never from the error's own message.
 */
export function setupFailedMessageBody(domain: string | undefined, step: string | undefined): string {
  const subject = domain ? `Setup for ${domain}` : "Your last setup_infrastructure call";
  const progress = step ? ` at the ${step} step` : "";
  return (
    `${subject} has failed${progress} and will not complete on its own. Retrying will not help. ` +
    `Call contact_operator to reach a human — that is the only way to get this finished.`
  );
}
