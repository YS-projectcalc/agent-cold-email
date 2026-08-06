import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { buildOpsDigest } from "../src/admin/ops-sweep.js";
import { TenantDO } from "../src/tenant-do.js";
import { activatePaidPlan, adminApi, failPayment, mintTenant } from "./helpers.js";

interface OpsDigestResponse {
  tenants: { total: number; activeByPlan: Record<string, number> };
  mrrCents: number;
  totalUsageCents: number;
  provisioningFailureCount: number;
  pastDueCount: number;
  watchdogAlerts: string[];
  errors: number;
}

afterEach(() => vi.restoreAllMocks());

// D6 (brief) — the required test case: "digest aggregates across >=2
// tenants correctly (MRR, counts)." Every tenant here is minted fresh inside
// THIS test (vitest-pool-workers isolates storage per test case), so the
// aggregate numbers are exact, not just >= assertions.
describe("GET /admin/ops/digest — D6 owner business-health rollup", () => {
  it("aggregates MRR, plan counts, and past_due count across multiple tenants", async () => {
    const a = await mintTenant("Digest A Co", "managed");
    await activatePaidPlan(a.tenantId, "managed"); // -> billing_state active, 0 provisioned -> mrr floor $99

    const b = await mintTenant("Digest B Co", "managed");
    await activatePaidPlan(b.tenantId, "managed"); // -> billing_state active, 0 provisioned -> mrr floor $99

    await mintTenant("Digest Demo Co", "demo"); // never paid -> 0 mrr

    const pastDue = await mintTenant("Digest PastDue Co", "managed");
    await failPayment(pastDue.tenantId); // billing_state -> past_due, NOT active -> excluded from mrr

    const digest = await adminApi<OpsDigestResponse>("/admin/ops/digest");
    expect(digest.status).toBe(200);

    expect(digest.body.tenants.total).toBe(4);
    // The tiers collapsed to one paid plan (design §4): all three paid tenants
    // are status='active' (past_due is a billing_state, not a status).
    expect(digest.body.tenants.activeByPlan.managed).toBe(3);
    expect(digest.body.tenants.activeByPlan.demo).toBe(1);

    // Only the two ACTUALLY-paid-and-billing-active tenants count toward MRR —
    // the past_due tenant is excluded. Each provisioned 0 mailboxes, so MRR is
    // the $99 curve floor ($49 platform + $10 x min-5 mailboxes) per tenant.
    expect(digest.body.mrrCents).toBe(9_900 + 9_900);

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

// Adversarial audit 2026-08-05 (docs/adversarial/audit-dunning-2026-08-05.md)
// reported buildOpsDigest's unguarded per-tenant `Promise.all` as an F1-class
// sibling: one wedged tenant DO used to zero the WHOLE digest (and 500 the
// on-demand GET /admin/ops/digest route) instead of just being skipped.
// Fault-injects the real path via TenantDO.prototype patching (login.test.ts:301).
describe("buildOpsDigest — one wedged tenant's opsSummary throw must not zero the digest for the rest", () => {
  it("skips the wedged tenant, counts it in errors, and still aggregates the healthy tenant correctly", async () => {
    // Storage isn't reset between `it()` blocks in this file (other tests in
    // this suite mint their own paid tenants), so assert the DELTA this test
    // itself produces rather than an absolute total.
    const before = await buildOpsDigest(env, Date.now(), 24);

    const { tenantId: wedgedId } = await mintTenant("Digest Wedged Co", "managed");
    await activatePaidPlan(wedgedId, "managed");

    const { tenantId: healthyId } = await mintTenant("Digest Healthy Co", "managed");
    await activatePaidPlan(healthyId, "managed");

    const originalOpsSummary = TenantDO.prototype.opsSummary;
    (TenantDO.prototype as any).opsSummary = function (this: any, sinceMs: number) {
      if (this.tenantId === wedgedId) throw new Error("simulated wedged DO (storage error / overload)");
      return originalOpsSummary.call(this, sinceMs);
    };

    try {
      const digest = await buildOpsDigest(env, Date.now(), 24);
      expect(digest.errors).toBe(before.errors + 1);
      // The healthy tenant's own $99 floor (49 platform + 10 x min-5 mailboxes)
      // still lands — the wedged tenant is skipped, not silently zeroing the
      // rest of the aggregate.
      expect(digest.mrrCents).toBe(before.mrrCents + 9_900);
      expect(digest.tenants.activeByPlan.managed).toBe((before.tenants.activeByPlan.managed ?? 0) + 1);
    } finally {
      TenantDO.prototype.opsSummary = originalOpsSummary;
    }
  });
});
