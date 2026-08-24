import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/env.js";
import { runScheduledOpsSweep } from "../src/scheduled.js";
import { readTenantSlice } from "../src/admin/tenant-slice.js";
import { watchtowerStub } from "../src/admin/watchtower-infra.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { insertTenantIndex } from "../src/db.js";
import { SEND_PIPELINE_SUBREQUESTS, SWEEP_RPCS_PER_TENANT, SWEEP_TICK_SUBREQUESTS } from "../src/admin/sweep-budget.js";
import { newId } from "../src/schema.js";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw";
import { seedBenignSdnList } from "./helpers.js";

// SCALE AUDIT S1 — MEASURED, the way the audit measured it.
//
// The audit wrapped `env.TENANT` in a counting proxy and drove the real
// `runScheduledOpsSweep` at 5 / 20 / 50 / 100 / 200 seeded tenants. The slope
// was exactly 8.0 DO RPCs per tenant: `subrequests(N) ~= 8N + 29`, crossing
// 1,000 at N = 122. Above that the invocation's subrequest budget runs out
// mid-sweep, `runLeg` swallows every remaining leg's instant throw, and the
// LAST leg — the dead-man heartbeat, last precisely because it means "this tick
// ran to completion" — never runs. `WatchtowerDO.alarm()` then grades the cron
// STOPPED and pages the founder about a cron that is running fine.
//
// This file measures the SAME quantity on the fixed code and asserts the
// property that removes the ceiling: the count does not grow with the tenant
// count. It reds on the old code, where doubling the tenants doubles the RPCs.
//
// The slice is shrunk via the `sliceLimit` seam so the property can be asserted
// at a tenant count a test can seed, rather than at the shipped 49.

const SLICE = 4;

/** Counts `get()` (one per leg per tenant) and every RPC method called on the
 * stub, SPLIT by whether the call belongs to the tenant-slice fan-out or to the
 * send pipeline. The two are bounded by different things since 2026-08-24 (see
 * the S1 test below), so a single total can no longer state either property. */
const SEND_PIPELINE_METHODS = new Set(["runScheduledPoll", "runScheduledTick"]);

function countingEnv(counter: { gets: number; rpcs: number; fanoutRpcs: number; sendPipelineRpcs: number }): Env {
  const real = env.TENANT;
  const namespace = {
    idFromName: (name: string) => real.idFromName(name),
    get: (id: DurableObjectId) => {
      counter.gets++;
      const stub = real.get(id) as unknown as Record<string, unknown>;
      return new Proxy(stub, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            counter.rpcs++;
            if (SEND_PIPELINE_METHODS.has(String(prop))) counter.sendPipelineRpcs++;
            else counter.fanoutRpcs++;
            return (target[prop as string] as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
    },
  };
  return { ...env, TENANT: namespace } as unknown as Env;
}

/** Index rows only — the sweep's fan-out is driven by `tenants_index`, and a
 * tenant that has never signed up still costs the RPC, which is the quantity
 * under test. */
async function seedTenantIndexRows(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await insertTenantIndex(env, {
      id: newId("ten"),
      apiTokenHash: `scale-hash-${newId("h")}`,
      brand: `Scale ${i}`,
      plan: "free",
      createdAt: 1_800_000_000_000,
      contactEmail: null,
    });
  }
}

async function sweepWithCounter(sliceLimit: number): Promise<{ gets: number; rpcs: number; fanoutRpcs: number; sendPipelineRpcs: number }> {
  const counter = { gets: 0, rpcs: 0, fanoutRpcs: 0, sendPipelineRpcs: 0 };
  await runScheduledOpsSweep(countingEnv(counter), { mailer: new SandboxOpsMailer(), sliceLimit });
  return counter;
}

describe("S1 — the per-tick DO fan-out no longer grows with the tenant count", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tenants_index").run();
    await env.DB.prepare("DELETE FROM watchtower_state").run();
    await env.DB.prepare("DELETE FROM watchtower_cursor").run();
    await env.DB.prepare("DELETE FROM sweep_cursor").run();
    await runInDurableObject(watchtowerStub(env), async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
    await seedBenignSdnList();
    // The SDN refresh leg fetches; never touch the network from a test.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sdnValidCsv, { status: 200 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("doubling the tenant count does not change the FAN-OUT's DO RPC count", async () => {
    await seedTenantIndexRows(SLICE * 2);
    const small = await sweepWithCounter(SLICE);

    await seedTenantIndexRows(SLICE * 2);
    const doubled = await sweepWithCounter(SLICE);

    vi.restoreAllMocks();

    // ⚠️ SPLIT ON 2026-08-24, and the split is the honest statement of what
    // changed. This used to assert the WHOLE tick's DO count was invariant in N.
    // The send pipeline moved OFF the tenant slice that day — deliberately: the
    // cron used to hand it the fan-out's slice, which throttled automatic
    // sending to whatever the HEALTH legs could afford in 15 seconds (three
    // tenants of sixty-six). It now runs to its own leg deadline, its own
    // rotation and its own count cap, so its DO calls DO grow with N until that
    // cap. Asserting a single invariant total would now be false, and relaxing
    // it to an inequality would have quietly dropped the S1 property for the
    // fan-out as well. Two properties, stated separately:
    //
    //   (a) THE FAN-OUT is invariant in N — the original S1 claim, undamaged.
    expect(
      { gets: doubled.fanoutRpcs, rpcs: doubled.fanoutRpcs },
      "the tenant-slice fan-out grew with the tenant count — that is S1 regressing",
    ).toEqual({ gets: small.fanoutRpcs, rpcs: small.fanoutRpcs });
    expect(small.fanoutRpcs).toBeLessThanOrEqual(SLICE * SWEEP_RPCS_PER_TENANT);
    expect(small.fanoutRpcs).toBeGreaterThan(0); // the proxy is really being used

    //   (b) THE WHOLE TICK is bounded by a constant — a larger one, declared.
    //       This is what stops the send pipeline's own fan-out from being the
    //       unpriced leg B1 was about.
    expect(doubled.rpcs).toBeLessThanOrEqual(SWEEP_TICK_SUBREQUESTS);
    expect(doubled.sendPipelineRpcs).toBeLessThanOrEqual(SEND_PIPELINE_SUBREQUESTS);

    //   (c) ...and the send pipeline really is reaching more tenants than the
    //       slice now, or (a) would be passing because nothing ran.
    expect(doubled.sendPipelineRpcs).toBeGreaterThan(small.sendPipelineRpcs);
  }, 60_000);

  it("the dead-man heartbeat still runs — the leg the fan-out used to starve", async () => {
    await seedTenantIndexRows(SLICE * 3);
    await runScheduledOpsSweep(env, { mailer: new SandboxOpsMailer(), sliceLimit: SLICE });
    vi.restoreAllMocks();

    const heartbeat = await runInDurableObject(watchtowerStub(env), (_instance, state) =>
      state.storage.get<number>("sweep_heartbeat_ts"),
    );
    expect(typeof heartbeat).toBe("number");
  }, 60_000);

  // W-M4's WIRING, asserted against the real entry point rather than the
  // function. A check whose only caller is one a test invokes directly is 100%
  // green and 100% dead; `sweep_signals` exists specifically because the leg it
  // reports on runs in production and nothing observed it there.
  it("the real cron tick reports the alerting leg's OWN health (W-M4 wiring)", async () => {
    await seedTenantIndexRows(SLICE);
    await runScheduledOpsSweep(env, { mailer: new SandboxOpsMailer(), sliceLimit: SLICE });
    vi.restoreAllMocks();

    const row = await env.DB.prepare(`SELECT status FROM watchtower_state WHERE check_name = 'sweep_signals'`).first<{ status: string }>();
    expect(row?.status).toBe("healthy");
    // And the cursor leg really committed, so the rotation is driven by
    // production and not only by readTenantSlice's own tests.
    const cursor = await env.DB.prepare(`SELECT id FROM sweep_cursor WHERE id = 1`).first();
    expect(cursor).not.toBeNull();
  }, 60_000);

  it("rotates: consecutive ticks sweep DIFFERENT tenants and eventually cover them all", async () => {
    await seedTenantIndexRows(SLICE * 3);
    const seen = new Set<string>();
    for (let tick = 0; tick < 3; tick++) {
      const slice = await readTenantSlice(env, SLICE);
      expect(slice.ids.length).toBe(SLICE);
      expect(slice.total).toBe(SLICE * 3);
      expect(slice.complete).toBe(false);
      expect(slice.plannedCoverageTicks).toBe(3);
      for (const id of slice.ids) seen.add(id);
      await runScheduledOpsSweep(env, { mailer: new SandboxOpsMailer(), sliceLimit: SLICE });
    }
    vi.restoreAllMocks();

    // Every tenant reached within `plannedCoverageTicks` ticks — the fairness property
    // a bounded sweep owes in exchange for not reaching everyone every tick.
    expect(seen.size).toBe(SLICE * 3);
  }, 60_000);

  it("a tenant count inside one slice is swept COMPLETE, exactly as before", async () => {
    await seedTenantIndexRows(SLICE - 1);
    const slice = await readTenantSlice(env, SLICE);
    vi.restoreAllMocks();
    expect(slice.complete).toBe(true);
    expect(slice.plannedCoverageTicks).toBe(1);
  });
});
