# Class sweep — purchased-vs-connected domain DNS misapplication (2026-08-05)

**Ref** `0d48fbe` main, read-only (working tree mutating from sibling lanes — re-pin before a fixer acts). Frozen by orchestrator from sweep-domain-type's read-only report.

## CONCLUSIONS
1. **Root cause CONFIRMED; the incident's "32s race" (H2) was a MISDIAGNOSIS.** `goauthorpitchdesk.com` is a `go`-prefixed LOOKALIKE registered via `POST /domains/register` → InboxKit is the registrar → `connection_type="purchased"`. `setDns` (inboxkit-domain-port.ts:180) runs InboxKit's **connect-existing-domain** flow (`POST /domains/nameservers` = "here are NS for YOU to apply at YOUR registrar" + check-propagation) — an operation that does not apply when InboxKit already owns the nameservers. `last_ns_check=None` ⇒ step-2 never ran ⇒ step-1 threw. A race resolves on retry; Mordy's 3 retries over 24h with `actual_ns=[]` cannot be a 32s race → permanent wrong-operation. The 14-member hotfix + 2-round gate SHIP'd on the race premise and never questioned the operation; its round-2 "attempt3 vendor-healthy→ready" proof STUBS setDns to succeed → fixture-unreal for a purchased domain. **This class is OPEN.**
2. **Fix is CODE + almost-certainly a stuck vendor domain.** Code-only (branch setDns for purchased) prevents future strands + stops the loop, but Mordy's live domain (`nameserver_match=pending, actual_ns=[]`, 24h+) may be wedged — "code fix repairs Mordy" is UNPROVEN; needs a read-only vendor check + likely release+reprovision.

## CORRECTED CLASS
The InboxKit domain port implements the CONNECTED-domain half (setDns = connect-existing NS flow) but is only ever INVOKED on PURCHASED domains (buy=/domains/register; adopt=same account) — the two halves are mismatched, and the discriminator (`connection_type`) is DROPPED at the `OwnedDomain` type boundary so nothing CAN branch. Compounded by class-2 (retryable laundering) + class-3 (readiness lie).

## INVENTORY (most-critical first)
| site | class | verdict | reason |
|---|---|---|---|
| vendors/real/inboxkit-domain-port.ts:180-201 `setDns` | 1 | **IN — root** | connect-existing NS flow unconditionally; only called on purchased/adopted → wrong op, throws forever |
| engine/provisioning.ts:399-404 `setDnsWithRetry` throw | 2 | **IN — root** | re-throws VendorError(retryable:true), discarding mapInboxKitError's permanent 4xx grade → looks transient → unbounded customer retries |
| engine/provisioning.ts:387-389 `dns_status='ready'` | 3 | **IN** | flips 'ready' on setDns RETURN ignoring the returned DnsRecordSet flags; setDns returns all-false without throwing on not-propagated → 'ready' can LIE (gate doc's own NEW-4, unfixed) |
| vendors/real/inboxkit-domain-port.ts:119-140/243 `listOwnedDomains` | 1 | **IN — enabler** | reads vendor `connection_type` (:243) but DROPS it; OwnedDomain has no such field — the type drop is why nothing downstream can branch |
| packages/shared/src/vendor-ports.ts:39-45 `OwnedDomain` / :18-24 `DnsRecordSet` | 1/3 | **IN — enabler** | OwnedDomain lacks connection_type; DnsRecordSet flags exist but every consumer discards them |
| engine/provisioning.ts:471-473 & :556 setDnsWithRetry calls | 1 | **IN** | both drive setDns uniformly; B1 fix re-drives the SAME wrong op |
| engine/deliverability-actions.ts:191-203 REPLACE_DOMAIN | 1 | **IN** | burn-replacement buys a new lookalike (purchased) → same wrong setDns; blast radius is NOT just initial setup |
| engine/provisioning.ts:320-350 `findAdoptableDomain` | 1 | **IN — enabler** | adopts by status+assignedMailboxes only; never records connection_type |
| engine/provisioning.ts:536-542 domains INSERT | 1 | **IN — enabler** | persists no connection_type/registrar → even fixed code has nothing in-DB to branch on |
| inboxkit-domain-port.ts:139 (>MAX_DOMAIN_PAGES retryable:true) | 2 | **IN** | permanent condition classified retryable → loops |
| engine/lifecycle.ts:209-238 teardown `domain.release` | 1 | **UNCERTAIN** | selects ALL domains (no source filter) incl. BYO, calls /domains/remove uniformly — BYO never in the domain port → may error/throw, failing teardown |
| inboxkit-domain-port.ts:203-211 `release` | 1 | **UNCERTAIN** | single /domains/remove for both types; may need branch (cancel-registration vs disconnect) |
| engine/byo-intake.ts + byo-mailbox-composition.ts | 1 | **OUT** | BYO uses dnsScan + pollByoDomainDns, NO buy/setDns — where CONNECTED handling correctly lives; reinforces setDns is the orphaned wrong-op |
| engine/tick.ts:390-392 send retryable | 2 | **OUT** | bounded by MAX_SEND_ATTEMPTS(5) |
| vendors/real/mailbox-port.ts:47-63 provision, :133-148 cancelWarmup | 2/3 | **OUT** | buy gating is upstream (setDns throw); cancelWarmup retryable is correct+bounded |

## SYSTEMIC GUARD
- Carry the discriminator: add `connectionType: "purchased"|"connected"` to `OwnedDomain`, populate from listOwnedDomains (:243), record on the domains row at buy/adopt.
- Branch setDns: purchased → skip `POST /domains/nameservers`, only poll status/propagation (InboxKit owns purchased mail-DNS); connected → keep current flow.
- Stop laundering: setDnsWithRetry PRESERVES a non-retryable underlying VendorError — a permanent wrong-op surfaces permanent, not "retry to finish it" forever.
- Readiness honesty: gate dns_status='ready' + mailbox buy on the returned propagation flags, not merely on setDns not throwing (closes NEW-4).
- CI: fixture rule exercising the real port against BOTH connection_type values; forbid a setDns fixture that only models transient-then-success.

## UNSETTLED (need vendor evidence — gate whether code alone repairs Mordy)
(a) exact InboxKit semantics of `POST /domains/nameservers` + `/domains/remove` for a `purchased` domain; (b) whether Mordy's live domain is wedged vs awaiting automation (read-only `POST /domains/list`/status).
