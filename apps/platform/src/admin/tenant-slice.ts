// The cron sweep's BOUNDED TENANT SLICE — one keyset-paged window of
// `tenants_index` per tick, shared by every per-tenant leg, plus the isolated
// bounded loop those legs run it through.
//
// WHY ONE SLICE FOR ALL LEGS rather than a cursor per leg (scale audit S1):
// the legs all iterate the same list, so a shared window makes the per-tick
// cost `SWEEP_RPCS_PER_TENANT x SWEEP_TENANT_SLICE` — a constant — instead of
// `~8N`. A seventh O(N) leg (the provisioning-reconcile arm, dark today) then
// costs one more RPC per SLICE rather than one more per tenant, which is the
// headroom the audit asked for. It also means every leg sees the SAME tenants
// on the same tick, so "this tenant was swept" is one fact rather than seven.
//
// COVERAGE IS THE PRICE, AND IT IS PUBLISHED. A bounded sweep reaches every
// tenant across `coverageTicks(total, leastVisited)` ticks instead of every
// tick. That is a real degradation of detection latency and it is reported
// (`admin/sweep-signals.ts`'s coverage check + GET /admin/ops/checks), because a
// bound whose latency nobody publishes is the same blind spot pointing the
// other way.
//
// THE SECOND ARGUMENT IS `leastVisited`, NOT THE SLICE. It was the slice until
// 2026-08-20, and that is a different number whenever the shared fan-out
// deadline stops a trailing leg partway through — which at real DO latency was
// every tick, making the published figure 31x optimistic. `commitSweepCursor`
// below already advances the rotation by the least-covered leg for exactly this
// reason; the reported latency has to use the same quantity the cursor does.
//
// KEYSET, NOT OFFSET. `WHERE id > ? ORDER BY id LIMIT ?` bounds the D1 read
// itself (the old `SELECT id FROM tenants_index` had no LIMIT, so the whole
// index landed in Worker memory every leg, every tick) and cannot skip or
// duplicate a row when tenants are inserted mid-rotation, which an OFFSET page
// can.

import type { Env } from "../env.js";
import type { TenantOpsSummary } from "../engine/ops-summary.js";
import { RealClock } from "../clock.js";
import { coverageTicks, CRON_PERIOD_MS, PAYING_TENANT_PRIORITY_CAP, priorityWindowSize, SWEEP_TENANT_SLICE } from "./sweep-budget.js";
import { rotationOffset } from "../isolated-loop.js";
import { isPaidPlan } from "@coldstart/shared";

/**
 * The tick's shared wall-clock ceiling, and NOTHING else.
 *
 * SPLIT OUT of `SweepFanout` deliberately (B1's fix round). A leg that iterates
 * a population which is NOT the tenant slice — the screening-recovery leg
 * drains sentinel-held review rows — still needs the deadline, but must never
 * touch the rotation accumulator: its `visited` count says nothing about how
 * far the tenant rotation got, and feeding it in would advance the cursor by
 * however many tenants happened to be stuck on the sentinel. One type carrying
 * both facts is how that mistake gets made silently.
 */
export interface SweepDeadline {
  readonly startedAt: number;
  readonly deadlineMs: number;
}

/**
 * One tick's tenant fan-out phase: the shared deadline above, PLUS the
 * accumulator that says how far the LEAST covered slice leg got.
 *
 * `leastVisited` is written by `sweepTenants` and read once, by
 * `commitSweepCursor`. It is state rather than a return value because the legs
 * are called from `scheduled.ts` through `runLeg`'s uniform
 * `(name, fallback, fn)` shape and one of them (provisioning reconcile) does
 * not run at all while it is dark — threading a per-leg count out would have to
 * distinguish "swept zero tenants" from "never ran", and getting that wrong
 * pins the rotation on its first slice forever.
 */
export interface SweepFanout extends SweepDeadline {
  leastVisited: number | null;
  /**
   * How many tenants this tick's fan-out may have in flight at once.
   *
   * ON `SweepFanout` AND DELIBERATELY NOT ON `SweepDeadline`, which is what
   * makes `sweepDeadlineOf()` strip it for free. A leg iterating a population
   * that is NOT the tenant slice must stay SEQUENTIAL, and the reason is
   * concrete rather than cautious: `reapStaleReservations` writes
   * `vendor_spend_ledger WHERE period_key = ?` and
   * `vendor_slot_state WHERE id = 1` — rows SHARED across the items it
   * iterates. Every tenant-slice leg touches only its own tenant's DO and its
   * own tenant's rows; those two do not. Same type-level separation, and the
   * same reason, as `leastVisited`.
   */
  readonly concurrency: number;
  /**
   * How many leading entries of each leg's tenant list are PRIORITY tenants
   * (paying, swept every tick) rather than members of the rotating slice.
   *
   * The rotation accumulator has to net them out: `commitSweepCursor` indexes
   * the ROTATING slice, so a prefix that counts priority tenants would advance
   * the cursor by tenants that are not on that page at all.
   *
   * On `SweepFanout` for the same reason `concurrency` is — `sweepDeadlineOf()`
   * strips it, and a leg iterating its own population has no priority prepend.
   */
  readonly priorityCount: number;
}

export function newSweepFanout(
  startedAt: number,
  deadlineMs: number,
  concurrency: number = 1,
  priorityCount: number = 0,
): SweepFanout {
  return {
    startedAt,
    deadlineMs,
    leastVisited: null,
    concurrency: Math.max(1, Math.floor(concurrency)),
    priorityCount: Math.max(0, Math.floor(priorityCount)),
  };
}

/**
 * The same tick's deadline WITHOUT the rotation accumulator — what a leg that
 * fans out over its own population passes to `sweepTenants`.
 *
 * A function rather than a spread at the call site so the stripping is one
 * named, greppable act: `{ ...fanout }` would still carry `leastVisited` and
 * would compile.
 */
export function sweepDeadlineOf(fanout: SweepDeadline | undefined): SweepDeadline | undefined {
  return fanout && { startedAt: fanout.startedAt, deadlineMs: fanout.deadlineMs };
}

/** Does this deadline also accumulate the tenant rotation's progress? */
function isSweepFanout(deadline: SweepDeadline): deadline is SweepFanout {
  return "leastVisited" in deadline;
}

/**
 * What a per-tenant leg is allowed to touch this call. Both fields absent is
 * the ON-DEMAND shape (an operator hitting `POST /admin/ops/dunning-sweep`
 * wants the whole platform, once, and its failure is loud and attributable);
 * the cron always passes both.
 */
export interface SweepScope {
  /** The bounded slice this tick may touch. Absent = every tenant. */
  tenantIds?: readonly string[];
  /** The tick's shared fan-out phase. Absent = no deadline, no cursor. */
  fanout?: SweepFanout;
  /**
   * Paying tenants swept AHEAD of the rotating slice, every tick.
   *
   * PREPENDED, NOT SORTED IN. The obvious reading of "paying-tenant-first" is
   * to order the slice by plan, and that silently breaks the rotation:
   * `commitSweepCursor` advances a KEYSET cursor with `slice.ids[covered - 1]`,
   * which is only meaningful while the slice is in `id` order. A prepend keeps
   * the rotating page exactly as the keyset read returned it, and
   * `SweepFanout.priorityCount` nets the prepend back out of the accumulator.
   */
  priorityTenantIds?: readonly string[];
  /**
   * The tick's SHARED per-tenant ops summaries, fetched once by the
   * `opsSummary` prefetch leg (admin/ops-sweep.ts) and read by the three legs
   * that used to fetch one each — dunning, digest and the watchtower. Cuts the
   * fan-out from 9 DO RPCs per tenant to 7, which is what the slice is derived
   * from.
   *
   * PRESENCE OF THE MAP, NOT PRESENCE OF THE TENANT, IS THE MODE SWITCH, and
   * the distinction is load-bearing:
   *
   *  - map ABSENT  = the on-demand path (an operator hitting
   *    `GET /admin/ops/digest`). Fetch per tenant, exactly as before.
   *  - map PRESENT but this tenant MISSING = the cron path, where the prefetch
   *    leg reached this tenant and its RPC THREW. Falling back to a fetch here
   *    would put the RPC back into the worst case the slice is derived from,
   *    making the dedupe cosmetic; so the leg counts an ERROR instead, which is
   *    what the failing RPC would have produced anyway and keeps `cron_legs`
   *    saying so.
   */
  summaries?: ReadonlyMap<string, TenantOpsSummary>;
  /**
   * The ORIGINAL throw for each tenant the prefetch could not supply.
   *
   * Beside `summaries` and read by `sweptSummary`, which RETHROWS it rather
   * than raising a synthetic error in its place. Without this the wedged-DO
   * alert's body and its `err.name`-derived materiality key are both destroyed
   * on the only production path — NB-1, gate 2026-08-24, proven by execution.
   */
  summaryFailures?: ReadonlyMap<string, unknown>;
}

/**
 * This tenant's ops summary for a slice leg: from the tick's shared prefetch
 * when there is one, otherwise fetched, and in BOTH cases checked against the
 * window the caller actually needs.
 *
 * THE WINDOW CHECK IS THE POINT, not defensive padding. Three legs share one
 * object and ask about three different spans; the windowed fields are
 * pre-aggregated counts that no caller can re-window. Handing the watchtower a
 * 24h failure count silently reads as an incident, and handing the digest a 1h
 * deliverability count silently reads as a calm day. Both are wrong in a
 * direction nobody would notice, so the mismatch throws — loudly, into
 * `sweepTenants`' per-tenant catch, where it becomes a counted leg error rather
 * than a wrong number.
 *
 * Returns `null` ONLY for "the prefetch ran and did not supply this tenant",
 * i.e. its RPC threw. Callers treat that as their own error (see
 * `SweepScope.summaries`).
 */
export async function sweptSummary(
  env: Env,
  scope: SweepScope,
  tenantId: string,
  need: { actionsSinceMs?: number; failureSignalsSinceMs?: number },
  fetchSinceMs: number,
): Promise<TenantOpsSummary | null> {
  if (!scope.summaries) {
    return await env.TENANT.get(env.TENANT.idFromName(tenantId)).opsSummary(fetchSinceMs);
  }
  const summary = scope.summaries.get(tenantId);
  if (!summary) {
    // RETHROW THE ORIGINAL (NB-1). The consuming leg's catch is what classifies
    // and banks this failure — `tenantDoWedgedKey` reads `err.name`, and the
    // alert body quotes `err.message`. A synthetic `new Error` here makes the
    // name always "Error" (collapsing four materiality keys to one) and the
    // message a tautology about our own plumbing. The tenant's DO threw; the
    // tenant's DO error is what has to arrive.
    const original = scope.summaryFailures?.get(tenantId);
    if (original !== undefined) throw original;
    return null;
  }
  if (need.actionsSinceMs !== undefined && summary.windows.actionsSinceMs !== need.actionsSinceMs) {
    throw new Error(
      `shared ops summary for ${tenantId} was windowed at actionsSinceMs=${summary.windows.actionsSinceMs}, caller needs ${need.actionsSinceMs}`,
    );
  }
  if (need.failureSignalsSinceMs !== undefined && summary.windows.failureSignalsSinceMs !== need.failureSignalsSinceMs) {
    throw new Error(
      `shared ops summary for ${tenantId} was windowed at failureSignalsSinceMs=${summary.windows.failureSignalsSinceMs}, caller needs ${need.failureSignalsSinceMs}`,
    );
  }
  return summary;
}

export interface TenantSlice {
  /** The tenants this tick may touch, in `id` order. */
  ids: string[];
  /**
   * The window size this tick was ALLOWED — `SWEEP_TENANT_SLICE`, or a test's
   * `sliceLimit`. Distinct from `ids.length`, which is the SHORT TAIL whenever
   * the remaining index is smaller than the limit.
   *
   * Carried because the two are not interchangeable for coverage arithmetic
   * (gate 2026-08-20 NB-3). On a tail tick `ids.length` is small because the
   * tail is small, not because anything clipped, so extrapolating a rotation
   * from it is wrong in the pessimistic direction — `{total: 30, covered: 1}`
   * published "a full pass every 30 tick(s) (~150 min)" when the truth was 10
   * ticks / 50 min. The sustainable advance is this limit; `ids.length` only
   * says whether the tick was clipped.
   */
  limit: number;
  /** EVERY tenant in the index — the denominator, so a partial pass can say so. */
  total: number;
  /** True iff `ids` is the whole index (nothing was left for a later tick). */
  complete: boolean;
  /**
   * Ticks a full rotation takes at this tenant count IF every fan-out leg
   * reaches the whole slice — the PLAN, not the outcome.
   *
   * NAMED `planned` SINCE THE 2026-08-20 CALIBRATION FIX, because it was being
   * read as the achieved figure and reported to the founder as one. The
   * rotation advances by `SweepFanout.leastVisited` (see `commitSweepCursor`),
   * which the shared fan-out deadline can drive far below `ids.length`: live at
   * 63 tenants this said 2 ticks while the cursor was moving one tenant per
   * tick, i.e. 63. Anything grading or publishing COVERAGE LATENCY must use the
   * achieved count; this field is only ever the intent.
   */
  plannedCoverageTicks: number;
}

/** Rows a single on-demand (non-cron) fan-out may read. The audit's S8: the
 * cross-tenant reads had no cap at all. This is a bound with a DENOMINATOR
 * beside it (`countTenants`), never a silent narrowing. */
export const MAX_TENANT_SCAN = 5_000;

/**
 * The paying tenants this tick sweeps ahead of the rotation, bounded.
 *
 * `plan = 'managed'` is `isPaidPlan`'s definition, restated in SQL because a
 * predicate cannot cross into D1. `tenant-slice-priority.test.ts` holds the two
 * together by running every `TenantPlan` value through both — a divergence here
 * would either starve a paying tenant of its priority or hand it to everyone.
 *
 * `status = 'active'` as well: a suspended or terminated tenant is not owed
 * every-tick freshness, and including it would spend the priority budget on
 * exactly the tenants with nothing to sweep.
 */
export async function readPriorityTenantIds(
  env: Env,
  limit: number = PAYING_TENANT_PRIORITY_CAP,
  nowMs: number = new RealClock().now(),
): Promise<string[]> {
  const window = Math.max(0, Math.min(limit, PAYING_TENANT_PRIORITY_CAP));
  if (window === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT id FROM tenants_index WHERE plan = 'managed' AND status = 'active' ORDER BY id LIMIT ?`,
  )
    .bind(PAYING_TENANT_SCAN_MAX)
    .all<{ id: string }>();
  const all = rows.results.map((r) => r.id);
  if (all.length <= window) return all;

  // THE WINDOW ROTATES (NB-8, gate 2026-08-24). `ORDER BY id LIMIT 5` hands the
  // same lowest-five ids priority every tick, forever — the sixth paying tenant
  // is starved of it DETERMINISTICALLY, not occasionally. The starvation was
  // bounded (it still rotates in with everyone else) but it was an accident
  // rather than a decision, and the cap now shrinks to the CONCURRENCY as well
  // (`priorityWindowSize`), so at the rollback lever the window is ONE and the
  // unfairness would be total.
  //
  // Cycle-derived, exactly like the send pipeline's own rotation: every paying
  // tenant gets the priority slot every `ceil(n / window)` ticks. `nowMs` is a
  // parameter so a test can pin it — a wall-clock-derived order otherwise makes
  // any fixed-order assertion a periodic flake.
  // STRIDE BY THE WINDOW, not by one. `rotationOffset` advances the cycle index
  // by 1 per period, which for a window of w would re-serve w-1 of the same
  // tenants every tick and take `n` ticks to reach everyone. Multiplying by the
  // window makes consecutive ticks serve DISJOINT groups, so the guarantee is
  // the one the docstring claims: every paying tenant gets the priority slot
  // once per `ceil(n / window)` ticks.
  const groups = Math.ceil(all.length / window);
  const offset = (rotationOffset(nowMs, CRON_PERIOD_MS, groups) * window) % all.length;
  return Array.from({ length: window }, (_v, i) => all[(offset + i) % all.length] as string);
}

/**
 * How many paying tenants the priority read will look at.
 *
 * A cap with a stated consequence rather than a silent narrowing: past this many
 * PAYING tenants the tail stops entering the rotation window at all. It sits far
 * above the tenant count at which `sweep_coverage` says the read-model is due,
 * so a platform that reaches it has a larger problem than this constant.
 */
export const PAYING_TENANT_SCAN_MAX = 1_000;

/** The SQL predicate above, as a function — the oracle its test compares against. */
export function isPriorityPlan(plan: string): boolean {
  return isPaidPlan(plan);
}

/** How many tenants the control plane knows about, unfiltered. */
export async function countTenants(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM tenants_index`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The tenants this tick may sweep, resuming from the persisted cursor.
 *
 * WRAPPING IS A RESTART, NOT A REFILL: when the tail of the index is shorter
 * than the slice, this returns the short tail and the next tick starts over at
 * the beginning. Topping the slice up from the head would make the head tenants
 * sweep twice in one rotation for no gain, and the arithmetic that bounds the
 * tick is about the MAXIMUM, which a short tail cannot exceed.
 */
export async function readTenantSlice(env: Env, limit: number = SWEEP_TENANT_SLICE): Promise<TenantSlice> {
  const total = await countTenants(env);
  const cursor = await readSweepCursor(env);
  const rows = cursor
    ? await env.DB.prepare(`SELECT id FROM tenants_index WHERE id > ? ORDER BY id LIMIT ?`)
        .bind(cursor, limit)
        .all<{ id: string }>()
    : await env.DB.prepare(`SELECT id FROM tenants_index ORDER BY id LIMIT ?`).bind(limit).all<{ id: string }>();

  let ids = rows.results.map((r) => r.id);
  // The cursor pointed past the last row (every tenant behind it was deleted, or
  // the rotation ended exactly on the boundary). Start the next rotation NOW
  // rather than burning a whole tick on an empty slice.
  if (ids.length === 0 && cursor !== null && total > 0) {
    const restart = await env.DB.prepare(`SELECT id FROM tenants_index ORDER BY id LIMIT ?`).bind(limit).all<{ id: string }>();
    ids = restart.results.map((r) => r.id);
  }

  return { ids, limit, total, complete: ids.length >= total, plannedCoverageTicks: coverageTicks(total, limit) };
}

/**
 * Where the next tick resumes, given how far the LEAST-covered leg actually
 * got.
 *
 * THE MINIMUM IS LOAD-BEARING. The fan-out deadline can stop leg 6 earlier than
 * leg 1, so advancing the cursor to the end of the slice would hand leg 6 a
 * tenant it never swept and never will — coverage would silently become
 * probabilistic. Advancing only as far as every leg reached keeps "each leg
 * visits each tenant once per rotation" true.
 *
 * `null` restarts the rotation. `visitedByEveryLeg` of 0 cannot happen —
 * `sweepTenants` always attempts its first tenant regardless of the deadline,
 * precisely so a tick can never make zero progress and pin the rotation head.
 */
export async function commitSweepCursor(
  env: Env,
  slice: TenantSlice,
  visitedByEveryLeg: number,
  nowMs: number,
): Promise<string | null> {
  const covered = Math.min(visitedByEveryLeg, slice.ids.length);
  // The cursor is the LAST id every leg finished — including when the slice was
  // full, which is the case that matters: `covered === ids.length` means "this
  // page is done", not "the rotation is done". Restarting there would pin the
  // sweep on the first page forever and every tenant past it would never be
  // swept again. Only a pass that covered the WHOLE index has nothing to
  // resume from.
  const complete = slice.complete && covered >= slice.ids.length;

  // ZERO ROTATION PROGRESS HOLDS THE CURSOR; IT DOES NOT WRAP IT.
  //
  // `covered === 0` used to fall into the `null` (restart) branch, and the
  // docstring above called it unreachable — correctly, while every leg's
  // always-attempted index 0 was a ROTATION tenant. The paying-tenant prepend
  // makes it reachable: a tick whose deadline is already spent can cover only
  // priority tenants, and the netted rotation advance is then 0. Restarting
  // there would re-sweep the head every tick and never reach anything else —
  // the pin this file's `covered >= ids.length` comment exists to prevent,
  // arrived at from the other direction.
  //
  // The `updated_at` stamp still happens unconditionally: it is the sweep's
  // freshness tell (`sweepAgeSeconds`), and a tick that made no rotation
  // progress is still a tick that RAN.
  if (covered === 0 && !complete) {
    await env.DB.prepare(
      `INSERT INTO sweep_cursor (id, last_tenant_id, updated_at) VALUES (1, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    )
      .bind(nowMs)
      .run();
    return await readSweepCursor(env);
  }

  const next = complete ? null : (slice.ids[covered - 1] ?? null);
  await env.DB.prepare(
    `INSERT INTO sweep_cursor (id, last_tenant_id, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_tenant_id = excluded.last_tenant_id, updated_at = excluded.updated_at`,
  )
    .bind(next, nowMs)
    .run();
  return next;
}

async function readSweepCursor(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT last_tenant_id FROM sweep_cursor WHERE id = 1`).first<{ last_tenant_id: string | null }>();
  return row?.last_tenant_id ?? null;
}

/**
 * The tenant ids one leg call should iterate: the cron's bounded slice when it
 * was handed one, otherwise a BOUNDED full read.
 *
 * `MAX_TENANT_SCAN` is a cap and caps narrow silently, so every caller of this
 * pairs it with `countTenants` and reports both numbers — see `buildOpsDigest`'s
 * `tenants.scanned` vs `tenants.total`.
 */
export async function resolveSweepTenants(env: Env, scope: SweepScope): Promise<string[]> {
  if (scope.tenantIds) {
    // Priority tenants lead, then the rotating page VERBATIM.
    //
    // The de-duplication drops from the PREPEND, never from the page, and that
    // direction is the whole point: `commitSweepCursor` indexes `slice.ids` by
    // the covered count, so the rotating region has to stay exactly the keyset
    // page the cursor was computed against. Removing a duplicate from the page
    // instead would shift every id after it by one and the cursor would land
    // short. (Idempotent with the same filtering `scheduled.ts` does before it
    // sets `fanout.priorityCount`, which is where the count has to be exact.)
    const page = scope.tenantIds;
    const priority = (scope.priorityTenantIds ?? []).filter((id) => !page.includes(id));
    return priority.length === 0 ? [...page] : [...priority, ...page];
  }
  const result = await env.DB.prepare(`SELECT id FROM tenants_index ORDER BY id LIMIT ?`)
    .bind(MAX_TENANT_SCAN)
    .all<{ id: string }>();
  return result.results.map((r) => r.id);
}

export interface TenantSweepResult {
  /** Tenants this leg actually attempted, from the head of `tenantIds`. */
  visited: number;
  /**
   * Longest CONTIGUOUS PREFIX of `tenantIds` this leg finished — the ONLY
   * number a keyset cursor may advance by.
   *
   * Identical to `visited` in the sequential path, and that is exactly why it
   * needs its own name. `commitSweepCursor` does `slice.ids[covered - 1]`: it
   * indexes the slice by a COUNT, which is sound only while the covered set IS
   * a prefix. Concurrency makes that a live constraint rather than a free one
   * (see `sweepTenants` below), and a single field called "visited" carrying
   * both meanings is how the two get conflated — the same shape as the
   * planned-vs-achieved coverage defect of 2026-08-20.
   */
  prefix: number;
  /** Tenants left for a later tick because the fan-out deadline arrived. NOT a
   * failure — see admin/sweep-signals.ts on why capacity and error must not
   * share a counter. */
  deferred: number;
  /** Tenants whose body threw. */
  errors: number;
}

/**
 * Run `fn` for every tenant in `scope`, isolating each tenant's failure and
 * stopping at the shared fan-out deadline.
 *
 * ONE loop for the six legs that each hand-rolled their own (CLAUDE.md rule c).
 * They had drifted already: every one counted `errors`, none had a deadline, and
 * only the send pipeline distinguished "did not run" from "failed" — which is
 * exactly the conflation the `cron_legs` alert was drowning in.
 *
 * THE FIRST TENANT IS ALWAYS ATTEMPTED, deadline or not. A deadline evaluated
 * before the first item can starve a leg completely, and a starved leg advances
 * no cursor, which pins the rotation on the same head forever — the very
 * head-of-line shape isolated-loop.ts exists to prevent.
 */
export async function sweepTenants(
  tenantIds: readonly string[],
  fanout: SweepDeadline | undefined,
  fn: (tenantId: string) => Promise<void>,
  onError: (tenantId: string, err: unknown) => void,
): Promise<TenantSweepResult> {
  // The concurrency lives on `SweepFanout`, so a leg with its OWN population
  // (which passes `sweepDeadlineOf(...)`) is serial by construction, not by
  // remembering to ask for it.
  const concurrency = fanout && isSweepFanout(fanout) ? fanout.concurrency : 1;
  const priorityCount = fanout && isSweepFanout(fanout) ? Math.min(fanout.priorityCount, tenantIds.length) : 0;
  const result =
    concurrency > 1
      ? await sweepConcurrently(tenantIds, fanout, fn, onError, concurrency, priorityCount)
      : await sweepSerially(tenantIds, fanout, fn, onError, priorityCount);

  // Only a leg iterating THE TENANT SLICE may move the rotation cursor. A leg
  // with its own population passes `sweepDeadlineOf(...)`, which has no
  // accumulator to write into.
  //
  // THE PREFIX, NOT THE COUNT. They are equal serially; concurrently they are
  // not necessarily, and `commitSweepCursor` indexes by this number.
  if (fanout && isSweepFanout(fanout)) {
    // NET OUT THE PRIORITY PREPEND. The cursor indexes the ROTATING page, so a
    // prefix that still counts the paying tenants swept ahead of it would
    // advance the rotation by tenants that are not on that page — skipping
    // exactly `priorityCount` of them, every tick, forever.
    const rotationPrefix = Math.max(0, result.prefix - priorityCount);
    fanout.leastVisited = fanout.leastVisited === null ? rotationPrefix : Math.min(fanout.leastVisited, rotationPrefix);
  }
  return result;
}

/**
 * Indices the deadline may NOT skip.
 *
 * Two guarantees in one predicate:
 *  - index 0 is always attempted, so a leg can never make ZERO progress and pin
 *    the rotation head. That is the pre-existing `i > 0 &&` rule.
 *  - every PRIORITY index is always attempted, and so is the FIRST ROTATION
 *    index (`priorityCount`). Without the second half, a tick whose deadline was
 *    already spent would cover only paying tenants, the netted rotation prefix
 *    would be 0, and `commitSweepCursor` reads a zero advance as "restart the
 *    rotation" — pinning it at the head forever, one tenant short of the exact
 *    failure the `i > 0` rule exists to prevent.
 *
 * The cost is a bounded overrun of at most `PAYING_TENANT_PRIORITY_CAP + 1`
 * tenants past the deadline, on a leg that has 150s of send-pipeline budget
 * behind it.
 */
function mustAttempt(index: number, priorityCount: number): boolean {
  return index <= priorityCount;
}

/** The serial path — the loop that shipped before concurrency existed, kept as
 * its own function rather than as `concurrency === 1` falling through the pool
 * below. The pool at one worker is *semantically* the same loop, but it is not
 * the same code, and "C=1 reproduces today exactly" is a claim worth being
 * literally true rather than argued.
 *
 * The one edit to the original body is the deadline predicate, and it is a
 * rewrite of the same condition: at `priorityCount = 0`,
 * `!mustAttempt(i, 0)` is `!(i <= 0)` is `i > 0` — the original guard,
 * character for character in meaning. */
async function sweepSerially(
  tenantIds: readonly string[],
  fanout: SweepDeadline | undefined,
  fn: (tenantId: string) => Promise<void>,
  onError: (tenantId: string, err: unknown) => void,
  priorityCount: number = 0,
): Promise<TenantSweepResult> {
  const clock = new RealClock();
  let visited = 0;
  let errors = 0;
  let deferred = 0;

  for (let i = 0; i < tenantIds.length; i++) {
    if (!mustAttempt(i, priorityCount) && fanout && clock.now() - fanout.startedAt >= fanout.deadlineMs) {
      deferred = tenantIds.length - i;
      break;
    }
    const tenantId = tenantIds[i] as string;
    try {
      await fn(tenantId);
    } catch (err) {
      // One tenant's failure must never abort the sweep for every other tenant,
      // nor (via runScheduledOpsSweep) every other cron leg.
      errors++;
      onError(tenantId, err);
    }
    visited++;
  }

  // Serially the covered set is a prefix by construction — stated, not assumed,
  // so the two paths return the same shape and the caller never has to know
  // which one ran.
  return { visited, prefix: visited, deferred, errors };
}

/**
 * The bounded-concurrency path: `concurrency` workers pulling from one shared
 * index, sharing the tick's deadline.
 *
 * WHY THIS EXISTS. The fan-out is dispatch-bound, not work-bound — production
 * `wrangler tail` puts DO `cpuTime` at 1-3% of `wallTime`, so the 15s deadline
 * was being spent almost entirely WAITING. Overlapping those waits takes the
 * slice from 3 to 15 against the same deadline, which is the difference between
 * a full rotation every 110 minutes and every 25 (sweep-budget.ts derives it;
 * docs/research/sweep-capacity-measurement-2026-08-24.md measures it).
 *
 * "CLAIM", NOT "ABANDON" — THE ONE DECISION THAT MAKES THIS SAFE. The deadline
 * stops handing out NEW tenants; whatever is already in flight is awaited to
 * completion. Because workers claim indices in ascending order and every
 * claimed index therefore finishes, the covered set is always `{0..k-1}` — a
 * contiguous prefix, which is what `commitSweepCursor` requires.
 *
 * The tighter-looking alternative — race each tenant against the deadline and
 * drop whatever has not returned — is WRONG HERE, and not subtly. One slow
 * tenant at index i abandoned while i+1.. completed leaves a HOLE: the cursor
 * advances past a tenant that was never swept, and since the next tick reads
 * `WHERE id > ?` that tenant is skipped for the entire rotation. It skips
 * precisely the SLOW tenant, i.e. the one most likely to be the sick one this
 * sweep exists to notice. `tenant-slice-concurrency.test.ts` keeps that
 * counterexample executable.
 *
 * The cost of `claim` is that the leg can overrun the deadline by at most one
 * in-flight tenant's round trip. That is bounded and it is the right trade: the
 * fan-out deadline is a scheduling target with 150s of send-pipeline budget
 * behind it, whereas a rotation hole is silent data loss.
 */
async function sweepConcurrently(
  tenantIds: readonly string[],
  fanout: SweepDeadline | undefined,
  fn: (tenantId: string) => Promise<void>,
  onError: (tenantId: string, err: unknown) => void,
  concurrency: number,
  priorityCount: number = 0,
): Promise<TenantSweepResult> {
  const clock = new RealClock();
  const n = tenantIds.length;
  const done = new Array<boolean>(n).fill(false);
  let next = 0;
  let visited = 0;
  let errors = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= n) return;
      // THE SHIPPED GUARD, unchanged in meaning: index 0 is always attempted,
      // so a leg can never make zero progress and pin the rotation head.
      if (!mustAttempt(index, priorityCount) && fanout && clock.now() - fanout.startedAt >= fanout.deadlineMs) {
        next = n; // stop every OTHER worker from claiming as well
        return;
      }
      next = index + 1;
      const tenantId = tenantIds[index] as string;
      try {
        await fn(tenantId);
      } catch (err) {
        errors++;
        onError(tenantId, err);
      }
      // An errored tenant still counts as covered, exactly as it does serially:
      // it was reached, the failure is reported through `errors` / `cron_legs`,
      // and leaving a hole here would strand it for a whole rotation.
      done[index] = true;
      visited++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, n)) }, () => worker()));

  let prefix = 0;
  while (prefix < n && done[prefix]) prefix++;
  return { visited, prefix, deferred: n - visited, errors };
}
