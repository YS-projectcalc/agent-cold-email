import { describe, expect, it } from "vitest";
import { api, signup, tenantStub } from "./helpers.js";

// Backend gaps brief item 3 — POST /demo/run's optional bounded
// {leads<=200, campaigns<=3} sandbox-seed-variety params. The default-
// unchanged contract (leads=3) is already covered by test/demo-run.test.ts
// and test/subject-fidelity.test.ts, which this change must not disturb —
// deliberately NOT re-asserted here.

const SETUP_BODY = {
  brand: "Rich Demo Co",
  primaryDomain: "richdemoco.com",
  domains: 1,
  inboxesEach: 5, // enough daily-cap headroom (5 * 40/day) to send a 12-lead run in one tick
  persona: "Sender",
  physicalAddress: "1 Demo St",
  senderIdentity: "Sender <s@richdemoco.com>",
};

interface DemoRunSummary {
  sent: number;
  replies: number;
  bounces: number;
  complaints: number;
}
interface CampaignListItem {
  campaignId: string;
  name: string;
  status: string;
}
interface InboxRow {
  threadId: string;
  leadEmail: string;
  label: string | null;
}
interface InboxPage {
  threads: InboxRow[];
}

describe("POST /demo/run — bounded seed-variety params (backend gaps brief item 3)", () => {
  it("rejects leads > 200 with 400", async () => {
    const { token } = await signup("Demo Bounds Leads Co", "demo-bounds-leads@test.example");
    const res = await api("/demo/run", { method: "POST", token, body: JSON.stringify({ leads: 201 }) });
    expect(res.status).toBe(400);
  });

  it("rejects leads < 1 with 400", async () => {
    const { token } = await signup("Demo Bounds Zero Co", "demo-bounds-zero@test.example");
    const res = await api("/demo/run", { method: "POST", token, body: JSON.stringify({ leads: 0 }) });
    expect(res.status).toBe(400);
  });

  it("rejects campaigns > 3 with 400", async () => {
    const { token } = await signup("Demo Bounds Campaigns Co", "demo-bounds-campaigns@test.example");
    const res = await api("/demo/run", { method: "POST", token, body: JSON.stringify({ campaigns: 4 }) });
    expect(res.status).toBe(400);
  });

  it("an empty body still works (defaults apply) — same shape as no body at all", async () => {
    const { token } = await signup("Demo Empty Body Co", "demo-empty-body@test.example");
    await api("/setup-infrastructure", { method: "POST", token, body: JSON.stringify({ ...SETUP_BODY, brand: "Demo Empty Body Co", primaryDomain: "demoemptybodyco.com" }) });
    const res = await api<DemoRunSummary>("/demo/run", { method: "POST", token, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
  });

  it("leads=12, campaigns=3 generates 3 demo campaigns and 12 leads with mixed reply/bounce/ooo/silent variety", async () => {
    const { tenantId, token } = await signup("Demo Rich Co", "demo-rich@test.example");
    await api("/setup-infrastructure", { method: "POST", token, body: JSON.stringify({ ...SETUP_BODY, brand: "Demo Rich Co", primaryDomain: "demorichco.com" }) });

    const res = await api<DemoRunSummary>("/demo/run", { method: "POST", token, body: JSON.stringify({ leads: 12, campaigns: 3 }) });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
    expect(res.body.replies).toBeGreaterThanOrEqual(1);
    expect(res.body.bounces).toBeGreaterThanOrEqual(1);

    const campaigns = await api<CampaignListItem[]>("/campaigns", { token });
    expect(campaigns.body).toHaveLength(3);

    const account = await api<{ leads: number }>("/account", { token });
    expect(account.body.leads).toBe(12);

    // An "ooo" lead's thread is labeled `out_of_office` (backend gaps brief
    // item 3's OOO variety — a real customer agent classification, applied
    // by runDemo itself after the reply actually lands).
    const inbox = await api<InboxPage>("/inbox?archived=include&limit=200", { token });
    const oooRow = inbox.body.threads.find((t) => t.leadEmail.includes(".reply@") && t.label === "out_of_office");
    expect(oooRow).toBeDefined();
    void tenantId;
  });

  it("is deterministic: two fresh tenants given the same params generate the identical lead-email set", async () => {
    const bodyFor = (brand: string, domain: string) => ({ ...SETUP_BODY, brand, primaryDomain: domain });

    const t1 = await signup("Demo Determinism A", "demo-determinism-a@test.example");
    await api("/setup-infrastructure", { method: "POST", token: t1.token, body: JSON.stringify(bodyFor("Demo Determinism A", "demodeterminisma.com")) });
    await api("/demo/run", { method: "POST", token: t1.token, body: JSON.stringify({ leads: 10, campaigns: 2 }) });
    const inbox1 = await api<InboxPage>("/inbox?archived=include&limit=200", { token: t1.token });

    const t2 = await signup("Demo Determinism B", "demo-determinism-b@test.example");
    await api("/setup-infrastructure", { method: "POST", token: t2.token, body: JSON.stringify(bodyFor("Demo Determinism B", "demodeterminismb.com")) });
    await api("/demo/run", { method: "POST", token: t2.token, body: JSON.stringify({ leads: 10, campaigns: 2 }) });
    const inbox2 = await api<InboxPage>("/inbox?archived=include&limit=200", { token: t2.token });

    const emails1 = new Set(inbox1.body.threads.map((t) => t.leadEmail));
    const emails2 = new Set(inbox2.body.threads.map((t) => t.leadEmail));
    expect(emails1.size).toBeGreaterThan(0);
    expect(emails1).toEqual(emails2);
  });

  it("repeated /demo/run calls with a richer seed still reset prior demo state (no unbounded growth)", async () => {
    const { tenantId, token } = await signup("Demo Rich Reset Co", "demo-rich-reset@test.example");
    await api("/setup-infrastructure", { method: "POST", token, body: JSON.stringify({ ...SETUP_BODY, brand: "Demo Rich Reset Co", primaryDomain: "demorichresetco.com" }) });

    const stub = tenantStub(tenantId);
    await api("/demo/run", { method: "POST", token, body: JSON.stringify({ leads: 12, campaigns: 3 }) });
    const afterFirst = await api<{ leads: number }>("/account", { token });
    expect(afterFirst.body.leads).toBe(12);

    // Bypass the once-per-minute throttle directly at the DO layer (test-only,
    // same pattern test/demo-run.test.ts already uses).
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM demo_run_state`);
    });
    await api("/demo/run", { method: "POST", token, body: JSON.stringify({ leads: 5, campaigns: 1 }) });

    const afterSecond = await api<{ leads: number }>("/account", { token });
    expect(afterSecond.body.leads).toBe(5); // not 12+5 — prior demo rows were reset, not appended

    const campaigns = await api<CampaignListItem[]>("/campaigns", { token });
    expect(campaigns.body).toHaveLength(1);

    // No orphaned thread_labels rows survive past the reset either (the ooo
    // labels the first, richer run wrote).
    const labelRowCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM thread_labels`).one().n,
    );
    const inboxAfter = await api<InboxPage>("/inbox?archived=include&limit=200", { token });
    expect(labelRowCount).toBeLessThanOrEqual(inboxAfter.body.threads.length);
  });
});
