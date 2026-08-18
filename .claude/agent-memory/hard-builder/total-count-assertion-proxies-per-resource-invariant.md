---
name: total-count-assertion-proxies-per-resource-invariant
description: CLASS — a money-guard test asserting a TOTAL call count as a proxy for a PER-RESOURCE invariant ("never re-buy THIS address") fires as a false money-path regression the moment an unrelated isolation fix stops the loop aborting early
metadata:
  type: project
---

⚠️ CLASS: a guard test that asserts a **total** vendor-call count (`expect(mailbox.buys).toHaveLength(1)`) as a stand-in for a **per-resource** invariant ("a terminal verdict authorizes no SECOND purchase of THIS address") is only true because of whatever made the loop stop early. Change the loop — here IN-5's `forEachIsolated` per-slot isolation in `provisionMailboxesForDomain` — and the count doubles, so the test reads as a P0 money regression while the real invariant is untouched. The tell: the recorded calls are **different resources** (`sender11@`, `sender12@` = the two slots the request ordered at `inboxesEach: 2`), each dispatched exactly once under its own address-derived `claimBuyDispatch`.

**Why:** the assertion conflated "one buy total" with "≤1 buy per address". The per-address dispatch claim (MAX_BUY_DISPATCHES=2, claim written BEFORE the vendor call) is the actual guard, and it never moved; the pre-IN-5 loop's abort-at-first-failure was incidental cover, not the guard.

**How to apply:**
- Before calling a count-assertion failure a regression, print the recorded call ARGUMENTS. Same resource repeated = real. Distinct resources = a loop-shape change, not a spend duplication.
- Rewrite the assertion as identity, not arity: `expect([...buys].sort()).toEqual([addr1, addr2])` pins one purchase per ORDERED slot, and add the leg that actually exercises the money guard — a RETRY with a **fresh request-idempotency key** (bypasses request idempotency so only the durable dispatch record stands) must add zero buys.
- Prove both directions with cp-backed injections: break the guard (`if (verdict.kind === "terminal") return dispatchBuy(...)`) → the fixed test must go RED (it did: 4 buys); revert the isolation hunk → the count returns to the old value, which is what names the cause.
- Do NOT "fix" this by reverting the isolation: with IN-5's loop reverted, `provisioning-hol.test.ts`'s slot-2/3 case records `[]` instead of the healthy addresses.

Related: [[return-type-destroys-the-terminal-distinction]] (the terminal verdict this guard protects), [[vendor-cancel-needs-marker-and-attempt-cap]], [[guards-inline-in-a-loop-are-not-a-policy]].
