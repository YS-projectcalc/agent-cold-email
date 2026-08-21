// THE DAILY ANNOUNCEMENT BUDGET — the mechanism that makes the per-day inbox
// property true (alert-state design §5.5). PURE: no store, no clock, no mailer;
// `watchtower-do.ts` owns the persisted ring and applies these decisions
// atomically.
//
// WHY A PER-EPISODE CAP IS NOT ENOUGH. §1.4's cap bounds emails per EPISODE.
// The founder counts emails per DAY, and the multiplier between the two is the
// instance count, which is unbounded: 12 of the 26 families are per-entity, and
// summing the flapper-reachable ones at 100 tenants (2 domains, 4 mailboxes
// each) gives ~1,400 instances, each worth ~1 email/day in a never-closing
// episode. Measured by the design gate: ~114/day on a correlated 50%-duty DO
// flap, ~1,866/day pathological, against a ratified ~2/day.
//
// THE GOVERNING PRINCIPLE, first because both round-2 gate blockers were
// violations of it:
//
//   The budget may delay an ANNOUNCEMENT. It may never delay an episode CLOSE,
//   and it may never suppress the report that it is itself suppressing.
//
// Recoveries are therefore EXEMPT (a budget-withheld recovery reverts the whole
// previous state, so the episode never closes — simulated at 100 simultaneous
// recoveries it drains over 4.0 days with up to 100 checks reading unhealthy
// while actually healthy, on the exact surface the 2-hourly watch cron polls as
// `?unhealthy=1`). The exemption is self-bounding: a recovery is owed only for
// an episode that was ANNOUNCED, and announcements are exactly what this bounds.

import type { AlertAction } from "./watchtower-policy.js";

/**
 * Announcement emails permitted in any rolling 24h window.
 *
 * NAMED FOR WHAT IT BOUNDS. It was `MAX_ALERT_EMAILS_PER_DAY`, and it does not
 * bound alert emails: recoveries and the three exempt groups are alert emails it
 * does not touch. A constant whose name overstates its own guarantee is this
 * repo's claim-drift class, and the founder-facing figure (§9.13) is stated in
 * INBOX units — ~20 announcements plus up to the same number of recoveries plus
 * exempt traffic, ~30/day measured, ~42/day theoretical — rather than read off
 * this number.
 *
 * [RATIFY:founder] — it changes what the founder can expect from the channel.
 */
export const MAX_ANNOUNCEMENT_EMAILS_PER_DAY = 20;

/**
 * Of those 20, the most that PER-ENTITY families may take — leaving 5 reserved
 * for the global and monitor families (§5.5 ordering (iii)).
 *
 * A FLOOR FOR THEM, NOT A CEILING: when no per-entity family is alerting the
 * global ones may use the whole 20. It exists because round-robin ordering
 * operates within ONE `reconcileAlerts` call and there are three entry points in
 * fixed order, so a `tenant_do_wedged:` storm in the first batch could otherwise
 * exhaust the budget before the sweep's own checks are offered a slot. The
 * reservation makes that cross-batch gap harmless without needing ordering to
 * cross batches at all.
 *
 * ⚠️ THIS SUB-CAP IS WHY `saturated` MUST READ EITHER COUNTER. In a pure
 * per-entity storm it binds first and holds the TOTAL at 15 of 20 forever, so a
 * total-only reading of saturation never fires while 85 of 100 instances are
 * being suppressed — 0 `alert_budget_exceeded` emails over 7 days, gate round 3.
 * A change to this number must meet that coupling; it cannot move alone.
 */
export const MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY = 15;

/** The rolling window the two counters are measured over. */
export const ANNOUNCEMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One announcement email that actually reached the founder. */
export interface AnnouncementSlot {
  id: string;
  ts: number;
  perEntity: boolean;
}

/**
 * A bounded ring of send timestamps — NOT `{windowStartMs, count}`.
 *
 * Two fields express a TUMBLING window that resets on a boundary, which permits
 * 20 sends at T+23.9h and 20 more at T+24.1h: 40 emails in a 0.20h span while
 * every stated gate still passes. The ring holds at most
 * `MAX_ANNOUNCEMENT_EMAILS_PER_DAY` entries (admission guarantees no more can be
 * live at once) and the count is "entries newer than nowMs - 24h", which is
 * exact for arbitrary spans.
 */
export interface AnnouncementRing {
  sends: AnnouncementSlot[];
}

export const EMPTY_ANNOUNCEMENT_RING: AnnouncementRing = { sends: [] };

export interface AnnouncementCounts {
  total: number;
  perEntity: number;
}

/** Drop entries that have aged out of the rolling window. Also trims to the ring
 * bound, so a value written by a future edit (or a corrupted one) cannot make
 * the counters unbounded. */
export function pruneRing(ring: AnnouncementRing, nowMs: number): AnnouncementRing {
  const live = ring.sends.filter((s) => nowMs - s.ts < ANNOUNCEMENT_WINDOW_MS);
  return { sends: live.length > MAX_ANNOUNCEMENT_EMAILS_PER_DAY ? live.slice(-MAX_ANNOUNCEMENT_EMAILS_PER_DAY) : live };
}

export function countRing(ring: AnnouncementRing): AnnouncementCounts {
  return {
    total: ring.sends.length,
    perEntity: ring.sends.filter((s) => s.perEntity).length,
  };
}

/**
 * Is the announcement channel saturated? — EITHER counter at its cap.
 *
 * This is what `alert_budget_exceeded` observes, and the "either" is the whole
 * of it: see `MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY`. The invariant that makes
 * the reading honest is that DENIAL IMPLIES SATURATION exactly — admission is
 * `total < 20 && (!perEntity || pe < 15)`, so denial is
 * `total >= 20 || (perEntity && pe >= 15)`, which this predicate covers. The
 * counters that GATE are the counters OBSERVED, so a withheld announcement can
 * never be invisible.
 */
export function isSaturated(counts: AnnouncementCounts): boolean {
  return counts.total >= MAX_ANNOUNCEMENT_EMAILS_PER_DAY || counts.perEntity >= MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY;
}

/** May one more announcement of this scope be sent against these counts? */
export function admits(counts: AnnouncementCounts, perEntity: boolean): boolean {
  if (counts.total >= MAX_ANNOUNCEMENT_EMAILS_PER_DAY) return false;
  return !perEntity || counts.perEntity < MAX_PER_ENTITY_ANNOUNCEMENTS_PER_DAY;
}

/** What one check is asking the budget for. */
export interface AnnouncementCandidate {
  /** The check name — its FAMILY is what round-robin orders on. */
  name: string;
  family: string;
  action: AlertAction;
  perEntity: boolean;
}

/**
 * Rank within a tick: a NEW incident outranks a genuinely different condition,
 * which outranks a repeat that says nothing new (§5.5 ordering (ii)).
 * `recovered` never appears here — it is exempt.
 */
const ACTION_RANK: Partial<Record<AlertAction, number>> = { alerted: 0, escalated: 1, realerted: 2 };

/**
 * The order candidates are offered slots in: round-robin across FAMILIES before
 * instances, so one noisy family cannot starve every other check (§5.5 (i)).
 *
 * HONEST SCOPE: this orders within ONE `reconcileAlerts` call. There are three
 * entry points in fixed order (`runWatchtower`, `reportSweepSignals`,
 * `reportSweepSignalsHealth`), so a `tenant_do_wedged:` storm in the first batch
 * can still reach the budget before the sweep's own checks are offered a slot —
 * which is exactly what the 15/5 reserved split closes. Rule (i)'s named goal
 * survives regardless: `d1` is decided in `reconcileD1Alert` at the top of
 * `runWatchtower`, before the tenant loop, so a simultaneous D1 outage stays
 * audible.
 *
 * Returns indices into `candidates`, so the caller keeps its own array order for
 * everything else it does per result.
 */
export function announcementOrder(candidates: readonly AnnouncementCandidate[]): number[] {
  const byFamily = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    const bucket = byFamily.get(candidate.family);
    if (bucket) bucket.push(index);
    else byFamily.set(candidate.family, [index]);
  }
  // Within a family, the most urgent action first — so if a family only wins one
  // slot this round, it spends it on the new incident rather than on a repeat.
  for (const bucket of byFamily.values()) {
    bucket.sort((a, b) => (ACTION_RANK[candidates[a]!.action] ?? 3) - (ACTION_RANK[candidates[b]!.action] ?? 3));
  }

  const queues = [...byFamily.values()];
  const ordered: number[] = [];
  for (let round = 0; ordered.length < candidates.length; round++) {
    for (const queue of queues) {
      const index = queue[round];
      if (index !== undefined) ordered.push(index);
    }
  }
  return ordered;
}

/**
 * Apply the budget to an ORDERED list of candidates against a starting count.
 *
 * Pure so the whole property is testable without a Durable Object; the DO calls
 * this inside its own storage transaction, which is what makes the decision
 * atomic rather than read-then-hope.
 */
export function admitInOrder(
  counts: AnnouncementCounts,
  candidates: readonly AnnouncementCandidate[],
  order: readonly number[],
): boolean[] {
  const admitted = new Array<boolean>(candidates.length).fill(false);
  const running = { ...counts };
  for (const index of order) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if (!admits(running, candidate.perEntity)) continue;
    admitted[index] = true;
    running.total += 1;
    if (candidate.perEntity) running.perEntity += 1;
  }
  return admitted;
}
