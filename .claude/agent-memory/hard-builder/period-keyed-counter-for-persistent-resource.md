---
name: period-keyed-counter-for-persistent-resource
description: a per-period (monthly) ledger counter used to gate a PERSISTENT resource resets each period while occupancy persists → over-allocation after rollover; keep occupancy counters account-wide/single-row, not period-keyed.
metadata:
  type: reference
---

CLASS (ColdStart GA gates G4, 2026-07-23): the design put `slots_used` (the
InboxKit plan-slot occupancy counter) inside the **per-calendar-month**
`vendor_spend_ledger` row alongside the $ ceiling. But plan-slot OCCUPANCY
persists across months (a mailbox bought in January still holds its slot in
February), so a per-month counter resets to 0 at each rollover → the gate would
let a tenant re-provision the FULL plan again — silent over-provisioning. The $
ceiling correctly resets monthly (spend is a monthly budget); the slot count must
NOT. Fix: a single account-wide `vendor_slot_state(id=1, slots_used)` row,
incremented on real provision, decremented on release/reap/teardown — never
period-keyed. Each counter still gets its own atomic single-row conditional
UPDATE for the two-concurrent-reserve guard.

**Tell:** a counter that gates a durable/long-lived resource lives in a row keyed
by a time bucket that's shorter than the resource's lifetime. Decrement-on-release
also needs a durable per-item marker (mailboxes.slot_counted) because at teardown
the tenant is frozen→reads sandbox, so the live adapter kind can no longer tell a
real slot from a sandbox one.
