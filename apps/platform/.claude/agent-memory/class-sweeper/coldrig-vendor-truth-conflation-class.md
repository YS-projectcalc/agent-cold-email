---
name: coldrig-vendor-truth-conflation-class
description: The vendor-truth-conflation defect class swept 2026-08-14 in ColdStart — its two facets, where members live, and the type-level root
metadata:
  type: project
---

Class swept 2026-08-14 at HEAD `6b96ae92bd5d20e2871a41609e8518ccd68804c8`: **"a terminal vendor state graded as a transient not-yet."** Two facets — (1) grading from OUR local lifecycle column instead of the vendor's verdict, (2) a "not yet" with no bound after which it becomes failure.

**The root is at the port TYPE boundary, not at any call site.** `DomainPort.setDns` returns a bare `DnsRecordSet` (five booleans) and `MailboxPort.provisioningState` returns `"absent" | "pending" | "ready"` — neither type can express "the vendor says this is dead," so every adapter is forced to collapse terminal into false/pending and every engine consumer is structurally unable to discriminate. This is the SAME shape as the 2026-08-05 incident's root cause (the adapter dropped `connection_type` at the type boundary, so nothing downstream could branch on it) — that one was fixed by adding `DomainConnectionType` to the port types. The same fix shape applies.

**Why this class keeps regenerating here:** the codebase's asymmetry rule ("guessing not-ready costs a retry, guessing ready bills a customer for a dead mailbox") is correct and load-bearing, but it makes NOT-READY the safe default everywhere — and nothing anywhere converts a long-lived not-ready into a failure. Any future "be conservative, report not-ready" decision is a new class member unless it also carries a bound.

**Do NOT propose deleting the asymmetry.** Propose the bound + a terminal verdict alongside it. A fix that makes `polledDomainIsReady` return true for a non-active vendor status re-opens the exact false-ready billing defect the 2026-08-06 combined-diff gate closed.

Related: [[coldrig-search-coverage-ledger]]
