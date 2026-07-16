import { runInDurableObject } from "cloudflare:test";
import { ActivityQueryInput, InboxQueryInput } from "@coldstart/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import type { TenantDO } from "../src/tenant-do.js";
import { api, signup, tenantStub } from "./helpers.js";

// Anthropic Connectors Directory instant-reject trigger #1: "All tools must
// include a `title` and the applicable `readOnlyHint` or `destructiveHint`."
// This asserts the MCP-spec `annotations` object (ToolAnnotationsSchema —
// title/readOnlyHint/destructiveHint) is present and honest for every
// registered tool, not just that tools/list responds (see mcp.test.ts for
// the base protocol coverage).

interface ToolListResult {
  tools: {
    name: string;
    annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
  }[];
}

// Tools that only read tenant state — no mutation of any kind.
const READ_ONLY_TOOLS = new Set([
  "infrastructure_status",
  "campaign_results",
  "metrics",
  "inbox",
  "thread",
  "account",
  "get_dashboard",
  "list_campaigns",
  "activity",
]);

// Tools whose worst-case action is genuinely destructive/irreversible via
// this API surface: real sends (launch_campaign, reply), a hard delete
// (configure_dashboard action=delete), or an unrecoverable suspend (pause,
// pause_all — AGENTS.md/tools.ts: "there is no resume tool").
const DESTRUCTIVE_TOOLS = new Set(["launch_campaign", "reply", "pause", "pause_all", "configure_dashboard"]);

// Tools that mutate but only additively/reversibly: setup_infrastructure
// (creates new resources, never deletes/overwrites existing ones), mark and
// label_thread (fully reversible triage flags).
const ADDITIVE_NONDESTRUCTIVE_TOOLS = new Set(["setup_infrastructure", "mark", "label_thread"]);

async function listTools(): Promise<ToolListResult["tools"]> {
  const res = await api<{ jsonrpc: "2.0"; id: number; result: ToolListResult }>("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  return res.body.result.tools;
}

describe("tools/list — MCP tool annotations (Anthropic Connectors Directory requirement)", () => {
  it("every one of the 17 tools carries a non-empty annotations.title", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(17);
    for (const t of tools) {
      expect(t.annotations, `${t.name} is missing annotations`).toBeDefined();
      expect(typeof t.annotations!.title, `${t.name}.annotations.title`).toBe("string");
      expect(t.annotations!.title!.length, `${t.name}.annotations.title`).toBeGreaterThan(0);
    }
  });

  it("every pure-read tool declares readOnlyHint: true", async () => {
    const tools = await listTools();
    for (const name of READ_ONLY_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} not found in tools/list`).toBeDefined();
      expect(t!.annotations?.readOnlyHint, `${name}.annotations.readOnlyHint`).toBe(true);
    }
  });

  it("no read-only tool is also flagged destructive", async () => {
    const tools = await listTools();
    for (const name of READ_ONLY_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations?.destructiveHint, `${name}.annotations.destructiveHint`).not.toBe(true);
    }
  });

  it("every genuinely destructive/irreversible tool declares destructiveHint: true", async () => {
    const tools = await listTools();
    for (const name of DESTRUCTIVE_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} not found in tools/list`).toBeDefined();
      expect(t!.annotations?.readOnlyHint, `${name}.annotations.readOnlyHint`).not.toBe(true);
      expect(t!.annotations?.destructiveHint, `${name}.annotations.destructiveHint`).toBe(true);
    }
  });

  it("additive-only mutating tools declare destructiveHint: false, not the true default", async () => {
    const tools = await listTools();
    for (const name of ADDITIVE_NONDESTRUCTIVE_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} not found in tools/list`).toBeDefined();
      expect(t!.annotations?.readOnlyHint, `${name}.annotations.readOnlyHint`).not.toBe(true);
      expect(t!.annotations?.destructiveHint, `${name}.annotations.destructiveHint`).toBe(false);
    }
  });

  it("classification covers exactly the 17 tools with no overlap between sets", async () => {
    const tools = await listTools();
    const classified = new Set([...READ_ONLY_TOOLS, ...DESTRUCTIVE_TOOLS, ...ADDITIVE_NONDESTRUCTIVE_TOOLS]);
    expect(classified.size).toBe(17);
    expect(tools.map((t) => t.name).sort()).toEqual([...classified].sort());
  });
});

// Directory-readiness adversarial finding (docs/adversarial/directory-readiness-2026-07-16.md,
// BLOCKING #1): the test above only checks that a tool DECLARES
// `readOnlyHint: true` — it encodes the builder's classification, not
// ground truth, so it certified `infrastructure_status` as honest even
// though its handler wrote to D1-equivalent tenant SQL storage on every
// call (mailbox-state.ts's refreshMailboxWarmupState). This oracle closes
// that gap: it genuinely INVOKES every readOnlyHint:true tool against a
// write-detecting spy on the tenant's real SqlStorage (`ctx.sql`, the same
// storage.sql instance TenantDO's `requireContext()` hands every engine/*.ts
// function — there is no separate D1 database for tenant data in this repo;
// D1 (`env.DB`) is only the tiny token->tenant control-plane index, see
// src/db.ts) and asserts it issues ZERO INSERT/UPDATE/DELETE/REPLACE
// statements. Must FAIL on a handler that writes, PASS once it's genuinely
// read-only — ground-truth, not self-reported.
describe("write-detecting spy — every readOnlyHint:true tool performs ZERO write statements when invoked", () => {
  interface ReadOnlyFixture {
    tenantId: string;
    campaignId: string;
    threadId: string;
  }

  // One invocation per READ_ONLY_TOOLS entry, calling the SAME TenantDO
  // method tools.ts's `call` dispatches to (mcp/tools.ts) so this exercises
  // the real handler, not a re-implementation of it.
  const READ_ONLY_INVOCATIONS: Record<string, (instance: TenantDO, fx: ReadOnlyFixture) => unknown> = {
    infrastructure_status: (i) => i.infrastructureStatus(),
    campaign_results: (i, fx) => i.campaignResults(fx.campaignId),
    metrics: (i) => i.metrics(),
    inbox: (i) => i.inbox(InboxQueryInput.parse({})),
    thread: (i, fx) => i.thread(fx.threadId),
    account: (i) => i.account(),
    get_dashboard: (i) => i.dashboardViews(),
    list_campaigns: (i) => i.campaigns(),
    activity: (i) => i.activity(ActivityQueryInput.parse({})),
  };

  let fixture: ReadOnlyFixture;

  beforeAll(async () => {
    const brand = "Annotation Spy Co";
    const domain = "annotationspyco.com";
    const { tenantId, token } = await signup(brand, `founder@${domain}`);

    // Real mailboxes are required: refreshMailboxWarmupState's UPDATE loop
    // (mailbox-state.ts) only runs when `mailboxes` is non-empty, so a
    // fixture with zero mailboxes would pass this oracle even on the
    // pre-fix, genuinely-writing handler — a false green. Advance past
    // warmup so the fixture also exercises a non-trivial dailyCap/status.
    await api("/setup-infrastructure", {
      method: "POST",
      token,
      body: JSON.stringify({
        brand,
        primaryDomain: domain,
        domains: 1,
        inboxesEach: 1,
        persona: "Ops",
        physicalAddress: "1 Test St",
        senderIdentity: `Ops <o@${domain}>`,
      }),
    });
    await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);

    const launched = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Spy Campaign",
        offer: "x",
        leads: [{ email: `lead@${domain}-leads.com`, firstName: "L", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    const campaignId = launched.body.campaignId;

    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
    const threadId = inbox.body.threads[0]!.threadId;

    // Deliberately NOT pre-seeding dashboard_views: get_dashboard's spy
    // invocation below must run against a genuinely VIRGIN tenant (this
    // fixture never calls anything in dashboard-views.ts up to this point)
    // — a first-ever call is exactly the case that used to write (a
    // lazy INSERT via ensureDefaultViewSeeded) and now must not.
    fixture = { tenantId, campaignId, threadId };
  });

  it("every READ_ONLY_TOOLS entry has a spy invocation defined (no untested tool)", () => {
    expect(Object.keys(READ_ONLY_INVOCATIONS).sort()).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it.each([...READ_ONLY_TOOLS])("%s issues no INSERT/UPDATE/DELETE/REPLACE against tenant SQL storage", async (name) => {
    const invoke = READ_ONLY_INVOCATIONS[name]!;

    const writes = await runInDurableObject(tenantStub(fixture.tenantId), async (instance, state) => {
      const original = state.storage.sql.exec.bind(state.storage.sql);
      const seenWrites: string[] = [];
      state.storage.sql.exec = ((...args: Parameters<typeof original>) => {
        const [query] = args;
        if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query)) seenWrites.push(query);
        return original(...args);
      }) as typeof state.storage.sql.exec;

      await invoke(instance, fixture);
      return seenWrites;
    });

    expect(writes, `${name} performed write statement(s) it claims readOnlyHint:true against: ${JSON.stringify(writes)}`).toEqual([]);
  });
});
