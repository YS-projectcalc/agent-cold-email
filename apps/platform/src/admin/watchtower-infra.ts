// The watchtower's D1-INDEPENDENT leg + its liveness signal (audit 2026-08-06,
// BLOCKING-1 and BLOCKING-2).
//
// Everything here exists because of one root defect: the watchtower could not
// report a failure of anything it stands on. It stands on two things — D1 being
// readable and the 5-minute cron firing — so this module routes the `d1` check
// through a store that is not D1 (the WatchtowerDO), and publishes "a sweep
// completed" as a fact something OUTSIDE the sweep can check.
//
// TWO heartbeats on purpose, and they do NOT mean the same thing:
//  - `watchtower_cursor.last_sweep_ts` (D1) says "the watchtower leg completed"
//    — it is written only after the probes and the state machine both ran. GET
//    /status serves its age, so the founder's external prober sees a degraded
//    platform over plain HTTP, with no admin token and no DO call on a public
//    endpoint.
//  - the WatchtowerDO's heartbeat says "a cron tick ran to completion", written
//    unconditionally at the end of the sweep. Its reader is the dead-man ALARM,
//    which must keep working when D1 is the thing that is broken — and it must
//    stay QUIET during a D1 outage, because the cron is firing perfectly well
//    in that case and BLOCKING-1's alert is the one that describes it.
// Neither can replace the other: each is unreadable in exactly the case the
// other exists to cover.

import type { Env } from "../env.js";
import type { OpsMailer } from "../ops-mail/ops-mailer.js";
import { alertEmailFor, reasonForNoEmail, trySend, type AlertOutcome, type CheckResult } from "./watchtower-alerts.js";
import { SWEEP_STALE_MS } from "./watchtower-grading.js";

/** One instance, platform-wide — this is control state, not per-tenant state. */
const WATCHTOWER_DO_NAME = "singleton";

export function watchtowerStub(env: Env) {
  return env.WATCHTOWER.get(env.WATCHTOWER.idFromName(WATCHTOWER_DO_NAME));
}

/**
 * BLOCKING-1 — reconcile the `d1` check WITHOUT reading D1, and send.
 *
 * The send path itself never needed D1 (`RealOpsMailer` uses only the
 * `send_email` binding); what made a sustained D1 outage a total alerting
 * blackout was that the throttle state lived in the table that was down. The
 * decision now comes from DO storage, so a D1 outage produces exactly one
 * email, a 6h re-alert while it persists, and one recovery email — never the
 * 288-a-day storm that alerting unthrottled would have produced.
 *
 * NEVER THROWS: if the WatchtowerDO is unreachable too, we genuinely cannot
 * report, and saying so in the sweep log is the honest outcome. It must not
 * take down the rest of the sweep, which is still able to run whenever it was
 * the DO (not D1) that failed.
 *
 * DECIDE -> SEND -> COMMIT (cached-terminal member 5). This check straddles the
 * boundary — the DO owns the state, the Worker owns the mailer — so the state
 * write is a SECOND RPC that happens only once the send outcome is known. The
 * DO used to persist the transition at decision time, which meant an alert that
 * never left the building still stamped `last_alert_ts` and `alert_count`: the
 * next sweep read an announced episode and suppressed for 6h, and a recovery
 * emailed the founder that an incident they were never told about was over.
 * That is the same defect `withheldAlertState` closed in the D1-backed store,
 * and this is the parity the file previously only claimed.
 */
export async function reconcileD1Alert(env: Env, mailer: OpsMailer, result: CheckResult, nowMs: number): Promise<AlertOutcome> {
  try {
    const stub = watchtowerStub(env);
    const decision = await stub.decideD1Alert(result.healthy, nowMs);
    const email = alertEmailFor(env, result, decision.transition, decision.prevSinceTs, nowMs);
    const notified = email ? await trySend(mailer, email) : null;
    try {
      await stub.commitD1Alert(result.healthy, nowMs, notified);
    } catch (err) {
      // The decision was made and (maybe) delivered; only the bookkeeping
      // failed. Reported honestly below rather than as `unreportable`, because
      // a delivered email IS a delivered email. Un-banked state re-decides on
      // the next sweep, so the cost is at worst a duplicate alert — the
      // opposite of the silence this check exists to prevent.
      console.error("watchtower: the D1 alert was decided and sent, but its state could not be banked — the next sweep re-attempts it", err);
    }
    return {
      name: result.name,
      action: decision.transition.action,
      emailSent: notified?.delivered ?? false,
      // Same translation the D1-backed store uses (watchtower.ts's
      // reconcileAlerts), not a second one: this file exists because the `d1`
      // check needs a different STORE, and a check reported through two stores
      // that describe the same non-delivery differently is the reporting
      // divergence this wave is about.
      why: notified?.why ?? reasonForNoEmail(decision.transition.action),
    };
  } catch (err) {
    console.error("watchtower: could not reconcile the D1 check — the WatchtowerDO is unreachable, so this outage is UNREPORTED", err);
    return { name: result.name, action: "unreportable", emailSent: false, why: "send_failed" };
  }
}

/**
 * BLOCKING-2 — "a cron tick ran to completion", for the dead-man alarm. Called
 * at the end of every tick regardless of what the tick found: this is a claim
 * about the SCHEDULER, not about platform health, and conflating the two would
 * make a D1 outage fire the dead-man for an incident BLOCKING-1 already covers.
 */
export async function recordSweepHeartbeat(env: Env, nowMs: number): Promise<void> {
  await watchtowerStub(env).recordSweepHeartbeat(nowMs);
}

/** "The watchtower leg completed" — the freshness signal GET /status serves. */
export async function recordWatchtowerCompleted(env: Env, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchtower_cursor (id, last_sweep_ts) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_sweep_ts = excluded.last_sweep_ts`,
  )
    .bind(nowMs)
    .run();
}

export interface SweepFreshness {
  lastSweepTs: number | null;
  ageSeconds: number | null;
  stale: boolean;
}

/**
 * How long since a sweep last completed — the dead-man leg GET /status serves.
 *
 * A missing cursor row reads as STALE, not as unknown-and-therefore-fine: the
 * row survives deploys, so its absence means no sweep has EVER completed
 * against this database, which is precisely the "cron was never firing" case a
 * status probe exists to catch. The cost is that a brand-new database reports
 * degraded until its first tick (at most one cron period).
 */
export async function readSweepFreshness(env: Env, nowMs: number): Promise<SweepFreshness> {
  const row = await env.DB.prepare(`SELECT last_sweep_ts FROM watchtower_cursor WHERE id = 1`).first<{ last_sweep_ts: number }>();
  const lastSweepTs = row?.last_sweep_ts ?? null;
  if (lastSweepTs === null) return { lastSweepTs: null, ageSeconds: null, stale: true };
  const ageMs = Math.max(0, nowMs - lastSweepTs);
  return { lastSweepTs, ageSeconds: Math.round(ageMs / 1000), stale: ageMs >= SWEEP_STALE_MS };
}
