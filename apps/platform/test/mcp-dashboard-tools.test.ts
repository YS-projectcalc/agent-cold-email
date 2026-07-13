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

const MINIMAL_LAYOUT = { schemaVersion: 1, widgets: [] };

// SPEC.md §19.5 — tools 13-15. Parity law (§19.0): everything the dashboard
// can do, an MCP agent can do too, via the SAME TenantDO methods.
describe("MCP tool: get_dashboard", () => {
  it("with no id, lists views (lazy-seeding the default); with an id, fetches the full layout", async () => {
    const { token } = await signup("MCP Dashboard Co", "mcp-dash@mcp-dash-test.example");

    interface ViewSummary { id: string; isDefault: boolean; rev: number }
    const list = await callTool<ViewSummary[]>(token, "get_dashboard", {});
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("default");

    interface ViewDetail extends ViewSummary { layout: { widgets: unknown[] } }
    const detail = await callTool<ViewDetail>(token, "get_dashboard", { id: "default" });
    expect(detail.layout.widgets.length).toBeGreaterThan(0);
  });
});

describe("MCP tool: configure_dashboard", () => {
  it("create -> update (matching rev) -> promote -> delete, full lifecycle via MCP", async () => {
    const { token } = await signup("MCP Configure Co", "mcp-configure@mcp-dash-test.example");
    await callTool(token, "get_dashboard", {}); // seed default

    interface ViewDetail { id: string; rev: number; editedBy: string; isDefault: boolean }
    const created = await callTool<ViewDetail>(token, "configure_dashboard", { action: "create", name: "Agent View", layout: MINIMAL_LAYOUT });
    expect(created.editedBy).toBe("mcp");
    expect(created.isDefault).toBe(false);

    const updated = await callTool<ViewDetail>(token, "configure_dashboard", {
      action: "update",
      id: created.id,
      rev: created.rev,
      layout: MINIMAL_LAYOUT,
      note: "agent tidy-up",
    });
    expect(updated.rev).toBe(created.rev + 1);

    interface ViewSummary { id: string; isDefault: boolean }
    const promoted = await callTool<ViewSummary[]>(token, "configure_dashboard", { action: "promote", id: created.id });
    expect(promoted.find((v) => v.id === created.id)!.isDefault).toBe(true);

    // Can't delete the (now-)default view — same guard as the HTTP route.
    const res = await api("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "configure_dashboard", arguments: { action: "delete", id: created.id } }),
    });
    const body = res.body as JsonRpcSuccess<ToolCallResult>;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/default/i);
  });

  it("update with `name` renames the view via MCP — same rev-CAS semantics as the HTTP route", async () => {
    const { token } = await signup("MCP Rename Co", "mcp-rename@mcp-dash-test.example");
    await callTool(token, "get_dashboard", {});

    interface ViewDetail { id: string; name: string; rev: number; editedBy: string }
    const created = await callTool<ViewDetail>(token, "configure_dashboard", { action: "create", name: "Agent View", layout: MINIMAL_LAYOUT });

    const renamed = await callTool<ViewDetail>(token, "configure_dashboard", {
      action: "update",
      id: created.id,
      rev: created.rev,
      layout: MINIMAL_LAYOUT,
      name: "Renamed Agent View",
    });
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe("Renamed Agent View");
    expect(renamed.rev).toBe(created.rev + 1);
    expect(renamed.editedBy).toBe("mcp");
  });

  it("a stale rev returns a structured conflict (currentRev + currentLayout), surfaced via isError content, not a bare string", async () => {
    const { token } = await signup("MCP Stale Rev Co", "mcp-stale@mcp-dash-test.example");
    await callTool(token, "get_dashboard", {});

    // Two concurrent-looking updates against the SAME base rev — the second replay is stale.
    await api("/dashboard/views/default", { method: "PUT", token, body: JSON.stringify({ rev: 1, layout: MINIMAL_LAYOUT }) });

    const res = await api("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", { name: "configure_dashboard", arguments: { action: "update", id: "default", rev: 1, layout: MINIMAL_LAYOUT } }),
    });
    const body = res.body as JsonRpcSuccess<ToolCallResult>;
    expect(body.result.isError).toBe(true);
    const parsed = JSON.parse(body.result.content[0]!.text) as { error: string; currentRev: number; currentLayout: { widgets: unknown[] } };
    expect(parsed.currentRev).toBe(2);
    expect(Array.isArray(parsed.currentLayout.widgets)).toBe(true);
  });

  it("rejects an unknown widget type with a JSON-RPC invalid-params error (-32602), same as any other bad tool args", async () => {
    const { token } = await signup("MCP Bad Widget Co", "mcp-bad-widget@mcp-dash-test.example");
    const res = await api<{ error: { code: number } }>("/mcp", {
      method: "POST",
      token,
      body: rpc("tools/call", {
        name: "configure_dashboard",
        arguments: { action: "create", name: "Bad", layout: { schemaVersion: 1, widgets: [{ id: "w1", type: "not_real", gridPos: { x: 0, y: 0, w: 1, h: 1 }, visible: true, props: {} }] } },
      }),
    });
    expect(res.body.error.code).toBe(-32602);
  });
});

describe("MCP tool: label_thread", () => {
  it("sets and clears a thread label with source='mcp'", async () => {
    const { tenantId, token } = await signup("MCP Label Co", "mcp-label@mcp-dash-test.example");
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({ brand: "MCP Label Co", primaryDomain: "mcplabelco.com", domains: 1, inboxesEach: 1, persona: "Sender", physicalAddress: "1 St", senderIdentity: "Sender <s@mcplabelco.com>" }),
    });
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email: "a@mcplabelco-leads.com", firstName: "A", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();

    interface InboxPage { threads: { threadId: string }[] }
    const inbox = await callTool<InboxPage>(token, "inbox", {});
    expect(inbox.threads.length).toBeGreaterThan(0);
    const threadId = inbox.threads[0]!.threadId;

    interface LabelResult { threadId: string; label: string | null; source: string | null }
    const set = await callTool<LabelResult>(token, "label_thread", { threadId, label: "wrong_person" });
    expect(set.label).toBe("wrong_person");
    expect(set.source).toBe("mcp");

    const cleared = await callTool<LabelResult>(token, "label_thread", { threadId, label: null });
    expect(cleared.label).toBeNull();
  });
});
