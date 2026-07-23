import { describe, expect, it } from "vitest";
import { buildDemoLeads, friendlyCampaignName, splitIntoCampaignBatches } from "../src/engine/demo-seed.js";

// Backend gaps brief item 3 — pure, deterministic generation feeding POST
// /demo/run's optional {leads, campaigns} params. No ctx/clock/randomness:
// unit-testable directly, independent of the DO/HTTP layer.
describe("buildDemoLeads", () => {
  it("count<=3 is EXACTLY the original canned demo set (byte-for-byte) — the default-unchanged contract", () => {
    const leads = buildDemoLeads(3);
    expect(leads).toEqual([
      { email: "morgan.reply@demo-leads.coldrig.dev", firstName: "Morgan", company: "Reply Co", kind: "reply" },
      { email: "casey.bounce@demo-leads.coldrig.dev", firstName: "Casey", company: "Bounce Co", kind: "bounce" },
      { email: "jordan.prospect@demo-leads.coldrig.dev", firstName: "Jordan", company: "Prospect Co", kind: "silent" },
    ]);
  });

  it("count<3 slices the canned set from the front", () => {
    expect(buildDemoLeads(1)).toEqual([{ email: "morgan.reply@demo-leads.coldrig.dev", firstName: "Morgan", company: "Reply Co", kind: "reply" }]);
  });

  it("is deterministic: the Nth lead is identical across repeated calls", () => {
    expect(buildDemoLeads(50)).toEqual(buildDemoLeads(50));
    expect(buildDemoLeads(200)).toHaveLength(200);
  });

  it("count>3 extends the canned set with a mix of every kind (reply/bounce/ooo/silent)", () => {
    const leads = buildDemoLeads(20);
    expect(leads).toHaveLength(20);
    expect(leads.slice(0, 3)).toEqual(buildDemoLeads(3));
    const kinds = new Set(leads.map((l) => l.kind));
    expect(kinds).toEqual(new Set(["reply", "bounce", "ooo", "silent"]));
  });

  it("every email is unique and every non-silent kind's local-part matches the sandbox EmailPort's trigger substrings", () => {
    const leads = buildDemoLeads(40);
    expect(new Set(leads.map((l) => l.email)).size).toBe(40);
    for (const lead of leads) {
      const local = lead.email.split("@")[0]!.toLowerCase();
      if (lead.kind === "bounce") expect(local).toContain("bounce");
      if (lead.kind === "reply" || lead.kind === "ooo") expect(local).toContain("reply");
      if (lead.kind === "silent") expect(local).not.toMatch(/complaint|bounce|reply/);
    }
  });
});

describe("splitIntoCampaignBatches", () => {
  it("campaignCount=1 returns the whole list as a single batch (the default-preserving path)", () => {
    const leads = [1, 2, 3];
    expect(splitIntoCampaignBatches(leads, 1)).toEqual([[1, 2, 3]]);
  });

  it("splits near-evenly across N campaigns, preserving order, never an empty batch", () => {
    const leads = Array.from({ length: 10 }, (_, i) => i);
    const batches = splitIntoCampaignBatches(leads, 3);
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toEqual(leads); // order preserved, nothing lost/duplicated
    for (const batch of batches) expect(batch.length).toBeGreaterThan(0);
  });

  it("clamps campaignCount down when there are fewer leads than campaigns requested", () => {
    const leads = [1, 2];
    const batches = splitIntoCampaignBatches(leads, 3);
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toEqual(leads);
  });
});

// M5 dashboard-polish defect D — friendly, deterministic campaign names
// (replacing "Demo run run_<uuid>", which clipped/overflowed every chip and
// table column it appeared in).
describe("friendlyCampaignName", () => {
  it("returns the bare base name for a single-batch run (the default campaigns=1 path)", () => {
    expect(friendlyCampaignName(0, 1)).toBe("Founder outreach");
  });

  it("suffixes a lettered batch label for a multi-campaign run", () => {
    expect(friendlyCampaignName(0, 3)).toBe("Founder outreach — batch A");
    expect(friendlyCampaignName(1, 3)).toBe("Founder outreach — batch B");
    expect(friendlyCampaignName(2, 3)).toBe("Founder outreach — batch C");
  });

  it("is deterministic — same (idx, totalBatches) always produces the same name", () => {
    expect(friendlyCampaignName(1, 2)).toBe(friendlyCampaignName(1, 2));
  });

  it("wraps past 26 batches rather than throwing, even though /demo/run bounds campaigns to 3", () => {
    expect(friendlyCampaignName(26, 27)).toBe("Founder outreach — batch A");
  });
});
