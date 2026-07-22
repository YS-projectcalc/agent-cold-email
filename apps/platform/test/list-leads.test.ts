import { describe, expect, it } from "vitest";
import { api, signup } from "./helpers.js";

// SPEC.md §22 — warm-lead thin layer, increment #3: list_leads (read-only,
// doubles as the JSON export surface, Q6). REST + MCP parity, filters, and
// cursor pagination. Tenant isolation is covered end-to-end in
// test/lead-dispositions.test.ts; read-only-hint ground-truth (zero writes)
// is covered by test/mcp-tool-annotations.test.ts's write-detecting spy.

interface LeadListRow {
  leadId: string;
  email: string;
  firstName: string;
  company: string;
  campaignId: string;
  campaignName: string;
  globalStatus: string;
  interestStatus: string;
  notes: string;
  tags: string[];
  suppressed: boolean;
  lastEventType: string | null;
  lastEventTs: number | null;
  createdAt: number;
}

interface LeadListPage {
  leads: LeadListRow[];
  nextCursor: string | null;
}

async function launchCampaign(token: string, name: string, emails: string[]) {
  return api<{ campaignId: string }>("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name,
      offer: "x",
      leads: emails.map((email) => ({ email, firstName: "P", company: "Co" })),
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
}

async function mcp<T = unknown>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await api<{ result: { content: { text: string }[]; isError?: boolean } }>("/mcp", {
    method: "POST",
    token,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (res.body.result.isError) throw new Error(`tool ${name} errored: ${res.body.result.content[0]!.text}`);
  return JSON.parse(res.body.result.content[0]!.text) as T;
}

describe("list_leads — read/export surface (REST)", () => {
  it("returns leads with disposition + suppression joined in, and the expected shape", async () => {
    const { token } = await signup("List Leads Co", "founder@listleadsco.com");
    const email = "lead@listleadsco-leads.com";
    const launched = await launchCampaign(token, "Campaign One", [email]);

    await api("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email, interestStatus: "interested", notes: "n", tags: ["t1"] }),
    });

    const res = await api<LeadListPage>("/leads", { token });
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    const row = res.body.leads[0]!;
    expect(row.email).toBe(email);
    expect(row.campaignId).toBe(launched.body.campaignId);
    expect(row.campaignName).toBe("Campaign One");
    expect(row.interestStatus).toBe("interested");
    expect(row.notes).toBe("n");
    expect(row.tags).toEqual(["t1"]);
    expect(row.suppressed).toBe(false);
    expect(row.globalStatus).toBe("active");
  });

  it("a lead with no disposition row yet defaults interestStatus='none', notes='', tags=[]", async () => {
    const { token } = await signup("Default Disposition Co", "founder@defaultdispositionco.com");
    await launchCampaign(token, "c", ["lead@defaultdispositionco-leads.com"]);

    const res = await api<LeadListPage>("/leads", { token });
    const row = res.body.leads[0]!;
    expect(row.interestStatus).toBe("none");
    expect(row.notes).toBe("");
    expect(row.tags).toEqual([]);
  });

  it("filters by campaign, interestStatus, suppressed, and replied independently", async () => {
    const { token } = await signup("Filter Co", "founder@filterco.com");
    const c1 = await launchCampaign(token, "C1", ["a@filterco-leads.com", "b@filterco-leads.com"]);
    const c2 = await launchCampaign(token, "C2", ["c@filterco-leads.com"]);

    await api("/leads/disposition", {
      method: "POST",
      token,
      body: JSON.stringify({ email: "a@filterco-leads.com", interestStatus: "interested" }),
    });
    await api("/leads/suppress", { method: "POST", token, body: JSON.stringify({ email: "b@filterco-leads.com" }) });

    const byCampaign = await api<LeadListPage>(`/leads?campaign=${c1.body.campaignId}`, { token });
    expect(byCampaign.body.leads.map((l) => l.email).sort()).toEqual(["a@filterco-leads.com", "b@filterco-leads.com"]);

    const byOtherCampaign = await api<LeadListPage>(`/leads?campaign=${c2.body.campaignId}`, { token });
    expect(byOtherCampaign.body.leads.map((l) => l.email)).toEqual(["c@filterco-leads.com"]);

    const byInterest = await api<LeadListPage>(`/leads?interestStatus=interested`, { token });
    expect(byInterest.body.leads.map((l) => l.email)).toEqual(["a@filterco-leads.com"]);

    const bySuppressedTrue = await api<LeadListPage>(`/leads?suppressed=true`, { token });
    expect(bySuppressedTrue.body.leads.map((l) => l.email)).toEqual(["b@filterco-leads.com"]);

    const bySuppressedFalse = await api<LeadListPage>(`/leads?suppressed=false`, { token });
    expect(bySuppressedFalse.body.leads.map((l) => l.email).sort()).toEqual(["a@filterco-leads.com", "c@filterco-leads.com"]);

    const byRepliedFalse = await api<LeadListPage>(`/leads?replied=false`, { token });
    expect(byRepliedFalse.body.leads).toHaveLength(3); // none have replied yet
  });

  it("cursor-paginates deterministically across pages with no gaps/dupes", async () => {
    const { token } = await signup("Page Co", "founder@pageco.com");
    const emails = Array.from({ length: 5 }, (_, i) => `lead${i}@pageco-leads.com`);
    await launchCampaign(token, "c", emails);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : `?limit=2`;
      const page: { status: number; body: LeadListPage } = await api<LeadListPage>(`/leads${qs}`, { token });
      expect(page.status).toBe(200);
      seen.push(...page.body.leads.map((l) => l.email));
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(5); // no duplicates
    expect(seen.sort()).toEqual(emails.sort());
  });

  it("rejects an invalid interestStatus at the boundary (400, not a silent empty result)", async () => {
    const { token } = await signup("Bad Filter Co", "founder@badfilterco.com");
    const res = await api("/leads?interestStatus=do_not_contact", { token });
    expect(res.status).toBe(400);
  });
});

describe("list_leads — MCP parity", () => {
  it("list_leads tool returns the SAME shape as the REST route", async () => {
    const { token } = await signup("Mcp List Co", "founder@mcplistco.com");
    await launchCampaign(token, "c", ["lead@mcplistco-leads.com"]);

    const result = await mcp<LeadListPage>(token, "list_leads", {});
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]!.email).toBe("lead@mcplistco-leads.com");
  });
});
