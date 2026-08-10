---
name: gate-waits-on-state-the-gated-action-produces
description: CLASS — a "conservative" readiness gate that waits on vendor state the vendor only computes AFTER the action being gated is a permanent deadlock, not a slow wait; the safe-direction asymmetry argument is void when the awaited signal never arrives.
metadata:
  type: project
---

CLASS (ColdStart P0 2026-08-10, the same paying customer as the 08-05 incident):
`purchasedDomainIsReady` gated mailbox creation on InboxKit's
`dns_propagation_status` + `nameserver_match_status`. Vendor support, verbatim:
*"the DNS will be configured during mailbox processing"* — on a PURCHASED domain
the checker behind those fields does not run until a mailbox exists. The gate
therefore waited on state that only the gated action produces. Six days of live
"pending", every retry re-reading it. Not a slow wait — a closed loop.

**The refuted argument is the interesting part.** Wave 1 justified an
allowlist-of-ready-tokens with an explicit asymmetry note: "a false not-ready is
visible, recoverable, no money spent; a false ready bills monthly on dead DNS."
That reasoning silently assumes THE AWAITED SIGNAL EVENTUALLY ARRIVES. Where it
never does, the "safe" direction is the catastrophic one. **When you write a
safe-direction argument for a wait, state the arrival assumption out loud and
say what makes it true** — here it was true for `connected` (the customer's
registrar acts, the checker demonstrably runs) and false for `purchased`, in the
SAME predicate, off the SAME fields.

**How to spot it before a customer does:** for every field a readiness gate
reads, ask *what event causes the vendor to write it?* If that event is
downstream of the action you are gating, you have a deadlock. A field that is
null/"pending" on day 1 and day 6 with no intervening state change is the
observable signature — a genuinely slow signal moves.

**Fix shape.** Branch on the OPERATING discriminator the caller resolved
(`connectionType`), never on the vendor row's own copy of it, or the exemption
leaks into the other flow. Keep the existence/`status: "active"` check — the
contract clears the propagation verdicts, not the sanity checks. And relocate
the safety rather than deleting it: the mail-DNS guarantee moved to the mailbox
leg, which already awaited `provisioningState === "ready"` before writing the
billable row, so bill-only-on-vendor-confirmed survived untouched.

**Test note:** the wave-1 false-ready guards were all written on the purchased
path. Re-POINT them to the branch where they still govern (`unknown`) instead of
deleting them, and add an over-widening guard driving a CONNECTED domain against
a listing row that WOULD satisfy the new short-circuit. Related:
[[half-a-vendor-contract-invoked-on-the-other-half]] (same two-half contract,
same customer), [[sandbox-port-masks-real-server-contract]].
