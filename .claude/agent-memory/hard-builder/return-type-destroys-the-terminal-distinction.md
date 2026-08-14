---
name: return-type-destroys-the-terminal-distinction
description: "CLASS — a port whose return type cannot say DEAD reports a terminal vendor state as its benign not-yet value, and any 'success-pending' branch downstream then reports it to the customer as progress, forever. The type is the bug, not the branch."
metadata:
  type: project
---

⚠️ CLASS (ColdStart vendor-verdict wave, 2026-08-14; the defect was LIVE + ARMED):
a readiness-polling port returns a value that has room for "ready" and "not yet"
but NO room for "the vendor says this is dead". A terminal registration
(expired/suspended/cancelled) therefore comes back byte-identical to one accepted
two seconds ago, and the engine's benign branch matches it. After a prior wave
turned that benign branch into an HTTP 202 `provisioning:"pending"` SUCCESS, a
paid, permanently-dead domain was reported to the customer as "provisioning in
progress" on every call, forever — zero mailboxes, `info` severity, nothing
escalating.

**The information was never missing.** `polledDomainIsReady` READ the vendor's
status and returned `false` for it. The return type (`boolean` -> five booleans)
is what destroyed it. So "make the engine re-ask the vendor" is a non-fix: it
gets the same all-false answer. Same drop-the-discriminator shape as the
2026-08-05 `connection_type` incident, one layer further out.

**Two guards, and BOTH are needed — they fail independently (proved by two
separate cp-backed revert-proofs):**
1. A discriminated verdict (`ready | not_yet | terminal{vendorState} |
   inconclusive{reason}`) so the benign branch structurally CANNOT match a
   terminal. Exhaustive `switch` + `never` fallthrough at every consumer.
2. An AGE BOUND on the durable pending state. This is not redundant: an async
   registration that FAILED and was therefore never listed is a case NO verdict
   can see — the vendor reports nothing about it either way. Only the bound
   terminates that one.

**Anchor the bound on a clock-coherent column.** Not `purchased_at` (a real
vendor buy stamps `Date.now()`, adopt/sandbox stamp `ctx.clock.now()`, and the
virtual->real clock migration does not shift it — it can sit in the real
future). Use the column the migration DOES shift, and shift the new give-up
marker alongside it. Per-call backoff budgets can never do this job: every one
restarts at zero on the next customer call, so an agent retrying hourly renews
the "still propagating" story indefinitely.

**Gotchas that cost real time here:**
- An unrecognized vendor token must be `inconclusive`, never `terminal`. The live
  vocabulary is unverified; hard-failing a healthy domain on a renamed status is
  worse than waiting. Keep the terminal set a short allowlist of unambiguous
  tokens and include both `cancelled`/`canceled`.
- The give-up marker belongs in its OWN column, not as a new `dns_status` enum
  value — every reader branches on `dns_status != 'ready'` and a third value
  silently changes all of them at once.
- **Self-adversarial gap I shipped and then caught:** I stamped the age anchor
  only on a not-yet, and keyed the founder alert on that anchor being old. So the
  SHARPEST failure — terminal on the very first poll, given up on in seconds —
  produced no founder signal at all. Whenever a bound has a fast path and a slow
  path, check that the escalation covers BOTH; the fast one is the one the age
  test excludes by construction.
- Clearing the marker on a genuinely-ready poll is what keeps the fix from
  permanently condemning a registration that recovers.

Related: [[half-a-vendor-contract-invoked-on-the-other-half]] (the enabler is a
type-boundary drop), [[gate-waits-on-state-the-gated-action-produces]],
[[polling-check-error-is-indistinguishable-from-negative]].
