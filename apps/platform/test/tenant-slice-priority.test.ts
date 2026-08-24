import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env.js";
import { isPaidPlan } from "@coldstart/shared";
import type { TenantPlan } from "@coldstart/shared";
import { insertTenantIndex } from "../src/db.js";
import {
  commitSweepCursor,
  isPriorityPlan,
  newSweepFanout,
  readPriorityTenantIds,
  readTenantSlice,
  resolveSweepTenants,
  sweepTenants,
  type SweepScope,
} from "../src/admin/tenant-slice.js";
import { RealClock } from "../src/clock.js";
import {
  ASSUMED_DO_RPC_MS,
  CRON_PERIOD_MS,
  mustAttemptOverrunMs,
  mustAttemptTenants,
  PAYING_TENANT_PRIORITY_CAP,
  PRE_LANE_MUST_ATTEMPT_OVERRUN_MS,
  priorityWindowSize,
  SEND_PIPELINE_LEG_DEADLINE_MS,
  SEND_PIPELINE_TENANT_BUDGET_MS,
  SWEEP_FANOUT_CONCURRENCY,
  SWEEP_FANOUT_CONCURRENCY_MAX,
  SWEEP_FANOUT_DEADLINE_MS,
  sweepTenantSliceFor,
} from "../src/admin/sweep-budget.js";

// PAYING-TENANT-FIRST (lane feat/sweep-capacity-2026-08-24).
//
// Paying tenants are swept EVERY tick; everyone else waits their turn in the
// keyset rotation. The obvious implementation — sort the slice by plan — is
// unavailable: `commitSweepCursor` advances a KEYSET cursor with
// `slice.ids[covered - 1]`, which only means anything while the page is in `id`
// order. So the paying tenants are PREPENDED and `SweepFanout.priorityCount`
// nets them back out of the rotation accumulator.
//
// Two things can go silently wrong and both are pinned below: the cursor
// advancing by tenants that are not on its page (skipping `priorityCount`
// tenants per tick, forever), and a spent deadline covering only paying tenants
// so the netted advance is 0 — which `commitSweepCursor` reads as "restart",
// pinning the rotation at the head.

const ALL_PLANS: TenantPlan[] = ["demo", "free", "managed"];

async function seed(id: string, plan: TenantPlan, status = "active"): Promise<void> {
  await insertTenantIndex(env as Env, {
    id,
    apiTokenHash: `prio-hash-${id}`,
    brand: `Prio ${id}`,
    plan,
    createdAt: 1_800_000_000_000,
    contactEmail: null,
  });
  if (status !== "active") await env.DB.prepare(`UPDATE tenants_index SET status = ? WHERE id = ?`).bind(status, id).run();
}

describe("who counts as a priority tenant", () => {
  it("the SQL predicate and isPaidPlan agree on every plan there is", () => {
    // The read is `plan = 'managed'` in SQL because a predicate cannot cross
    // into D1. A divergence would either starve a paying tenant of its priority
    // or hand priority to everyone — this is the only thing holding them together.
    for (const plan of ALL_PLANS) {
      expect(isPriorityPlan(plan), `plan=${plan}`).toBe(isPaidPlan(plan));
    }
    // Positive control: the two functions must not agree by both being constant.
    expect(ALL_PLANS.filter(isPaidPlan).length).toBeGreaterThan(0);
    expect(ALL_PLANS.filter((p) => !isPaidPlan(p)).length).toBeGreaterThan(0);
  });

  it("reads only ACTIVE paying tenants, bounded by the cap", async () => {
    await env.DB.prepare(`DELETE FROM tenants_index`).run();
    await seed("ten_pri_pay_a", "managed");
    await seed("ten_pri_pay_b", "managed");
    await seed("ten_pri_free", "free");
    await seed("ten_pri_demo", "demo");
    await seed("ten_pri_susp", "managed", "suspended");

    const ids = await readPriorityTenantIds(env as Env);
    expect(ids).toEqual(["ten_pri_pay_a", "ten_pri_pay_b"]);

    // The cap binds, and it binds at the cap rather than at some other number.
    for (let i = 0; i < PAYING_TENANT_PRIORITY_CAP + 3; i++) await seed(`ten_pri_bulk_${String(i).padStart(2, "0")}`, "managed");
    expect((await readPriorityTenantIds(env as Env)).length).toBe(PAYING_TENANT_PRIORITY_CAP);
    expect((await readPriorityTenantIds(env as Env, 2)).length).toBe(2);
  });
});

describe("the prepend must not disturb the keyset page the cursor indexes", () => {
  it("de-duplicates from the PREPEND, never from the page", async () => {
    // A paying tenant that already sits on this tick's page. Dropping it from
    // the PAGE would shift every id after it by one and the cursor would land
    // short of where the sweep actually got.
    const scope: SweepScope = { tenantIds: ["b", "c", "d"], priorityTenantIds: ["a", "c"] };
    const resolved = await resolveSweepTenants(env as Env, scope);
    expect(resolved).toEqual(["a", "b", "c", "d"]);
    // The rotating region is the page, verbatim and in order.
    expect(resolved.slice(1)).toEqual(["b", "c", "d"]);
  });

  it("nets the prepend out of the rotation advance", async () => {
    const page = ["r1", "r2", "r3", "r4"];
    const priority = ["p1", "p2"];
    const fanout = newSweepFanout(new RealClock().now(), 60_000, 6, priority.length);
    const combined = await resolveSweepTenants(env as Env, { tenantIds: page, priorityTenantIds: priority, fanout });
    const result = await sweepTenants(combined, fanout, async () => {}, () => {});

    expect(result.prefix).toBe(6); // everything
    // ...but the ROTATION only advanced by the four page tenants. Feeding 6 to
    // `commitSweepCursor` would index two tenants past the end of the page.
    expect(fanout.leastVisited).toBe(page.length);
  });

  it("EFFECT — with priority active, a full rotation still reaches every tenant and skips none", async () => {
    await env.DB.prepare(`DELETE FROM tenants_index`).run();
    await env.DB.prepare(`DELETE FROM sweep_cursor`).run();
    const paying = ["ten_rp_pay_0", "ten_rp_pay_1"];
    for (const id of paying) await seed(id, "managed");
    const rotating: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `ten_rp_free_${String(i).padStart(2, "0")}`;
      rotating.push(id);
      await seed(id, "free");
    }

    const covered = new Map<string, number>();
    const limit = 3; // small, so the rotation takes many ticks and holes would show
    let ticks = 0;
    while (ticks < 60 && rotating.some((id) => !covered.has(id))) {
      ticks++;
      const priorityAll = await readPriorityTenantIds(env as Env);
      const slice = await readTenantSlice(env as Env, limit);
      const priorityIds = priorityAll.filter((id) => !slice.ids.includes(id));
      const fanout = newSweepFanout(new RealClock().now(), 60_000, 6, priorityIds.length);
      const combined = await resolveSweepTenants(env as Env, { tenantIds: slice.ids, priorityTenantIds: priorityIds, fanout });
      await sweepTenants(combined, fanout, async (id) => void covered.set(id, (covered.get(id) ?? 0) + 1), () => {});
      await commitSweepCursor(env as Env, slice, fanout.leastVisited ?? slice.ids.length, Date.now());
    }

    // NOBODY IS SKIPPED. This is the union-of-ids assertion, not a shape check
    // on the cursor — a shape check would have agreed with the bug.
    for (const id of [...paying, ...rotating]) expect(covered.has(id), `never swept: ${id}`).toBe(true);
    // ...and the paying tenants were swept on EVERY tick, which is the feature.
    for (const id of paying) expect(covered.get(id), `${id} should be swept every tick`).toBe(ticks);
    // ...while a rotating tenant was swept far less often. Positive control: if
    // the rotation had collapsed to "everyone every tick" the line above would
    // pass vacuously.
    expect(Math.max(...rotating.map((id) => covered.get(id) ?? 0))).toBeLessThan(ticks);
    expect(ticks).toBeGreaterThan(1);
  });
});

describe("a spent deadline must still move the rotation", () => {
  it("covers the whole priority block AND the first rotation tenant", async () => {
    for (const concurrency of [1, 6]) {
      const page = ["z1", "z2", "z3"];
      const priority = ["y1", "y2"];
      // Deadline already gone: without the priority-aware rule the netted
      // advance would be 0, and `commitSweepCursor` reads 0 as "restart" —
      // pinning the rotation at its head on every tick, forever.
      const fanout = newSweepFanout(new RealClock().now() - 60_000, 1_000, concurrency, priority.length);
      const combined = await resolveSweepTenants(env as Env, { tenantIds: page, priorityTenantIds: priority, fanout });
      const swept: string[] = [];
      await sweepTenants(combined, fanout, async (id) => void swept.push(id), () => {});
      expect(swept.sort(), `C=${concurrency}`).toEqual(["y1", "y2", "z1"]);
      expect(fanout.leastVisited, `C=${concurrency}`).toBe(1);
    }
  });

  it("with no priority tenants the rule is exactly the old `i > 0` guard", async () => {
    const fanout = newSweepFanout(new RealClock().now() - 60_000, 1_000, 1, 0);
    const result = await sweepTenants(["a", "b", "c"], fanout, async () => {}, () => {});
    expect(result.visited).toBe(1);
    expect(fanout.leastVisited).toBe(1);
  });
});

describe("the priority pass reallocates the tick rather than enlarging it", () => {
  it("shortens the rotating slice by exactly the ACTUAL priority count", () => {
    const base = sweepTenantSliceFor(6, 0);
    expect(sweepTenantSliceFor(6, 1)).toBe(base - 1);
    expect(sweepTenantSliceFor(6, PAYING_TENANT_PRIORITY_CAP)).toBe(base - PAYING_TENANT_PRIORITY_CAP);
    // Never by more than the cap, however many paying tenants exist.
    expect(sweepTenantSliceFor(6, 500)).toBe(base - PAYING_TENANT_PRIORITY_CAP);
    // ...and never below one: a platform of nothing but paying tenants still
    // rotates, it just rotates slowly.
    expect(sweepTenantSliceFor(1, PAYING_TENANT_PRIORITY_CAP)).toBeGreaterThanOrEqual(1);
  });
});


// ── GATE ROUND 2026-08-24 ────────────────────────────────────────────────────

describe("NB-8 — the priority window ROTATES, so no paying tenant is starved of it", () => {
  it("every paying tenant gets the window across ceil(n/window) ticks", async () => {
    await env.DB.prepare(`DELETE FROM tenants_index`).run();
    const paying: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `ten_rot_pay_${String(i).padStart(2, "0")}`;
      paying.push(id);
      await seed(id, "managed");
    }
    const window = 3;
    const seen = new Set<string>();
    // The rotation is CYCLE-derived, so the clock is pinned rather than left to
    // the wall — an unpinned one makes this a periodic flake, not a test.
    for (let cycle = 0; cycle < Math.ceil(paying.length / window); cycle++) {
      const ids = await readPriorityTenantIds(env as Env, window, cycle * CRON_PERIOD_MS);
      expect(ids.length).toBe(window);
      for (const id of ids) seen.add(id);
    }
    // THE DEFECT THIS REPLACES: `ORDER BY id LIMIT n` returned the same lowest-n
    // ids on every tick, so ids 3..7 here would never appear at all.
    for (const id of paying) expect(seen.has(id), `never got the priority window: ${id}`).toBe(true);
  });

  it("a window as large as the paying population is stable (no pointless churn)", async () => {
    await env.DB.prepare(`DELETE FROM tenants_index`).run();
    await seed("ten_small_a", "managed");
    await seed("ten_small_b", "managed");
    const first = await readPriorityTenantIds(env as Env, 5, 0);
    const later = await readPriorityTenantIds(env as Env, 5, 7 * CRON_PERIOD_MS);
    expect(first).toEqual(["ten_small_a", "ten_small_b"]);
    expect(later).toEqual(first);
  });
});

describe("NB-6 — the must-attempt overrun is bounded and does not scale with the paying population", () => {
  it("the priority window is clamped to the concurrency", () => {
    // At the rollback lever the prepend is SERIAL, so an unclamped window of 5
    // would be 6 x 450ms x 7 legs = 18.9s past a deadline that has no slack.
    expect(priorityWindowSize(1)).toBe(1);
    expect(priorityWindowSize(6)).toBe(PAYING_TENANT_PRIORITY_CAP);
    expect(priorityWindowSize(SWEEP_FANOUT_CONCURRENCY_MAX)).toBe(PAYING_TENANT_PRIORITY_CAP);
  });

  it("at C=1 with FIVE paying tenants the tick still only pre-attempts two", async () => {
    await env.DB.prepare(`DELETE FROM tenants_index`).run();
    for (let i = 0; i < 5; i++) await seed(`ten_c1_pay_${i}`, "managed");
    const ids = await readPriorityTenantIds(env as Env, priorityWindowSize(1), 0);
    expect(ids.length).toBe(1);
    expect(mustAttemptTenants(1)).toBe(2);
    // ...and the overrun is two round trips per leg, NOT six.
    expect(mustAttemptOverrunMs(1)).toBe(2 * ASSUMED_DO_RPC_MS * 7);
    expect(mustAttemptOverrunMs(1)).toBeLessThan(7_000);
  });

  it("at the SHIPPED concurrency this lane adds ZERO overrun over the pre-existing rule", () => {
    // The whole must-attempt set is one round trip when it runs concurrently, so
    // it costs exactly what "always attempt index 0" already cost before this
    // lane existed. That is the claim that matters for S6, which has no slack.
    expect(mustAttemptOverrunMs(SWEEP_FANOUT_CONCURRENCY)).toBe(PRE_LANE_MUST_ATTEMPT_OVERRUN_MS);
    // And across the whole supported range it never exceeds twice the baseline.
    for (let c = 1; c <= SWEEP_FANOUT_CONCURRENCY_MAX; c++) {
      expect(mustAttemptOverrunMs(c), `C=${c}`).toBeLessThanOrEqual(2 * PRE_LANE_MUST_ATTEMPT_OVERRUN_MS);
    }
  });

  it("states the composed period cost honestly instead of hiding it", () => {
    // S6's derivation leaves ZERO slack: deadline + pipeline bounds == period
    // exactly. The must-attempt overrun therefore lands OUTSIDE the period, and
    // it did before this lane too. Asserted so the number is a fact on the
    // record rather than an unpleasant surprise at 300 tenants.
    const composed = SWEEP_FANOUT_DEADLINE_MS + mustAttemptOverrunMs(SWEEP_FANOUT_CONCURRENCY) + SEND_PIPELINE_LEG_DEADLINE_MS + SEND_PIPELINE_TENANT_BUDGET_MS;
    expect(composed).toBeGreaterThan(CRON_PERIOD_MS); // pre-existing, not new
    expect(composed - CRON_PERIOD_MS).toBe(PRE_LANE_MUST_ATTEMPT_OVERRUN_MS);
  });
});

describe("NB-6 — zero rotation progress HOLDS the cursor, it does not wrap it", () => {
  it("a tick that covered only priority tenants leaves the cursor where it was", async () => {
    await env.DB.prepare(`DELETE FROM tenants_index`).run();
    await env.DB.prepare(`DELETE FROM sweep_cursor`).run();
    for (let i = 0; i < 6; i++) await seed(`ten_hold_${String(i).padStart(2, "0")}`, "free");

    // Advance the cursor normally first, so "held" is distinguishable from "unset".
    const first = await readTenantSlice(env as Env, 2);
    const fanout1 = newSweepFanout(new RealClock().now(), 60_000, 6, 0);
    await sweepTenants(first.ids, fanout1, async () => {}, () => {});
    const advanced = await commitSweepCursor(env as Env, first, fanout1.leastVisited ?? 0, Date.now());
    expect(advanced).toBe(first.ids[1]);

    // Now a tick whose netted rotation advance is 0.
    const second = await readTenantSlice(env as Env, 2);
    const held = await commitSweepCursor(env as Env, second, 0, Date.now() + 1);
    // NOT null (which is "restart at the head" — it would re-sweep the head
    // forever and never reach anything else).
    expect(held).toBe(advanced);
    const row = await env.DB.prepare(`SELECT last_tenant_id, updated_at FROM sweep_cursor WHERE id = 1`).first<{
      last_tenant_id: string | null;
      updated_at: number;
    }>();
    expect(row?.last_tenant_id).toBe(advanced);
    // ...and the freshness stamp still moved: a tick that made no rotation
    // progress is still a tick that RAN, and `sweepAgeSeconds` reads this.
    expect(row!.updated_at).toBeGreaterThan(0);
  });
});
