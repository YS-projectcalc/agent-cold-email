import { describe, expect, it } from "vitest";
import { activatePaidPlan, adminApi, failPayment, mintTenant } from "./helpers.js";

interface OpsDigestResponse {
  tenants: { total: number; activeByPlan: Record<string, number> };
  mrrCents: number;
  totalUsageCents: number;
  provisioningFailureCount: number;
  pastDueCount: number;
  watchdogAlerts: string[];
}

// D6 (brief) — the required test case: "digest aggregates across >=2
// tenants correctly (MRR, counts)." Every tenant here is minted fresh inside
// THIS test (vitest-pool-workers isolates storage per test case), so the
// aggregate numbers are exact, not just >= assertions.
describe("GET /admin/ops/digest — D6 owner business-health rollup", () => {
  it("aggregates MRR, plan counts, and past_due count across multiple tenants", async () => {
    const launch = await mintTenant("Digest Launch Co", "launch");
    await activatePaidPlan(launch.tenantId, "launch"); // -> billing_state active, mrr 9900

    const growth = await mintTenant("Digest Growth Co", "growth");
    await activatePaidPlan(growth.tenantId, "growth"); // -> billing_state active, mrr 29900

    await mintTenant("Digest Demo Co", "demo"); // never paid -> 0 mrr

    const pastDue = await mintTenant("Digest PastDue Co", "launch");
    await failPayment(pastDue.tenantId); // billing_state -> past_due, NOT active -> excluded from mrr

    const digest = await adminApi<OpsDigestResponse>("/admin/ops/digest");
    expect(digest.status).toBe(200);

    expect(digest.body.tenants.total).toBe(4);
    expect(digest.body.tenants.activeByPlan.launch).toBe(2); // both launch tenants are still tenant_profile.status='active'
    expect(digest.body.tenants.activeByPlan.growth).toBe(1);
    expect(digest.body.tenants.activeByPlan.demo).toBe(1);

    // Only the two ACTUALLY-paid-and-billing-active tenants count toward MRR
    // — the past_due launch tenant must NOT be double-counted here.
    expect(digest.body.mrrCents).toBe(9_900 + 29_900);

    expect(digest.body.pastDueCount).toBe(1);
    expect(digest.body.watchdogAlerts.some((a) => a.includes("past_due"))).toBe(true);

    // No infra ever provisioned for any of these tenants -> no usage accrued.
    expect(digest.body.totalUsageCents).toBe(0);
    // B2 sagas aren't built — honestly 0, not fabricated (src/admin/README.md).
    expect(digest.body.provisioningFailureCount).toBe(0);
  });

  it("windowHours accepts an ?hours= override", async () => {
    const res = await adminApi<{ windowHours: number }>("/admin/ops/digest?hours=1");
    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(1);
  });
});
