import { describe, expect, it } from "vitest";
import { adminApi, api } from "./helpers.js";

// The required guardrail (brief DoD): every /admin/* route MUST require
// ADMIN_TOKEN, timing-safe compared, and 401 without/with a wrong one — this
// surface exposes cross-tenant data, unlike the per-tenant `requireAuth`.
describe("admin routes — require ADMIN_TOKEN, not a tenant token", () => {
  it("401s with no Authorization header", async () => {
    const res = await api("/admin/ops/digest");
    expect(res.status).toBe(401);
  });

  it("401s with a wrong/garbage admin token", async () => {
    const res = await adminApi("/admin/ops/digest", { adminToken: "cs_test_not-the-admin-token" });
    expect(res.status).toBe(401);
  });

  it("401s a tenant-scoped token presented on an admin route", async () => {
    // A valid PER-TENANT bearer token must never work here — different
    // credential space entirely (src/admin/README.md).
    const res = await adminApi("/admin/ops/digest", { adminToken: "cs_test_deadbeef00000000000000000000000000000000000000000000000000000000" });
    expect(res.status).toBe(401);
  });

  it("200s with the correct ADMIN_TOKEN", async () => {
    const res = await adminApi("/admin/ops/digest");
    expect(res.status).toBe(200);
  });

  it("also gates the support-triage admin routes", async () => {
    const noAuth = await api("/admin/support/digest");
    expect(noAuth.status).toBe(401);

    const authed = await adminApi("/admin/support/digest");
    expect(authed.status).toBe(200);
  });
});
