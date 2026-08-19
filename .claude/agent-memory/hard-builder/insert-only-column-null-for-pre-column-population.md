---
name: insert-only-column-null-for-pre-column-population
description: A column added by addColumnIfMissing and written INSERT-only is permanently NULL for every pre-existing row — and its value is often still recoverable by INVERTING a deterministic derivation (persona from the mailbox address).
metadata:
  type: project
---

`addColumnIfMissing` is a plain `ALTER TABLE ADD COLUMN` with a literal default (it cannot
compute), so any column whose only writer is an `INSERT OR IGNORE` is **permanently NULL for the
entire pre-column population** — which, on this platform, is the whole current paying population.
`domain_intents.persona_slug` shipped this way; `readProvisioningSnapshot` reads it as the ONLY
persona source, and `deriveNextSteps` substituted `""`, which `slugify` turns into `"hello"`
(`|| "hello"` fallback), so the customer-facing recommendation planned against `hello11@…`,
matched none of the tenant's real mailboxes, counted every slot NEW, and priced a +$16/mo increase
inside a step whose prose said "your bill is unchanged". `inboxes_each` is NULL for the same rows.

**Why:** two readers of one NULL disagreed — `provisioning-reconcile.ts` treats a NULL spec as
"not safely completable, abstain" while the new customer-facing path substituted a default. The
DEFAULT-SUBSTITUTING reader is always the dangerous one. No fixture could see it: every
end-to-end fixture seeded the one column production leaves NULL, and derived the mailbox addresses
from that same seed (grain-matched — see [[fixture-born-with-the-code-restates-its-premise]]).

**How to apply:** on any NULL-column finding, ask two questions in order.
1. *Is the value RECOVERABLE from an artifact the old code already produced?* A deterministic
   derivation is invertible: `managedMailboxAddress` is `${persona}${ordinal+1}${slot+1}@${domain}`,
   so a live mailbox at a known ordinal inverts to exactly one persona. Write the inverse NEXT TO
   the forward function (the `domainIntentKey`/`domainIntentOrdinal` idiom) and verify by ROUND
   TRIP (`forward(candidate) === artifact`), never by parsing — parsing has to reason about
   multi-digit ordinals and slugs that end in digits. Backfill in the DO constructor on the
   `backfillFirstPaidAt`/`grandfatherActiveScreening` precedent, guarded by `IS NULL`, in ONE
   `CASE key WHEN ? THEN ?` statement (a per-row loop with `sql.exec` reddens the whole platform
   suite — [[loop-isolation-tripwire-flags-any-sql-write-loop]]), and write only when EVERY
   artifact agrees.
2. *Where it is still unknown, does the consumer ABSTAIN or DEFAULT?* Abstain: emit the step with
   `effect: null` and prose saying the platform cannot price it. But scope the abstention to where
   the answer actually DEPENDS on the missing value — a tenant with nothing live has a
   persona-INDEPENDENT plan and must keep its correct projection, or you have re-created §7.17.6's
   mirror-image defect (the platform knowing something and pretending not to).
