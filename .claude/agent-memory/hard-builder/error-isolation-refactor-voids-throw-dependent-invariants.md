---
name: error-isolation-refactor-voids-throw-dependent-invariants
description: CLASS — converting a loop from fail-fast to per-item isolation (throw becomes a returned failedCount) silently voids every CALLER invariant that was justified by the throw; the justifying comment survives and reads as still-true.
metadata:
  type: project
---

CLASS (ColdStart, wave-1+2 integration gate B3, 2026-08-18): a head-of-line-blocking
fix converts a loop from FAIL-FAST to PER-ITEM ISOLATION — the vendor failure that
used to `throw` now comes back as `outcome.failures.length` on the result. Every
caller that inferred something from "it did not throw" is now WRONG, and nothing
in the type system or the test suite says so, because the new field is optional to
read.

**The instance.** `releaseMailboxes` (engine/lifecycle.ts) gained `failedCount`.
Of its three callers, one was wired; `tenant-do.ts`'s `removeMailboxes` still
read:

```ts
// TERMINAL: releaseMailboxes THROWS on any vendor release failure, so a
// non-throwing return means every selected mailbox was actually released.
async () => terminal(await removeMailboxes(ctx, input)),
```

The comment is the tell — it states the fact it rests on, and that fact was
deleted by a sibling lane. Result: a PARTIAL release (vendor 404s one mailbox)
was recorded `status='done'` under the customer's idempotency key, the retry the
platform's own MCP description instructs made zero vendor calls, and the stuck
mailbox stayed live — billed $10/mo to the customer AND to the platform — with
no reconcile lane anywhere. F1 violated on the money path.

**Why no test saw it.** Every fixture released cleanly, so `failedCount` was
always 0 and both the old and new code agreed. Reproducing it needs a port that
fails ONE item mid-batch (`suspendReleases`-style override of the DO's cached
`sandboxAdapters.mailbox.release`, keyed on a specific address).

**How to apply.** When a lane turns a throw into a returned failure count:
1. Grep every caller of the changed function and ask what each inferred from the
   absence of a throw (terminality, "safe to record", "safe to bill", "complete").
2. Read the RESULT, never control flow: a `settleX(result)` predicate beside the
   producer (`engine/remove-mailboxes-terminality.ts` next to
   `setup-terminality.ts`), `failedCount > 0 ⇒ nonTerminal`.
3. Surface the count ON THE WIRE — an agent that asked for 3 and got
   `releasedCount: 2` otherwise has no field telling it why.
4. Grep the PROSE too: the MCP tool description and openapi both promised "a
   retry with the same key releases nothing further", which the fix makes false
   in the partial case. See [[deleted-mechanism-leaves-its-prose-and-its-sentinel]].
5. Sweep the sibling callers in the same change (teardown discarded it too, and
   wrote a `teardown_records` row asserting a whole reclaim over a partial one).

RESIDUAL WORTH KNOWING: making the partial non-terminal means a same-key retry
RE-RUNS a RELATIVE operation ("release N more"), so it can release beyond the
stragglers. Bounding that needs a durable per-key remove-intent record (the
`provision-intents.ts` pattern), which is a design change, not a fix.

Relates to [[classifier-cannot-see-an-undiscriminated-return]] (both are
"terminality asserted from the wrong evidence") and
[[caller-side-effect-gated-on-callee-result-field]] (the mirror: a caller reading
a field the callee stopped setting).
