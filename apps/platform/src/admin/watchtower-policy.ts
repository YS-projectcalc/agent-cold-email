// The watchtower's ALERT POLICY — the pure state transition every alert store
// applies, plus the dials the founder's 2026-08-16 ruling made per-check.
//
// Split out of watchtower-alerts.ts (CLAUDE.md rule b) when the debounce +
// backoff landed: that file is the alert VOCABULARY (what a check result is,
// how its email renders) and this one is the RULE (when an email is owed). One
// direction of dependency only — this module knows nothing about check names,
// labels or email bodies, so it stays testable as a table of pure decisions.
//
// WHY A POLICY OBJECT RATHER THAN CONSTANTS (founder ruling 2026-08-16): the
// same `decideAlert` backs the ordinary 5-minute checks AND the cron dead-man,
// and the dead-man must NOT inherit the debounce (see IMMEDIATE/DEAD_MAN below).
// A shared function with a hard-coded rule cannot express that, and a second
// copy of the rule for the dead-man is exactly the divergence this module was
// extracted to prevent. Making `policy` a REQUIRED argument means a new call
// site has to state which rule it wants instead of silently inheriting one.

/** The per-check dials. `admin/watchtower-alerts.ts`'s `policyFor` is the ONE
 * place that decides which check gets which of these. */
export interface AlertPolicy {
  /**
   * Consecutive UNHEALTHY observations required before the FIRST email of an
   * episode. 1 = alert on the first bad observation (the pre-2026-08-16 rule).
   * 2 = one bad observation is a flap and is worth ZERO emails — including no
   * recovery email, since nothing was ever announced.
   */
  confirmAfterObservations: number;
  /** Gap between the confirming email and the first re-alert. */
  firstRealertMs: number;
  /** Gap between every re-alert after that one. */
  steadyRealertMs: number;
  /**
   * §7.11 (Q3's blame-split ruling) — which channel this check's transitions
   * render to. `"email"` is every check that existed before this wave, byte-
   * identical. `"digest"` means an email is NEVER owed for this check,
   * whatever `AlertAction` fires — `alertEmailFor` returns `null`
   * unconditionally and `AlertOutcome.why` reports `"digest_only"`. The
   * cadence dials above are UNCHANGED by the channel — a digest check still
   * debounces and backs off exactly like an email one; only where the result
   * goes differs. (No digest RENDERER exists yet — the digest itself is a
   * separate deliverable; today `"digest"` means "silently observed", which
   * is still strictly more honest than emailing about it.)
   */
  channel: "email" | "digest";
}

/**
 * The first re-alert gap while a check stays unhealthy. Unchanged by the
 * 2026-08-16 ruling (ofac/sdn-alert.ts deliberately mirrors this number for
 * the SDN lane, which is its own state machine).
 */
export const WATCHTOWER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Every re-alert after the first one. The founder's complaint was not that a
 * persistent outage alerts — it is that a KNOWN, unchanged condition (two
 * stuck `domain_dns_aging` checks) billed the inbox 4 times a day each with
 * nothing new to say. A daily reminder keeps the condition from being
 * forgotten without competing with alerts that are actually new.
 */
export const WATCHTOWER_STEADY_REALERT_MS = 24 * 60 * 60 * 1000;

/** Consecutive unhealthy observations before the first email, for a check the
 * cron RE-OBSERVES on a fixed cadence. At the 5-minute sweep this pages a
 * genuinely-down service ~10 min after onset (15 in the worst case of a missed
 * tick), which is the founder's stated ceiling. */
export const WATCHTOWER_CONFIRM_OBSERVATIONS = 2;

/** The default: everything the cron re-observes every 5 minutes. */
export const DEBOUNCED_ALERT_POLICY: AlertPolicy = {
  confirmAfterObservations: WATCHTOWER_CONFIRM_OBSERVATIONS,
  firstRealertMs: WATCHTOWER_COOLDOWN_MS,
  steadyRealertMs: WATCHTOWER_STEADY_REALERT_MS,
  channel: "email",
};

/**
 * §7.11 (Q3) — the digest-only twin of `DEBOUNCED_ALERT_POLICY`: identical
 * cadence, `channel: "digest"`. `customer_progress_agent:<tenantId>` is the
 * one check this wave routes here — a customer-side stall while the tenant
 * keeps paying is real, but not a founder-inbox event ("if they're paying,
 * who cares" — founder ruling Q3).
 */
export const DEBOUNCED_DIGEST_ALERT_POLICY: AlertPolicy = {
  confirmAfterObservations: WATCHTOWER_CONFIRM_OBSERVATIONS,
  firstRealertMs: WATCHTOWER_COOLDOWN_MS,
  steadyRealertMs: WATCHTOWER_STEADY_REALERT_MS,
  channel: "digest",
};

/**
 * No debounce, normal backoff — for checks where "2 consecutive observations"
 * is either meaningless or already satisfied upstream. Handing one of these a
 * debounce does not delay an alert, it DELETES it (a one-shot event report is
 * never observed twice) or breaks the paging ceiling (a check already damped
 * over N ticks would need N+1). `policyFor` documents each member.
 */
export const IMMEDIATE_ALERT_POLICY: AlertPolicy = {
  confirmAfterObservations: 1,
  firstRealertMs: WATCHTOWER_COOLDOWN_MS,
  steadyRealertMs: WATCHTOWER_STEADY_REALERT_MS,
  channel: "email",
};

/**
 * The cron dead-man's policy — HARD EXEMPTION (founder ruling 2026-08-16, C).
 *
 * `cron_sweep` already embodies a time threshold (`SWEEP_STALE_MS`: three
 * missed 5-minute cycles) and it is the check of last resort — when it fires,
 * EVERY other alert in the platform is silent, so silence means nothing. A
 * debounce would double-delay it and a 24h steady step would thin out the one
 * signal that says the whole watchtower is dead. Both dials therefore stay at
 * the pre-2026-08-16 values, which is why `watchtower-deadman.test.ts` needed
 * no edit in this wave: its timing is byte-identical.
 */
export const DEAD_MAN_ALERT_POLICY: AlertPolicy = {
  confirmAfterObservations: 1,
  firstRealertMs: WATCHTOWER_COOLDOWN_MS,
  steadyRealertMs: WATCHTOWER_COOLDOWN_MS,
  channel: "email",
};

/** What the state machine did for one check this observation — returned for
 * tests + the sweep's structured log line.
 *
 * `pending` and `suppressed` are BOTH deliberate silences and are NOT the same
 * one: `pending` is "seen unhealthy once, not confirmed yet, nothing has been
 * announced", `suppressed` is "already announced, inside the backoff".
 * `unreportable` is not a decision at all — it is the D1-independent leg saying
 * its own store was unreachable, so the check was neither alerted nor cleared. */
export type AlertAction = "alerted" | "realerted" | "recovered" | "suppressed" | "pending" | "healthy" | "unreportable";

/** The persisted per-check state, store-agnostic (D1 row or DO storage value). */
export interface AlertState {
  status: "healthy" | "unhealthy";
  sinceTs: number;
  lastAlertTs: number | null;
  /**
   * Consecutive unhealthy observations in the CURRENT episode (reset by any
   * healthy observation). Drives `confirmAfterObservations`.
   */
  unhealthyObs: number;
  /**
   * Unhealthy emails ISSUED in the current episode. 0 means the founder has
   * never been told about this episode, which is what makes a debounced flap
   * silent in BOTH directions — a recovery is only owed for an announcement
   * that actually went out. It also drives the backoff ladder (1 = only the
   * confirming email so far, so the next gap is `firstRealertMs`).
   */
  alertCount: number;
}

/**
 * What a store hands back: the current shape, or a row/value written before
 * the 2026-08-16 counters existed. The D1 side gets its defaults from
 * `migrations/0018_watchtower_debounce.sql`; DO storage has no migration
 * mechanism at all, so the fallback below is the only thing that reconciles a
 * `d1_alert_state` value written by the previous deploy.
 */
export type PersistedAlertState = Omit<AlertState, "unhealthyObs" | "alertCount"> &
  Partial<Pick<AlertState, "unhealthyObs" | "alertCount">>;

/**
 * How many alerts to credit an episode that was already running when this
 * policy shipped. 2 = "past its first re-alert", so an in-flight incident lands
 * on the 24h step immediately instead of re-announcing itself and restarting
 * the ladder. The founder's two stuck `domain_dns_aging` checks are exactly
 * this case, and a duplicate email on deploy day is the thing this wave exists
 * to stop.
 */
const LEGACY_EPISODE_ALERT_COUNT = 2;

/** Fill in the counters for a value persisted before they existed. A legacy
 * unhealthy row always carries `last_alert_ts` (the old rule set it on entering
 * the state), so "was this episode announced" is recoverable exactly. */
export function normalizeAlertState(prev: PersistedAlertState | null): AlertState | null {
  if (prev === null) return null;
  const announced = prev.status === "unhealthy" && prev.lastAlertTs !== null;
  return {
    status: prev.status,
    sinceTs: prev.sinceTs,
    lastAlertTs: prev.lastAlertTs,
    unhealthyObs: prev.unhealthyObs ?? (prev.status === "unhealthy" ? 1 : 0),
    alertCount: prev.alertCount ?? (announced ? LEGACY_EPISODE_ALERT_COUNT : 0),
  };
}

export interface AlertTransition {
  action: AlertAction;
  next: AlertState;
}

/**
 * The ONE alert rule set, as a pure function of (previous state, observation,
 * policy):
 *  - healthy -> unhealthy: count the observation. Below
 *    `confirmAfterObservations` it is PENDING (silent). At it, ALERT.
 *  - unhealthy -> unhealthy after the alert: re-alert once `firstRealertMs`
 *    has passed, then once per `steadyRealertMs`; SUPPRESS in between.
 *  - unhealthy -> healthy: RECOVERY email only if this episode was ever
 *    announced; a debounced flap goes quiet the way it arrived.
 *  - healthy -> healthy (or first-ever-healthy): nothing.
 * `next` is what the caller must persist; `action` says which email (if any)
 * `alertEmailFor` will render.
 */
export function decideAlert(
  prev: PersistedAlertState | null,
  healthy: boolean,
  nowMs: number,
  policy: AlertPolicy,
): AlertTransition {
  const state = normalizeAlertState(prev);
  // The current unhealthy EPISODE, or null when there is not one running. Every
  // counter below is episode-scoped: a healthy observation ends the episode, so
  // nothing survives it to be double-counted by the next one.
  const episode = state !== null && state.status === "unhealthy" ? state : null;

  if (healthy) {
    if (episode !== null) {
      // Announced -> tell the founder it is over. Never announced (a debounced
      // flap, or a pending first observation) -> stay silent in both directions.
      const action: AlertAction = episode.alertCount > 0 ? "recovered" : "healthy";
      return { action, next: healthyState(nowMs) };
    }
    // Stay/enter healthy — keep the original since_ts if already healthy.
    return { action: "healthy", next: healthyState(state ? state.sinceTs : nowMs) };
  }

  // PHASE 2 — an episode the founder has already been told about: the backoff
  // ladder. `alertCount` is what says which rung, so a re-alert never restarts
  // the debounce and the 24h step cannot be reached by anything but a second
  // announcement.
  if (episode !== null && episode.alertCount > 0) {
    const { sinceTs, alertCount } = episode;
    const unhealthyObs = episode.unhealthyObs + 1;
    const gapMs = alertCount >= 2 ? policy.steadyRealertMs : policy.firstRealertMs;
    if (nowMs - (episode.lastAlertTs ?? sinceTs) >= gapMs) {
      return {
        action: "realerted",
        next: { status: "unhealthy", sinceTs, lastAlertTs: nowMs, unhealthyObs, alertCount: alertCount + 1 },
      };
    }
    // Still unhealthy, inside the backoff — record the latest detail, send NOTHING.
    return {
      action: "suppressed",
      next: { status: "unhealthy", sinceTs, lastAlertTs: episode.lastAlertTs, unhealthyObs, alertCount },
    };
  }

  // PHASE 1 — nothing announced yet: count consecutive observations until the
  // policy is satisfied.
  const sinceTs = episode ? episode.sinceTs : nowMs;
  const unhealthyObs = (episode ? episode.unhealthyObs : 0) + 1;
  if (unhealthyObs < policy.confirmAfterObservations) {
    // Seen, not confirmed. The state IS recorded (GET /admin/ops/checks and the
    // next observation both need it) — only the email waits.
    return { action: "pending", next: { status: "unhealthy", sinceTs, lastAlertTs: null, unhealthyObs, alertCount: 0 } };
  }
  return { action: "alerted", next: { status: "unhealthy", sinceTs, lastAlertTs: nowMs, unhealthyObs, alertCount: 1 } };
}

function healthyState(sinceTs: number): AlertState {
  return { status: "healthy", sinceTs, lastAlertTs: null, unhealthyObs: 0, alertCount: 0 };
}

/**
 * The state to persist when a transition's email was composed and NOT
 * delivered (docs/adversarial/class-sweep-cached-terminal-2026-08-17.md member
 * 5). `decideAlert` computes `next` BEFORE anything is sent, so persisting it
 * unconditionally recorded a dark channel as an announcement: `lastAlertTs` and
 * `alertCount` advanced, the backoff engaged, and the founder — who was told
 * nothing — later received a RECOVERED email for an incident that was never
 * announced.
 *
 * Every counter that means "the founder knows" therefore stays exactly where it
 * was, while the OBSERVATION counters still advance. The next sweep recomputes
 * the same transition and tries again, so the anti-storm property is preserved
 * in the only sense that matters: at most one send attempt per check per tick,
 * and no email at all once one lands.
 *
 * A withheld RECOVERY keeps the episode open rather than banking the healthy
 * state. That leaves the check reading unhealthy for one more tick — an error
 * in the SAFE direction, and self-correcting, because the recovery is retried
 * until it is actually delivered.
 */
export function withheldAlertState(prev: PersistedAlertState | null, transition: AlertTransition): AlertState {
  const previous = normalizeAlertState(prev);
  if (transition.action === "recovered") return previous ?? transition.next;
  return {
    ...transition.next,
    lastAlertTs: previous?.lastAlertTs ?? null,
    alertCount: previous?.alertCount ?? 0,
  };
}
