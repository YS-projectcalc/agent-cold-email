---
name: knob-frozen-into-a-row-at-first-use
description: A config knob copied into a period/session row by INSERT OR IGNORE is frozen at that row's creation — so the remediation the alert instructs ("raise the limit and retry") is a no-op until the next period.
metadata:
  type: project
---

⚠️ A gate that reads its threshold from a ROW, where the row was seeded `INSERT OR IGNORE` from a config knob, has silently made the knob write-once-per-period. Changing the knob does nothing until a new row exists. This is worst on a guard whose OWN alert text instructs the operator to change that knob — the instruction is false in exactly the window it gets read, because the alert only fires when the gate is already blocking.

**Why:** ColdStart `engine/spend-ceiling.ts`, found 2026-08-20 while implementing the paying-tenant formula. The reserve gates on `vendor_spend_ledger.ceiling_cents`, seeded once per calendar month; `alertCapacityPending` says *"raise SPEND_CEILING_CENTS … a retry will succeed once the limit is raised"*. Raising it did nothing for up to a month. Fixed with a RAISE-ONLY reconcile (`WHERE … ceiling_cents < ?`) beside the seed — never lowering, since dropping a live month's ceiling under its already-spent reserved+committed blocks every remaining provision on numbers the operator never saw.

**How to apply:** whenever a knob is denormalized into a row, decide explicitly whether later knob changes must reach the live row, and in WHICH direction. Then expect fixture fallout: six tests across three files here expressed "the ceiling is low" by seeding a low ROW only, and all six broke — a fixture that sets one of the two places is now under-specified, not wrong. Fix by declaring both, never by removing the reconcile. Related: [[coldstart-per-tick-recompute-clobbers-control-state]], [[adapter-selected-from-column-before-same-request-update]].
