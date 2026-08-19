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

// NON-BLOCKING-4 (build gate 2026-08-19) — THE STAMP COVERED 1 OF 28 TOOLS.
// Only `infrastructure_status` stamped, so an agent actively calling
// setup_infrastructure / launch_campaign / ack_message / activity for 24h
// without polling status scored `agentStalled` — a false stall aimed at the
// most active agents there are. It now lives in `mcp/handler.ts`'s `tools/call`,
// which is bearer-only by construction, so every tool is agent activity.
describe("NON-BLOCKING-4 — every bearer MCP tool call is agent activity, not just infrastructure_status", () => {
  async function callTool(token: string, name: string, args: Record<string, unknown>): Promise<number> {
    const res = await api("/mcp", {
      method: "POST",
      token,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return res.status;
  }

  it("a NON-status tool (metrics) stamps the column", async () => {
    const { tenantId, token } = await mintTenantWithToken("Mcp Metrics Activity Co", "managed", "tok-mcp-metrics-1");
    await activatePaidPlan(tenantId, "managed");
    expect(await lastAgentActivityAt(tenantId)).toBeNull();

    expect(await callTool(token, "metrics", {})).toBe(200);

    const stamped = await lastAgentActivityAt(tenantId);
    expect(stamped).not.toBeNull();
    expect(stamped as number).toBeLessThanOrEqual(realNowMs());
    expect(stamped as number).toBeGreaterThan(realNowMs() - 60_000);
  });

  it("a WRITE tool (contact_operator) stamps it too — the stamp is per call, not per tool", async () => {
    const { tenantId, token } = await mintTenantWithToken("Mcp Write Activity Co", "managed", "tok-mcp-write-1");
    await activatePaidPlan(tenantId, "managed");

    expect(await callTool(token, "contact_operator", { body: "a real agent action", urgency: "normal" })).toBe(200);
    expect(await lastAgentActivityAt(tenantId)).not.toBeNull();
  });

  it("an UNKNOWN tool name does not stamp — a malformed probe is not an agent doing work", async () => {
    const { tenantId, token } = await mintTenantWithToken("Mcp Unknown Activity Co", "managed", "tok-mcp-unknown-1");
    await activatePaidPlan(tenantId, "managed");

    await callTool(token, "no_such_tool", {});
    expect(await lastAgentActivityAt(tenantId)).toBeNull();
  });

  it("infrastructure_status over MCP still stamps — and still issues no write of its own", async () => {
    const { tenantId, token } = await mintTenantWithToken("Mcp Status Activity Co", "managed", "tok-mcp-status-1");
    await activatePaidPlan(tenantId, "managed");

    expect(await callTool(token, "infrastructure_status", {})).toBe(200);
    expect(await lastAgentActivityAt(tenantId)).not.toBeNull();
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
