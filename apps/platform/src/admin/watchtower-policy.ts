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

import type { RecoveryBasis } from "@coldstart/shared";

/** The per-check dials. `admin/watchtower-alerts.ts`'s `policyFor` is the ONE
 * place that decides which check gets which of these. */
export interface AlertPolicy {
  /**
   * UNHEALTHY observations required before the FIRST email of an episode. 1 =
   * alert on the first bad observation (the pre-2026-08-16 rule). 2 = one bad
   * observation is a flap and is worth ZERO emails — including no recovery
   * email, since nothing was ever announced.
   *
   * NOT "consecutive" any more (IN-9, design §3.1). `unhealthyObs` is now zeroed
   * only by an episode CLOSE, so the gate reads "N unhealthy observations not
   * yet answered by a full recovery run" — the exact wording the already-shipped
   * sibling fix uses one layer down in `gradeStreak`. Before this, ANY healthy
   * observation zeroed the count, so a fault alternating bad/good never
   * assembled two in a row and stayed silent forever: executed against HEAD,
   * 24 alternating observations produced 0 emails.
   */
  confirmAfterObservations: number;
  /**
   * HEALTHY observations required before an announced episode CLOSES (§3.1).
   *
   * The other half of IN-9, and it is one decision with the half above: a
   * carried unhealthy count without episode closure would page eventually on a
   * once-a-month flake. 3 clean 5-minute ticks = 15 min, matching the
   * `LEG_RECOVER_AFTER_SWEEPS` hysteresis one layer down.
   *
   * Applies to a `reobserved` clear ONLY. A `no_longer_applicable` clear closes
   * in ONE observation, always — it is not a measurement of the condition, it
   * says the entity left the population, and a departed entity never produces
   * another observation, so requiring three would leave its episode open and
   * re-alerting on the 24h ladder forever.
   */
  recoverAfterObservations: number;
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

/**
 * Healthy observations before a re-observed check's episode closes (design
 * §3.3). Three clean 5-minute ticks = 15 min.
 */
export const WATCHTOWER_RECOVER_OBSERVATIONS = 3;

/** The default: everything the cron re-observes every 5 minutes. */
export const DEBOUNCED_ALERT_POLICY: AlertPolicy = {
  confirmAfterObservations: WATCHTOWER_CONFIRM_OBSERVATIONS,
  recoverAfterObservations: WATCHTOWER_RECOVER_OBSERVATIONS,
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
  recoverAfterObservations: WATCHTOWER_RECOVER_OBSERVATIONS,
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
  // The confirm-side exemption reason transfers VERBATIM to the recovery side
  // (design §3.3): a one-shot is never re-observed, so a recovery confirmation
  // would DELETE the recovery rather than delay it — and a `gradeSweepStreak`-
  // damped check already requires 3 consecutive clean ticks upstream, so a
  // second confirmation here double-damps it to 30 min.
  recoverAfterObservations: 1,
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
  // Hard exemption on BOTH sides: timing stays byte-identical, which is why
  // `watchtower-deadman.test.ts` needs no edit in this increment either.
  recoverAfterObservations: 1,
  firstRealertMs: WATCHTOWER_COOLDOWN_MS,
  steadyRealertMs: WATCHTOWER_COOLDOWN_MS,
  channel: "email",
};

/** What the state machine did for one check this observation — returned for
 * tests + the sweep's structured log line.
 *
 * `pending`, `holding` and `suppressed` are all deliberate silences and are NOT
 * the same one: `pending` is "seen unhealthy, not confirmed yet, nothing has
 * been announced", `holding` is "the producer says healthy but the episode is
 * not closed yet", `suppressed` is "already announced, inside the backoff or at
 * the key cap". `escalated` is an email about a genuinely DIFFERENT condition
 * under the same check name — the thing a two-valued healthy/unhealthy
 * comparison could not express at all. `unreportable` is not a decision — it is
 * the D1-independent leg saying its own store was unreachable, so the check was
 * neither alerted nor cleared. */
export type AlertAction =
  | "alerted"
  | "realerted"
  | "escalated"
  | "recovered"
  | "suppressed"
  | "pending"
  | "holding"
  | "healthy"
  | "unreportable";

/**
 * The materiality keys this episode has ACTUALLY ANNOUNCED, plus how many
 * distinct ones the cap turned away (design §1.3).
 *
 * `keys` means DELIVERED — a dark-channel escalation is reverted by
 * `withheldAlertState` and does not bank its key, or the condition would be
 * recorded as announced and never announced again. `overflow` rides the next
 * ladder email's body so the founder is told the episode has more distinct
 * conditions than the cap allowed.
 */
export interface AnnouncedKeys {
  keys: string[];
  overflow: number;
}

/**
 * The most distinct materiality keys ONE episode may announce.
 *
 * INVARIANT: `MAX_ANNOUNCED_KEYS_PER_EPISODE > max(|declared key space|)`,
 * STRICTLY greater — asserted over the family table in
 * `watchtower-families.test.ts`. That inequality is the whole safety argument:
 * the cap then can NEVER bind on a correctly-declared family and binds only on
 * a mis-derived or undeclared key, so the anti-storm bound does not depend on
 * all 26 key derivations being right. `ALERT_FAMILIES` tops out at 4.
 */
export const MAX_ANNOUNCED_KEYS_PER_EPISODE = 5;

/** The persisted per-check state, store-agnostic (D1 row or DO storage value). */
export interface AlertState {
  status: "healthy" | "unhealthy";
  sinceTs: number;
  lastAlertTs: number | null;
  /**
   * Unhealthy observations in the CURRENT episode. Zeroed by an episode CLOSE,
   * NOT by a healthy observation (IN-9 — see `confirmAfterObservations`).
   */
  unhealthyObs: number;
  /**
   * Healthy observations since the last unhealthy one, within an open episode.
   * Drives `recoverAfterObservations`, and it is also what tells an operator
   * (and `reconcileAlerts`' onset adoption) that a recovery is in progress on a
   * row still reading `status = 'unhealthy'`.
   */
  healthyObs: number;
  /**
   * Unhealthy emails ISSUED in the current episode. 0 means the founder has
   * never been told about this episode, which is what makes a debounced flap
   * silent in BOTH directions — a recovery is only owed for an announcement
   * that actually went out.
   */
  alertCount: number;
  /**
   * LADDER RUNGS CLIMBED — how many `realerted` emails this episode has issued.
   *
   * SPLIT OFF `alertCount` (N1). One field was carrying two facts: "was this
   * episode announced" AND "how many rungs has it climbed". Because
   * `gapMs = alertCount >= 2 ? steady : first`, ANY increment promoted the check
   * from the 6h rung to the 24h rung — so an `escalated` email (which the
   * increment adds, and which says something genuinely new) would silently
   * DELETE the episode's "still broken" 6h ping. Escalations are now
   * rung-neutral, and `realertCount >= 1` is byte-identical to the old
   * `alertCount >= 2`, which is why `watchtower-policy.test.ts`'s `sustained()`
   * expectations hold unchanged.
   */
  realertCount: number;
  /** The per-episode announced ledger (§1.3). */
  announcedKeys: AnnouncedKeys;
}

/**
 * ONE health observation, as the state machine sees it.
 *
 * `materiality` is REQUIRED on the unhealthy arm, exactly as `basis` is required
 * on the healthy arm, and for the same reason: it does not compile until each
 * producer states which it is. An optional field with a default re-creates the
 * silent-inherit failure that making `policy` a required argument was introduced
 * to stop, and a defaulted key would make every escalation invisible.
 */
export type AlertObservation = { healthy: false; materiality: string } | { healthy: true; basis: RecoveryBasis };

/**
 * What a store hands back: the current shape, or a row/value written before
 * the 2026-08-16 counters existed. The D1 side gets its defaults from
 * `migrations/0018_watchtower_debounce.sql`; DO storage has no migration
 * mechanism at all, so the fallback below is the only thing that reconciles a
 * `d1_alert_state` value written by the previous deploy.
 */
export type PersistedAlertState = Omit<AlertState, "unhealthyObs" | "alertCount" | "healthyObs" | "realertCount" | "announcedKeys"> &
  Partial<Pick<AlertState, "unhealthyObs" | "alertCount" | "healthyObs" | "realertCount" | "announcedKeys">>;

/** An episode with nothing announced yet. */
export const EMPTY_ANNOUNCED_KEYS: AnnouncedKeys = { keys: [], overflow: 0 };

/**
 * How many alerts to credit an episode that was already running when this
 * policy shipped. 2 = "past its first re-alert", so an in-flight incident lands
 * on the 24h step immediately instead of re-announcing itself and restarting
 * the ladder. The founder's two stuck `domain_dns_aging` checks are exactly
 * this case, and a duplicate email on deploy day is the thing this wave exists
 * to stop.
 */
const LEGACY_EPISODE_ALERT_COUNT = 2;

/**
 * Fill in the counters for a value persisted before they existed. A legacy
 * unhealthy row always carries `last_alert_ts` (the old rule set it on entering
 * the state), so "was this episode announced" is recoverable exactly.
 *
 * THE SEAM IS MANDATORY, not a convenience (§2.3): DO storage has no migration
 * mechanism at all, so a `d1_alert_state` / `dead_man_alert_state` value written
 * by the previous deploy reaches `decideAlert` with none of these fields. The D1
 * side gets column defaults from its migration and still passes through here, so
 * ONE rule covers both stores — a backfill only ever reaches one of them.
 *
 * `announcedKeys` is deliberately NOT reconstructed: an empty ledger on an
 * announced episode is the LEGACY-ADOPT predicate (§2.2), which `decideAlert`
 * answers with a silent adoption rather than an email.
 */
export function normalizeAlertState(prev: PersistedAlertState | null): AlertState | null {
  if (prev === null) return null;
  const announced = prev.status === "unhealthy" && prev.lastAlertTs !== null;
  const alertCount = prev.alertCount ?? (announced ? LEGACY_EPISODE_ALERT_COUNT : 0);
  return {
    status: prev.status,
    sinceTs: prev.sinceTs,
    lastAlertTs: prev.lastAlertTs,
    unhealthyObs: prev.unhealthyObs ?? (prev.status === "unhealthy" ? 1 : 0),
    // A pre-field row cannot be mid-recovery: the old machine closed an episode
    // on the FIRST healthy observation, so an unhealthy row it wrote had seen no
    // healthy one since.
    healthyObs: prev.healthyObs ?? 0,
    alertCount,
    // Mirrors 0018's `LEGACY_EPISODE_ALERT_COUNT` credit exactly, in the new
    // field: an in-flight episode sits on the 24h step rather than dropping back
    // to the 6h rung and emitting one extra email on deploy day.
    realertCount: prev.realertCount ?? (alertCount >= LEGACY_EPISODE_ALERT_COUNT ? 1 : 0),
    announcedKeys: normalizeAnnouncedKeys(prev.announcedKeys),
  };
}

/**
 * Coerce a persisted ledger, treating anything unreadable as LEGACY (empty), not
 * as "this episode announced nothing".
 *
 * The two are opposite instructions to §2.2's adopt rule and the difference is a
 * storm: "announced nothing" means re-announce every key in the episode, so a
 * single corrupt byte would email once per condition. Empty + `alertCount > 0`
 * routes to the silent adoption instead, which is the safe reading of "we cannot
 * tell what was announced".
 */
function normalizeAnnouncedKeys(value: AnnouncedKeys | undefined): AnnouncedKeys {
  if (!value || !Array.isArray(value.keys)) return { ...EMPTY_ANNOUNCED_KEYS };
  return {
    keys: value.keys.filter((k): k is string => typeof k === "string"),
    overflow: typeof value.overflow === "number" && Number.isFinite(value.overflow) ? value.overflow : 0,
  };
}

export interface AlertTransition {
  action: AlertAction;
  next: AlertState;
  /**
   * Which silence a `suppressed` action is — the two are different facts to an
   * operator reading `AlertOutcome.why`. `cooldown` is "already announced,
   * inside the backoff"; `key_cap` is "a genuinely NOVEL condition arrived and
   * the episode is already at `MAX_ANNOUNCED_KEYS_PER_EPISODE`", which is the
   * one that means information was dropped.
   */
  suppressedBy?: "cooldown" | "key_cap";
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
  observation: AlertObservation,
  nowMs: number,
  policy: AlertPolicy,
): AlertTransition {
  const state = normalizeAlertState(prev);
  // The current unhealthy EPISODE, or null when there is not one running. Every
  // counter below is episode-scoped: an episode CLOSE zeroes them, so nothing
  // survives it to be double-counted by the next one.
  const episode = state !== null && state.status === "unhealthy" ? state : null;

  if (observation.healthy) {
    if (episode !== null) return decideRecovery(episode, observation.basis, nowMs, policy);
    // Stay/enter healthy — keep the original since_ts if already healthy.
    return { action: "healthy", next: healthyState(state ? state.sinceTs : nowMs) };
  }

  const key = observation.materiality;

  // PHASE 2 — an episode the founder has already been told about. The order
  // below is LADDER-FIRST and it is load-bearing (§1.4/B2): the escape falls
  // THROUGH the ladder rather than replacing it, so an episode sitting at the
  // key cap and still broken emits ~30 emails over 30 days rather than 5 and
  // then permanent silence. Row 3 is the fall-through after the ladder
  // declined, never a terminal outcome for the tick.
  if (episode !== null && episode.alertCount > 0) {
    const { sinceTs, alertCount, announcedKeys } = episode;
    const unhealthyObs = episode.unhealthyObs + 1;
    const novel = !announcedKeys.keys.includes(key);
    const underCap = announcedKeys.keys.length < MAX_ANNOUNCED_KEYS_PER_EPISODE;
    // The RUNG, not the announcement count (N1) — see `realertCount`.
    const gapMs = episode.realertCount >= 1 ? policy.steadyRealertMs : policy.firstRealertMs;
    const base = { status: "unhealthy" as const, sinceTs, unhealthyObs, healthyObs: 0, alertCount };

    // 1 — the ladder. The re-alert body carries this tick's key, so no second
    //     email is owed for it; bank it if it is novel and fits.
    if (nowMs - (episode.lastAlertTs ?? sinceTs) >= gapMs) {
      return {
        action: "realerted",
        next: {
          ...base,
          lastAlertTs: nowMs,
          alertCount: alertCount + 1,
          realertCount: episode.realertCount + 1,
          announcedKeys: novel && underCap ? appendKey(announcedKeys, key) : announcedKeys,
        },
      };
    }

    const held = { ...base, lastAlertTs: episode.lastAlertTs, realertCount: episode.realertCount };

    // 1.5 — THE LEGACY-ADOPT RULE (§2.2). An episode announced by the PREVIOUS
    //     deploy has an empty ledger, and every key it ever announced is
    //     therefore "novel" to row 2 — one spurious escalation email per stuck
    //     check on deploy day. Adopt the first observed key SILENTLY instead:
    //     no email, key appended, counters untouched.
    //
    //     Safe because the predicate is UNREACHABLE for state this code writes:
    //     `alerted` writes `alertCount` and the first key together,
    //     `escalated`/`realerted` only append, `withheldAlertState` copies the
    //     previous ledger, and an episode close zeroes both. It covers D1 AND DO
    //     storage, which is the point — a backfill only reaches one of them.
    if (announcedKeys.keys.length === 0) {
      return { action: "suppressed", suppressedBy: "cooldown", next: { ...held, announcedKeys: appendKey(announcedKeys, key) } };
    }

    // 2 — a genuinely DIFFERENT condition under the same check name. Rung-
    //     neutral: `realertCount` does not move, so the 6h/24h ladder is exactly
    //     where it was.
    if (novel && underCap) {
      return { action: "escalated", next: { ...held, alertCount: alertCount + 1, announcedKeys: appendKey(announcedKeys, key) } };
    }

    // 3 — novel, but the episode is at the cap. Count it so the next ladder
    //     email can say the episode holds more distinct conditions than it told
    //     the founder about.
    if (novel) {
      return {
        action: "suppressed",
        suppressedBy: "key_cap",
        next: { ...held, announcedKeys: { keys: announcedKeys.keys, overflow: announcedKeys.overflow + 1 } },
      };
    }

    // 4 — the same condition, inside the backoff. Record the latest detail,
    //     send NOTHING.
    return { action: "suppressed", suppressedBy: "cooldown", next: { ...held, announcedKeys } };
  }

  // PHASE 1 — nothing announced yet: count observations until the policy is
  // satisfied. NOT consecutive ones (IN-9): only an episode close zeroes this.
  const sinceTs = episode ? episode.sinceTs : nowMs;
  const unhealthyObs = (episode ? episode.unhealthyObs : 0) + 1;
  const carried = episode ? episode.announcedKeys : EMPTY_ANNOUNCED_KEYS;
  if (unhealthyObs < policy.confirmAfterObservations) {
    // Seen, not confirmed. The state IS recorded (GET /admin/ops/checks and the
    // next observation both need it) — only the email waits.
    return {
      action: "pending",
      next: { status: "unhealthy", sinceTs, lastAlertTs: null, unhealthyObs, healthyObs: 0, alertCount: 0, realertCount: 0, announcedKeys: carried },
    };
  }
  return {
    action: "alerted",
    next: {
      status: "unhealthy",
      sinceTs,
      lastAlertTs: nowMs,
      unhealthyObs,
      healthyObs: 0,
      alertCount: 1,
      realertCount: 0,
      announcedKeys: appendKey(carried, key),
    },
  };
}

/**
 * The healthy arm of an OPEN episode (§3.1).
 *
 * `no_longer_applicable` closes in ONE observation and is not negotiable: it is
 * not a measurement of the condition, it says the entity left the population.
 * Requiring three would break two shipped, gate-ratified properties — the
 * continuity blame-flip cross-clear needs one-tick closure, and a departed
 * entity never produces another observation, so its episode would stay open and
 * re-alert on the 24h ladder forever.
 */
function decideRecovery(episode: AlertState, basis: RecoveryBasis, nowMs: number, policy: AlertPolicy): AlertTransition {
  const closed: AlertAction = episode.alertCount > 0 ? "recovered" : "healthy";
  if (basis === "no_longer_applicable") return { action: closed, next: healthyState(nowMs) };

  const healthyObs = episode.healthyObs + 1;
  if (healthyObs >= policy.recoverAfterObservations) return { action: closed, next: healthyState(nowMs) };

  // HOLDING — silent, and the episode stays OPEN. `unhealthyObs`, the ledger and
  // the ladder rung are all preserved: this is the half of IN-9 that makes the
  // carried unhealthy count safe, because without closure a once-a-month flake
  // would page eventually.
  return { action: "holding", next: { ...episode, healthyObs } };
}

function appendKey(ledger: AnnouncedKeys, key: string): AnnouncedKeys {
  return { keys: [...ledger.keys, key], overflow: ledger.overflow };
}

function healthyState(sinceTs: number): AlertState {
  return {
    status: "healthy",
    sinceTs,
    lastAlertTs: null,
    unhealthyObs: 0,
    healthyObs: 0,
    alertCount: 0,
    realertCount: 0,
    announcedKeys: { ...EMPTY_ANNOUNCED_KEYS },
  };
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
  if (transition.action === "recovered") {
    // THE EPISODE STAYS OPEN and the recovery is retried until it lands — the
    // semantics this arm shipped with, unchanged.
    //
    // WHAT IS RECORDED IS THAT THE PRODUCER SAID HEALTHY (build gate N6). The
    // `healthyObs === 0` gate on onset adoption (`reconcileAlerts`) reads this
    // column to mean "the producer has NOT reported healthy", and a withheld
    // recovery left it at 0 while the producer plainly had — so a departed
    // sibling stayed adoptable and the new episode inherited its stale onset,
    // which is exactly the silent-nudge-deletion B6 exists to prevent. Reachable
    // via the `no_longer_applicable` route only: a tenant leaves scope while an
    // announced `customer_progress_*` episode is open, that recovery email is
    // dark-channel-withheld, and the tenant later returns and stalls again. (The
    // same-tick blame-flip cross-clear cannot reach it — `reclassified`
    // suppresses the SEND, so no email is composed and nothing is withheld.)
    //
    // `Math.max`, not `+ 1`, so the retry cadence cannot drift: a `reobserved`
    // clear that reached `recovered` already carries
    // `healthyObs === recoverAfterObservations - 1`, which is >= 1, so this is a
    // no-op there and only the `no_longer_applicable` route moves 0 -> 1. That
    // route closes UNCONDITIONALLY on every observation, so the recovery is
    // still retried on the very next tick.
    const held = previous ?? transition.next;
    return { ...held, healthyObs: Math.max(held.healthyObs, 1) };
  }
  return {
    ...transition.next,
    lastAlertTs: previous?.lastAlertTs ?? null,
    alertCount: previous?.alertCount ?? 0,
    // The two fields the announced-ledger increment added to the "means the
    // founder knows" set (§5.4). Missing either converts a dark-channel
    // ESCALATION into a permanent deletion: the key would be banked as
    // announced, `escalated` would never fire for it again, and the condition
    // would go unreported for the life of the episode. `realertCount` is the
    // same argument on the ladder — a withheld re-alert must not push the rung.
    realertCount: previous?.realertCount ?? 0,
    announcedKeys: previous?.announcedKeys ?? { ...EMPTY_ANNOUNCED_KEYS },
  };
}
