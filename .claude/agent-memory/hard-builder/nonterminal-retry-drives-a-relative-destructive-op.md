---
name: nonterminal-retry-drives-a-relative-destructive-op
description: A correctly non-terminal outcome hands an UNBOUNDED retry to a RELATIVE destructive op ("release N"), so each instructed retry destroys count-failedCount more healthy resources, forever
metadata:
  type: project
---

⚠️ CLASS. Making a partial outcome NON-TERMINAL (so the same key re-runs instead
of replaying) is correct — and it is catastrophic when the retried operation is
RELATIVE and destructive. ColdStart N1 (wave-1-2-integration-gate-2026-08-18
round 2): `remove_mailboxes` = "release the N newest live". One mailbox the
vendor permanently refuses can never leave `released_at IS NULL`, so
`failedCount >= 1` is PERMANENT, so the outcome is permanently non-terminal, so
the key NEVER freezes, so the retry the docs instruct has no terminating
condition — and each pass re-resolved "the N newest live" and destroyed
`count - failedCount` HEALTHY mailboxes. Measured: ask 3, six retries, 12 gone.

**The tell:** a retry vehicle whose target set is recomputed from CURRENT state,
guarding an effect that CHANGES that state. Terminality and the intent are a
pair — if the outcome can be non-terminal, the retry must be ABSOLUTE.

**Fix shape (shipped):** a durable per-key INTENT recording the RESOLVED SET
before the first effect (`engine/remove-intents.ts`, mirroring
`provision-intents.ts`), one multi-row INSERT-only write; every same-key retry
drives exactly that set's still-unfinished members; the relative selection is
DELETED from the shared executor (`releaseMailboxes`' `{limit}` scope became
`{ids}`) so no future caller can inherit it. Counts then report the INTENT
(cumulative), which is what makes `failedCount === 0` mean "the downgrade
finished" and lets the key freeze on its own.

**Same-key-different-body:** the recorded intent WINS, no 409 — matches
setup_infrastructure's ordinal intents ("no key permutation can change what gets
purchased"), and refusing would punish the exact retry the old docs asked for.
Consequence to state out loud: once the 30-day request_idempotency row is
evicted, a REUSED old key is a no-op (intent rows are never deleted), so the
tool description must say a genuine second downgrade needs a NEW key.

Siblings: [[idempotency-replays-a-non-terminal-outcome-forever]] (the same axis,
opposite error), [[persist-before-confirm-cross-boundary]],
[[error-isolation-refactor-voids-throw-dependent-invariants]] (the per-item
isolation that produced `failedCount` here in the first place).
