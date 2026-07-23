import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { normalizeName, tokenize } from "../src/ofac/normalize.js";
import { screenTenant } from "../src/ofac/screening.js";
import { swapInSdnList } from "../src/ofac/sdn-list.js";
import { getScreeningReview } from "../src/admin/db.js";
import { adminApi, api, mintTenant, signup, tenantStub, withTenantContext } from "./helpers.js";

function sdnEntry(uid: string, name: string) {
  const nameNormalized = normalizeName(name);
  return { uid, nameNormalized, tokens: tokenize(nameNormalized), entityType: null as string | null, program: "TEST-PROGRAM" };
}

async function seedSdnList(nowMs: number): Promise<void> {
  await swapInSdnList(env, {
    listVersion: `test-${nowMs}`,
    entries: [sdnEntry("9001", "Globex Corp")],
    publishedDate: "2026-07-23",
    fetchedAt: nowMs,
  });
}

async function readScreeningStatus(tenantId: string): Promise<string> {
  const row = await runInDurableObject(tenantStub(tenantId), async (_i, state) =>
    state.storage.sql.exec<{ screening_status: string }>(`SELECT screening_status FROM tenant_profile WHERE id = ?`, tenantId).one(),
  );
  return row.screening_status;
}

async function holdForReview(brand: string, contactEmail: string): Promise<{ tenantId: string; token: string }> {
  const { tenantId, token } = await signup(brand, contactEmail);
  await withTenantContext(tenantId, (ctx) => screenTenant(ctx, { trigger: "checkout" }));
  return { tenantId, token };
}

// G1b — POST /admin/tenants/:id/screening + GET /admin/screening/reviews
// (ga-gates-design-2026-07-22.md §G1, design line 59: reuses the EXACT
// requireAdminAuth + enforcement_actions audit pattern already used by POST
// /admin/tenants/:id/terminate — test structure mirrors admin-terminate.test.ts).
describe("admin screening surface (G1b)", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM screening_reviews`).run();
  });

  it("non-admin (wrong or tenant token) is rejected 401 before any effect", async () => {
    await seedSdnList(20_000_000);
    const { tenantId, token } = await holdForReview("Globex Corp International", "founder@globexadmin1.test");

    const wrongAdmin = await adminApi(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      adminToken: "not-the-admin-token",
      body: JSON.stringify({ decision: "clear" }),
    });
    expect(wrongAdmin.status).toBe(401);

    const tenantToken = await api(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      token,
      body: JSON.stringify({ decision: "clear" }),
    });
    expect(tenantToken.status).toBe(401);

    expect(await readScreeningStatus(tenantId)).toBe("review"); // unchanged
  });

  it("404s for an unknown tenant id", async () => {
    const res = await adminApi(`/admin/tenants/ten_does_not_exist/screening`, {
      method: "POST",
      body: JSON.stringify({ decision: "clear" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /admin/screening/reviews lists every PENDING review", async () => {
    await seedSdnList(21_000_000);
    const a = await holdForReview("Globex Corp International", "founder@globexadmin2.test");
    const b = await holdForReview("Globex Corp Global", "founder@globexadmin3.test");

    const res = await adminApi<{ count: number; reviews: Array<{ tenantId: string; status: string }> }>("/admin/screening/reviews");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const ids = res.body.reviews.map((r) => r.tenantId);
    expect(ids).toEqual(expect.arrayContaining([a.tenantId, b.tenantId]));
    expect(res.body.reviews.every((r) => r.status === "pending")).toBe(true);
  });

  it("decision:'clear' un-blocks activation on the tenant's OWN DO and resolves the review row", async () => {
    await seedSdnList(22_000_000);
    const { tenantId, token } = await holdForReview("Globex Corp International", "founder@globexadmin4.test");
    expect(await readScreeningStatus(tenantId)).toBe("review");

    const res = await adminApi<{ cleared: boolean; reviewResolved: boolean }>(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      body: JSON.stringify({ decision: "clear", note: "verified false positive" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(true);
    expect(res.body.reviewResolved).toBe(true);

    expect(await readScreeningStatus(tenantId)).toBe("clear");
    const review = await getScreeningReview(env, tenantId);
    expect(review).toMatchObject({ status: "cleared", resolvedBy: "admin" });
    expect(review?.resolvedAt).not.toBeNull();

    // Clearing screening never suspended the tenant — its own token still works.
    const account = await api("/account", { token });
    expect(account.status).toBe(200);
  });

  it("decision:'reject' chains into the SAME D5 terminate path — suspends, reclaims infra, locks the token, logs enforcement_actions", async () => {
    await seedSdnList(23_000_000);
    const { tenantId, token } = await holdForReview("Globex Corp International", "founder@globexadmin5.test");

    const res = await adminApi<{ terminated: boolean; enforcementLogged: boolean; suspended: boolean }>(
      `/admin/tenants/${tenantId}/screening`,
      { method: "POST", body: JSON.stringify({ decision: "reject", note: "confirmed match" }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.terminated).toBe(true);
    expect(res.body.suspended).toBe(true);
    expect(res.body.enforcementLogged).toBe(true);

    // Token locked out — cannot re-provision (mirrors admin-terminate.test.ts).
    const account = await api("/account", { token });
    expect(account.status).toBe(401);

    const enf = await env.DB.prepare(`SELECT action, reason FROM enforcement_actions WHERE tenant_id = ?`).bind(tenantId).all<{
      action: string;
      reason: string;
    }>();
    expect(enf.results).toHaveLength(1);
    expect(enf.results[0]?.action).toBe("TERMINATE");
    expect(enf.results[0]?.reason).toContain("OFAC/SDN screening rejected");

    const review = await getScreeningReview(env, tenantId);
    expect(review?.status).toBe("rejected");
  });

  it("clear/reject on a tenant with NO review row on file still applies to tenant_profile honestly (reviewResolved:false)", async () => {
    const { tenantId } = await mintTenant("Never Reviewed Co", "launch");
    const res = await adminApi<{ cleared: boolean; reviewResolved: boolean }>(`/admin/tenants/${tenantId}/screening`, {
      method: "POST",
      body: JSON.stringify({ decision: "clear" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.reviewResolved).toBe(false);
  });
});
