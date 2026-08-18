---
name: anchor-stamped-before-the-read-defeats-its-own-bound
description: "CLASS: an age bound whose anchor is COALESCE-stamped by the same call that reads it always measures ~0 for the legacy NULL population; and a cross-clock-domain fallback column (purchased_at) fixes it in one direction while insta-terminaling fresh resources in the other."
metadata:
  type: project
---

An age/staleness bound is inoperative for the population it was added for when the
observation that stamps the anchor runs BEFORE the age is computed. ColdStart
`domain-dns.ts`: `recordDnsObservation` does `dns_first_checked_at = COALESCE(anchor, now)`
and the bound then reads the POST-write row, so a 504h stall's first-ever
observation measured 0ms and the 6h give-up could not fire until the customer
retried, waited 6h, and retried again. Fix: compute the age against the state the
call FOUND (read pre-write), not the state it left.

**Why:** the audited surface (founder alert, `ops-summary.ts`) had a `purchased_at`
NULL-anchor fallback and read the row WITHOUT stamping, so it looked like the
customer-facing bound just needed "the same fallback" — but the same expression
pasted into the write path yields 0 every time.

**How to apply:** whenever a bound reads a column its own call also writes, ask
which snapshot the decision is entitled to. Also: importing a fallback column
across a clock domain is NOT free — `purchased_at` is stamped `Date.now()` by the
real registrar adapter and `ctx.clock.now()` by sandbox, and `clock-migration.ts`
shifts the anchor but not the purchase, so on a virtual clock advanced ~29 days a
domain bought seconds ago reads as weeks old and goes terminal. Gate any such
fallback on `tenant_profile.clock_mode = 'real'`. Both directions were caught only
by the FULL suite (`vendor-verdict-class.test.ts`'s burn-replacement transient
control + its N1 CONTROL asserting a present anchor is never overridden) — a
targeted run of the new gate tests was green while both were broken. Related:
[[coldstart-per-tick-recompute-clobbers-control-state]].
