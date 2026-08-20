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
// tenant across `coverageTicks(total, slice)` ticks instead of every tick. That
// is a real degradation of detection latency and it is reported
// (`admin/sweep-signals.ts`'s coverage check + GET /admin/ops/checks), because a
// bound whose latency nobody publishes is the same blind spot pointing the
// other way.
//
// KEYSET, NOT OFFSET. `WHERE id > ? ORDER BY id LIMIT ?` bounds the D1 read
// itself (the old `SELECT id FROM tenants_index` had no LIMIT, so the whole
// index landed in Worker memory every leg, every tick) and cannot skip or
// duplicate a row when tenants are inserted mid-rotation, which an OFFSET page
// can.

import type { Env } from "../env.js";
import { RealClock } from "../clock.js";
import { coverageTicks, SWEEP_TENANT_SLICE } from "./sweep-budget.js";

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
}

export function newSweepFanout(startedAt: number, deadlineMs: number): SweepFanout {
  return { startedAt, deadlineMs, leastVisited: null };
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
}

export interface TenantSlice {
  /** The tenants this tick may touch, in `id` order. */
  ids: string[];
  /** EVERY tenant in the index — the denominator, so a partial pass can say so. */
  total: number;
  /** True iff `ids` is the whole index (nothing was left for a later tick). */
  complete: boolean;
  /** Ticks a full rotation takes at this tenant count. */
  coverageTicks: number;
}

/** Rows a single on-demand (non-cron) fan-out may read. The audit's S8: the
 * cross-tenant reads had no cap at all. This is a bound with a DENOMINATOR
 * beside it (`countTenants`), never a silent narrowing. */
export const MAX_TENANT_SCAN = 5_000;

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

  return { ids, total, complete: ids.length >= total, coverageTicks: coverageTicks(total, limit) };
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
  const next = covered === 0 || complete ? null : (slice.ids[covered - 1] ?? null);
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
  if (scope.tenantIds) return [...scope.tenantIds];
  const result = await env.DB.prepare(`SELECT id FROM tenants_index ORDER BY id LIMIT ?`)
    .bind(MAX_TENANT_SCAN)
    .all<{ id: string }>();
  return result.results.map((r) => r.id);
}

export interface TenantSweepResult {
  /** Tenants this leg actually attempted, from the head of `tenantIds`. */
  visited: number;
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
  const clock = new RealClock();
  let visited = 0;
  let errors = 0;
  let deferred = 0;

  for (let i = 0; i < tenantIds.length; i++) {
    if (i > 0 && fanout && clock.now() - fanout.startedAt >= fanout.deadlineMs) {
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

  // Only a leg iterating THE TENANT SLICE may move the rotation cursor. A leg
  // with its own population passes `sweepDeadlineOf(...)`, which has no
  // accumulator to write into.
  if (fanout && isSweepFanout(fanout)) {
    fanout.leastVisited = fanout.leastVisited === null ? visited : Math.min(fanout.leastVisited, visited);
  }
  return { visited, deferred, errors };
}
