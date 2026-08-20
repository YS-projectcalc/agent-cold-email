// Routes the ops sweep's OWN return values into the founder-alert channel
// (audit 2026-08-06, NB-2 + NB-3 + table row 4).
//
// Every cron leg already counts what went wrong — and `runLeg` already catches a
// leg-level throw. All of it then went into ONE `console.log`/`console.error`
// line with no reader: a tenant failing every cycle, a wedged engine abandoning
// tenants at their budget, or a warmup subscription that may still be billing
// incremented a number forever and paged nobody.
//
// WHAT THE COVERAGE CHECK DOES AND DOES NOT CATCH (NEW-4, round 2 of
// docs/adversarial/wave-b1-scale-monitoring-gate-2026-08-20.md). ONE
// persistently wedged tenant reaches no check at all: `send_starved:` requires
// zero eligible mailboxes (a slow engine's mailboxes are healthy),
// `tenant_do_wedged:` requires `opsSummary` to throw, and `customer_progress_*`
// is about owed setup steps. Materially softened by what a budget expiry
// actually is — `withItemBudget` abandons the WAIT, not the work; the RPC keeps
// running and its effects are idempotent — so it is a latency and
// observability event rather than a stuck tenant. Named here rather than
// papered over, and carried on the ROADMAP as owed; a per-tenant staleness
// signal is the alert-state increment's shape, not a threshold tweak.
//
// THE 2026-08-20 CALIBRATION WIDENED THAT GAP, DELIBERATELY, AND IT IS OWED.
// NEW-4 used to be able to say that "a wedged engine abandoning EVERY tenant at
// its budget" was at least visible, because `budgetExpiries` was summed into
// `signals.deferred` and a full slice's worth of them tripped the old threshold.
// That arm is gone: it compared a CROSS-LEG SUM to a single slice, which is how
// one shared fan-out deadline read as 109-against-37 and pinned the check.
//
// It could not be kept, only replaced. The slice is now 3, so the old
// `deferred >= SWEEP_TENANT_SLICE` rule would fire on three deferred leg-visits
// — hair-trigger, permanently pinned, reproducing the exact defect one size
// smaller. And the rotation measure that replaced it cannot see this case by
// construction: the send pipeline runs OUTSIDE the shared fan-out (its own
// deadline, its own rotation offset) and so contributes nothing to
// `leastVisited`.
//
// So: a wedged engine expiring every tenant's budget is now graded by NOTHING.
// `budgetExpiries` is still reported in this check's detail and still logged per
// tenant, but no threshold reads it. That is a REGRESSION of this module taken
// knowingly rather than a gap discovered — the alternative was a second arm in
// its own units, which is what N6 was. It belongs to the per-tenant staleness
// signal in the alert-state increment, where the frozen design already put it.
//
// Everything here goes through the SAME throttled state machine as every other
// check (watchtower_state + reconcileAlerts), never a per-tick send, and every
// per-tick observation is damped first (watchtower-grading.ts) so a leg that
// errors intermittently cannot produce an alternating UNHEALTHY/RECOVERED pair.
//
// UNKNOWN IS NOT HEALTHY: a leg that threw returned its `null` fallback, so its
// counters are unknown, not zero. Reporting the check healthy on that basis
// would send a false RECOVERED and re-arm the alert for a condition nobody
// fixed — so a leg's throw counts as UNHEALTHY, and an absent digest reports
// nothing at all.
//
// FOUR SEPARATE THINGS, FOUR SEPARATE CHECKS (scale audit S4/S11 +
// sweep-completeness W-M1/W-M2/W-M3/W-M4). They used to be one:
//   `cron_legs`       — a leg FAILED. Errors and throws only.
//   `sweep_coverage`  — work the tick deliberately did not do. `skippedForLegDeadline`
//                       lived in the failure signal, and it is non-zero on EVERY
//                       tick at scale by design, so the leg check pinned
//                       permanently unhealthy and a genuinely dying leg then
//                       produced no NEW alert at all — only an edited `detail`
//                       string on an already-suppressed row.
//   `alert_delivery`  — an alert was owed and did not reach the founder.
//   `sweep_signals`   — this module itself threw (reported by scheduled.ts,
//                       from outside, because a bag built above the reporter
//                       cannot contain the reporter).

import type { Env } from "../env.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import type { OpsDigest } from "./ops-sweep.js";
import { reconcileAlerts, reportCheck } from "./watchtower.js";
import {
  ALERT_DELIVERY_CHECK,
  CRON_LEGS_CHECK,
  SWEEP_COVERAGE_CHECK,
  SWEEP_SIGNALS_CHECK,
  type AlertOutcome,
  type CheckResult,
} from "./watchtower-alerts.js";
import { watchtowerStub } from "./watchtower-infra.js";
import { coverageTicks, SWEEP_TENANT_SLICE } from "./sweep-budget.js";

/**
 * HOW EACH LEG REPORTS — the table that makes this module's coverage claim
 * checkable instead of merely stated.
 *
 * W-M3 (docs/adversarial/sweep-completeness-pass-2026-08-17.md): the old
 * docblock promised *"a NEW leg is covered the moment it is added to that
 * object — there is no per-leg list to keep in sync."* That was FALSE. Coverage
 * required the leg to name its counter exactly `errors` | `budgetExpiries` |
 * `skippedForLegDeadline` AND to return `null` on throw. A new leg reporting
 * seven failures under any other plausible field name read perfectly clean, and
 * two legs already did exactly that: `watchtower` returns an OUTCOME ARRAY and
 * `sdnRefresh` reports failure as `{reason: "failed", error: <string>}` — a
 * string is not a counter, so the OFAC list could fail to refresh forever with
 * `cron_legs` green (W-M1, W-M2).
 *
 * There IS a per-leg list. It is here, it is explicit, and
 * `sweep-signal-coverage.test.ts` reds when `scheduled.ts`'s leg bag and this
 * table disagree — so the promise is now kept by a guard rather than by a
 * comment.
 */
export const LEG_SHAPES = {
  /** No failure signal of its own; a throw (the `null` fallback) is the only tell. */
  tenantSlice: "no-signal",
  deliverability: "counters",
  dunning: "counters",
  digest: "counters",
  /** `AlertOutcome[]` — W-M1. */
  watchtower: "alert-outcomes",
  warmupCancel: "counters",
  webhooks: "counters",
  spendReservations: "counters",
  /** `{reason: "fresh" | "refreshed" | "failed"}` — W-M2. */
  sdnRefresh: "outcome-reason",
  sdnRecovery: "counters",
  provisioningReconcile: "counters",
  sweepCursor: "no-signal",
  retireChecks: "no-signal",
  sendPipeline: "counters",
} as const satisfies Record<string, LegShape>;

export type LegShape = "counters" | "alert-outcomes" | "outcome-reason" | "no-signal";

/** Counters that mean SOMETHING FAILED. */
const FAILURE_COUNTERS = ["errors"] as const;

/**
 * Counters that mean WORK WAS DEFERRED — capacity, not failure (scale audit S4).
 * `skippedForLegDeadline` is set every cycle the rotation cannot reach every
 * tenant and `deferred` every time the shared fan-out deadline lands; both are
 * the bounded sweep working as designed. `budgetExpiries` sits here too: a
 * tenant abandoned at its per-tenant budget was not reached, and the engine
 * being slow is a capacity fact about that tenant, not a leg fault.
 */
const DEFERRAL_COUNTERS = ["budgetExpiries", "skippedForLegDeadline", "deferred"] as const;

export interface LegSignals {
  /** Legs that returned their runLeg fallback — i.e. threw outright. */
  legsThrew: string[];
  /** Sum of every FAILURE counter across the legs that did return a summary. */
  counted: number;
  /** Sum of every DEFERRAL counter — reported, never graded as a failure. */
  deferred: number;
  /** Legs present in the bag with no entry in `LEG_SHAPES`. Reported as a
   * failure: a leg this module cannot read is a leg it cannot clear either, and
   * silence about it is the exact defect W-M3 names. */
  unknownLegs: string[];
  /** Alerts owed this tick that did not reach the founder (W-M1). */
  undeliveredAlerts: { count: number; reasons: string[] };
  detail: string;
  deferralDetail: string;
}

function counterOf(leg: unknown, field: string): number {
  if (!leg || typeof leg !== "object") return 0;
  const value = (leg as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** An `AlertOutcome[]` leg result, or null when the value is not one. */
function asAlertOutcomes(leg: unknown): AlertOutcome[] | null {
  if (!Array.isArray(leg)) return null;
  return leg.every((o) => o && typeof o === "object" && typeof (o as AlertOutcome).name === "string")
    ? (leg as AlertOutcome[])
    : null;
}

/**
 * Reduce one tick's leg results to one failure observation, one capacity
 * observation, and one alert-delivery observation.
 */
export function collectLegSignals(legs: Record<string, unknown>): LegSignals {
  const legsThrew: string[] = [];
  const unknownLegs: string[] = [];
  const failureParts: string[] = [];
  const deferralParts: string[] = [];
  const undeliveredReasons: string[] = [];
  let counted = 0;
  let deferred = 0;
  let undelivered = 0;

  for (const [name, leg] of Object.entries(legs)) {
    if (leg === null) {
      legsThrew.push(name);
      continue;
    }
    const shape = (LEG_SHAPES as Record<string, LegShape>)[name];
    if (shape === undefined) {
      unknownLegs.push(name);
      continue;
    }
    if (shape === "no-signal") continue;

    if (shape === "counters") {
      for (const field of FAILURE_COUNTERS) {
        const n = counterOf(leg, field);
        if (n > 0) {
          counted += n;
          failureParts.push(`${name}.${field}=${n}`);
        }
      }
      for (const field of DEFERRAL_COUNTERS) {
        const n = counterOf(leg, field);
        if (n > 0) {
          deferred += n;
          deferralParts.push(`${name}.${field}=${n}`);
        }
      }
      continue;
    }

    if (shape === "alert-outcomes") {
      const outcomes = asAlertOutcomes(leg);
      if (outcomes === null) {
        // The leg is DECLARED as outcomes and did not return them. That is a
        // contract break, and reading it as zero is how W-M1 happened.
        unknownLegs.push(name);
        continue;
      }
      const unreportable = outcomes.filter((o) => o.action === "unreportable").length;
      if (unreportable > 0) {
        counted += unreportable;
        failureParts.push(`${name}.unreportableChecks=${unreportable}`);
      }
      // OWED AND NOT DELIVERED. `why` is what separates "we chose not to tell
      // you" (suppressed_cooldown / pending_debounce / nothing_owed /
      // digest_only / reclassified) from "we could not".
      for (const outcome of outcomes) {
        if (outcome.emailSent) continue;
        if (outcome.why !== "send_failed" && outcome.why !== "dark_channel") continue;
        undelivered++;
        undeliveredReasons.push(`${outcome.name} (${outcome.why})`);
      }
      continue;
    }

    // "outcome-reason" — W-M2. `maybeRefreshSdnList` deliberately never throws;
    // its failure is a string field, so it contributed 0 to every counter and
    // `legsThrew` stayed empty.
    const reason = (leg as { reason?: unknown }).reason;
    if (reason === "failed") {
      counted += 1;
      const err = (leg as { error?: unknown }).error;
      failureParts.push(`${name}.reason=failed${typeof err === "string" ? ` (${err})` : ""}`);
    }
  }

  const detail = [
    legsThrew.length > 0 ? `leg(s) that threw outright: ${legsThrew.join(", ")}` : "",
    unknownLegs.length > 0 ? `leg(s) this reducer cannot read (add them to LEG_SHAPES): ${unknownLegs.join(", ")}` : "",
    failureParts.length > 0 ? `non-zero counters: ${failureParts.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  return {
    legsThrew,
    counted,
    deferred,
    unknownLegs,
    undeliveredAlerts: { count: undelivered, reasons: undeliveredReasons },
    detail,
    deferralDetail: deferralParts.join(", "),
  };
}

/**
 * How many ticks a full rotation may take before the coverage cost of the
 * bounded sweep is worth telling the founder about.
 *
 * 12 ticks is one hour at the live 5-minute cadence — the point at which "a
 * stuck tenant is noticed within a cron period" has stopped being true by an
 * order of magnitude. Past it, the audit's answer is to replace the per-tenant
 * RPC fan-out with the D1/Analytics read-model (admin/README.md,
 * ARCHITECTURE.md #3) rather than tune it. This check is what makes that arrive
 * as a message instead of as a customer complaint.
 *
 * THE TENANT COUNT THIS CORRESPONDS TO WAS RESTATED on 2026-08-20 and it moved
 * a long way. The docstring used to read "~590 tenants" — computed through
 * `ASSUMED_DO_RPC_MS = 25`, which production measurement then put at ~450.
 * One hour is `12 x SWEEP_TENANT_SLICE` tenants, which at the calibrated slice
 * is 36. The threshold is deliberately NOT being raised to keep pace: it is a
 * statement about detection latency the founder was given, the latency is real,
 * and re-tuning the threshold to silence it is the exact move that would make
 * this check decorative. What the number now says is that the read-model is due
 * at the CURRENT tenant count.
 */
export const COVERAGE_TICKS_ALERT_AFTER = 12;

/**
 * What one tick knows about its own COVERAGE — the two numbers, and only those
 * two, that the rotation-latency question is asked in.
 *
 * `covered` is `SweepFanout.leastVisited`: how many tenants the LEAST-covered
 * fan-out leg reached, which is by construction exactly how far
 * `commitSweepCursor` advanced the rotation. It is the achieved figure, and it
 * is the only one from which detection latency can be computed.
 *
 * BUNDLED RATHER THAN TWO PARAMETERS, deliberately. The defect being fixed is a
 * caller that had the slice and reported the slice; a shape that accepts a
 * `TenantSlice` would let the next caller do it again, because a `TenantSlice`
 * has a plausible-looking tick count on it. This type does not typecheck
 * against one.
 */
export interface SweepCoverage {
  /** Every tenant in the control-plane index — the denominator. */
  total: number;
  /** Tenants the least-covered fan-out leg actually reached this tick. */
  covered: number;
}

/**
 * Turn one tick's sweep output into founder alerts. Returns the reconciled
 * outcomes so the sweep's log line records what it decided.
 *
 * `digest === null` means the digest leg threw: its counters are unknown, so
 * the warmup check is omitted entirely rather than reported either way.
 */
export async function reportSweepSignals(
  env: Env,
  mailer: OpsMailer,
  input: { legs: Record<string, unknown>; digest: OpsDigest | null; coverage: SweepCoverage | null },
  nowMs: number,
): Promise<AlertOutcome[]> {
  const results: CheckResult[] = [];
  const signals = collectLegSignals(input.legs);

  // NB-2 + row 4 — the legs' own error accounting, damped over consecutive ticks.
  const observedUnhealthy = signals.legsThrew.length > 0 || signals.unknownLegs.length > 0 || signals.counted > 0;
  const grade = await watchtowerStub(env).gradeSweepStreak(CRON_LEGS_CHECK, observedUnhealthy);
  if (grade === false) {
    results.push({
      name: CRON_LEGS_CHECK,
      healthy: false,
      detail:
        `The ops sweep has been reporting failures on consecutive ticks — ${signals.detail}. ` +
        `These are counted per leg and were previously visible only in the Worker log, which pages nobody. ` +
        `A leg that throws every tick, or a tenant abandoned at its budget every cycle, looks exactly like this.`,
    });
  } else if (grade === true) {
    results.push({
      name: CRON_LEGS_CHECK,
      healthy: true,
      // reobserved: the streak grader is fed a freshly collected signal bag
      // every tick, so the healthy claim is a current observation.
      basis: "reobserved",
      detail: "Every ops-sweep leg completed with zero errors on consecutive ticks.",
    });
  }

  // S4 + S11 — CAPACITY, in its own name, and since the 2026-08-20 calibration
  // fix in ONE unit: how many ticks a full rotation ACTUALLY takes.
  //
  // It used to be two arms that could not be compared. The second asked whether
  // the rotation was longer than an hour; the first summed every leg's deferral
  // counters and compared that to a single slice. Those are not the same
  // quantity — `signals.deferred` counts LEG-VISITS across legs, so ONE shared
  // fan-out deadline landing at one tenant is counted once per leg. Live at 63
  // tenants that read `1 + 36 + 36 + 36 = 109` against a threshold of 37 and
  // pinned the check permanently, which (via `decideAlert`'s in-episode
  // suppression) is also what kept the rotation-length arm — the one that means
  // "go build the read-model" — from ever producing its own alert. N6, and the
  // S4 defect reproduced inside the check S4 created.
  //
  // AND THE SUM WAS NOT EVEN COMPLETE, which is the other reason it could not be
  // a threshold: of the six legs that iterate the tenant slice, only four can
  // report a deferral at all. `digest` returns `tenants.scanned`/`complete`
  // rather than a `deferred` counter, and `watchtower` returns an `AlertOutcome[]`
  // with no counters anywhere in it (W-M1's shape). Both deferred 36 tenants on
  // the live tick and contributed 0. A grade built on that sum is reading four
  // sixths of the evidence.
  //
  // `leastVisited` has neither problem: `sweepTenants` folds EVERY slice leg's
  // visit count into it by construction, including the two that cannot describe
  // themselves. The deferral counters remain the operator-facing detail, where
  // an under-count costs nothing but a less specific diagnosis.
  //
  // ONE ARM NOW: `ceil(total / covered)`. It subsumes the old rotation arm
  // exactly (when nothing is deferred, `covered` IS the slice) and it answers
  // the question the check's own prose asks — how late is a stuck tenant
  // noticed — rather than how much work the tick chose not to do. Deferral
  // counters stay in the DETAIL, where an operator needs them to see WHICH leg
  // is losing work; they no longer decide the grade.
  const coverage = input.coverage;
  // UNKNOWN IS NOT HEALTHY, and it is not unhealthy either. A tick that could
  // not read its own slice (the `tenantSlice` leg threw) has no coverage
  // observation to make. The old code still graded the arm in that state and
  // could emit a RECOVERED whose detail read "the tenant slice could not be
  // read this tick" — a healthy claim built on absent data. Skipping the
  // observation holds the streak instead: the leg's throw is already reported
  // by `cron_legs`, which is the check that owns it.
  if (coverage !== null) {
    const rotationTicks = coverageTicks(coverage.total, coverage.covered);
    const coverageGrade = await watchtowerStub(env).gradeSweepStreak(SWEEP_COVERAGE_CHECK, rotationTicks > COVERAGE_TICKS_ALERT_AFTER);
    if (coverageGrade !== null) {
      // The ACHIEVED figure, always — and the planned slice beside it whenever
      // the two disagree, because that gap is the whole diagnosis: it says the
      // deadline is binding mid-slice rather than the tenant count having grown.
      const rotation =
        `${coverage.total} tenant(s), and this tick's least-covered leg reached ${coverage.covered} of them ` +
        `= a full pass every ${rotationTicks} tick(s) (~${rotationTicks * 5} min)` +
        (coverage.covered < SWEEP_TENANT_SLICE
          ? `. The slice is sized at ${SWEEP_TENANT_SLICE} tenant(s) per tick, so the shared fan-out deadline is ` +
            `stopping the trailing legs partway through it — the rotation advances by the LEAST-covered leg`
          : "");
      results.push(
        coverageGrade
          ? {
              name: SWEEP_COVERAGE_CHECK,
              healthy: true,
              basis: "reobserved",
              detail: `The ops sweep is reaching every tenant on schedule — ${rotation}.`,
            }
          : {
              name: SWEEP_COVERAGE_CHECK,
              healthy: false,
              detail:
                `The ops sweep is not keeping up with the tenant count. ${rotation}. ` +
                (signals.deferred > 0 ? `Work deferred inside this tick's own slice: ${signals.deferralDetail}. ` : "") +
                `NOTHING IS FAILING — every tenant is still reached, just later. What degrades is DETECTION LATENCY: a stuck ` +
                `tenant, a dead domain or a starved send queue is now noticed a rotation late rather than within a cron period. ` +
                `The fix is the D1/Analytics read-model (admin/README.md), not a bigger slice. The slice is bounded by the ` +
                `WALL CLOCK the cron period has left after the send pipeline's own bounds, at a DO RPC round trip measured ` +
                `against production — so widening it does not buy coverage, it just moves the deadline's cut further up the ` +
                `leg order (admin/sweep-budget.ts).`,
            },
      );
    }
  }

  // W-M1 — alerts that were OWED and did not arrive.
  const deliveryGrade = await watchtowerStub(env).gradeSweepStreak(ALERT_DELIVERY_CHECK, signals.undeliveredAlerts.count > 0);
  if (deliveryGrade !== null) {
    results.push(
      deliveryGrade
        ? {
            name: ALERT_DELIVERY_CHECK,
            healthy: true,
            basis: "reobserved",
            detail: "Every watchtower alert owed on recent ticks was delivered.",
          }
        : {
            name: ALERT_DELIVERY_CHECK,
            healthy: false,
            detail:
              `${signals.undeliveredAlerts.count} watchtower alert(s) were OWED and did not reach the ops address on consecutive ticks: ` +
              `${signals.undeliveredAlerts.reasons.join(", ")}. ` +
              `'dark_channel' means the ops mail channel is not configured (OPS_ALERT_EMAIL / the sending domain); ` +
              `'send_failed' means it is configured and the send threw. Either way the platform's health reporting is one-way ` +
              `right now: poll GET /admin/ops/checks rather than trusting an empty inbox.`,
          },
    );
  }

  // NB-3 — the one digest watchdog with no other alert path and a money cost.
  if (input.digest) {
    const gaveUp = input.digest.gaveUpWarmupCancels;
    // NO_LONGER_APPLICABLE on the clear, deliberately (signal-inversion arm B).
    // `gaveUp` is a count over the DIGEST WINDOW, and nothing anywhere re-checks
    // whether the abandoned subscriptions were ever cancelled —
    // warmup-cancel.ts guarantees the platform will never retry them. So 24h
    // after the last give-up the count reaches zero on a timer and the old code
    // told the founder the condition had cleared, a day after telling them
    // those subscriptions "may STILL BE BILLING". Real recurring vendor charges,
    // self-cleared by the passage of time.
    //
    // This closes the false CLEAR only. The separate defect at this site — a
    // rising give-up count (1 -> 12) suppressed inside the alert cooldown — is
    // a different mechanism and is NOT fixed here.
    //
    // A PARTIAL DIGEST MAY NOT CLEAR IT EITHER (scale audit S1). The cron now
    // builds this digest over a bounded tenant slice, so `gaveUp === 0` means
    // "none among the tenants this tick reached" — the same "unknown is not
    // healthy" rule this file already applies to a digest leg that threw. A
    // NON-ZERO count from a partial pass is still a real observation and still
    // alerts.
    if (gaveUp > 0 || input.digest.complete) {
      results.push({
        ...(gaveUp === 0
          ? { healthy: true as const, basis: "no_longer_applicable" as const }
          : { healthy: false as const }),
        name: "warmup_cancel_gave_up",
        // The vendor is deliberately NOT named here (test/vendor-identity-leak.ts's
        // source tripwire): the digest already names it on the operator-only
        // surface that is allowlisted for exactly that, and this line is
        // actionable without it.
        detail:
          gaveUp === 0
            ? "No warmup-pool cancellation has been abandoned in the digest window."
            : `${gaveUp} warmup-pool cancellation(s) GAVE UP after retries in the last ${input.digest.windowHours}h — those subscriptions ` +
              `may STILL BE BILLING. The platform will not retry them again; cancel them in the mailbox vendor's console ` +
              `(GET /admin/ops/digest names it).`,
      });
    }
  }

  return results.length > 0 ? reconcileAlerts(env, mailer, results, nowMs) : [];
}

/**
 * W-M4 — report whether `reportSweepSignals` itself ran.
 *
 * Called by `scheduled.ts` AFTER the leg, because the thing being reported on
 * is the reporter: the `legs` bag is constructed above `reportSweepSignals`, so
 * its own throw (its first act is a cross-DO `gradeSweepStreak` RPC) was logged,
 * swallowed, and observed by nothing — while the heartbeat written below it kept
 * the dead-man reading healthy. Total, permanent, silent loss of every leg
 * signal with every monitor green.
 *
 * Goes through `reportCheck`, which never throws: a failure to report this must
 * not be the thing that takes the sweep down. Its policy is the DEBOUNCED
 * default, so one flaky tick costs nothing and a genuine outage pages within
 * two cron periods.
 */
export async function reportSweepSignalsHealth(env: Env, mailer: OpsMailer, reported: boolean, nowMs: number): Promise<void> {
  await reportCheck(
    env,
    mailer,
    reported
      ? {
          name: SWEEP_SIGNALS_CHECK,
          healthy: true,
          basis: "reobserved",
          detail: "The ops sweep's signal-reporting leg ran and reconciled this tick.",
        }
      : {
          name: SWEEP_SIGNALS_CHECK,
          healthy: false,
          detail:
            `The ops sweep's signal-reporting leg THREW — so no cron_legs, sweep_coverage, alert_delivery or ` +
            `warmup_cancel_gave_up observation was made this tick. Those checks are not healthy, they are UNREPORTED, ` +
            `and the cron heartbeat is still being written, so the dead-man will stay quiet. Check the WatchtowerDO ` +
            `(gradeSweepStreak) and D1.`,
        },
    nowMs,
  );
}
