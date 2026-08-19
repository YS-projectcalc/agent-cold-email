import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { NextStep } from "@coldstart/shared";
import type { TenantDO } from "../src/tenant-do.js";
import { realNowMs } from "../src/engine/clamped-age.js";
import { deriveNextSteps } from "../src/engine/next-steps.js";
import { activatePaidPlan, mintTenant, postWebhook, tenantStub, withTenantContext } from "./helpers.js";
import { checkoutSessionCompleted } from "./stripe-fixtures.js";

// I11 — `first_paid_at` (design §7.10.1, §7.17.4, §7.19). `addColumnIfMissing`
// cannot compute, so a backfill is required on the `grandfatherActiveScreening`
// precedent (self-applying, guarded on "already set -> return"), and — per the
// wave-level clock rule (§7.19) — the derived value MUST be clamped to real
// wall-clock: `checkout.session.completed` is processed under `ctx.clock`,
// which is a VirtualClock (up to 1440x accelerated) for any tenant that was on
// the demo/free plan at the moment it paid.
//
// "A genuine DO reconstruction isn't reliably triggerable from a test"
// (screening-grandfather.test.ts) — same idiom: call the private method
// directly on the live instance.
interface TenantDOWithBackfill {
  backfillFirstPaidAt(): void;
}

function firstPaidAt(tenantId: string): Promise<number | null> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql.exec<{ first_paid_at: number | null }>(`SELECT first_paid_at FROM tenant_profile WHERE id = ?`, ctx.tenantId).one()
      .first_paid_at,
  );
}

describe("backfillFirstPaidAt — the one-shot UPDATE, on the grandfatherActiveScreening precedent", () => {
  it("derives from the earliest checkout.session.completed webhook_events row, when NULL", async () => {
    const { tenantId } = await mintTenant("Backfill Pilot Co", "managed");
    // A real checkout, so a real webhook_events row exists — then simulate "a
    // row that predates this wave's go-forward wiring" by resetting the
    // column back to NULL, exactly as the grandfather test resets its columns.
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET first_paid_at = NULL WHERE id = ?`, tenantId);
    });
    const expected = await withTenantContext(tenantId, (ctx) =>
      ctx.sql.exec<{ ts: number }>(`SELECT MIN(ts) as ts FROM webhook_events WHERE type = 'checkout.session.completed'`).one().ts,
    );

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      (instance as unknown as TenantDOWithBackfill).backfillFirstPaidAt();
    });

    expect(await firstPaidAt(tenantId)).toBe(expected);
  });

  it("clamps a FUTURE-dated (virtual-clock) webhook row to real now, never the raw future value", async () => {
    const { tenantId } = await mintTenant("Backfill Future Co", "demo");
    const future = realNowMs() + 30 * 24 * 60 * 60 * 1000; // 30 real days ahead — a 1440x VirtualClock stamp
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `INSERT INTO webhook_events (event_id, type, ts) VALUES (?, 'checkout.session.completed', ?)`,
        `evt_future_${tenantId}`,
        future,
      );
    });

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      (instance as unknown as TenantDOWithBackfill).backfillFirstPaidAt();
    });

    const stamped = await firstPaidAt(tenantId);
    expect(stamped).not.toBeNull();
    expect(stamped as number).toBeLessThan(future);
    expect(stamped as number).toBeLessThanOrEqual(realNowMs());
    expect(stamped as number).toBeGreaterThan(realNowMs() - 60_000); // clamped to "now", not some other value
  });

  it("stays NULL when no checkout.session.completed row exists — never-paid population", async () => {
    const { tenantId } = await mintTenant("Backfill Never Paid Co", "demo");
    await runInDurableObject(tenantStub(tenantId), (instance) => {
      (instance as unknown as TenantDOWithBackfill).backfillFirstPaidAt();
    });
    expect(await firstPaidAt(tenantId)).toBeNull();
  });

  it("never re-stamps once first_paid_at is already set", async () => {
    const { tenantId } = await mintTenant("Backfill Already Set Co", "managed");
    const sentinel = 1_700_000_000_000;
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(`UPDATE tenant_profile SET first_paid_at = ? WHERE id = ?`, sentinel, tenantId);
      // An EARLIER row that would win MIN() if the guard were missing.
      state.storage.sql.exec(
        `INSERT INTO webhook_events (event_id, type, ts) VALUES (?, 'checkout.session.completed', ?)`,
        `evt_earlier_${tenantId}`,
        1_000_000_000_000,
      );
    });

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      (instance as unknown as TenantDOWithBackfill).backfillFirstPaidAt();
    });

    expect(await firstPaidAt(tenantId)).toBe(sentinel);
  });
});

describe("go-forward — checkout.session.completed stamps first_paid_at, clamped, once", () => {
  it("a live checkout webhook stamps first_paid_at when NULL", async () => {
    const { tenantId } = await mintTenant("Go Forward Co", "demo");
    expect(await firstPaidAt(tenantId)).toBeNull();

    await activatePaidPlan(tenantId, "managed");

    const stamped = await firstPaidAt(tenantId);
    expect(stamped).not.toBeNull();
    expect(stamped as number).toBeLessThanOrEqual(realNowMs());
  });

  it("a SECOND checkout does not move an already-stamped first_paid_at", async () => {
    const { tenantId } = await mintTenant("Go Forward Twice Co", "demo");
    await activatePaidPlan(tenantId, "managed");
    const first = await firstPaidAt(tenantId);
    expect(first).not.toBeNull();

    // A later, distinct checkout event for the same tenant (e.g. a plan change).
    await postWebhook(checkoutSessionCompleted({ tenantId, plan: "managed", subscriptionId: `sub_second_${tenantId}` }));

    expect(await firstPaidAt(tenantId)).toBe(first);
  });
});

describe("I11 — paid_seats_unprovisioned gets an honest sinceMs from first_paid_at", () => {
  it("a paying, nothing-provisioned tenant's owed step carries a real, non-null sinceMs", async () => {
    const { tenantId } = await mintTenant("Sincems Co", "demo");
    await activatePaidPlan(tenantId, "managed");
    await runInDurableObject(tenantStub(tenantId), async (_i, state) => {
      state.storage.sql.exec(
        `UPDATE tenant_profile SET mailbox_qty_synced = 5, register_domains = 1, physical_address = 'x', sender_identity = 'y', primary_domain = 'z.com' WHERE id = ?`,
        tenantId,
      );
    });

    const derived = await withTenantContext(tenantId, (ctx) => deriveNextSteps(ctx));
    const step = derived.steps.find((s) => s.reason === "paid_seats_unprovisioned") as NextStep | undefined;
    expect(step).toBeDefined();
    expect(step?.sinceMs).not.toBeNull();
    expect(step?.sinceMs as number).toBeGreaterThanOrEqual(0);
    expect(step?.sinceMs as number).toBeLessThan(60_000); // stamped moments ago in this test
  });
});
