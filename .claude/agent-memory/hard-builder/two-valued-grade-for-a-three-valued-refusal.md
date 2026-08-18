---
name: two-valued-grade-for-a-three-valued-refusal
description: A boolean `retryable` cannot say "an OPERATOR clears this and then the same retry works" — so every operator-clearable refusal collapses into permanent and is emitted as "check your inputs"; an empty vendor wallet stopped a paying customer for a week.
metadata:
  type: reference
---

⚠️ CLASS, and it cost a real customer a week (coldstart, Mordy, 2026-08-18). `VendorError(message, retryable)` answers "can THIS caller retry" but the question a refusal actually poses is three-valued:

1. **retryable** — transient, re-attempt works on its own.
2. **operator-actionable** — this caller can never clear it, but an OPERATOR can (fund the account, rotate the credential, un-suspend, ship the adapter fix), after which the caller's **SAME** request completes untouched.
3. **permanent** — nobody can clear it; the request itself is wrong.

With two values, (2) collapses into (3) and `error-response.ts` renders *"Retrying as-is will not help — check your inputs"*. Both halves are false for an empty prepaid wallet: the inputs were fine, and the identical retry succeeded the moment a human topped up. The customer's agent read the message, **correctly obeyed it, and disabled its retry loop.**

**Widest member is the ROOT grader, not the exotic branch:** `const retryable = status >= 500 || status === 429` makes **401 / 402 / 403** permanent. One rotated vendor JWT tells EVERY tenant to check its inputs and writes terminal `setup_failed` rows fleet-wide.

**How to apply:**
- Add the third value as its own field (`operatorActionable`), keep `retryable` untouched — published contracts and ~10 sites read it, and the two questions are independent.
- Grade at the ROOT and at the 200-`{error:true}` envelope both; a vendor may refuse funds with either, and which one is often UNVERIFIED.
- Scope the shared grader to **THROWING** branches only. Routing a deliberate `inconclusive` RETURN through a throwing grader reopens the vendor-verdict class ('absent' is the verdict that authorizes a re-buy).
- The message channel needs the matching rung (`operator_pending` between `action_required` and `terminal`), or an agent branching on severity still cannot tell "stop forever" from "wait, then retry identically".
- A body-text match for funding words is acceptable ONLY when it can just upgrade honesty and never authorize spend — fail-open to the status grade.

Siblings: [[vendor-prepaid-wallet-exhaustion-reads-as-permanent]], [[return-type-destroys-the-terminal-distinction]], [[customer-safe-translator-gated-on-error-shape]].
