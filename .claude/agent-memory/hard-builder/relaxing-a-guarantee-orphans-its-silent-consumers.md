---
name: relaxing-a-guarantee-orphans-its-silent-consumers
description: ⚠️ relaxing a boundary validator breaks every downstream site that silently RELIED on the guarantee without ever naming it — grep for consumers of the GUARANTEE, not the validator
metadata:
  type: project
---

Relaxing a boundary check (zod refinement, assert, type narrowing) is never a
one-line change: sites downstream may have been written on the assumption the
check held, and they do NOT mention it, so a grep for the validator finds
nothing.

**Confirmed 2026-08-18, ColdStart I2.** `SetupInfrastructureInput`'s
`superRefine` required `registrant` whenever `registerDomains: true`. The design
called deleting it "strictly widening — no existing caller's behaviour changes".
Two sites depended on it without saying so:

1. `runSetupInfrastructure`'s profile write did
   `registrant_json = input.registrant ? JSON.stringify(...) : null`. Safe only
   because zod guaranteed a registrant on the opt-in path. After the relax, the
   flagship recommended call (`registerDomains:true`, no registrant) WIPED the
   tenant's persisted registrant, then 400'd on the next
   `assertCompleteRegistrant` — the exact call the wave exists to make work.
2. `TenantDO.selectSetupDomainPort` baked the vendor port's registrant from
   `input.registrant` ALONE. After the relax it carried the
   brand/physicalAddress-derived PARTIAL while the buy-site pre-flight validated
   the COMPLETE persisted one and waved it through — a partial contact_details
   payload sent to the registrar. The file's own comment claimed the two "can
   never disagree".

**Why:** a validator's guarantee is consumed by code that never references it,
so its removal is invisible to every search anchored on the validator's name.
The failure surfaces one or two seams later, on the exact path the relaxation
was for.

**How to apply:** before deleting/relaxing any boundary check, enumerate what
the checked field FEEDS (writes, adapter construction, downstream asserts) and
ask of each: "does this line only work because the check held?" Fix those in the
same commit. Related: [[fixture-born-with-the-code-restates-its-premise]],
[[absent-field-means-opposite-things-on-read-and-write]].
