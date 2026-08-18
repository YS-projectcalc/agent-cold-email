// Terminality classification for `runSetupInfrastructure`'s outcome, for the
// request-replay layer (engine/idempotency.ts's Settled contract).
//
// ITS OWN FILE because it is the one place that has to know EVERY non-terminal
// way this saga can return, and that knowledge belongs next to neither the
// wrapper (which must stay generic — it has no business learning any intent's
// result semantics) nor the DO method (where a predicate would go stale the day
// the saga grows another such return). Both facts it reads are stated by the
// result itself — `quoteOnly` and `provisioning` — so nothing here infers a
// state from a durable marker or from which branch happened to run.
//
// It lives in src rather than in a test helper so the closure tests can drive
// the same classification production drives; a test that restated it would be
// proving its own copy.

import { nonTerminal, terminal, type Settled } from "@coldstart/shared";
import { isSetupProvisioningIncomplete, type SetupInfrastructureRunResult } from "./provisioning.js";

export function settleSetupInfrastructure(
  result: SetupInfrastructureRunResult,
): Settled<SetupInfrastructureRunResult> {
  // Any `provisioning` state at all: the 202 SUCCESS-PENDING branch (owes a
  // domain's DNS plus every mailbox behind it) and the capacity-gated branch
  // (owes everything, until a human raises a limit).
  if (isSetupProvisioningIncomplete(result)) return nonTerminal(result);
  // A preview provisions nothing. `mcp/tools.ts` instructs the two-call
  // quote-then-commit flow explicitly, and both calls carry the same
  // Idempotency-Key header, so freezing the quote is the most reachable member
  // of the class — it needs no vendor failure and no crash.
  //
  // The typeof/null guard is what makes the TOTALITY that `idempotency.ts` and
  // `isSetupProvisioningIncomplete` both promise actually true: this predicate
  // is handed a `JSON.parse` of a row that may predate the current result
  // shape, and the `in` operator THROWS on a primitive or null. No writer can
  // currently produce a non-object payload under this key, so today the guard
  // costs nothing — but the claim above it was false without it, and it would
  // have thrown inside the synchronous pre-await prefix and 500'd the call.
  if (typeof result === "object" && result !== null && "quoteOnly" in result) return nonTerminal(result);
  return terminal(result);
}
