import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { realNowMs } from "../src/engine/clamped-age.js";
import type { TenantOpsSummary } from "../src/engine/ops-summary.js";
import {
  activatePaidPlan,
  api,
  cookieApi,
  createDashboardSession,
  mintTenantWithToken,
  tenantStub,
  withTenantContext,
} from "./helpers.js";

// I12 — `lastAgentActivityAt` keys on `authVia`, bearer only (design §7.10.2,
// gate B4 — CLOSED). `infrastructureStatus()` serves TWO principals: the
// agent's MCP tool (bearer) and the cookie-authed dashboard SPA, which POLLS
// IT ON A TIMER — so a single open browser tab would keep the signal fresh
// forever and the stuck-customer check could never fire on its own benchmark.
//
// THE DECISIVE NEGATIVE: a COOKIE-authed poll must NOT advance the column.

function lastAgentActivityAt(tenantId: string): Promise<number | null> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql
      .exec<{ last_agent_activity_at: number | null }>(`SELECT last_agent_activity_at FROM tenant_profile WHERE id = ?`, ctx.tenantId)
      .one().last_agent_activity_at,
  );
}

describe("I12 — infrastructure_status stamps last_agent_activity_at ONLY for a bearer caller", () => {
  it("a BEARER-authed GET /infrastructure-status advances the column to real now", async () => {
    const { tenantId, token } = await mintTenantWithToken("Bearer Activity Co", "managed", "tok-bearer-activity-1");
    await activatePaidPlan(tenantId, "managed");
    expect(await lastAgentActivityAt(tenantId)).toBeNull();

    const res = await api("/infrastructure-status", { token });
    expect(res.status).toBe(200);

    const stamped = await lastAgentActivityAt(tenantId);
    expect(stamped).not.toBeNull();
    expect(stamped as number).toBeLessThanOrEqual(realNowMs());
    expect(stamped as number).toBeGreaterThan(realNowMs() - 60_000);
  });

  it("THE DECISIVE NEGATIVE — a COOKIE-authed GET /infrastructure-status does NOT advance the column", async () => {
    const { tenantId, token } = await mintTenantWithToken("Cookie Activity Co", "managed", "tok-cookie-activity-1");
    await activatePaidPlan(tenantId, "managed");
    const session = await createDashboardSession(token);
    expect(await lastAgentActivityAt(tenantId)).toBeNull();

    const res = await cookieApi("/infrastructure-status", session);
    expect(res.status).toBe(200);

    // A single open dashboard tab polling this endpoint on a timer must never
    // keep the liveness signal fresh — that is the exact benchmark failure
    // this increment closes.
    expect(await lastAgentActivityAt(tenantId)).toBeNull();
  });

  it("a bearer call after a cookie call still advances it — the two principals are independently observed", async () => {
    const { tenantId, token } = await mintTenantWithToken("Mixed Activity Co", "managed", "tok-mixed-activity-1");
    await activatePaidPlan(tenantId, "managed");
    const session = await createDashboardSession(token);

    await cookieApi("/infrastructure-status", session);
    expect(await lastAgentActivityAt(tenantId)).toBeNull();

    await api("/infrastructure-status", { token });
    expect(await lastAgentActivityAt(tenantId)).not.toBeNull();
  });

  it("is throttled to a 5-minute resolution — a second bearer call moments later does not re-stamp", async () => {
    const { tenantId, token } = await mintTenantWithToken("Throttle Activity Co", "managed", "tok-throttle-activity-1");
    await activatePaidPlan(tenantId, "managed");

    await api("/infrastructure-status", { token });
    const first = await lastAgentActivityAt(tenantId);
    expect(first).not.toBeNull();

    await api("/infrastructure-status", { token });
    const second = await lastAgentActivityAt(tenantId);
    expect(second).toBe(first);
  });
});

describe("I12 — opsSummary (the cron/system fan-out) never advances last_agent_activity_at", () => {
  it("calling opsSummary() directly leaves the column untouched", async () => {
    const { tenantId, token } = await mintTenantWithToken("Ops Summary Activity Co", "managed", "tok-ops-activity-1");
    await activatePaidPlan(tenantId, "managed");
    // Establish a real bearer stamp first, so this test proves opsSummary
    // never ADVANCES it, not merely that a never-touched column stays null.
    await api("/infrastructure-status", { token });
    const before = await lastAgentActivityAt(tenantId);
    expect(before).not.toBeNull();

    await runInDurableObject(tenantStub(tenantId), (instance) => {
      (instance as unknown as { opsSummary(sinceMs: number): TenantOpsSummary }).opsSummary(0);
    });

    expect(await lastAgentActivityAt(tenantId)).toBe(before);
  });
});
