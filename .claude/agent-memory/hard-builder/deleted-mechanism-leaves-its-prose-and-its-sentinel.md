---
name: deleted-mechanism-leaves-its-prose-and-its-sentinel
description: Replacing a mechanism leaves two silent liars behind — the customer-facing sentence that described it, and the sentinel value invented to model its absence; both survive typecheck and every test.
metadata:
  type: feedback
---

When a mechanism is replaced rather than extended, sweep for the things that DESCRIBED it, not just the things that CALLED it. Two shapes, both seen in one ColdStart increment:

1. **Prose pinned to a deleted mechanism.** A 60s "incomplete-outcome replay window" was replaced by the `Settled` contract (a non-terminal outcome records nothing at all). The window's code went; `retrySetupMessageBody` still told the paying customer "a retry within about a minute just returns this same in-progress answer" — a caveat about machinery that no longer exists, in the ONE message whose wrongness caused the original incident. Nothing catches this: the sentence is a string, and its test only asserted the message exists.

2. **A sentinel that re-commits the original sin.** The same rework wrote `notified = email ? await trySend(...) : {delivered: true, why: "suppressed_cooldown"}` — using "delivered" to mean "nothing was owed" inside the very function whose bug was recording an undelivered alert as delivered. Model "nothing owed" as `null` (or its own reason), never as a fake success.

**Why:** both survive typecheck and every existing test, because the type is still `string`/`boolean` and the assertions were written against the old mechanism.

**How to apply:** after deleting or replacing a mechanism, grep for its VOCABULARY (the numbers, the window name, the phrase) across `src/`, message builders, tool descriptions and openapi — not just for its identifiers. And check whether any boolean you kept now carries two meanings. Related: [[customer-safe-translator-gated-on-error-shape]], [[false-recovery-disarms-cooldown-dedup]].
