---
name: orphan-detection-blind-to-the-row-never-created
description: Detection built on "a durable row is STUCK past a grace bound" cannot see "the row was never created" — the shape a target-semantics saga produces when it reports full success with paid capacity unbuilt.
metadata:
  type: project
---

⚠️ A watchtower/orphan check keyed on *a row sitting too long in an intermediate status* is
structurally blind to the sibling defect: **no row exists at all**, because the call that would
have created it was never made — and the platform reported SUCCESS.

**Why:** ColdStart's `setup_infrastructure` takes `domains`/`inboxesEach` as a TARGET over tenant
ORDINALS, not a delta (`engine/provisioning.ts` `planProvisioning`; address =
`` `${personaSlug}${ordinal+1}${slot+1}@${domain}` ``, `mailbox-provisioning.ts`). A repeat call at
the same `domains` is a no-op once its ordinals are satisfied, so two `{domains:1}` calls both
addressed ordinal 0 and ordinal 1 was never requested — no `domain_intents` row, nothing for
`mailbox_orphan:`/`domain_orphan:` (vendor-truth wave) to age out, and the response was the
full-success `{jobId, billing}`. The customer paid for 5 seats and held 2 for a week. The
vendor-side orphan checks shipped in the same period and would never have caught it.

**How to apply:** when designing detection for "unfinished business", ask what the MISSING-row
case looks like, not only the stuck-row case. The signal that catches it is a **commitment the
customer already made that the state does not satisfy** — here `max(MINIMUM_BILLABLE_MAILBOXES,
tenant_profile.mailbox_qty_synced)` vs `billableMailboxCount(ctx)`: money paid for capacity that
has no row. Note its honest bound: `syncMailboxQuantity` sets `mailbox_qty_synced` to
`max(5, provisioned)`, so the gap is non-zero exactly when a paying tenant holds fewer than the
5-mailbox floor — real, and narrower than it looks.

Corollary that shaped the fix: a recommendation must be a **dry run, not a sentence** — build
candidate params, run them through the SAME planner the saga calls, and emit the step only if the
planner says it buys something. Related: [[gate-waits-on-state-the-gated-action-produces]],
[[classifier-cannot-see-an-undiscriminated-return]],
[[anchor-stamped-before-the-read-defeats-its-own-bound]] (why `paid_seats_unprovisioned` reports
`sinceMs: null` — there is no activation timestamp, and stamping one at first read measures ~0
forever for the existing population). Design: `docs/research/customer-continuity-design-2026-08-18.md`.
