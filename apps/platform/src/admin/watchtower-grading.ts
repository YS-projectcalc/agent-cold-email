// Observation DAMPING for the watchtower — the layer between "what one probe
// saw this tick" and "what state the alert machine is told about".
//
// WHY (audit NB-1, 2026-08-06): the alert machine (watchtower-alerts.ts) emails
// on a state CHANGE and throttles persistence. That is correct for a condition
// that is either true or false, and WRONG for a condition SAMPLED every 5
// minutes: an intermittent fault flips healthy/unhealthy every cycle, and each
// flip is a genuine transition the 6h cooldown does not suppress. Executed
// against the pre-fix code: 24 emails in 2 simulated hours on one failure every
// other window. This is the cry-wolf class ofac/sdn-alert.ts was built for, and
// it is what trains a founder to ignore `[coldrig] ... UNHEALTHY`.
//
// Two damping shapes, because there are two kinds of observation:
//  - a COUNT of discrete events (failed sends, complaints) -> grade a trailing
//    WINDOW with a threshold, so one bad minute cannot flip the state and one
//    quiet minute cannot clear it;
//  - a per-tick BOOLEAN (this sweep's legs errored) -> grade a STREAK, N
//    consecutive bad ticks to alert and M consecutive good ones to recover.
// Both can answer "hold" — report nothing for this check this tick — which the
// alert machine turns into "no state change, no email" for free, since it only
// processes the results it is handed.
//
// PURE: no store, no clock, no I/O. The callers own persistence.

/**
 * How far back the failure-signal scan counts events. Deliberately much longer
 * than the 5-minute sweep cadence that produced the flap: the SAME failure is
 * counted by ~12 consecutive sweeps, so an intermittent fault holds the check
 * unhealthy continuously (1 email + the 6h cooldown) instead of oscillating.
 */
export const FAILURE_SIGNAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Terminal-'failed' sends in the window that constitute a signal. NOT 1: a hard
 * bounce is a normal outcome of cold email (it is why the deliverability loop
 * exists), and alerting on every single one is the same cry-wolf failure by a
 * different route. Three in an hour is a pattern, not an address.
 */
export const FAILURE_SIGNAL_FAILED_THRESHOLD = 3;

/**
 * Spam complaints are NOT damped the same way — one is worth an email. A
 * complaint is a deliverability-reputation event with an irreversible cost, and
 * it is rare enough that the trailing window alone (one alert, then quiet until
 * a clean hour) keeps the volume honest.
 */
export const FAILURE_SIGNAL_COMPLAINT_THRESHOLD = 1;

/** Consecutive bad sweeps before the cron-leg health check alerts (15 min). */
export const LEG_ALERT_AFTER_SWEEPS = 3;

/** Consecutive clean sweeps before it recovers — hysteresis, so a leg that
 * errors every other tick never produces an alternating email pair. */
export const LEG_RECOVER_AFTER_SWEEPS = 3;

/**
 * How stale the last completed sweep may be before the platform is considered
 * to have lost its cron. Three missed 5-minute cycles: long enough that normal
 * cron drift, a slow sweep, or one failed tick cannot trip it; short enough
 * that a dead watchtower surfaces in minutes, not days.
 */
export const SWEEP_STALE_MS = 15 * 60 * 1000;

/** How often the dead-man alarm re-arms itself to re-check sweep freshness. */
export const DEAD_MAN_INTERVAL_MS = 5 * 60 * 1000;

/** `null` = HOLD: the observation is inside the dead band, so the caller must
 * report nothing for this check and leave its state exactly as it was. */
export type Grade = boolean | null;

/**
 * Grade the windowed failure-signal counts. Unhealthy above either threshold,
 * healthy only on a genuinely clean window, HOLD in between — which is what
 * gives the check hysteresis without any extra persistence.
 */
export function gradeFailureSignals(failed: number, complaints: number): Grade {
  if (complaints >= FAILURE_SIGNAL_COMPLAINT_THRESHOLD || failed >= FAILURE_SIGNAL_FAILED_THRESHOLD) return false;
  if (failed === 0 && complaints === 0) return true;
  return null;
}

export interface StreakState {
  unhealthy: number;
  healthy: number;
}

export const EMPTY_STREAK: StreakState = { unhealthy: 0, healthy: 0 };

export interface StreakGrade {
  next: StreakState;
  grade: Grade;
}

/**
 * Grade a per-tick boolean into an N-up/M-down streak. Note that once a streak
 * has crossed its threshold EVERY further tick keeps returning the same grade —
 * the alert machine, not this function, is what stops that becoming a second
 * email (it sees no state change and suppresses within the cooldown).
 *
 * THE BAD TALLY SURVIVES A GOOD TICK; only a CONFIRMED recovery clears it (IN-8,
 * docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md, widened by
 * sweep-completeness-pass-2026-08-17.md §4(ii) to "any grader whose no-signal
 * state is reported identically to healthy").
 *
 * This used to zero `unhealthy` on ANY good tick, which made the gate
 * "N CONSECUTIVE bad ticks" — and a leg that fails INTERMITTENTLY rather than
 * continuously never assembles N in a row. It therefore returned `null` (HOLD)
 * forever, the caller reports nothing for a HOLD, and a sweep leg failing half
 * the time stayed silent indefinitely. Executed: 8 ticks of [bad, good, ...]
 * produced no grade at all. The dead band was not a band on SEVERITY, it was
 * "anything short of a 100% duty cycle".
 *
 * Carrying the tally across good ticks makes the gate "N bad ticks not yet
 * answered by a full recovery run", which is the condition the alert actually
 * means. The hysteresis this function exists for is untouched, because it lives
 * entirely in the RECOVERY direction: a recovery still requires `recoverAfter`
 * consecutive clean ticks, so an intermittent leg alerts ONCE and then stays
 * unhealthy rather than producing the alternating email pair (24 emails in 2
 * simulated hours) that motivated this file. An isolated blip still clears — it
 * simply has to be answered by a real clean run first.
 */
export function gradeStreak(
  prev: StreakState,
  observedUnhealthy: boolean,
  alertAfter: number = LEG_ALERT_AFTER_SWEEPS,
  recoverAfter: number = LEG_RECOVER_AFTER_SWEEPS,
): StreakGrade {
  if (observedUnhealthy) {
    const next = { unhealthy: prev.unhealthy + 1, healthy: 0 };
    return { next, grade: next.unhealthy >= alertAfter ? false : null };
  }
  const healthy = prev.healthy + 1;
  const recovered = healthy >= recoverAfter;
  return { next: { unhealthy: recovered ? 0 : prev.unhealthy, healthy }, grade: recovered ? true : null };
}
