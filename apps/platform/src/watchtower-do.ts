import { DurableObject } from "cloudflare:workers";
import {
  alertEmailFor,
  policyFor,
  trySend,
  CRON_SWEEP_CHECK,
  D1_CHECK,
  type CheckResult,
} from "./admin/watchtower-alerts.js";
import { decideAlert, type AlertTransition, type PersistedAlertState } from "./admin/watchtower-policy.js";
import { DEAD_MAN_INTERVAL_MS, EMPTY_STREAK, gradeStreak, SWEEP_STALE_MS, type Grade, type StreakState } from "./admin/watchtower-grading.js";
import type { Env } from "./env.js";
import { createOpsMailer, type OpsMailer } from "./ops-mail/ops-mailer.js";

/**
 * WatchtowerDO — the watchtower's own durable control state, on a substrate
 * that is NOT D1 and a schedule that is NOT the cron trigger.
 *
 * WHY IT EXISTS (audit 2026-08-06, BLOCKING-1 + BLOCKING-2): every alert the
 * platform could send required D1 to be readable AND the 5-minute cron to be
 * firing, and neither fact was itself alarmed. The send path needs only the
 * `send_email` binding (ops-mail/real-ops-mailer.ts), so an alert IS deliverable
 * during a full D1 outage — the old code simply ordered D1 reads ahead of it,
 * and had no throttle state anywhere else to send safely without them. Without
 * SOME cross-invocation store, "alert anyway" means 288 emails a day.
 *
 * REJECTED ALTERNATIVES. In-memory state is isolate-scoped and resets under the
 * exact conditions we are alarming on. A KV namespace is eventually consistent
 * (a read-modify-write on a throttle counter can lose the write that suppresses
 * the storm) and needs an out-of-band namespace to exist before deploy. A second
 * D1 database shares the failure domain we are trying to escape. DO storage is
 * strongly consistent, serialized by the input gate, created by the deploy
 * itself, and independent of D1 — and it is also the only substrate here that
 * can SCHEDULE (alarms), which is what the cron dead-man needs.
 *
 * ONE responsibility: hold the watchtower's control state and wake itself up.
 * It decides; the Worker (or, for the alarm, this DO) sends. No probe, no
 * business logic, no tenant data ever lands here.
 */

const HEARTBEAT_KEY = "sweep_heartbeat_ts";
const D1_ALERT_KEY = "d1_alert_state";
const DEAD_MAN_ALERT_KEY = "dead_man_alert_state";
const STREAK_KEY_PREFIX = "streak:";

/** What the Worker needs to render the email for a decision made in here. */
export interface RemoteAlertDecision {
  transition: AlertTransition;
  /** `since_ts` of the state being LEFT — a recovery email reports it. */
  prevSinceTs: number | null;
}

export class WatchtowerDO extends DurableObject<Env> {
  /**
   * The ops channel the DEAD-MAN ALARM sends through. Every Worker-side alert
   * producer is HANDED its OpsMailer (`runWatchtower(env, mailer, now)`,
   * `runDunningSweep(...)`) precisely so a test can pass a SandboxOpsMailer and
   * assert what was actually sent; an alarm has no caller to hand it one, so
   * this DO resolves its own from the same `createOpsMailer` choke point and
   * exposes it as the equivalent seam.
   */
  mailer: OpsMailer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.mailer = createOpsMailer(env);
  }

  /**
   * BLOCKING-1 — reconcile the `d1` health check against DO storage, so the
   * decision to email that D1 is down never itself reads D1. Returns the
   * decision; the caller sends (it holds the OpsMailer) and must treat a throw
   * from here as "cannot alert", never as "healthy".
   */
  async reconcileD1Alert(healthy: boolean, nowMs: number): Promise<RemoteAlertDecision> {
    return this.applyAlert(D1_ALERT_KEY, D1_CHECK, healthy, nowMs);
  }

  /**
   * BLOCKING-2 — "a sweep completed at `nowMs`". Written on EVERY tick,
   * healthy or not: this records that the CRON FIRED, which is a different
   * claim from "the platform is healthy" (that is what every other check is
   * for). Arms the dead-man alarm the first time; the alarm re-arms itself
   * thereafter, so the chain survives the cron dying.
   */
  async recordSweepHeartbeat(nowMs: number): Promise<void> {
    await this.ctx.storage.put(HEARTBEAT_KEY, nowMs);
    if ((await this.ctx.storage.getAlarm()) === null) {
      // Scheduled off WALL CLOCK, never off the caller's `nowMs`. The heartbeat
      // VALUE is whatever clock the sweep stamped it with; the alarm is a real
      // future wake-up, and deriving it from a stamp that is behind wall clock
      // would schedule an alarm that is already due — a hot loop at exactly the
      // moment the platform is already struggling.
      await this.ctx.storage.setAlarm(Date.now() + DEAD_MAN_INTERVAL_MS);
    }
  }

  /**
   * NB-2/NB-3 — fold one tick's observation into a persisted N-up/M-down streak
   * and return the resulting grade (`null` = hold, report nothing this tick).
   * Lives here rather than in D1 because it is the same "the watchtower's own
   * bookkeeping" concern, and adding a table for two counters is not.
   */
  async gradeSweepStreak(key: string, observedUnhealthy: boolean): Promise<Grade> {
    const prev = (await this.ctx.storage.get<StreakState>(STREAK_KEY_PREFIX + key)) ?? EMPTY_STREAK;
    const { next, grade } = gradeStreak(prev, observedUnhealthy);
    await this.ctx.storage.put(STREAK_KEY_PREFIX + key, next);
    return grade;
  }

  /**
   * The DEAD-MAN (BLOCKING-2). Delivered by the Durable Object alarm
   * scheduler — a different mechanism from the Worker's `[triggers] crons`,
   * so it keeps running when the cron does not (see the README/report for the
   * limits of that independence).
   *
   * Re-arms BEFORE doing anything else: a throw in the body must not be able to
   * break the chain, or the watcher dies exactly when it is needed.
   */
  override async alarm(): Promise<void> {
    const nowMs = Date.now();
    await this.ctx.storage.setAlarm(nowMs + DEAD_MAN_INTERVAL_MS);

    const heartbeat = (await this.ctx.storage.get<number>(HEARTBEAT_KEY)) ?? null;
    if (heartbeat === null) {
      // Only `recordSweepHeartbeat` arms this alarm, so there is no reachable
      // path here — staying quiet is the safe reading (we cannot tell "cron
      // never started" from "storage was just reset" and must not guess).
      console.error("watchtower dead-man: alarm fired with no sweep heartbeat recorded — staying quiet");
      return;
    }

    const ageMs = nowMs - heartbeat;
    const stale = ageMs >= SWEEP_STALE_MS;
    const result: CheckResult = {
      name: CRON_SWEEP_CHECK,
      // reobserved: `stale` is derived from the heartbeat just read out of
      // storage, so the healthy claim is a current measurement.
      ...(stale ? { healthy: false as const } : { healthy: true as const, basis: "reobserved" as const }),
      detail: stale
        ? `No ops sweep has completed for ~${Math.round(ageMs / 60000)} min (last: ${new Date(heartbeat).toISOString()}). ` +
          `The 5-minute Cron Trigger appears to have stopped, so EVERY other watchtower alert is silent too — ` +
          `silence from this platform right now means nothing. Check the Worker's [triggers] cron and its deploy.`
        : `Ops sweep completed ~${Math.round(ageMs / 60000)} min ago (last: ${new Date(heartbeat).toISOString()}).`,
    };

    const decision = await this.applyAlert(DEAD_MAN_ALERT_KEY, result.name, result.healthy, nowMs);
    const email = alertEmailFor(this.env, result, decision.transition, decision.prevSinceTs, nowMs);
    if (email) await trySend(this.mailer, email);
  }

  /**
   * The shared read -> decide -> persist step for both DO-backed checks.
   *
   * Takes the CHECK NAME as well as the storage key so the policy comes from
   * the same `policyFor` table the D1-backed store uses (founder ruling
   * 2026-08-16): this is the call site where the debounced `d1` check and the
   * exempt `cron_sweep` dead-man meet, and hard-coding either rule here is how
   * the two stores would drift apart.
   *
   * `prev` is read as `PersistedAlertState` because a value written by the
   * PREVIOUS deploy has no debounce counters and DO storage has no migration
   * step — `decideAlert` normalizes it.
   */
  private async applyAlert(key: string, checkName: string, healthy: boolean, nowMs: number): Promise<RemoteAlertDecision> {
    const prev = (await this.ctx.storage.get<PersistedAlertState>(key)) ?? null;
    const transition = decideAlert(prev, healthy, nowMs, policyFor(checkName));
    await this.ctx.storage.put(key, transition.next);
    return { transition, prevSinceTs: prev?.sinceTs ?? null };
  }
}
