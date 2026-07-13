import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
}
interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function rpc(method: string, params?: unknown, id: number | string | null = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function callTool<T>(token: string, name: string, args: unknown): Promise<T> {
  const res = await api<JsonRpcSuccess<ToolCallResult>>("/mcp", { method: "POST", token, body: rpc("tools/call", { name, arguments: args }) });
  expect(res.status).toBe(200);
  if (res.body.result.isError) throw new Error(`tool ${name} errored: ${res.body.result.content[0]!.text}`);
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

async function setupReadyTenant(brand: string, primaryDomain: string) {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  return { tenantId, token };
}

interface CampaignListItem {
  campaignId: string;
  name: string;
  status: string;
  counts: { sent: number; reply: number; bounce: number };
}

// SPEC.md §19.0 parity law — every dashboard capability (here: GET /campaigns
// and GET /activity, already backing the dashboard UI) must stay MCP-reachable.
describe("MCP tool: list_campaigns", () => {
  it("returns the SAME shape as GET /campaigns (id/name/status/counts, no N+1)", async () => {
    const { tenantId, token } = await setupReadyTenant("MCP List Campaigns Co", "mcplistcampaigns.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Alpha", offer: "x", leads: [{ email: "reply.prospect@mcplistcampaigns-leads.com", firstName: "R", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const viaHttp = await api<CampaignListItem[]>("/campaigns", { token });
    const viaMcp = await callTool<CampaignListItem[]>(token, "list_campaigns", {});

    expect(viaMcp).toEqual(viaHttp.body);
    expect(viaMcp).toHaveLength(1);
    expect(viaMcp[0]!.name).toBe("Alpha");
    expect(viaMcp[0]!.counts.sent).toBe(1);
  });

  it("rejects a non-object `arguments` payload with -32602 (schema expects an object)", async () => {
    const { token } = await signup("MCP List Campaigns Bad Args Co", "founder@mcplistcampaigns-badargs.example");
    const res = await api<{ error: { code: number } }>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "list_campaigns", arguments: "not an object" }),
    });
    expect(res.body.error.code).toBe(-32602);
  });

  it("tenant-scoped: tenant A never sees tenant B's campaigns", async () => {
    const a = await setupReadyTenant("MCP Isolation Campaigns A", "mcpisolationcampaignsa.com");
    const b = await setupReadyTenant("MCP Isolation Campaigns B", "mcpisolationcampaignsb.com");
    await api("/campaigns", {
      method: "POST",
      token: a.token,
      body: JSON.stringify({ name: "A-Only", offer: "x", leads: [{ email: "a@mcpisocampaignsa-leads.com", firstName: "A", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });

    const listA = await callTool<CampaignListItem[]>(a.token, "list_campaigns", {});
    const listB = await callTool<CampaignListItem[]>(b.token, "list_campaigns", {});
    expect(listA).toHaveLength(1);
    expect(listA[0]!.name).toBe("A-Only");
    expect(listB).toHaveLength(0);
  });
});

describe("MCP tool: activity", () => {
  it("returns the SAME shape as GET /activity, and honors the kind filter + pagination", async () => {
    const { tenantId, token } = await setupReadyTenant("MCP Activity Co", "mcpactivityco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email: "reply.prospect@mcpactivityco-leads.com", firstName: "R", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const viaHttp = await api<{ items: { id: string; kind: string; label: string; ts: number }[]; nextCursor: string | null }>("/activity", { token });
    const viaMcp = await callTool<{ items: { id: string; kind: string; label: string; ts: number }[]; nextCursor: string | null }>(token, "activity", {});
    expect(viaMcp).toEqual(viaHttp.body);
    expect(viaMcp.items.length).toBeGreaterThan(0);

    // server-side kind filter, same as the HTTP route.
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts) VALUES ('act_mcp_inj_1', ?, 'PAUSE', 'mbx_inj', '{}', 0)`,
        tenantId,
      );
    });
    const eventsOnly = await callTool<{ items: { kind: string }[] }>(token, "activity", { kind: "event" });
    expect(eventsOnly.items.length).toBeGreaterThan(0);
    expect(eventsOnly.items.every((i) => i.kind === "event")).toBe(true);

    // cursor pagination, limit=1, no loss.
    const full = viaMcp.items.length + 1; // +1 for the injected deliverability row
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < full + 2; i++) {
      const page = await callTool<{ items: { id: string }[]; nextCursor: string | null }>(token, "activity", { limit: 1, ...(cursor ? { cursor } : {}) });
      for (const item of page.items) seen.add(item.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(full);
  });

  it("rejects an invalid kind value with -32602, same convention as every other tool", async () => {
    const { token } = await signup("MCP Activity Bad Args Co", "founder@mcpactivity-badargs.example");
    const res = await api<{ error: { code: number } }>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "activity", arguments: { kind: "not_a_real_kind" } }),
    });
    expect(res.body.error.code).toBe(-32602);
  });

  it("tenant-scoped: tenant A never sees tenant B's activity", async () => {
    const a = await setupReadyTenant("MCP Isolation Activity A", "mcpisolationactivitya.com");
    const b = await setupReadyTenant("MCP Isolation Activity B", "mcpisolationactivityb.com");
    await api("/campaigns", {
      method: "POST",
      token: a.token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email: "a@mcpisolationactivitya-leads.com", firstName: "A", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(a.tenantId).tick();

    const feedA = await callTool<{ items: unknown[] }>(a.token, "activity", {});
    const feedB = await callTool<{ items: unknown[] }>(b.token, "activity", {});
    expect(feedA.items.length).toBeGreaterThan(0);
    expect(feedB.items).toEqual([]);
  });
});
