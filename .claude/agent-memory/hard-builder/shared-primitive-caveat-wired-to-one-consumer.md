---
name: shared-primitive-caveat-wired-to-one-consumer
description: "⚠️ THIRD INSTANCE on ColdStart: a skip/exclusion/suppression written for ONE consumer of a shared primitive, while the primitive feeds others — the other consumers silently keep the unfiltered view."
metadata:
  type: project
---

⚠️ When a design introduces a shared derivation with several consumers, every caveat it later needs
(a skip, an exclusion, a suppression, a population filter) gets written at the consumer where the
problem was NOTICED. The other consumers keep the unfiltered view, and the bug is invisible because
the caveat demonstrably exists in the code.

**Three instances on this project, same shape:**
1. Round-1 non-blocking 3 — the demo/simulated-tenant skip written for the watchtower CHECK, while
   `deriveNextSteps` also feeds every RESPONSE. A tenant paying nothing would have been told it owed
   5 mailboxes.
2. Round-2 N2 — the `continuity_nudge` exclusion written on `unackedBlockingMessages`, while the
   unhealthy predicate reads `owedCount` from `deriveNextSteps`. The nudge's own `action_required`
   row would sustain the check forever → `AlertState.sinceTs` never advances → **every future stall
   for that tenant is silently un-nudged**. The population that cannot self-clear it (no
   `ack_message` call) is exactly the target population.
3. (Pre-existing, same family) [[guards-inline-in-a-loop-are-not-a-policy]] — governance written
   inline at one call site rather than at the effect.

**How to apply:**
- Put the filter in the PRIMITIVE, never in a consumer. If a consumer seems to need its own filter,
  that is the signal the primitive is under-specified — fix it there.
- When reviewing a fix, ask *which reader actually evaluates the predicate the caveat protects*, and
  check that reader specifically. N2's exclusion was real code on a real signal — just not the
  signal the `unhealthy ⇔ owedCount > 0` predicate consults.
- A property-level guard survives this better than a rule: "no new reason appeared whose source is a
  row this feature writes" is checkable at the primitive regardless of where someone wires the
  filter.

Related: [[emitter-writes-into-the-set-that-keys-its-own-dedup]] (the loop N2's exclusion exists to
break), [[guard-scoped-wider-than-the-state-it-protects]] (the mirror error — right site, wrong
scope). Design: `docs/research/customer-continuity-design-2026-08-18.md` §7.17.2.
