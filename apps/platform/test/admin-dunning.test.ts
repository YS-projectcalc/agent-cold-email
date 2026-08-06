import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { activatePaidPlan, adminApi, failPayment, mintTenant, postWebhook, seedBenignSdnList, tenantStub } from "./helpers.js";
import { subscriptionUpdated } from "./stripe-fixtures.js";

interface DunningSweepResponse {
  scannedTenants: number;
  pastDueTenants: number;
  results: { tenantId: string; cycle: number; action: string; applied: boolean }[];
}

// D2 (brief) — the required test cases: "a past_due tenant produces a
// dunning action; idempotent within a cycle; a current tenant produces none."
describe("POST /admin/ops/dunning-sweep — D2 dunning / failed-payment sweep", () => {
  it("a past_due tenant produces a dunning action ('retry' on its first failure)", async () => {
    const { tenantId } = await mintTenant("Dunning Sweep Co", "managed");
    await failPayment(tenantId); // billing_state -> past_due, 1 recorded failure

    const sweep = await adminApi<DunningSweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
    expect(sweep.status).toBe(200);

    const mine = sweep.body.results.find((r) => r.tenantId === tenantId);
    expect(mine).toBeDefined();
    expect(mine?.action).toBe("retry");
    expect(mine?.applied).toBe(true);
  });

  it("is idempotent within a cycle — a second sweep with no new failure applies nothing new", async () => {
    const { tenantId } = await mintTenant("Dunning Idempotent Co", "managed");
    await failPayment(tenantId);

    const first = await adminApi<DunningSweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
    const firstMine = first.body.results.find((r) => r.tenantId === tenantId);
    expect(firstMine?.applied).toBe(true);

    const second = await adminApi<DunningSweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
    const secondMine = second.body.results.find((r) => r.tenantId === tenantId);
    // Same tenant, same cycle (failure count unchanged) — still surfaced
    // (it's still past_due) but NOT re-applied.
    expect(secondMine).toBeDefined();
    expect(secondMine?.cycle).toBe(firstMine?.cycle);
    expect(secondMine?.applied).toBe(false);
  });

  it("escalates after repeated failures and suspends after the grace threshold", async () => {
    const { tenantId } = await mintTenant("Dunning Escalate Co", "managed");
    await failPayment(tenantId); // cycle 1 -> retry
    await failPayment(tenantId); // cycle 2 -> escalate
    await failPayment(tenantId);
    await failPayment(tenantId); // cycle 4 -> suspend

    const sweep = await adminApi<DunningSweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
    const mine = sweep.body.results.find((r) => r.tenantId === tenantId);
    expect(mine?.cycle).toBe(4);
    expect(mine?.action).toBe("suspend");
    expect(mine?.applied).toBe(true);
  });

  // audit-stripe-webhook-2026-08-06.md finding 6: the cycle was a LIFETIME count
  // of invoice.payment_failed webhook rows, never windowed or reset. A customer
  // who had a rough month and then PAID was suspended on their very next
  // failure — cycle 4 on failure number one of a new cycle, skipping the entire
  // four-strike grace period this sweep exists to provide.
  it("a recovered tenant's next failure starts a NEW cycle at 1, not where the old one left off", async () => {
    const { tenantId } = await mintTenant("Dunning Recovered Co", "managed");
    await seedBenignSdnList();
    await activatePaidPlan(tenantId, "managed");

    // A rough month: three failures, one short of the suspend threshold.
    await failPayment(tenantId);
    await failPayment(tenantId);
    await failPayment(tenantId);

    // They fix the card; the subscription recovers.
    await postWebhook(subscriptionUpdated({ tenantId, status: "active" }));

    // One new failure, a whole billing period later.
    await failPayment(tenantId);

    const sweep = await adminApi<DunningSweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
    const mine = sweep.body.results.find((r) => r.tenantId === tenantId);
    expect(mine?.cycle).toBe(1);
    expect(mine?.action).toBe("retry");

    // ...and the paying customer is NOT suspended off a stale count.
    const status = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
      state.storage.sql.exec<{ status: string }>(`SELECT status FROM tenant_profile WHERE id = ?`, tenantId).one().status,
    );
    expect(status).not.toBe("suspended");
  });

  it("a current (never past_due) tenant produces no dunning action", async () => {
    const { tenantId } = await mintTenant("Current Co", "demo");

    const sweep = await adminApi<DunningSweepResponse>("/admin/ops/dunning-sweep", { method: "POST" });
    const mine = sweep.body.results.find((r) => r.tenantId === tenantId);
    expect(mine).toBeUndefined();
  });
});
