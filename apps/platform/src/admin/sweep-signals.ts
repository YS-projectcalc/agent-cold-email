// Routes the ops sweep's OWN return values into the founder-alert channel
// (audit 2026-08-06, NB-2 + NB-3 + table row 4).
//
// Every cron leg already counts what went wrong — `errors` on six sweeps,
// `budgetExpiries` and `skippedForLegDeadline` on the send pipeline, and the
// digest's threshold-crossing `watchdogAlerts` — and `runLeg` already catches a
// leg-level throw. All of it then went into ONE `console.log`/`console.error`
// line with no reader: a tenant failing every cycle, a wedged engine abandoning
// every tenant at its budget, or a warmup subscription that may still be
// billing incremented a number forever and paged nobody.
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

import type { Env } from "../env.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import type { OpsDigest } from "./ops-sweep.js";
import { reconcileAlerts } from "./watchtower.js";
import { CRON_LEGS_CHECK, type AlertOutcome, type CheckResult } from "./watchtower-alerts.js";
import { watchtowerStub } from "./watchtower-infra.js";

/** The three counters every leg summary may carry (absent = the leg has none). */
const LEG_COUNTERS = ["errors", "budgetExpiries", "skippedForLegDeadline"] as const;

export interface LegSignals {
  /** Legs that returned their runLeg fallback — i.e. threw outright. */
  legsThrew: string[];
  /** Sum of every counter above, across the legs that did return a summary. */
  counted: number;
  detail: string;
}

function counterOf(leg: unknown, field: string): number {
  if (!leg || typeof leg !== "object") return 0;
  const value = (leg as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reduce one tick's leg results to a single observation. Takes the same
 * `Record<string, unknown>` bag scheduled.ts logs, so a NEW leg is covered the
 * moment it is added to that object — there is no per-leg list to keep in sync.
 */
export function collectLegSignals(legs: Record<string, unknown>): LegSignals {
  const legsThrew: string[] = [];
  const parts: string[] = [];
  let counted = 0;
  for (const [name, leg] of Object.entries(legs)) {
    if (leg === null) {
      legsThrew.push(name);
      continue;
    }
    for (const field of LEG_COUNTERS) {
      const n = counterOf(leg, field);
      if (n > 0) {
        counted += n;
        parts.push(`${name}.${field}=${n}`);
      }
    }
  }
  const detail = [
    legsThrew.length > 0 ? `leg(s) that threw outright: ${legsThrew.join(", ")}` : "",
    parts.length > 0 ? `non-zero counters: ${parts.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return { legsThrew, counted, detail };
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
  input: { legs: Record<string, unknown>; digest: OpsDigest | null },
  nowMs: number,
): Promise<AlertOutcome[]> {
  const results: CheckResult[] = [];

  // NB-2 + row 4 — the legs' own error accounting, damped over consecutive ticks.
  const signals = collectLegSignals(input.legs);
  const observedUnhealthy = signals.legsThrew.length > 0 || signals.counted > 0;
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
      detail: "Every ops-sweep leg completed with zero errors on consecutive ticks.",
    });
  }

  // NB-3 — the one digest watchdog with no other alert path and a money cost.
  if (input.digest) {
    const gaveUp = input.digest.gaveUpWarmupCancels;
    results.push({
      name: "warmup_cancel_gave_up",
      healthy: gaveUp === 0,
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

  return results.length > 0 ? reconcileAlerts(env, mailer, results, nowMs) : [];
}
