import { Hono } from "hono";
import { AdminScreeningDecisionInput } from "../admin/schemas.js";
import { getScreeningReview, getTenantIndexById, listPendingScreeningReviews, resolveScreeningReview } from "../admin/db.js";
import { terminateTenantForAbuse } from "../admin/terminate.js";
import { RealClock } from "../clock.js";
import type { Env } from "../env.js";
import { parseJsonBody } from "../validate.js";

const RESOLVED_BY = "admin"; // ADMIN_TOKEN is a single shared owner secret, not a per-admin identity (mirrors enforcement_actions' posture).

// G1b (ga-gates-design-2026-07-22.md §G1) — the admin surface a screening HIT
// blocks on. Reuses the exact requireAdminAuth + enforcement_actions audit
// pattern already used by POST /admin/tenants/:id/terminate (design line 59):
//   GET  /admin/screening/reviews      — every review still awaiting the founder.
//   POST /admin/tenants/:id/screening  — resolve one: 'clear' un-blocks
//     activation on the tenant's own DO; 'reject' chains into the SAME D5
//     terminate path (design: "reject can chain into the existing terminate
//     path") — never a silent no-op, never auto-anything.
export const adminScreeningRoute = new Hono<{ Bindings: Env }>()
  .get("/admin/screening/reviews", async (c) => {
    const reviews = await listPendingScreeningReviews(c.env);
    return c.json({ count: reviews.length, reviews });
  })
  .post("/admin/tenants/:id/screening", async (c) => {
    const tenantId = c.req.param("id");
    const tenant = await getTenantIndexById(c.env, tenantId);
    if (!tenant) return c.json({ error: `tenant ${tenantId} not found` }, 404);

    const parsed = await parseJsonBody(c, AdminScreeningDecisionInput);
    if (!parsed.ok) return parsed.response;

    const now = new RealClock().now();
    const review = await getScreeningReview(c.env, tenantId);

    if (parsed.data.decision === "clear") {
      const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenantId));
      await stub.clearScreening();
      const reviewResolved = review ? await resolveScreeningReview(c.env, tenantId, "cleared", RESOLVED_BY, now) : false;
      return c.json({ tenantId, decision: "clear", cleared: true, reviewResolved });
    }

    // 'reject' — chains into the SAME D5 abuse-offboarding path terminate
    // uses (design line 59). Never leaves a confirmed sanctions match merely
    // "still in review" — the tenant is suspended and its infra reclaimed.
    await resolveScreeningReview(c.env, tenantId, "rejected", RESOLVED_BY, now);
    const result = await terminateTenantForAbuse(
      c.env,
      tenantId,
      `OFAC/SDN screening rejected${parsed.data.note ? `: ${parsed.data.note}` : ""}`,
      { screeningMatchedTerms: review?.matchedTerms ?? null },
      now,
    );
    return c.json({ tenantId, decision: "reject", ...result });
  });
