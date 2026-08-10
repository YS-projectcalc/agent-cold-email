---
name: refusal-path-added-to-claimed-record-table
description: "CLASS: adding a REFUSAL path after a claim-first dedup insert creates a first-ever divergence between 'recorded' and 'applied' — every existing consumer that counts rows in the claim table silently inherits phantom entries. Sweep the readers of the claim table, and fix with a flag, never by reordering the claim."
metadata:
  type: project
---

CLASS (ColdStart wave-2 gate residual N-2, fixed 2026-08-06). `webhook_events` was
a pure dedup/replay table: a row meant "this Stripe event arrived AND was
applied", because nothing could arrive and not apply. The wave's new staleness
guard added the first path that CLAIMS an event and then REFUSES it. The guard's
own tests were green — it correctly changed no billing state — but
`ops-summary.ts`'s `billingFailureCount` counts
`webhook_events WHERE type='invoice.payment_failed'` as the dunning cycle, so
three refused redeliveries read as three strikes and a recovered payer got
suspended on their FIRST genuine failure. The defect is in a file the guard's
author never opened.

**Why:** a dedup table's row is a claim, not an outcome. The moment any code path
can claim-then-not-do, every consumer that treated the claim as an outcome is
wrong, and none of them are in the diff.

**How to apply:**
1. When you add a refusal/skip/abort path AFTER an existing `INSERT OR IGNORE`
   claim, grep every reader of that table before writing the fix — the
   consumers are the blast radius, not the guard.
2. Fix with a FLAG on the row (`applied INTEGER NOT NULL DEFAULT 1`), not by
   moving the claim after the check. The claim-first order is load-bearing
   somewhere else (here: the checkout lane, where claim-before-effects is what
   closed an OFAC fail-open) — reordering trades a counting bug for a
   compliance bug. Marking cannot regress ordering by construction, which is
   the whole argument for it.
3. `DEFAULT 1` = "a row that already exists records something that applied", so
   no live tenant's counter shifts at deploy. Assert that in the migration test.
4. A new column on a per-DO table needs its `addColumnIfMissing` entry in
   tenant-do.ts or EVERY existing DO throws `no such column` out of the read —
   see [[coldstart-vitest-binding-and-d1-isolation-gotchas]] and the gate's N-3.
   Every test DO is built fresh from the current schema, so the suite CANNOT see
   this: manufacture the pre-column table (DROP + recreate with the old columns,
   re-insert the rows), `evictDurableObject`, then drive a real read. NB
   `ALTER TABLE ... DROP COLUMN` fails on these tables — SQLite rewrites the
   stored CREATE TABLE text and chokes on the house-style inline `--` comments
   (`error in table X after drop column: incomplete input`).

5. Mark EVERY refusal site, not just the first-delivery one. A completion/
   reconcile pass that declines to finish superseded work is also a refusal —
   an in-flight marker means the earlier attempt never completed, so that event
   never applied either. See [[completion-pass-must-recheck-ordering]].

**⚠️ "The crash isn't testable" is not "the fix isn't testable" — I got this
wrong and was corrected.** I declined to mark the completion-pass refusal on the
grounds that its trigger (a DO eviction mid-await) can't be forced in-process.
But the trigger is not the unit under test: WRITE THE DURABLE RESIDUE DIRECTLY
(claim row + in-flight marker via `runInDurableObject`), land a superseding
event, then deliver the redelivery — that drives the refusal path for real and
pins the semantic. Whenever you're about to report something as untestable, ask
whether you can seed the STATE instead of reproducing the EVENT that created it.
NB pick the superseding event so it doesn't move an unrelated basis/counter
(`subscription.deleted`, not `subscription.updated(active)` — a recovery calls
`recordDunningCycleBasis` and would hide the strike for the wrong reason, making
the test vacuously green).

Related: [[persist-before-confirm-cross-boundary]] (the claim/effect ordering
this must not disturb), [[guard-scoped-wider-than-the-state-it-protects]].
