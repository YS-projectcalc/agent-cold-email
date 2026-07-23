---
name: failing-by-construction-env-coverage-guard
description: How to make "a new vendor env binding must be wired into the spend-arming guard" enforce itself via a test that parses the source — so the NEXT binding trips RED instead of a doc comment being ignored.
metadata:
  type: project
---

TECHNIQUE (ColdStart R3-1, 2026-07-22): when a doc comment says "the next person
who adds X must also update Y" (here: a new vendor `INBOXKIT_*`/`MAILFORGE_*` env
binding must be OR'd into `isRealSpendArmed`, or the free-money simulated-checkout
bypass reopens on that vendor), a comment is NOT a guard — make it failing-by-construction:

1. Tag the load-bearing fields with a machine-readable marker in source — inline
   `// spend-arming` on each field in the `Cloudflare.Env` interface (env.ts).
2. A test `?raw`-imports the source text (workerd has no runtime fs; and a TS
   `declare global` interface has nothing to reflect at runtime), parses the
   `interface Env { ... }` body into `allFields` + the tagged `spendArming` set.
3. Assert (a) `spendArming` equals the expected literal set (a removed tag trips
   RED), (b) every tagged field name appears in the guard fn's body
   (`isRealSpendArmedBody.includes('env.'+field)`), and (c) EXHAUSTIVENESS:
   `spendArming ∪ KNOWN_NON_ARMING === allFields`, so a NEW env field that is
   neither tagged nor allowlisted trips RED until a human categorizes it.

The exhaustiveness leg (c) is what closes the "someone adds a vendor key and
forgets everything" hole — the pure tag+coverage version (a)+(b) only catches a
tagged-but-unwired field. Needs `declare module "*.ts?raw"` (see
[[coldstart-vitest-binding-and-d1-isolation-gotchas]]). RED-proof: drop the
InboxKit leg from the guard while leaving the env.ts tags ⇒ leg (b) fails with
the exact `env.INBOXKIT_API_KEY` it's missing.
