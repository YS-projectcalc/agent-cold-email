---
name: classifier-cannot-see-an-undiscriminated-return
description: A result-shape classifier (terminality, retryability, success) is structurally blind to any branch that returns the SAME shape as success — fix the RETURN to state its own status, never add caller-side inference from durable state.
metadata:
  type: project
---

⚠️ CLASS. When a wrapper has to classify a callee's outcome (terminal vs not, done vs owes-work), and the classifier reads the RESULT VALUE, it can only see what the result discriminates. A branch that returns the full-success shape is invisible to it — and that branch is usually the one that most needs classifying, because "return the normal shape" is how graceful degradation gets written.

ColdStart instance: `runSetupInfrastructure`'s capacity-gated back-pressure returned `{jobId, billing}` — byte-identical to a completed provision. The `Settled<T>` idempotency contract closed the 202-pending and quoteOnly members (both self-announcing: `provisioning:"pending"`, `quoteOnly:true`) and left this one open; the shim that classified them documented its own gap in a comment and shipped. Effect: founder raises the spend ceiling, agent retries with its key, gets a stale recorded success, nothing provisions.

**Why:** the fix that looks natural — infer it from the durable `capacity_pending` marker — is a caller-side read of a callee's private state, its own failure class. The correct fix is one field at the return site: a `provisioning?: "pending" | "capacity_pending"` whose PRESENCE means "owes work", so the classifier tests for the field rather than enumerating values and a future non-terminal branch is covered the day it is added. Making it customer-visible was a bonus, not a cost: back-pressure that wears success's clothes is its own honesty defect.

**How to apply:** when writing or reviewing a result classifier, enumerate every `return` in the classified function and ask which ones are DISTINGUISHABLE in the returned value. Any that are not are silent members. Prefer a presence-tested discriminator over a value allowlist. A comment in the classifier admitting "member N is not closed" is a scope item, not a caveat — treat it as unfinished work. Related: [[return-type-destroys-the-terminal-distinction]], [[idempotency-replays-a-non-terminal-outcome-forever]], [[caller-side-effect-gated-on-callee-result-field]].
