import { describe, expect, it } from "vitest";
import { api, signup, tenantStub } from "./helpers.js";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";

// Backend gaps brief item 1 / SPEC.md §19.4 — GET /inbox v2 gains a
// server-side archived filter. M3 filtered `markStatus !== "archived"`
// CLIENT-side (apps/dashboard/src/pages/InboxPage.tsx), which wastes pages at
// scale: an archived thread still consumes a page slot, so a caller paging
// through N archived-heavy pages can see an empty visible list for several
// fetches. `archived` is a NEW query param, default `"exclude"` (the fix —
// bare `GET /inbox` no longer needs a client-side filter to hide archived
// threads), `"include"` restores the pre-existing "everything" shape, `"only"`
// surfaces just the archived queue (a triage/undo surface).
interface InboxRow {
  threadId: string;
  markStatus: string;
}
interface InboxPage {
  threads: InboxRow[];
  nextCursor: string | null;
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

describe("GET /inbox v2 — server-side archived filter (backend gaps brief item 1)", () => {
  it("default (archived param omitted) EXCLUDES archived threads", async () => {
    const { tenantId, token } = await setupReadyTenant("Archive Default Co", "archivedefaultco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [
          { email: "a@archivedefaultco-leads.com", firstName: "A", company: "Co" },
          { email: "b@archivedefaultco-leads.com", firstName: "B", company: "Co" },
        ],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    await tenantStub(tenantId).tick();

    const all = await api<InboxPage>("/inbox?archived=include", { token });
    expect(all.body.threads).toHaveLength(2);
    const [t1, t2] = all.body.threads;

    await api(`/threads/${t1!.threadId}/mark`, { method: "POST", token, body: JSON.stringify({ status: "archived" }) });

    const bareDefault = await api<InboxPage>("/inbox", { token });
    expect(bareDefault.body.threads).toHaveLength(1);
    expect(bareDefault.body.threads[0]!.threadId).toBe(t2!.threadId);
  });

  it("archived=include restores every thread (archived + not)", async () => {
    const { tenantId, token } = await setupReadyTenant("Archive Include Co", "archiveincludeco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "a@archiveincludeco-leads.com", firstName: "A", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    await tenantStub(tenantId).tick();
    const before = await api<InboxPage>("/inbox", { token });
    const threadId = before.body.threads[0]!.threadId;
    await api(`/threads/${threadId}/mark`, { method: "POST", token, body: JSON.stringify({ status: "archived" }) });

    const included = await api<InboxPage>("/inbox?archived=include", { token });
    expect(included.body.threads.map((t) => t.threadId)).toContain(threadId);
  });

  it("archived=only surfaces ONLY the archived queue", async () => {
    const { tenantId, token } = await setupReadyTenant("Archive Only Co", "archiveonlyco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [
          { email: "a@archiveonlyco-leads.com", firstName: "A", company: "Co" },
          { email: "b@archiveonlyco-leads.com", firstName: "B", company: "Co" },
        ],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    await tenantStub(tenantId).tick();
    const all = await api<InboxPage>("/inbox?archived=include", { token });
    const [t1, t2] = all.body.threads;
    await api(`/threads/${t1!.threadId}/mark`, { method: "POST", token, body: JSON.stringify({ status: "archived" }) });

    const onlyArchived = await api<InboxPage>("/inbox?archived=only", { token });
    expect(onlyArchived.body.threads).toHaveLength(1);
    expect(onlyArchived.body.threads[0]!.threadId).toBe(t1!.threadId);
    void t2;
  });

  it("the MCP `inbox` tool accepts the same `archived` filter (shared DO method — parity law)", async () => {
    const { tenantId, token } = await setupReadyTenant("Archive Mcp Co", "archivemcpco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "c",
        offer: "x",
        leads: [{ email: "a@archivemcpco-leads.com", firstName: "A", company: "Co" }],
        sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
      }),
    });
    await tenantStub(tenantId).tick();
    const before = await api<InboxPage>("/inbox", { token });
    const threadId = before.body.threads[0]!.threadId;
    await api(`/threads/${threadId}/mark`, { method: "POST", token, body: JSON.stringify({ status: "archived" }) });

    const mcpRes = await api<{ result: { content: { type: string; text: string }[] } }>("/mcp", {
      method: "POST",
      token,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "inbox", arguments: { archived: "only" } },
      }),
    });
    expect(mcpRes.status).toBe(200);
    const mcpInbox = JSON.parse(mcpRes.body.result.content[0]!.text) as InboxPage;
    expect(mcpInbox.threads).toHaveLength(1);
    expect(mcpInbox.threads[0]!.threadId).toBe(threadId);
  });
});
