import { describe, expect, it } from "vitest";
import {
  EMPTY_STREAK,
  gradeStreak,
  LEG_ALERT_AFTER_SWEEPS,
  LEG_RECOVER_AFTER_SWEEPS,
  type StreakState,
} from "../src/admin/watchtower-grading.js";

// IN-8 + the arm-C widening, docs/adversarial/class-sweep-dedup-semantics-
// 2026-08-17.md and sweep-completeness-pass-2026-08-17.md §4(ii).
//
// THE CLASS: a grader whose no-signal state is reported identically to healthy.
// `gradeStreak`'s run-length gate zeroed the unhealthy tally on ANY good tick,
// so a leg that errors intermittently — rather than continuously — could never
// reach LEG_ALERT_AFTER_SWEEPS consecutive bad ticks and returned `null` (HOLD)
// forever. The caller reports nothing for a HOLD, so `cron_legs` stayed silent
// on a leg failing half the time, indefinitely.
//
// The hysteresis this function exists for is UNCHANGED and is asserted below: a
// recovery still needs LEG_RECOVER_AFTER_SWEEPS consecutive clean ticks, which
// is what stops an alternating alert/recover email pair.

/** Drive a whole observation sequence, returning every grade in order. */
function run(observations: readonly boolean[], from: StreakState = EMPTY_STREAK) {
  let state = from;
  const grades: (boolean | null)[] = [];
  for (const observedUnhealthy of observations) {
    const { next, grade } = gradeStreak(state, observedUnhealthy);
    state = next;
    grades.push(grade);
  }
  return { state, grades };
}

const BAD = true;
const GOOD = false;

describe("gradeStreak — intermittent faults must not be silent (IN-8)", () => {
  it("alerts on a 50% duty cycle (the sweep's [bad,good,bad,good,...] sequence)", () => {
    const { grades } = run([BAD, GOOD, BAD, GOOD, BAD, GOOD, BAD, GOOD]);
    expect(grades).toContain(false);
  });

  it("alerts on a 67% duty cycle (the executed SPOT-1 result)", () => {
    const { grades } = run([BAD, BAD, GOOD, BAD, BAD, GOOD]);
    expect(grades).toContain(false);
  });

  it("still alerts on a continuously failing leg at exactly LEG_ALERT_AFTER_SWEEPS", () => {
    const { grades } = run(Array.from({ length: LEG_ALERT_AFTER_SWEEPS }, () => BAD));
    expect(grades.slice(0, -1).every((g) => g === null)).toBe(true);
    expect(grades.at(-1)).toBe(false);
  });

  // The hysteresis the function exists for — unchanged.
  it("recovers ONLY after LEG_RECOVER_AFTER_SWEEPS consecutive clean ticks", () => {
    const { state } = run(Array.from({ length: LEG_ALERT_AFTER_SWEEPS }, () => BAD));
    const { grades } = run(Array.from({ length: LEG_RECOVER_AFTER_SWEEPS }, () => GOOD), state);
    expect(grades.slice(0, -1).every((g) => g === null)).toBe(true);
    expect(grades.at(-1)).toBe(true);
  });

  // The anti-storm property, at THIS layer. A repeated `false` is not a repeated
  // email: this function's contract is that every tick past the threshold
  // re-returns the same grade, and the alert machine suppresses it as "no state
  // change" (see the docstring). What produces the cry-wolf email PAIR is an
  // ALTERNATION — a `true` following a `false` — and an intermittent leg must
  // never produce one, because it never assembles a full clean recovery run.
  it("never alternates back to healthy on an intermittent leg (no cry-wolf pair)", () => {
    const { grades } = run([BAD, GOOD, BAD, GOOD, BAD, GOOD, BAD, GOOD, BAD, GOOD]);
    expect(grades).toContain(false);
    expect(grades).not.toContain(true);
  });

  it("a clean leg is never graded unhealthy and recovers normally", () => {
    const { grades } = run(Array.from({ length: 10 }, () => GOOD));
    expect(grades).not.toContain(false);
    expect(grades).toContain(true);
  });

  // A single isolated blip inside an otherwise clean run must still clear — the
  // fix must not make one bad tick permanent.
  it("clears a single isolated blip once a full recovery run lands", () => {
    const { state, grades } = run([BAD, GOOD, GOOD, GOOD]);
    expect(grades).not.toContain(false);
    expect(state.unhealthy).toBe(0);
  });
});
