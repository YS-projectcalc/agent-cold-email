---
name: announced-set-cap-bounds-storm-regardless-of-key-correctness
description: Design technique for changed-detail escapes — a per-episode announced SET plus a hard cap makes the anti-storm bound independent of whether any materiality-key derivation is correct; and a legacy-compat predicate that new code can never produce beats a migration backfill.
metadata:
  type: project
---

Two techniques from the ColdStart alert-state design
(`docs/research/alert-state-design-2026-08-20.md`, 2026-08-20). **DESIGN STAGE — specced, not
built; verify against the code before citing as shipped.**

**1. Cap the per-episode announced set.** A materiality KEY + per-episode announced set fixes
[[changed-detail-escape-storms-on-alternation]], but the bound then depends on all N key
derivations being right — and at least one family's key space is usually combinatorial (here: the
SET of failing cron legs). Adding `MAX_ANNOUNCED_KEYS_PER_EPISODE` makes the worst case
`1 + cap + ladder + 1` emails **whatever a key function does**, so the anti-storm argument survives
a mis-derived key. Calibrate it as `cap >= max(|declared key space|)` and ASSERT that in the
failing-by-construction guard — then a 6th key in any family reds the suite instead of silently
truncating.

**2. Prefer a legacy predicate the new code cannot produce over a migration backfill.** New column
`announced_keys`; legacy rows must not re-announce on deploy day. Instead of backfilling, the rule
is "`alertCount > 0` with an EMPTY set ⇒ adopt the first key silently" — unreachable for new state
(every announcing transition writes both together), so it is an unambiguous pre-column marker. Works
for a D1 table AND for DO storage, which has no migration mechanism at all — one rule, both
substrates, versus a backfill that only reaches one. Pin the unreachability as a fuzz invariant.
Corollary: parse failure on the blob must take the LEGACY branch, never "empty" — see
[[json-store-corrupt-catchall-silent-empty]]; empty here means re-announce everything.

**3. A PER-EPISODE ceiling is not an answer to a PER-DAY property.** v1 proved "≤ N emails per
episode" and asserted the founder's ratified "~2 emails/day" was preserved. The missing multiplier
is INSTANCE COUNT: 12 of 22 watchtower families are per-entity (`<tenantId>` / `<email>` /
`<domain>`), so at 100 tenants the same per-episode bound is ~900 emails/day. The gate simulated one
family at 50% duty × 100 tenants = **103/day**. Fixes that bound a per-item rate need a
**cross-item budget** (here: a rolling 24h counter in the DO, round-robin across FAMILIES so one
noisy family cannot starve every other check, over-budget alerts WITHHELD via the existing
withheld path and never deleted, and the overflow itself announced through one check with its own
ladder). One-shot money-bearing families stay exempt — suppressing a repeat reminder is cheap,
suppressing a billable loss is not.

**How to apply:** any time a design states a bound, check its UNITS against the property it claims
to preserve (per episode vs per day vs per inbox), and multiply by every unbounded dimension before
believing it.

**4. Two traps in the budget you add to fix #3, both caught by the round-2 gate:**
- **A rate-limiter must EXEMPT its own overflow report.** The "you are being rate-limited" check
  goes unhealthy exactly when the limiter is saturated, so budgeting it makes it self-suppressing
  — simulated 0 sent / 2015 withheld over 7 days. This is the dead-man's "an alarm must not depend
  on what it monitors" arriving through brand-new machinery, so the class sweep that closed it
  the first time does not catch it.
- **Before exempting X from a budget, check whether X's rate is ALREADY bounded by what the budget
  limits.** "Exempt recoveries" looked unbounded (1,400 instances) and is actually bounded by
  ANNOUNCEMENTS (≤140), because a recovery email is owed only for an episode that was announced and
  announcements are what the budget caps. That refutation is what let the budget avoid ever blocking
  an episode close — the alternative (budgeting recoveries) left 100 checks reading
  unhealthy-while-healthy for 4 days on the operator's own detector.
- Rule of thumb that resolved both: **the budget may delay an ANNOUNCEMENT; it may never delay a
  state CLOSE, and never suppress the report that it is suppressing.**
- **A SUB-CAP that binds first makes the primary cap's saturation predicate unreachable.** Adding a
  per-entity sub-cap (15 of 20) to fix a fairness finding silently reopened the "the overflow report
  never fires" finding fixed in the SAME revision: in a pure per-entity storm the total counter
  peaks at 15/20 forever, so a `saturated` predicate keyed to the total alone reads false while 85%
  of alerts are suppressed (0 sent over 7 days). Fix: saturation reads EITHER counter at its cap.
  **The generalisation — whenever you add a second, tighter limit, re-check every predicate keyed to
  the first one; and pin the regression test to the fixture where the tighter limit BINDS (a
  mixed-fixture test certifies the defect instead of catching it).**
- Also: a constant named for what it does NOT bound is claim-drift. `MAX_ALERT_EMAILS_PER_DAY` bounded
  announcements while recoveries and exempt families rode free — measured 30/day against a constant
  named 20. Rename at design time, and state founder-facing ceilings in the units the founder counts.

Also settled there: a recovery confirmation must NOT apply to a `no_longer_applicable` clear (the
entity left the population; requiring 3 confirmations re-opens the continuity blame-flip defect and
leaves departed entities' episodes open forever); and a silent "holding" state must be invisible to
any predicate that reads `status === 'unhealthy'` on a SIBLING (it inherited a stale episode onset
and permanently deleted a downstream one-shot nudge). Related:
[[false-recovery-disarms-cooldown-dedup]], [[confirmation-guard-deletes-one-shot-signals]],
[[composed-guard-arm-unreachable-under-its-own-precondition]],
[[guard-scoped-wider-than-the-state-it-protects]].
