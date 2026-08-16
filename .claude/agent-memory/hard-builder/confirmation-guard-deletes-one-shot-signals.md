---
name: confirmation-guard-deletes-one-shot-signals
description: "⚠️ CLASS: an N-consecutive-observations (debounce/confirmation) guard added at a SHARED alert choke point is a DELAY for a re-sampled check and a PERMANENT DELETION for a one-shot event report; it also compounds with any upstream damping and can silently breach the paging ceiling."
metadata:
  type: project
---

⚠️ CLASS (ColdStart watchtower, founder alert-policy ruling 2026-08-16). The
ask was "a check must be observed unhealthy on 2 CONSECUTIVE observations
before the first email". The rule is correct for a cron-SAMPLED probe and
catastrophic for two other shapes that share the same entry point
(`reconcileAlerts` / `decideAlert`):

1. **One-shot event reports are DELETED, not delayed.** `reportCheck` raises
   `mailbox_provisioning:<email>` / `mailbox_rebuy:<email>` ONCE, from inside a
   saga around real vendor spend — nothing ever re-observes them. "Wait for a
   second observation" therefore means "never alert". The repo's own comment
   said so about streak damping and the debounce would have walked straight
   into it. Proven by mutation: deleting the exemption makes the pre-existing
   `mailbox-rebuy-guard` test go silent.
2. **Damping COMPOUNDS.** `cron_legs` is already reported only after 3
   consecutive bad ticks (15 min); debouncing it again pages at 20 min and
   breaks the same ruling's "genuinely-down must page in ~10-15 min" ceiling.
   Two clauses of one spec can contradict each other on a single check — say
   so and pick the absolute one, don't average them.

**How to apply.** Before adding any "N consecutive/repeat observations"
requirement, enumerate the PRODUCERS of every signal that reaches the guarded
choke point and classify each by CADENCE: re-sampled (safe), already-damped
(exempt — the requirement is met upstream), one-shot (exempt — the requirement
is unmeetable). The discriminator is the observation cadence, not the state or
the severity, which is what makes this different from
[[guard-scoped-wider-than-the-state-it-protects]]. Put the classification in
ONE table (`policyFor(checkName)`) keyed on named constants rather than string
literals, make the policy a REQUIRED argument of the pure rule so no call site
inherits one silently, and back it with a source-parsing guard test that fails
when a new check name appears unclassified ([[failing-by-construction-env-coverage-guard]]).

Two more that generalize:
- **Recovery must be gated on "was it ANNOUNCED", not on "was it unhealthy".**
  A debounced flap that still sends RECOVERED is worse than the original noise.
  The durable witness is an alert COUNT (`alertCount > 0`), which doubles as
  the backoff ladder's rung — one field, both jobs. See
  [[false-recovery-disarms-cooldown-dedup]] for what a wrongly-cleared incident
  does to a cooldown.
- **A per-episode counter added to an existing state machine needs a BACKFILL
  for the episodes already in flight**, or every currently-firing incident
  re-announces itself and restarts the ladder right after deploy — on exactly
  the checks the change was meant to quiet. DO storage has no migration step,
  so the same reconstruction has to exist in code (`normalizeAlertState`).

Process: do NOT edit source while an 8-minute full-suite verification run is in
flight — vitest transforms each file as it reaches it, so a mid-run edit
contaminates the result and it has to be re-run from scratch.
