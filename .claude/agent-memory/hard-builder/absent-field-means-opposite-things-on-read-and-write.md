---
name: absent-field-means-opposite-things-on-read-and-write
description: "⚠️ CONFIRMED LIVE: an optional consent/money field can mean 'leave persisted value alone' on the WRITE path and 'NOT opted in' on the READ path — so citing the write path to justify omitting it from a recommended call produces a call that 503s."
metadata:
  type: project
---

⚠️ When two adversary rulings meet at one optional field, absence can be given **opposite
semantics on the read and write paths of the same request**. Citing one path to justify omitting
the field is then wrong in a way that reads as correct.

**The instance (ColdStart `setup_infrastructure.registerDomains`, confirmed live in prod tickets
`sup_dce385a8` / retraction `sup_9d2c9a3a`):**
- WRITE path (H8b, state ruling): absent must NOT erase persisted consent —
  `provisioning.ts:542` leaves `register_domains` alone.
- READ path (B1, money ruling): `optIn: input.registerDomains ?? false` (`tenant-do.ts:790`) —
  absent reads as NOT opted in, so a stale persisted `1` can never fire a real buy for a call
  that did not ask for one.

Both rulings are right. The design that emitted a recommended call without the field cited the
WRITE path in its justification, and the emitted call hit `selectRealDomainPort`
(`factory.ts:194-201`) → `RegistrarUnarmedDomainPort` → throw at `searchLookalikes`
(`provisioning.ts:518`, which runs UNCONDITIONALLY before any plan-shortfall branch, so even a
pure retry hits it) → founder page + 503.

**Why it matters beyond this field:** the customer's agent had been sending the field all along;
the recommendation would have taught it to stop. A "helpful" derived call can regress a working
integration.

**How to apply:**
- For any field you plan to OMIT from a generated/recommended call, trace the **read** path that
  consumes it in that same request, not the write path that persists it. Grep for `?? false`,
  `?? true`, and `!= null` on the field.
- A field with an intentional three-way meaning (`true` / `false` / absent) is a signal that two
  rulings already collided there — find both before reasoning about absence.
- Re-affirming consent the tenant already gave (`register_domains = 1` → emit `true`) is safe;
  auto-emitting `true` when the tenant never consented manufactures consent to real spend inside
  a call an unattended agent runs verbatim. Never do the second.

Related: [[sandbox-fallback-masks-a-missing-activation-gate]] (the guard that could not see this
field), [[two-valued-grade-for-a-three-valued-refusal]] and
[[customer-safe-translator-gated-on-error-shape]] (same wave's class A: the resulting
`registrar_unarmed` 503 is a self-clearable refusal graded "no action of yours can work" — the
opt-in leg is tenant-fixable in one field and should be a 400 naming it).
Design: `docs/research/customer-continuity-design-2026-08-18.md` §7.5/§7.8.
