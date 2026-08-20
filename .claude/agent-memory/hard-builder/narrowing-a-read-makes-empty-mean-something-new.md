---
name: narrowing-a-read-makes-empty-mean-something-new
description: Narrowing a full-table read for cost silently re-defines what an EMPTY result means — any fail-closed guard keyed on emptiness flips from rare-race to every-clean-request.
metadata:
  type: project
---

⚠️ CLASS, and the failure direction is usually catastrophic-but-quiet. A guard written against a FULL scan can legitimately read "zero rows" as "the data vanished", because under a full scan that is the only way to get zero. Add a WHERE clause for cost and zero becomes the ordinary answer for the common case — so the guard either fires constantly or (if inverted) never fires at all.

**Why:** ColdStart S9, 2026-08-20. `screenTenant` pulled all ~17k SDN rows per signup; its TOCTOU guard failed CLOSED on `entries.length === 0`, correctly, because a concurrent `swapInSdnList` cleanup could delete the version mid-screen and clearing a sanctioned tenant by racing a list swap is the wrong direction. Narrowing the read to "rows that could match" makes zero rows the answer for EVERY clean tenant — the guard as written would have held every clean signup for manual review. Fixed by giving the guard its own question (`sdnVersionHasEntries`, an indexed `SELECT 1 … LIMIT 1`), asked only when there is nothing to report, since a hit is itself proof the version was populated.

**How to apply:** when you add a filter to a read, grep every consumer of that read for `.length === 0` / `!rows.length` / `isEmpty` and re-derive what each one MEANT. Emptiness is an inference about the *store*; once the read is filtered it is only an inference about the *filter*. Give the store-level question its own cheap query. Related: [[polling-check-error-is-indistinguishable-from-negative]], [[operator-read-scoped-by-key-prefix-reports-empty-as-truth]], [[shared-primitive-caveat-wired-to-one-consumer]].
