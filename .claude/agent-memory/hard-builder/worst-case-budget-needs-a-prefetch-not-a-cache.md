---
name: worst-case-budget-needs-a-prefetch-not-a-cache
description: ⚠️ a lazy cache cannot lower a WORST-CASE budget — if the consumer might still fetch, the per-item cost constant cannot come down and any capacity derived from it is a lie; and de-duplicating calls that pass DIFFERENT windows silently mis-windows the aggregated fields.
metadata:
  type: project
---

ColdStart, 2026-08-24: three cron legs (dunning, digest, watchtower) each made
their own `opsSummary` DO RPC per tenant per tick — three round trips to the same
object for the same tenant.

**(a) The saving has to be deterministic or the arithmetic cannot use it.** The
first instinct is a per-tick memo with a fetch on miss. That leaves the WORST
case exactly where it was, and the tenant slice is derived from the worst case —
so `SWEEP_RPCS_PER_TENANT` could not come down, the slice could not go up, and
the "saving" would have been typical-case only while the capacity arithmetic
priced it as real. The shape that works is a PREFETCH LEG: fetch first, in its
own pass over the same population under the same deadline, and let consumers
treat a miss as an ERROR rather than falling back (a fallback restores the worst
case). Its coverage is then a superset of its consumers' by construction.

**(b) De-duplicating callers that pass different windows mis-windows them
silently.** The three passed a zero-width span, 24h and 1h. The windowed fields
are AGGREGATED at the source (counts, not rows), so no caller can re-window what
it is handed. A memo keyed on id gives two of the three a span they did not ask
for, in the reassuring direction both ways: a 24h failure count graded against a
1h threshold reads as an incident; a 1h activity count reported as a day's worth
reads as calm. Fix: ONE call that takes BOTH windows and computes each field
group with its own, an explicit `windows: {...}` field on the returned object,
and an accessor that THROWS on a mismatch into the per-item catch — a wrong
number becomes a counted error instead.

Proven by flipping the shared RPC back to single-window: the watchtower's
failure count read 2 instead of 1.

**(c) A SHARED FETCH MUST SHARE WHAT IT LEARNED, NOT JUST WHAT IT FETCHED.**
⚠️ The gate caught this by execution. The prefetch swallowed each failed RPC's
real error into a `console.error` and the consuming legs raised
`new Error("the prefetch did not supply tenant X")` in its place. Two things
died at once on the ONLY production path: the founder's alert body carried a
tautology about our own plumbing where "no such table: scheduled_sends" used to
be; and the downstream classifier keys on `err.name`, which on a fresh
`new Error` is always "Error" — so three of its four keys became UNREACHABLE and
a tenant whose failure MODE changed could no longer re-alert. Return
`failures: Map<id, unknown>` beside the results and RETHROW the original.

**How to apply:** when folding N calls into 1, enumerate every ARGUMENT the N
call sites pass AND everything the N catch blocks used to receive. A caught
error is a return value. Related:
[[remedy-computed-in-different-coordinates-than-the-defect]],
[[shared-primitive-caveat-wired-to-one-consumer]].
