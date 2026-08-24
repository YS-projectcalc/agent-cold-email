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
import { PAYING_TENANT_PRIORITY_CAP, sweepTenantSliceFor } from "../src/admin/sweep-budget.js";

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
