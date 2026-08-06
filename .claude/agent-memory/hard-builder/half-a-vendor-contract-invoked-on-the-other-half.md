---
name: half-a-vendor-contract-invoked-on-the-other-half
description: CLASS — an adapter implements ONE half of a two-half vendor contract, the discriminator is dropped at the port's type boundary, and the wrong half is invoked forever; retry fixtures that only model transient-then-success cannot express it.
metadata:
  type: project
---

CLASS (ColdStart INCIDENT 2026-08-05, the first paying customer's 100%-failing
provisioning): the vendor offers TWO ways to hold a domain — it registers it for
you (`connection_type: "purchased"`) or you point an existing one at it
(`"connected"`) — and each needs a DIFFERENT operation. The adapter implemented
only the CONNECTED half (`POST /domains/nameservers` + check-propagation) and was
only ever invoked on PURCHASED domains. Wrong operation: it threw
`404 Domain not found` at step 1 on every attempt, before a single mailbox was
attempted, and was graded `retryable: true`, so the customer's agent repeated the
same doomed call for 24 hours.

**The enabler is a TYPE-BOUNDARY drop.** The vendor reported `connection_type` in
the `/domains/list` response the adapter already parsed — and the adapter dropped
it building `OwnedDomain`. Nothing downstream *could* branch. Fix carries the
discriminator end to end: on `OwnedDomain` AND `PurchasedDomain`, persisted on
the `domains` row at acquisition (the only moment it is known for free), read
back by `setDnsWithRetry` and passed to `setDns(domain, key, connectionType)`.

**Why every test was green.** Two structural blindnesses, both worth checking for
by name:
1. **Every fixture modelled "fails N times, then succeeds"** — a transient race.
   A wrong operation NEVER succeeds, so no fixture in the suite could express it,
   and the incident's own hotfix + 2-round adversary gate shipped on a "32s async
   race" misdiagnosis (its round-2 proof STUBBED setDns to succeed).
2. **The sandbox port models "the call returned == the resource exists."** Real
   vendors accept async: `/mailboxes/buy` answers `"scheduled"`, so the very next
   uid-resolving call throws. Same shape one step later.

**How to apply:** when an adapter method has a doc comment describing a flow with
a precondition ("connect-existing-domain flow"), ask *which* callers satisfy that
precondition — if the answer is "none of them", the method is the wrong half.
And when a vendor response carries a discriminator the port type has no field
for, that is the bug, not a tidiness issue. Related:
[[sandbox-port-masks-real-server-contract]],
[[persist-before-confirm-cross-boundary]].
