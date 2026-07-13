import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, signup, tenantStub } from "./helpers.js";

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

describe("GET /campaigns — listCampaigns (§19.4)", () => {
  it("lists every campaign with id/name/status/counts — no N+1 (two campaigns, distinct counts)", async () => {
    const { tenantId, token } = await setupReadyTenant("List Campaigns Co", "listcampaigns.com");
    const c1 = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Alpha", offer: "x", leads: [{ email: "reply.prospect@listcampaigns-leads.com", firstName: "R", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    const c2 = await api<{ campaignId: string }>("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Beta", offer: "x", leads: [{ email: "silent@listcampaigns-leads.com", firstName: "S", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const list = await api<CampaignListItem[]>("/campaigns", { token });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);

    const alpha = list.body.find((c) => c.campaignId === c1.body.campaignId)!;
    const beta = list.body.find((c) => c.campaignId === c2.body.campaignId)!;
    expect(alpha.name).toBe("Alpha");
    expect(alpha.status).toBe("active");
    expect(alpha.counts.sent).toBe(1);
    expect(alpha.counts.reply).toBe(1); // the sandbox generates a reply for "reply.prospect@..."
    expect(beta.counts.sent).toBe(1);
    expect(beta.counts.reply).toBe(0);
  });

  it("a campaign with zero events still reports zero-filled counts (not undefined/missing keys)", async () => {
    const { token } = await setupReadyTenant("Zero Counts Co", "zerocounts.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Untouched", offer: "x", leads: [{ email: "a@zerocounts-leads.com", firstName: "A", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 5 }] }),
    });
    // No tick — nothing sent yet.
    const list = await api<CampaignListItem[]>("/campaigns", { token });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]!.counts).toEqual({ sent: 0, reply: 0, bounce: 0, complaint: 0, unsubscribe: 0, failed: 0, soft_bounce: 0 });
  });
});

describe("GET /activity — merged events + deliverability_actions feed (§19.4)", () => {
  it("merges send/reply events with deliverability actions in one chronological, cursor-paginated feed", async () => {
    const { tenantId, token } = await setupReadyTenant("Activity Co", "activityco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email: "reply.prospect@activityco-leads.com", firstName: "R", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick();
    await tenantStub(tenantId).pollInbox();

    const feed = await api<{ items: { id: string; kind: string; label: string; ts: number }[]; nextCursor: string | null }>("/activity", { token });
    expect(feed.status).toBe(200);
    const kinds = feed.body.items.map((i) => i.kind);
    expect(kinds.every((k) => k === "event" || k === "deliverability")).toBe(true);
    const labels = feed.body.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["sent", "reply"]));

    // Cursor-paginate with limit=1 and confirm no loss across the full feed.
    const full = feed.body.items.length;
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < full + 2; i++) {
      const qs = new URLSearchParams({ limit: "1", ...(cursor ? { cursor } : {}) });
      const page = await api<{ items: { id: string }[]; nextCursor: string | null }>(`/activity?${qs.toString()}`, { token });
      for (const item of page.body.items) seen.add(item.id);
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    expect(seen.size).toBe(full);
  });

  it("server-side kind filter narrows to just 'event' or just 'deliverability' — the agent_log widget no longer over-fetches + client-filters", async () => {
    const { tenantId, token } = await setupReadyTenant("Kind Filter Co", "kindfilterco.com");
    await api("/campaigns", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "c", offer: "x", leads: [{ email: "a@kindfilterco-leads.com", firstName: "A", company: "Co" }], sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }] }),
    });
    await tenantStub(tenantId).tick(); // produces a genuine 'event' (sent)

    // A deliverability_actions row directly inserted (same technique
    // deliverability-loop.test.ts uses) — deterministic without needing to
    // cross the real minSampleSends=10 pause threshold just to prove a query
    // param.
    await runInDurableObject(tenantStub(tenantId), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO deliverability_actions (id, tenant_id, action, target, detail_json, ts) VALUES ('act_inj_1', ?, 'PAUSE', 'mbx_inj', '{}', 0)`,
        tenantId,
      );
    });

    const full = await api<{ items: { kind: string }[] }>("/activity", { token });
    expect(full.body.items.some((i) => i.kind === "event")).toBe(true);
    expect(full.body.items.some((i) => i.kind === "deliverability")).toBe(true);

    const eventsOnly = await api<{ items: { kind: string }[] }>("/activity?kind=event", { token });
    expect(eventsOnly.body.items.length).toBeGreaterThan(0);
    expect(eventsOnly.body.items.every((i) => i.kind === "event")).toBe(true);

    const deliverabilityOnly = await api<{ items: { kind: string }[] }>("/activity?kind=deliverability", { token });
    expect(deliverabilityOnly.body.items.length).toBeGreaterThan(0);
    expect(deliverabilityOnly.body.items.every((i) => i.kind === "deliverability")).toBe(true);

    // Backward-compatible default: omitting `kind` still returns everything.
    expect(eventsOnly.body.items.length + deliverabilityOnly.body.items.length).toBe(full.body.items.length);
  });

  it("an empty tenant returns an empty feed, not an error", async () => {
    const { token } = await signup("Empty Activity Co", "founder@empty-activity.example");
    const feed = await api<{ items: unknown[]; nextCursor: string | null }>("/activity", { token });
    expect(feed.status).toBe(200);
    expect(feed.body.items).toEqual([]);
    expect(feed.body.nextCursor).toBeNull();
  });
});
