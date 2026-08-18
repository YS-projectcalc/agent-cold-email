// Terminality classification for `removeMailboxes`' outcome, for the
// request-replay layer (engine/idempotency.ts's Settled contract). Sibling of
// setup-terminality.ts, and for the same reason: the ONE place that knows how
// this intent can return while still owing work, kept out of both the generic
// wrapper and the DO method.
//
// WHY IT EXISTS AT ALL. The call site used to assert `terminal(...)` on the
// strength of a comment — "releaseMailboxes THROWS on any vendor release
// failure, so a non-throwing return means every selected mailbox was actually
// released". Per-item isolation (IN-3) then removed that throw and returned a
// `failedCount` instead, and the assertion outlived the fact it rested on: a
// PARTIAL release was recorded as the permanent answer to the customer's
// idempotency key. The retry the platform's own docs instruct made zero vendor
// calls, and the mailbox the vendor refused stayed live — billed to the
// customer AND to the platform — with no reconcile lane that re-attempts it.
//
// So the fact is read from the RESULT rather than from control flow, which is
// the whole point of the Settled contract: "the function returned" was never
// the same claim as "the work finished".

import { nonTerminal, terminal, type Settled } from "@coldstart/shared";
import type { RemoveMailboxesResult } from "./billing.js";

export function settleRemoveMailboxes(result: RemoveMailboxesResult): Settled<RemoveMailboxesResult> {
  // Every mailbox this call selected is gone at the vendor: nothing further is
  // owed, so the response is safe to freeze under the key.
  if (result.failedCount === 0) return terminal(result);
  // At least one is STILL LIVE. Recording this would freeze a half-finished
  // downgrade as the answer forever; releasing the claim lets a same-key retry
  // re-run and pick the stragglers up (`releaseMailboxes` is retry-safe by
  // construction — it is driven by `released_at IS NULL`, and both the vendor
  // release and the credential revoke are idempotent).
  return nonTerminal(result);
}
